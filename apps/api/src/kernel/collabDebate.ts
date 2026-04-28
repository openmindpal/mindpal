/**
 * Collab Orchestrator — 辩论机制 (v1)
 *
 * V1 二方辩论 + 共享辅助函数。
 * V2 N方辩论、持久化 CRUD、自动触发已拆分到独立文件。
 *
 * @see collabDebateV2.ts       — N方辩论 + 动态纠错 + 共识演化
 * @see collabDebateRepo.ts     — 辩论持久化 CRUD
 * @see collabDebateAutoTrigger.ts — 自动分歧检测与辩论触发
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { type LlmSubject } from "../lib/llm";
import { runAgentLoop } from "./agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";
import {
  createDebateSessionV2, isDebateConvergedV2,
  type DebateSession, type DebatePosition, type DebateRound, type DebateVerdict,
  type DebateConfig, DEBATE_CONFIG_DEFAULTS,
} from "@openslin/shared";
import type { DebatePhaseParams } from "./collabTypes";
import { loadApprovalRules } from "./approvalRuleEngine";

// ── 辩论配置动态加载 ─────────────────────────────────────────

/**
 * 从 approval_rules 加载辩论配置（rule_type='debate_config'），
 * 缺省用 DEBATE_CONFIG_DEFAULTS 兜底。
 */
export async function loadDebateConfig(pool: Pool, tenantId: string): Promise<DebateConfig> {
  const rules = await loadApprovalRules({ pool, tenantId, ruleType: "debate_config" });
  const cfg = (rules[0]?.metadata ?? {}) as Record<string, unknown>;
  return {
    maxRounds:                (cfg.maxRounds as number)                ?? DEBATE_CONFIG_DEFAULTS.maxRounds,
    convergenceThreshold:     (cfg.convergenceThreshold as number)     ?? DEBATE_CONFIG_DEFAULTS.convergenceThreshold,
    minConfidence:            (cfg.minConfidence as number)            ?? DEBATE_CONFIG_DEFAULTS.minConfidence,
    arbiterModel:             cfg.arbiterModel as string | undefined,
    allowCorrections:         (cfg.allowCorrections as boolean)        ?? DEBATE_CONFIG_DEFAULTS.allowCorrections,
    requireEvidence:          (cfg.requireEvidence as boolean)         ?? DEBATE_CONFIG_DEFAULTS.requireEvidence,
    scoreDecay:               (cfg.scoreDecay as number)               ?? DEBATE_CONFIG_DEFAULTS.scoreDecay,
    correctionBonus:          (cfg.correctionBonus as number)          ?? DEBATE_CONFIG_DEFAULTS.correctionBonus,
    consensusEvolutionWindow: (cfg.consensusEvolutionWindow as number) ?? DEBATE_CONFIG_DEFAULTS.consensusEvolutionWindow,
    divergenceConfDiff:       (cfg.divergenceConfDiff as number)       ?? DEBATE_CONFIG_DEFAULTS.divergenceConfDiff,
    minParties:               (cfg.minParties as number)               ?? DEBATE_CONFIG_DEFAULTS.minParties,
    maxParties:               (cfg.maxParties as number)               ?? DEBATE_CONFIG_DEFAULTS.maxParties,
  };
}

// ── P0-协作: 自主辩论机制 (v1) ────────────────────────────

/**
 * P0-协作: 多智能体自主辩论机制
 *
 * 流程：
 * 1. 正反双方对同一议题独立推理（Round 0）
 * 2. 交换立场，交叉质疑 2-3 轮（Round 1~N）
 * 3. 由 arbiter 审阅所有轮次，仲裁最终结论
 */
export async function runDebatePhase(params: DebatePhaseParams): Promise<DebateSession> {
  const {
    app, pool, queue, subject, locale, authorization, traceId,
    collabRunId, taskId, topic, sideA, sideB, signal,
  } = params;
  const arbiterRole = params.arbiterRole ?? "orchestrator_arbiter";
  const maxIterationsPerRound = params.maxIterationsPerRound ?? 5;

  // 从 approval_rules 动态加载辩论配置
  const debateConfig = await loadDebateConfig(pool, subject.tenantId);

  const debateId = crypto.randomUUID();
  const session = createDebateSessionV2({
    debateId, collabRunId, topic,
    parties: [
      { partyId: sideA.agentId, role: sideA.role, stance: "pro" },
      { partyId: sideB.agentId, role: sideB.role, stance: "con" },
    ],
    arbiter: arbiterRole,
    maxRounds: params.maxRounds ?? debateConfig.maxRounds,
  });

  app.log.info({ debateId, topic, sideA: sideA.role, sideB: sideB.role, maxRounds: session.maxRounds },
    "[CollabOrchestrator] 开始辩论阶段");

  // 辩论轮次循环
  for (let round = 0; round < session.maxRounds; round++) {
    if (signal?.aborted) {
      session.status = "aborted";
      break;
    }

    // 构建本轮上下文（历史轮次的立场摘要）
    const historyContext = buildDebateHistoryContext(session);

    // 正方推理
    const sideAPosition = await runDebateAgent({
      app, pool, queue, subject, locale, authorization, traceId,
      collabRunId, taskId, debateId, round, topic,
      agent: sideA,
      opponentRole: sideB.role,
      historyContext,
      maxIterations: maxIterationsPerRound,
      signal,
    });

    // 反方推理（能看到正方本轮的立场）
    const sideBPosition = await runDebateAgent({
      app, pool, queue, subject, locale, authorization, traceId,
      collabRunId, taskId, debateId, round, topic,
      agent: sideB,
      opponentRole: sideA.role,
      opponentPosition: sideAPosition,
      historyContext,
      maxIterations: maxIterationsPerRound,
      signal,
    });

    // 检测分歧度
    const divergence = detectDivergence(sideAPosition, sideBPosition, debateConfig);
    const debateRound: DebateRound = {
      round,
      positions: [sideAPosition, sideBPosition],
      divergenceDetected: divergence,
    };
    session.rounds.push(debateRound);

    app.log.info({
      debateId, round, divergence,
      sideAConfidence: sideAPosition.confidence,
      sideBConfidence: sideBPosition.confidence,
    }, "[CollabOrchestrator] 辩论轮次完成");

    // 检查是否提前收敛
    if (isDebateConvergedV2(session)) {
      session.status = "converged";
      app.log.info({ debateId, round }, "[CollabOrchestrator] 辩论提前收敛");
      break;
    }
  }

  if (session.status === "in_progress") {
    session.status = "max_rounds_reached";
  }

  // 仲裁阶段：arbiter 审阅全部轮次并给出裁决
  if (session.status !== "aborted") {
    try {
      session.verdict = await runDebateArbiter({
        app, pool, queue, subject, locale, authorization, traceId,
        collabRunId, taskId, session, arbiterRole,
        maxIterations: maxIterationsPerRound,
        signal,
      });
      session.status = "verdicted";
    } catch (e: any) {
      app.log.warn({ err: e, debateId }, "[CollabOrchestrator] 仲裁失败（降级为 inconclusive）");
    }
  }

  // 写入 collab_envelopes 供审计回溯
  await writeDebateEnvelope({ pool, subject, collabRunId, taskId, session }).catch((e: any) =>
    app.log.warn({ err: e, debateId }, "[CollabOrchestrator] writeDebateEnvelope 失败"));

  app.log.info({
    debateId,
    status: session.status,
    rounds: session.rounds.length,
    verdict: session.verdict?.outcome,
  }, "[CollabOrchestrator] 辩论阶段结束");

  return session;
}

// ── 辩论辅助函数 ──────────────────────────────────────────────

/** 构建辩论历史上下文（供后续轮次参考，V1/V2 共享） */
export function buildDebateHistoryContext(session: DebateSession): string {
  if (session.rounds.length === 0) return "";
  const sections = session.rounds.map((r) => {
    const positionLines = r.positions.map((p) =>
      `  [${p.fromRole}] Claim: ${p.claim}\n  Reasoning: ${p.reasoning.slice(0, 300)}\n  Confidence: ${p.confidence}`,
    );
    return `### Round ${r.round}\n${positionLines.join("\n")}`;
  });
  return "\n## Debate History\n" + sections.join("\n\n");
}

/** 运行单个辩论 Agent（通过 runAgentLoop 实例） */
async function runDebateAgent(params: {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  collabRunId: string;
  taskId: string;
  debateId: string;
  round: number;
  topic: string;
  agent: { agentId: string; role: string; goal: string };
  opponentRole: string;
  opponentPosition?: DebatePosition;
  historyContext: string;
  maxIterations: number;
  signal?: AbortSignal;
}): Promise<DebatePosition> {
  const { app, pool, queue, subject, locale, authorization, traceId, collabRunId, taskId } = params;
  const { debateId, round, topic, agent, opponentRole, opponentPosition, historyContext } = params;

  // 构建辩论专用 goal
  let debateGoal = `You are Agent "${agent.role}" in a structured debate about the following topic:

## Debate Topic
${topic}

## Your Role & Perspective
${agent.goal}

## Your Task (Round ${round})
`;

  if (round === 0) {
    debateGoal += `This is the opening round. Present your initial position on the topic.
Structure your response as:
1. **Claim**: Your core conclusion
2. **Reasoning**: Step-by-step logic
3. **Evidence**: Supporting facts or tool outputs
4. **Confidence**: How certain you are (0.0~1.0)`;
  } else {
    debateGoal += `Review the opponent's position and respond with your rebuttal.
Opponent (${opponentRole}) claimed: ${opponentPosition?.claim ?? "(unavailable)"}
Opponent reasoning: ${opponentPosition?.reasoning?.slice(0, 500) ?? "(unavailable)"}

Structure your response as:
1. **Rebuttal**: What you disagree with and why
2. **Revised Claim**: Your updated position (you may adjust based on valid points)
3. **Reasoning**: Updated logic
4. **Confidence**: How certain you are (0.0~1.0)`;
  }

  if (historyContext) {
    debateGoal += "\n" + historyContext;
  }

  // 创建临时 run
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'running', now(), now())`,
    [runId, jobId, subject.tenantId],
  );
  await pool.query(
    `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
     VALUES ($1, $2, 'collab.debate', $3, $4, $5, 'debate_phase', 'running', now(), now())`,
    [jobId, subject.tenantId, runId,
     JSON.stringify({ debateId, collabRunId, round, role: agent.role }),
     subject.subjectId],
  );

  const result = await runAgentLoop({
    app, pool, queue, subject, locale, authorization, traceId,
    goal: debateGoal,
    runId, jobId, taskId,
    maxIterations: params.maxIterations,
    signal: params.signal,
  });

  // 解析 Agent 输出为 DebatePosition
  return parseDebatePosition({
    debateId, round, fromRole: agent.role,
    agentOutput: result.message ?? "",
    rebuttalTo: opponentPosition?.claim,
  });
}

/** 解析 Agent 输出为结构化 DebatePosition */
function parseDebatePosition(params: {
  debateId: string;
  round: number;
  fromRole: string;
  agentOutput: string;
  rebuttalTo?: string;
}): DebatePosition {
  const { debateId, round, fromRole, agentOutput, rebuttalTo } = params;
  const text = agentOutput || "";

  // 尝试提取结构化字段
  const claimMatch = text.match(/\*?\*?Claim\*?\*?[:：]\s*(.+?)(?=\n|$)/i)
    ?? text.match(/\*?\*?Revised Claim\*?\*?[:：]\s*(.+?)(?=\n|$)/i);
  const reasoningMatch = text.match(/\*?\*?Reasoning\*?\*?[:：]\s*([\s\S]+?)(?=\*?\*?(?:Evidence|Confidence|Rebuttal)|$)/i);
  const confidenceMatch = text.match(/\*?\*?Confidence\*?\*?[:：]\s*(\d+\.?\d*)/i);
  const evidenceMatch = text.match(/\*?\*?Evidence\*?\*?[:：]\s*([\s\S]+?)(?=\*?\*?(?:Confidence|Rebuttal)|$)/i);

  const claim = claimMatch?.[1]?.trim() || text.slice(0, 200);
  const reasoning = reasoningMatch?.[1]?.trim() || text;
  const confidence = Math.min(1, Math.max(0, parseFloat(confidenceMatch?.[1] ?? "0.5")));
  const evidence = evidenceMatch?.[1]
    ? evidenceMatch[1].split(/\n|[,，]/).map((e: string) => e.trim()).filter(Boolean)
    : [];

  return {
    debateId, round, fromRole, claim, reasoning, evidence, confidence,
    rebuttalTo,
    submittedAt: new Date().toISOString(),
  };
}

/** 检测双方立场的分歧度 */
function detectDivergence(posA: DebatePosition, posB: DebatePosition, config: DebateConfig): boolean {
  const confGap = Math.abs(posA.confidence - posB.confidence);
  if (posA.confidence >= config.minConfidence && posB.confidence >= config.minConfidence && confGap <= config.divergenceConfDiff) {
    return false;
  }
  return true;
}

/** 运行仲裁 Agent：审阅全部辩论轮次，给出最终裁决 */
async function runDebateArbiter(params: {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  collabRunId: string;
  taskId: string;
  session: DebateSession;
  arbiterRole: string;
  maxIterations: number;
  signal?: AbortSignal;
}): Promise<DebateVerdict> {
  const { app, pool, queue, subject, locale, authorization, traceId, collabRunId, taskId, session, arbiterRole } = params;

  let arbiterGoal = `You are an impartial arbiter reviewing a structured debate.

## Debate Topic
${session.topic}

## Participants
- Side A: ${session.sideA}
- Side B: ${session.sideB}

## Debate Transcript
`;

  for (const round of session.rounds) {
    arbiterGoal += `\n### Round ${round.round}\n`;
    for (const pos of round.positions) {
      arbiterGoal += `**${pos.fromRole}**:
- Claim: ${pos.claim}
- Reasoning: ${pos.reasoning.slice(0, 500)}
- Confidence: ${pos.confidence}
`;
      if (pos.rebuttalTo) {
        arbiterGoal += `- Rebuttal to: ${pos.rebuttalTo.slice(0, 200)}\n`;
      }
    }
  }

  arbiterGoal += `\n## Your Task
Render a final verdict. Evaluate each round and each side's arguments.
Respond with:
1. **Outcome**: "side_a_wins" | "side_b_wins" | "synthesis" | "inconclusive"
2. **Winner**: The winning side's role name (or "synthesis" if merging both)
3. **Reasoning**: Why this outcome
4. **Synthesized Conclusion**: The best answer combining valid points from both sides
5. **Round Scores**: For each round, score Side A and Side B from 0.0 to 1.0`;

  // 创建仲裁 run
  const runId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'running', now(), now())`,
    [runId, jobId, subject.tenantId],
  );
  await pool.query(
    `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
     VALUES ($1, $2, 'collab.debate_arbiter', $3, $4, $5, 'debate_arbiter', 'running', now(), now())`,
    [jobId, subject.tenantId, runId,
     JSON.stringify({ debateId: session.debateId, collabRunId, arbiterRole }),
     subject.subjectId],
  );

  const result = await runAgentLoop({
    app, pool, queue, subject, locale, authorization, traceId,
    goal: arbiterGoal,
    runId, jobId, taskId,
    maxIterations: params.maxIterations,
    signal: params.signal,
  });

  return parseDebateVerdict({
    debateId: session.debateId,
    arbiterRole,
    arbiterOutput: result.message ?? "",
    session,
  });
}

/** 解析仲裁 Agent 输出为结构化 DebateVerdict */
function parseDebateVerdict(params: {
  debateId: string;
  arbiterRole: string;
  arbiterOutput: string;
  session: DebateSession;
}): DebateVerdict {
  const { debateId, arbiterRole, arbiterOutput, session } = params;
  const text = arbiterOutput || "";
  const textLower = text.toLowerCase();

  let outcome: DebateVerdict["outcome"] = "inconclusive";
  if (textLower.includes("side_a_wins") || textLower.includes("正方胜")) {
    outcome = "side_a_wins";
  } else if (textLower.includes("side_b_wins") || textLower.includes("反方胜")) {
    outcome = "side_b_wins";
  } else if (textLower.includes("synthesis") || textLower.includes("综合") || textLower.includes("融合")) {
    outcome = "synthesis";
  }

  let winnerRole: string | undefined;
  if (outcome === "side_a_wins") winnerRole = session.sideA;
  else if (outcome === "side_b_wins") winnerRole = session.sideB;

  const conclusionMatch = text.match(/\*?\*?Synthesized Conclusion\*?\*?[:：]\s*([\s\S]+?)(?=\*?\*?Round Scores|$)/i);
  const synthesizedConclusion = conclusionMatch?.[1]?.trim() || text.slice(0, 500);

  const roundScores: DebateVerdict["roundScores"] = session.rounds.map((r) => {
    const scoreMatch = text.match(new RegExp(`Round\\s*${r.round}[^\\n]*?(\\d+\\.?\\d*).*?(\\d+\\.?\\d*)`, "i"));
    return {
      round: r.round,
      sideAScore: scoreMatch ? parseFloat(scoreMatch[1]!) : 0.5,
      sideBScore: scoreMatch ? parseFloat(scoreMatch[2]!) : 0.5,
    };
  });

  const reasoningMatch = text.match(/\*?\*?Reasoning\*?\*?[:：]\s*([\s\S]+?)(?=\*?\*?(?:Synthesized|Round)|$)/i);

  return {
    debateId,
    arbiterRole,
    outcome,
    winnerRole,
    reasoning: reasoningMatch?.[1]?.trim() || text.slice(0, 500),
    synthesizedConclusion,
    roundScores,
    decidedAt: new Date().toISOString(),
  };
}

/** 将辩论结果写入 collab_envelopes 供审计回溯（V1/V2 共享） */
export async function writeDebateEnvelope(params: {
  pool: Pool;
  subject: LlmSubject & { spaceId: string };
  collabRunId: string;
  taskId: string;
  session: DebateSession;
}): Promise<void> {
  const { pool, subject, collabRunId, taskId, session } = params;
  const payload = {
    debateId: session.debateId,
    topic: session.topic,
    sideA: session.sideA,
    sideB: session.sideB,
    parties: session.parties ?? [],
    corrections: session.corrections ?? [],
    consensusEvolution: session.consensusEvolution ?? [],
    rounds: session.rounds.length,
    status: session.status,
    verdict: session.verdict ? {
      outcome: session.verdict.outcome,
      winnerRole: session.verdict.winnerRole ?? session.verdict.winnerRoles?.[0] ?? null,
      winnerRoles: session.verdict.winnerRoles ?? [],
      synthesizedConclusion: session.verdict.synthesizedConclusion.slice(0, 500),
      correctionSummary: session.verdict.correctionSummary ?? "",
    } : null,
  };
  await pool.query(
    `INSERT INTO collab_envelopes
     (tenant_id, space_id, collab_run_id, task_id, from_role, to_role, broadcast, kind, payload_digest)
     VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9)`,
    [subject.tenantId, subject.spaceId, collabRunId, taskId,
     "debate_phase", null, true, "debate.verdict", JSON.stringify(payload)],
  );
}

// ── 旧代码已拆分到独立模块，见文件头注释 ───────────────────
// EOF — 以下为空（persist*、runDebateIfDivergent、runDebatePhaseV2 已迁移）

