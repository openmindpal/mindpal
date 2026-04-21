/**
 * Verifier Agent — 独立目标满足性校验层
 *
 * 在 Agent Loop 的 LLM 判定 "done" 后，独立执行目标满足性校验：
 * 1. 对比 GoalGraph.successCriteria 与当前 WorldState
 * 2. 调用 LLM 做结构化验证（而非信任决策 LLM 的自我报告）
 * 3. 输出 verified / rejected / needs_more_info
 *
 * 关键设计：
 * - Verifier 使用独立的 LLM 调用（不同 purpose），避免自我验证偏差
 * - 支持环境变量开关（AGENT_LOOP_VERIFIER=0 禁用）
 * - rejected 时返回具体的未满足标准 + 建议的修复方向
 */
import type { FastifyInstance } from "fastify";
import type {
  GoalGraph, WorldState, SuccessCriterion,
} from "@openslin/shared";
import {
  worldStateToPromptText, getValidFacts, computeGoalProgress,
} from "@openslin/shared";
import type { SubGoal, CompletionEvidence } from "@openslin/shared";
import { invokeModelChat, type LlmSubject } from "../lib/llm";
import type { StepObservation } from "./agentLoop";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type VerificationVerdict = "verified" | "rejected" | "needs_more_info";

export interface VerificationResult {
  /** 验证结论 */
  verdict: VerificationVerdict;
  /** 置信度（0-1） */
  confidence: number;
  /** 验证推理说明 */
  reasoning: string;
  /** 各成功标准的评估结果 */
  criteriaResults: Array<{
    criterionId: string;
    description: string;
    met: boolean;
    evidence?: string;
    reason?: string;
  }>;
  /** rejected 时：建议的修复方向 */
  suggestedFixes?: string[];
  /** needs_more_info 时：需要收集的额外信息 */
  missingInfo?: string[];
  /** 验证使用的模型 */
  verifiedByModel?: string;
}

export interface VerifyParams {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** 目标图 */
  goalGraph: GoalGraph;
  /** 当前世界状态 */
  worldState: WorldState;
  /** 所有步骤观察 */
  observations: StepObservation[];
  /** LLM 给出的完成摘要（来自 decision.summary） */
  completionSummary: string;
  /** 默认模型引用 */
  defaultModelRef?: string;
}

/* ================================================================== */
/*  Verifier 核心逻辑                                                   */
/* ================================================================== */

/**
 * 执行目标满足性验证
 *
 * 流程：
 * 1. 预检：规则检查（快速路径，无需 LLM）
 * 2. LLM 验证：构建 Verifier prompt，调用独立 LLM 做结构化校验
 * 3. 解析验证结果
 */
export async function verifyGoalCompletion(params: VerifyParams): Promise<VerificationResult> {
  const {
    app, subject, locale, authorization, traceId,
    goalGraph, worldState, observations, completionSummary, defaultModelRef,
  } = params;

  // 环境变量开关
  if ((process.env.AGENT_LOOP_VERIFIER ?? "1") === "0") {
    return {
      verdict: "verified",
      confidence: 1.0,
      reasoning: "Verifier disabled by environment variable",
      criteriaResults: [],
    };
  }

  // ── 阶段 1: 规则预检（快速路径） ──
  const precheck = ruleBasedPreCheck(goalGraph, worldState, observations);
  if (precheck) return precheck;

  // ── 阶段 2: LLM 验证 ──
  try {
    const systemPrompt = buildVerifierSystemPrompt();
    const userPrompt = buildVerifierUserPrompt({
      goalGraph, worldState, observations, completionSummary,
    });

    const llmResult = await invokeModelChat({
      app,
      subject,
      locale,
      authorization,
      traceId,
      purpose: "agent.loop.verify", // 独立 purpose，不同于决策 LLM
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
    });

    const result = parseVerifierOutput(llmResult.outputText ?? "", goalGraph);
    result.verifiedByModel = (llmResult as any).modelRef ?? defaultModelRef ?? undefined;
    return result;
  } catch (err: any) {
    app.log.warn({ err: err?.message, runId: goalGraph.runId }, "[Verifier] LLM 验证失败，降级为 verified");
    // LLM 失败时不阻塞流程，降级为 verified
    return {
      verdict: "verified",
      confidence: 0.5,
      reasoning: `Verifier LLM call failed (${err?.message}), defaulting to verified`,
      criteriaResults: [],
    };
  }
}

/* ================================================================== */
/*  规则预检（零 LLM 调用的快速路径）                                     */
/* ================================================================== */

/**
 * 基于规则的快速预检
 * 返回 null 表示需要 LLM 验证；返回 VerificationResult 表示可直接判定
 */
function ruleBasedPreCheck(
  goalGraph: GoalGraph,
  worldState: WorldState,
  observations: StepObservation[],
): VerificationResult | null {
  // 无子目标（单节点降级模式）且有成功步骤 → 快速通过
  if (
    goalGraph.subGoals.length <= 1 &&
    observations.some((o) => o.status === "succeeded") &&
    observations.length <= 2
  ) {
    return {
      verdict: "verified",
      confidence: 0.8,
      reasoning: "Simple single-step goal with successful execution (rule-based fast path)",
      criteriaResults: goalGraph.globalSuccessCriteria.map((sc) => ({
        criterionId: sc.criterionId,
        description: sc.description,
        met: true,
        reason: "Single successful step for simple goal",
      })),
    };
  }

  // 所有步骤都失败 → 直接 reject
  if (observations.length > 0 && observations.every((o) => o.status !== "succeeded")) {
    return {
      verdict: "rejected",
      confidence: 0.95,
      reasoning: "All steps failed — goal cannot be considered complete",
      criteriaResults: goalGraph.globalSuccessCriteria.map((sc) => ({
        criterionId: sc.criterionId,
        description: sc.description,
        met: false,
        reason: "No successful steps executed",
      })),
      suggestedFixes: ["Retry failed steps with different parameters", "Try alternative tools"],
    };
  }

  // 需要 LLM 验证
  return null;
}

/* ================================================================== */
/*  Verifier Prompt 构建                                                */
/* ================================================================== */

function buildVerifierSystemPrompt(): string {
  return `You are an independent Goal Verification Agent. Your role is to verify whether a task has been truly completed, without bias from the executing agent's self-report.

## Verification Protocol
You MUST independently assess each success criterion against the actual evidence (WorldState and step outputs).

Respond with EXACTLY ONE JSON block:

\`\`\`verification_result
{
  "verdict": "verified" | "rejected" | "needs_more_info",
  "confidence": 0.0-1.0,
  "reasoning": "Detailed explanation of your verification",
  "criteriaResults": [
    {
      "criterionId": "...",
      "description": "...",
      "met": true|false,
      "evidence": "What evidence supports this",
      "reason": "Why this criterion is/isn't met"
    }
  ],
  "suggestedFixes": ["(only for rejected) specific fix suggestions"],
  "missingInfo": ["(only for needs_more_info) what info is missing"]
}
\`\`\`

## Verification Rules
- NEVER trust the executing agent's "done" claim at face value
- Check EACH success criterion against ACTUAL tool outputs and WorldState
- "verified" = ALL required criteria are met with clear evidence
- "rejected" = ANY required criterion is NOT met
- "needs_more_info" = Cannot determine without additional information
- Be skeptical but fair — look for concrete evidence, not assumptions
- confidence < 0.6 → consider "needs_more_info"`;
}

function buildVerifierUserPrompt(params: {
  goalGraph: GoalGraph;
  worldState: WorldState;
  observations: StepObservation[];
  completionSummary: string;
}): string {
  const { goalGraph, worldState, observations, completionSummary } = params;

  let prompt = `## Original Goal\n${goalGraph.mainGoal}\n`;

  // 目标图信息
  if (goalGraph.subGoals.length > 0) {
    prompt += `\n## Sub-Goals (${goalGraph.subGoals.length})\n`;
    for (const sg of goalGraph.subGoals) {
      const statusIcon = sg.status === "completed" ? "✅"
        : sg.status === "failed" ? "❌"
        : sg.status === "in_progress" ? "🔄"
        : "⏳";
      prompt += `${statusIcon} [${sg.goalId}] ${sg.description} (${sg.status})\n`;
    }
  }

  // 成功标准
  const allCriteria = [
    ...goalGraph.globalSuccessCriteria,
    ...goalGraph.subGoals.flatMap((sg) => sg.successCriteria),
  ];
  if (allCriteria.length > 0) {
    prompt += `\n## Success Criteria to Verify (${allCriteria.length})\n`;
    for (const sc of allCriteria) {
      prompt += `- [${sc.criterionId}] ${sc.description} (weight: ${sc.weight}, required: ${sc.required})\n`;
    }
  }

  // 世界状态摘要
  const worldText = worldStateToPromptText(worldState, 1500);
  if (worldText) {
    prompt += `\n${worldText}\n`;
  }

  // 步骤执行记录
  prompt += `\n## Execution History (${observations.length} steps)\n`;
  for (const obs of observations.slice(-10)) { // 最近 10 步
    const statusIcon = obs.status === "succeeded" ? "✅" : obs.status === "failed" ? "❌" : "⏳";
    const outputSummary = obs.output
      ? JSON.stringify(obs.output).slice(0, 300)
      : obs.outputDigest
      ? JSON.stringify(obs.outputDigest).slice(0, 300)
      : "(no output)";
    prompt += `${statusIcon} Step ${obs.seq}: ${obs.toolRef} → ${obs.status}\n   Output: ${outputSummary}\n`;
  }

  // 执行 Agent 的完成声明
  prompt += `\n## Executing Agent's Completion Claim\n"${completionSummary}"\n`;

  // 进度信息
  const progress = computeGoalProgress(goalGraph);
  prompt += `\n## Progress: ${Math.round(progress * 100)}%\n`;

  prompt += `\nBased on ALL the above evidence, verify whether the goal is truly achieved.`;

  return prompt;
}

/* ================================================================== */
/*  解析 Verifier 输出                                                  */
/* ================================================================== */

function parseVerifierOutput(output: string, goalGraph: GoalGraph): VerificationResult {
  const blockMatch = output.match(/```verification_result\s*\n?([\s\S]*?)```/);
  const jsonStr = blockMatch ? blockMatch[1].trim() : output.trim();

  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // 解析失败降级
    return {
      verdict: "verified",
      confidence: 0.4,
      reasoning: "Verifier output could not be parsed, defaulting to verified with low confidence",
      criteriaResults: [],
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    const verdict: VerificationVerdict =
      (["verified", "rejected", "needs_more_info"] as const).includes(parsed.verdict)
        ? parsed.verdict
        : "verified";

    const criteriaResults: VerificationResult["criteriaResults"] = Array.isArray(parsed.criteriaResults)
      ? parsed.criteriaResults.map((cr: any) => ({
          criterionId: String(cr.criterionId ?? ""),
          description: String(cr.description ?? ""),
          met: Boolean(cr.met),
          evidence: typeof cr.evidence === "string" ? cr.evidence : undefined,
          reason: typeof cr.reason === "string" ? cr.reason : undefined,
        }))
      : [];

    return {
      verdict,
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7,
      reasoning: String(parsed.reasoning ?? ""),
      criteriaResults,
      suggestedFixes: Array.isArray(parsed.suggestedFixes) ? parsed.suggestedFixes.map(String) : undefined,
      missingInfo: Array.isArray(parsed.missingInfo) ? parsed.missingInfo.map(String) : undefined,
    };
  } catch {
    return {
      verdict: "verified",
      confidence: 0.4,
      reasoning: "Verifier JSON parse failed, defaulting to verified with low confidence",
      criteriaResults: [],
    };
  }
}

/* ================================================================== */
/*  快速验证（无 GoalGraph 时的简化版本）                                 */
/* ================================================================== */

/**
 * 简化版验证器：当 GoalGraph 不可用时使用
 * 基于原始 goal string + observations 做基本验证
 */
export async function verifySimple(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  goal: string;
  observations: StepObservation[];
  completionSummary: string;
  defaultModelRef?: string;
}): Promise<VerificationResult> {
  const {
    app, subject, locale, authorization, traceId,
    goal, observations, completionSummary, defaultModelRef,
  } = params;

  // 环境变量开关
  if ((process.env.AGENT_LOOP_VERIFIER ?? "1") === "0") {
    return {
      verdict: "verified",
      confidence: 1.0,
      reasoning: "Verifier disabled",
      criteriaResults: [],
    };
  }

  // 简单规则：所有步骤都失败 → reject
  if (observations.length > 0 && observations.every((o) => o.status !== "succeeded")) {
    return {
      verdict: "rejected",
      confidence: 0.95,
      reasoning: "No successful steps — cannot be done",
      criteriaResults: [],
      suggestedFixes: ["Retry with different approach"],
    };
  }

  // 简单规则：只有 1-2 步都成功 → 快速通过
  if (observations.length <= 2 && observations.some((o) => o.status === "succeeded")) {
    return {
      verdict: "verified",
      confidence: 0.8,
      reasoning: "Simple task with successful execution",
      criteriaResults: [],
    };
  }

  // LLM 验证
  try {
    const systemPrompt = buildVerifierSystemPrompt();
    let userPrompt = `## Original Goal
${goal}

## Execution History (${observations.length} steps)
`;
    for (const obs of observations.slice(-8)) {
      const statusIcon = obs.status === "succeeded" ? "✅" : "❌";
      const outputSummary = JSON.stringify(obs.output ?? obs.outputDigest ?? {}).slice(0, 300);
      userPrompt += `${statusIcon} Step ${obs.seq}: ${obs.toolRef} → ${obs.status}\n   Output: ${outputSummary}\n`;
    }
    userPrompt += `\n## Agent's Claim: "${completionSummary}"\n\nVerify whether the goal is truly achieved.`;

    const llmResult = await invokeModelChat({
      app, subject, locale, authorization, traceId,
      purpose: "agent.loop.verify",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
    });

    // 构建一个虚拟 GoalGraph 用于解析
    const fakeGraph: GoalGraph = {
      graphId: "", runId: "", mainGoal: goal, subGoals: [],
      globalPreconditions: [], globalSuccessCriteria: [], globalCompletionEvidence: [],
      status: "executing", version: 1, createdAt: "", updatedAt: "",
    };

    const result = parseVerifierOutput(llmResult.outputText ?? "", fakeGraph);
    result.verifiedByModel = (llmResult as any).modelRef ?? defaultModelRef ?? undefined;
    return result;
  } catch (err: any) {
    app.log.warn({ err: err?.message }, "[Verifier] Simple verification LLM failed");
    return {
      verdict: "verified",
      confidence: 0.5,
      reasoning: `Verifier LLM failed (${err?.message})`,
      criteriaResults: [],
    };
  }
}

/* ================================================================== */
/*  verifyStepResult — 单步验证代理                                     */
/* ================================================================== */

/** 单步验证结果 */
export interface StepVerificationResult {
  /** 是否通过 */
  passed: boolean;
  /** 支撑证据 */
  evidence: string[];
  /** 未满足的标准 */
  failedCriteria: string[];
  /** 对应的目标节点 ID（如果匹配到） */
  matchedGoalId?: string;
}

/**
 * 单步验证：对比步骤执行结果与 GoalGraph 中当前目标节点的 successCriteria
 *
 * 在 Agent Loop 的 Act 阶段完成后自动调用：
 * - 验证通过 → 标记目标节点完成
 * - 验证失败 → 由主循环决定是否重试或上报
 */
export function verifyStepResult(params: {
  observation: StepObservation;
  goalGraph: GoalGraph;
  worldState: WorldState;
}): StepVerificationResult {
  const { observation, goalGraph, worldState } = params;
  const now = new Date().toISOString();

  // 1. 查找与当前步骤匹配的 in_progress 目标节点
  //    匹配策略：正在执行的目标节点 + 工具引用匹配
  const matchedGoal = goalGraph.subGoals.find((g) => {
    if (g.status !== "in_progress") return false;
    // 工具引用匹配
    if (g.suggestedToolRefs?.some(t => observation.toolRef.startsWith(t.split("@")[0]))) return true;
    // 已执行步骤匹配
    if (g.executedStepSeqs?.includes(observation.seq)) return true;
    return false;
  }) ?? goalGraph.subGoals.find(g => g.status === "in_progress");

  if (!matchedGoal) {
    // 无匹配目标节点 → 步骤成功即通过
    return {
      passed: observation.status === "succeeded",
      evidence: [observation.status === "succeeded" ? "Step succeeded (no goal binding)" : `Step failed: ${observation.errorCategory ?? "unknown"}`],
      failedCriteria: observation.status !== "succeeded" ? ["step_execution_failed"] : [],
    };
  }

  // 2. 对比 successCriteria
  const evidence: string[] = [];
  const failedCriteria: string[] = [];

  if (observation.status !== "succeeded") {
    failedCriteria.push("step_execution_failed");
    evidence.push(`Step ${observation.seq} (${observation.toolRef}) failed: ${observation.errorCategory ?? "unknown"}`);
    return { passed: false, evidence, failedCriteria, matchedGoalId: matchedGoal.goalId };
  }

  evidence.push(`Step ${observation.seq} (${observation.toolRef}) succeeded`);

  for (const criterion of matchedGoal.successCriteria) {
    if (criterion.met) {
      evidence.push(`Criterion "${criterion.description}" already met`);
      continue;
    }

    // 检查 WorldState 中是否有支撑证据
    const validFacts = getValidFacts(worldState);
    const keywords = criterion.description.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
    const hasEvidence = validFacts.some(f => {
      const fl = f.statement.toLowerCase();
      return keywords.some((kw: string) => fl.includes(kw)) && fl.includes("succeeded");
    });

    if (hasEvidence || (criterion.evidenceRef && validFacts.some(f => f.factId === criterion.evidenceRef))) {
      evidence.push(`Criterion "${criterion.description}" satisfied by WorldState evidence`);
    } else if (criterion.required) {
      failedCriteria.push(criterion.description);
    }
  }

  const passed = failedCriteria.length === 0;
  return { passed, evidence, failedCriteria, matchedGoalId: matchedGoal.goalId };
}

/**
 * 将步骤验证结果应用到 GoalGraph：通过时标记节点完成，失败时标记 failed
 */
export function applyStepVerification(
  goalGraph: GoalGraph,
  verification: StepVerificationResult,
  observation: StepObservation,
): GoalGraph {
  if (!verification.matchedGoalId) return goalGraph;

  const now = new Date().toISOString();
  const updatedGoals = goalGraph.subGoals.map((g) => {
    if (g.goalId !== verification.matchedGoalId) return g;

    if (verification.passed) {
      // 标记完成 + 收集证据
      const newEvidence: CompletionEvidence = {
        evidenceId: `ev:${observation.stepId ?? observation.seq}`,
        type: "tool_output",
        sourceRef: observation.stepId ?? String(observation.seq),
        summary: verification.evidence.join("; "),
        collectedAt: now,
      };
      return {
        ...g,
        status: "completed" as const,
        completionEvidence: [...g.completionEvidence, newEvidence],
        executedStepSeqs: [...(g.executedStepSeqs ?? []), observation.seq],
        updatedAt: now,
      };
    } else {
      // 累计失败信息，不立即标记 failed（留给主循环决定是否重试）
      return {
        ...g,
        executedStepSeqs: [...(g.executedStepSeqs ?? []), observation.seq],
        updatedAt: now,
      };
    }
  });

  return { ...goalGraph, subGoals: updatedGoals, updatedAt: now };
}
