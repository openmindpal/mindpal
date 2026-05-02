/**
 * collabDebate.ts — N方辩论 + 动态纠错 + 共识演化 (v2)
 *
 * 辩论共享辅助函数 + N方辩论执行引擎。
 * (原 collabDebate.ts 辅助函数已合并于此)
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { invokeModelChat, type LlmSubject } from "../lib/llm";
import { runAgentLoop } from "./agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";
import {
  createDebateSession, isDebateConverged, computeDebateConsensusScore,
  type DebateSession, type DebatePosition, type DebateRound,
  type DebateVerdict, type DebateParty, type DebateCorrection,
  type ConsensusEvolutionEntry,
  type DebateConfig, DEBATE_CONFIG_DEFAULTS,
} from "@mindpal/shared";
import type { DebateV2PhaseParams } from "./collabTypes";
import { loadApprovalRules } from "./approvalRuleEngine";
import { StructuredLogger } from "@mindpal/shared";

const _debateLogger = new StructuredLogger({ module: "collabDebate" });

// ── 辩论最大轮次硬限制（元数据驱动，环境变量 > 默认值） ──────────
const MAX_DEBATE_ROUNDS = parseInt(process.env.COLLAB_MAX_DEBATE_ROUNDS ?? "5", 10);
// ── 连续无新观点轮次阈值 ─────────────────────────────────────
const STALE_ROUNDS_THRESHOLD = parseInt(process.env.COLLAB_DEBATE_STALE_ROUNDS ?? "2", 10);

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

// ── 辩论辅助函数 ──────────────────────────────────────────────

/** 构建辩论历史上下文（供后续轮次参考） */
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

/** 将辩论结果写入 collab_envelopes 供审计回溯 */
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
    parties: session.parties,
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

// ── N方辩论主入口 ──────────────────────────────────────────

export async function runDebatePhaseV2(params: DebateV2PhaseParams): Promise<DebateSession> {
  const {
    app, pool, queue, subject, locale, authorization, traceId,
    collabRunId, taskId, topic, parties, signal,
  } = params;
  const arbiterRole = params.arbiterRole ?? "orchestrator_arbiter";
  const maxIterationsPerRound = params.maxIterationsPerRound ?? 5;

  // 从 approval_rules 动态加载辩论配置
  const debateConfig = await loadDebateConfig(pool, subject.tenantId);

  const enableCorrection = params.enableCorrection ?? debateConfig.allowCorrections;
  const consensusThreshold = params.consensusThreshold ?? debateConfig.convergenceThreshold;

  const debateId = crypto.randomUUID();
  const session = createDebateSession({
    debateId, collabRunId, topic,
    parties: parties.map(p => ({ partyId: p.agentId, role: p.role, stance: p.stance, budget: p.budget })),
    maxRounds: params.maxRounds ?? debateConfig.maxRounds,
  });

  app.log.info({
    debateId, topic, partyCount: parties.length, maxRounds: session.maxRounds,
    effectiveMaxRounds: Math.min(session.maxRounds, MAX_DEBATE_ROUNDS),
    parties: parties.map(p => p.role),
  }, "[CollabOrchestrator] 开始 N方辩论 (v2)");

  // 收敛性保证：观点变化率跟踪
  const seenOpinionHashes = new Set<string>();
  let staleRoundsCount = 0;
  const effectiveMaxRounds = Math.min(session.maxRounds, MAX_DEBATE_ROUNDS);

  for (let round = 0; round < effectiveMaxRounds; round++) {
    if (signal?.aborted) { session.status = "aborted"; break; }

    const historyContext = buildDebateHistoryContext(session);
    const roundPositions: DebatePosition[] = [];
    const activeParties = session.parties.filter((p: DebateParty) => p.status === "active");

    for (let i = 0; i < activeParties.length; i++) {
      if (signal?.aborted) break;
      const party = activeParties[i]!;
      const agent = parties.find(p => p.agentId === party.partyId);
      if (!agent) continue;

      // Round 0: 各方独立推理，不传入前序方立场，避免顺序偏见
      // Round 1+: 交叉质询，可看到同轮已发言方的立场
      const predecessorPositions = round === 0
        ? []
        : roundPositions.map(p => ({
            role: p.fromRole, claim: p.claim, confidence: p.confidence,
          }));

      const position = await runDebateAgentV2({
        app, pool, queue, subject, locale, authorization, traceId,
        collabRunId, taskId, debateId, round, topic,
        agent, party, predecessorPositions, historyContext,
        corrections: session.corrections ?? [],
        maxIterations: maxIterationsPerRound,
        signal,
      });

      roundPositions.push(position);
      party.currentConfidence = position.confidence;

      // 将该方的 pending 纠错标记为 accepted（已在本轮接收并处理）
      for (const c of session.corrections ?? []) {
        if (c.targetRole === party.role && c.status === "pending") {
          c.status = "accepted";
        }
      }
    }

    const divergence = detectNPartyDivergence(roundPositions, debateConfig);
    const debateRound: DebateRound = { round, positions: roundPositions, divergenceDetected: divergence };
    session.rounds.push(debateRound);

    if (enableCorrection && roundPositions.length >= 2) {
      const corrections = await detectAndApplyCorrections({
        app, pool, subject, locale, authorization, traceId,
        debateId, round, positions: roundPositions,
      });
      if (corrections.length > 0) {
        if (!session.corrections) session.corrections = [];
        session.corrections.push(...corrections);
      }
    }

    const consensusEntry = computeConsensusEvolution(session, round, debateConfig);
    if (!session.consensusEvolution) session.consensusEvolution = [];
    session.consensusEvolution.push(consensusEntry);

    // ── 观点变化率检测：跟踪观点摘要 hash ──
    const roundHash = roundPositions
      .map(p => `${p.fromRole}:${p.claim.slice(0, 100).trim().toLowerCase()}`)
      .sort()
      .join("|");
    const opinionHash = simpleHash(roundHash);
    const prevSize = seenOpinionHashes.size;
    seenOpinionHashes.add(opinionHash);
    if (seenOpinionHashes.size === prevSize) {
      staleRoundsCount++;
    } else {
      staleRoundsCount = 0;
    }

    // ── 提前终止：连续无新观点 ──
    if (staleRoundsCount >= STALE_ROUNDS_THRESHOLD) {
      _debateLogger.info("debate early termination: stale opinions", {
        debateId, round, staleRoundsCount, totalRounds: round + 1,
        uniqueOpinions: seenOpinionHashes.size,
      });
      session.status = "converged";
      break;
    }

    if (isDebateConverged(session, debateConfig.minConfidence, consensusThreshold)) {
      session.status = "converged";
      break;
    }
  }

  // ── 强制终止：达到最大轮次时采用多数意见（投票机制） ──
  if (session.status === "in_progress") {
    session.status = "max_rounds_reached";
    _debateLogger.info("debate forced termination: max rounds", {
      debateId,
      roundsCompleted: session.rounds.length,
      effectiveMaxRounds,
      uniqueOpinions: seenOpinionHashes.size,
      finalConsensusScore: computeDebateConsensusScore(session),
      decisionMethod: "majority_vote",
    });
  }

  if (session.status !== "aborted") {
    try {
      session.verdict = await runDebateArbiterV2({
        app, pool, queue, subject, locale, authorization, traceId,
        collabRunId, taskId, session, arbiterRole,
        maxIterations: maxIterationsPerRound, signal,
      });
      session.status = "verdicted";
    } catch (e: any) {
      app.log.warn({ err: e, debateId }, "[CollabOrchestrator] N方仲裁失败");
    }
  }

  await writeDebateEnvelope({ pool, subject, collabRunId, taskId, session }).catch((e: unknown) => {
    app.log.warn({ err: (e as Error)?.message, collabRunId, taskId }, "[CollabDebateV2] writeDebateEnvelope failed");
  });
  return session;
}

// ── V2 辅助函数 ──────────────────────────────────────────

/** 简单字符串 hash（用于观点变化率检测，非加密用途） */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0; // 32-bit integer
  }
  return hash.toString(36);
}

async function runDebateAgentV2(params: {
  app: FastifyInstance; pool: Pool; queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string; authorization: string | null; traceId: string | null;
  collabRunId: string; taskId: string; debateId: string; round: number; topic: string;
  agent: { agentId: string; role: string; goal: string; stance: string };
  party: DebateParty;
  predecessorPositions: Array<{ role: string; claim: string; confidence: number }>;
  historyContext: string; corrections: DebateCorrection[];
  maxIterations: number; signal?: AbortSignal;
}): Promise<DebatePosition> {
  const { app, pool, queue, subject, locale, authorization, traceId, collabRunId, taskId } = params;
  const { debateId, round, topic, agent, predecessorPositions, historyContext, corrections } = params;

  let debateGoal = `You are Agent "${agent.role}" (stance: ${agent.stance}) in a multi-party debate.

## Debate Topic
${topic}

## Your Role & Perspective
${agent.goal}

## Your Task (Round ${round})
`;

  if (round === 0) {
    debateGoal += `This is the opening round. Present your initial position.
Structure your response as JSON:
{"claim": "...", "reasoning": "...", "evidence": [...], "confidence": 0.0~1.0}`;
  } else {
    debateGoal += `Review other parties' positions and respond.\n`;
    for (const pp of predecessorPositions) {
      debateGoal += `  - ${pp.role}: "${pp.claim}" (confidence: ${pp.confidence})\n`;
    }
    debateGoal += `\nRespond as JSON: {"claim": "...", "reasoning": "...", "evidence": [...], "confidence": 0.0~1.0}`;
  }

  const myCorrectionsList = corrections.filter(c => c.targetRole === agent.role && (c.status === "accepted" || c.status === "pending"));
  if (myCorrectionsList.length > 0) {
    debateGoal += `\n\n## Corrections Applied to You:\n`;
    for (const c of myCorrectionsList) {
      debateGoal += `- [${c.correctionType}] ${c.correctionReason} → Suggested: ${c.suggestedCorrection}\n`;
    }
  }
  debateGoal += historyContext;

  const debateRunId = crypto.randomUUID();
  const debateJobId = crypto.randomUUID();

  // 写入 runs/jobs 表，确保辩论 Agent 运行可追溯（与 v1 runDebateAgent 对齐）
  await pool.query(
    `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'running', now(), now())`,
    [debateRunId, debateJobId, subject.tenantId],
  );
  await pool.query(
    `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
     VALUES ($1, $2, 'collab.debate_v2', $3, $4, $5, 'debate_phase_v2', 'running', now(), now())`,
    [debateJobId, subject.tenantId, debateRunId,
     JSON.stringify({ debateId, collabRunId, round, role: agent.role, stance: agent.stance }),
     subject.subjectId],
  );

  try {
    const result = await runAgentLoop({
      app, pool, queue, subject, locale, authorization, traceId,
      taskId, runId: debateRunId, jobId: debateJobId,
      goal: debateGoal, maxIterations: params.maxIterations, signal: params.signal,
    });

    const text = result.message ?? "";
    let claim = text.slice(0, 500);
    let reasoning = "";
    let evidence: string[] = [];
    let confidence = 0.5;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        claim = String(parsed.claim ?? claim);
        reasoning = String(parsed.reasoning ?? "");
        evidence = Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [];
        confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5)));
      }
    } catch { /* 解析失败 */ }

    return { debateId, round, fromRole: agent.role, claim, reasoning, evidence, confidence, submittedAt: new Date().toISOString() };
  } catch (err: any) {
    return { debateId, round, fromRole: agent.role, claim: "(执行失败)", reasoning: err?.message ?? "unknown", evidence: [], confidence: 0, submittedAt: new Date().toISOString() };
  }
}

function detectNPartyDivergence(positions: DebatePosition[], config: DebateConfig): boolean {
  if (positions.length <= 1) return false;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (Math.abs(positions[i]!.confidence - positions[j]!.confidence) > config.divergenceConfDiff * 2.5) return true;
    }
  }
  return positions.reduce((s, p) => s + p.confidence, 0) / positions.length < config.minConfidence;
}

async function detectAndApplyCorrections(params: {
  app: FastifyInstance; pool: Pool;
  subject: LlmSubject & { spaceId: string };
  locale: string; authorization: string | null; traceId: string | null;
  debateId: string; round: number; positions: DebatePosition[];
}): Promise<DebateCorrection[]> {
  const { app, debateId, round, positions } = params;
  const corrections: DebateCorrection[] = [];
  try {
    const positionSummary = positions.map(p =>
      `[${p.fromRole}] Claim: ${p.claim}\nReasoning: ${p.reasoning.slice(0, 300)}`
    ).join("\n\n");

    const result = await invokeModelChat({
      app: params.app, subject: params.subject, locale: params.locale,
      purpose: "debate_correction_detection",
      authorization: params.authorization, traceId: params.traceId,
      messages: [
        { role: "system", content: `你是一个严谨的事实核查和逻辑审查专家。检查以下多方辩论立场，识别任何:
1. 事实错误 (factual_error)
2. 逻辑谬误 (logical_fallacy)
3. 证据冲突 (evidence_conflict)
4. 幻觉内容 (hallucination)
5. 偏见检测 (bias_detected)

如果发现错误，返回 JSON 数组:
[{"targetRole": "...", "correctionType": "...", "originalClaim": "...", "reason": "...", "suggestion": "..."}]
如果没有错误，返回空数组: []` },
        { role: "user", content: positionSummary },
      ],
    });

    try {
      const text = result?.outputText ?? "";
      const jsonMatch = text.match(/\[.*\]/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item?.targetRole && item?.correctionType) {
              corrections.push({
                correctionId: crypto.randomUUID(),
                triggeredAtRound: round,
                correctionType: item.correctionType,
                targetRole: item.targetRole,
                correctedBy: "arbiter_auto",
                originalClaim: String(item.originalClaim ?? ""),
                correctionReason: String(item.reason ?? ""),
                suggestedCorrection: String(item.suggestion ?? ""),
                status: "pending",  // 纠错初始状态为 pending，待被纠错方在下一轮确认
                evidence: [],
                createdAt: new Date().toISOString(),
              });
            }
          }
        }
      }
    } catch { /* JSON 解析失败 */ }
  } catch (err: any) {
    app.log.warn({ err: err?.message, debateId, round }, "[CollabOrchestrator] 纠错检测 LLM 调用失败");
  }
  return corrections;
}

function computeConsensusEvolution(session: DebateSession, round: number, config: DebateConfig): ConsensusEvolutionEntry {
  const lastRound = session.rounds[session.rounds.length - 1];
  const positions = lastRound?.positions ?? [];
  const partyPositions: Record<string, { claim: string; confidence: number }> = {};
  for (const p of positions) {
    partyPositions[p.fromRole] = { claim: p.claim.slice(0, 200), confidence: p.confidence };
  }
  const consensusScore = computeDebateConsensusScore(session);
  let consensusState: ConsensusEvolutionEntry["consensusState"] = "no_consensus";
  if (consensusScore >= config.convergenceThreshold) consensusState = "full_consensus";
  else if (consensusScore >= config.minConfidence) consensusState = "majority_consensus";
  else if (consensusScore >= config.minConfidence * 0.5) consensusState = "partial_consensus";
  return {
    step: (session.consensusEvolution?.length ?? 0) + 1, atRound: round, consensusState,
    partyPositions, agreedPoints: [],
    divergentPoints: lastRound?.divergenceDetected ? ["存在分歧"] : [],
    consensusScore,
    evolutionNote: `Round ${round}: ${consensusState} (score=${consensusScore.toFixed(2)})`,
    recordedAt: new Date().toISOString(),
  };
}

async function runDebateArbiterV2(params: {
  app: FastifyInstance; pool: Pool; queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string; authorization: string | null; traceId: string | null;
  collabRunId: string; taskId: string; session: DebateSession;
  arbiterRole: string; maxIterations: number; signal?: AbortSignal;
}): Promise<DebateVerdict> {
  const { app, session, arbiterRole } = params;

  const partySummaries = session.parties.map(p => {
    const lastPos = session.rounds[session.rounds.length - 1]?.positions.find(pos => pos.fromRole === p.role);
    return `[${p.role}] (stance: ${p.stance}) Claim: ${lastPos?.claim ?? "N/A"} | Confidence: ${lastPos?.confidence ?? 0}`;
  }).join("\n");

  const correctionsSummary = (session.corrections ?? []).map(c =>
    `[${c.correctionType}] ${c.targetRole}: ${c.correctionReason}`
  ).join("\n");

  const arbiterGoal = `You are the arbiter in a multi-party debate (${session.parties.length} parties).

## Topic: ${session.topic}
## Party Final Positions:
${partySummaries}

## Corrections Applied:
${correctionsSummary || "None"}

## Consensus Evolution:
Final consensus score: ${computeDebateConsensusScore(session).toFixed(2)}

Provide your verdict as JSON:
{
  "outcome": "multi_synthesis" | "partial_consensus" | "side_a_wins" | "side_b_wins" | "inconclusive",
  "winnerRoles": [...],
  "reasoning": "...",
  "synthesizedConclusion": "...",
  "correctionSummary": "..."
}`;

  const result = await invokeModelChat({
    app: params.app, subject: params.subject, locale: params.locale,
    purpose: "debate_v2_arbiter", authorization: params.authorization,
    traceId: params.traceId,
    messages: [{ role: "user", content: arbiterGoal }],
  });

  const text = result?.outputText ?? "";
  let verdict: DebateVerdict = {
    debateId: session.debateId, arbiterRole, outcome: "inconclusive",
    reasoning: text.slice(0, 2000), synthesizedConclusion: "",
    roundScores: session.rounds.map((r, i) => ({
      round: i, sideAScore: r.positions[0]?.confidence ?? 0, sideBScore: r.positions[1]?.confidence ?? 0,
      partyScores: Object.fromEntries(r.positions.map(p => [p.fromRole, p.confidence])),
    })),
    decidedAt: new Date().toISOString(),
  };

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      verdict.outcome = parsed.outcome ?? "inconclusive";
      verdict.winnerRoles = Array.isArray(parsed.winnerRoles) ? parsed.winnerRoles : undefined;
      verdict.reasoning = String(parsed.reasoning ?? verdict.reasoning);
      verdict.synthesizedConclusion = String(parsed.synthesizedConclusion ?? "");
      verdict.correctionSummary = String(parsed.correctionSummary ?? "");
    }
  } catch { /* 解析失败 */ }

  return verdict;
}
