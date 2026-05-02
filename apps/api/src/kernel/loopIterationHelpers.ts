/**
 * Agent Loop — 迭代内辅助逻辑
 *
 * 从 runAgentLoop 主函数中提取的大块迭代逻辑：
 * - 迭代上下文构建（GoalGraph渲染 + WorldState + 环境状态 + 策略动态检索）
 * - LLM 调用（并行/串行）
 * - Verifier 校验
 */
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { GoalGraph, WorldState } from "@mindpal/shared";
import { computeGoalProgress, getExecutableSubGoals, worldStateToPromptText, resolveBoolean } from "@mindpal/shared";
import { invokeModelChat, type LlmSubject } from "../lib/llm";
import { recallProceduralStrategies } from "../modules/agentContext";
import { getEnvironmentSummary } from "./environmentState";
import type { StepObservation, ExecutionConstraints } from "./loopTypes";
import { buildThinkPrompt } from "./loopThinkDecide";
import { selectPurposeTier, tryDynamicModelRoute } from "./loopModelRouter";
import { detectIntentBoundary, type IntentDriftResult } from "./intentAnchoringService";
import { turboSkipIntentDrift, turboSkipStrategyRecall } from "./loopTurboMode";

/* ================================================================== */
/*  迭代上下文构建 — 辅助函数                                              */
/* ================================================================== */

/** 环境状态查询 */
async function fetchEnvironmentContext(params: {
  pool: Pool;
  subject: { tenantId: string; spaceId: string };
  iterations: number;
  worldState: WorldState | null;
}): Promise<{ environmentContext: string | undefined; updatedWorldState: WorldState | null }> {
  const { pool, subject, iterations } = params;
  let worldState = params.worldState;
  try {
    const envSummary = await getEnvironmentSummary({
      pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
    });
    if (envSummary.totalEntities > 0 || envSummary.activeConstraints > 0) {
      const lines: string[] = [];
      lines.push(`Entities: ${envSummary.totalEntities} total (${envSummary.onlineEntities} online, ${envSummary.degradedEntities} degraded, ${envSummary.offlineEntities} offline)`);
      if (envSummary.activeConstraints > 0) lines.push(`⚠️ Active constraints: ${envSummary.activeConstraints} (${envSummary.criticalConstraints} critical)`);
      if (envSummary.degradedEntities > 0) lines.push(`⚠️ Some environment entities are degraded — consider fallback strategies`);
      if (envSummary.offlineEntities > 0) lines.push(`❌ Some environment entities are offline — avoid depending on them`);
      const environmentContext = lines.join("\n");

      if (worldState && (envSummary.degradedEntities > 0 || envSummary.criticalConstraints > 0)) {
        const { upsertFact } = await import("@mindpal/shared");
        const now = new Date().toISOString();
        worldState = upsertFact(worldState, {
          factId: crypto.randomUUID(), category: "observation",
          key: `env:summary:iteration:${iterations}`,
          statement: `Environment: ${envSummary.totalEntities} entities (${envSummary.degradedEntities} degraded, ${envSummary.offlineEntities} offline), ${envSummary.criticalConstraints} critical constraints`,
          value: envSummary, confidence: 1.0, valid: true, recordedAt: now,
        });
      }
      return { environmentContext, updatedWorldState: worldState };
    }
    return { environmentContext: undefined, updatedWorldState: worldState };
  } catch {
    return { environmentContext: undefined, updatedWorldState: worldState };
  }
}

/** 动态策略检索 */
async function fetchDynamicStrategy(params: {
  pool: Pool;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  goal: string;
  iterations: number;
  observations: StepObservation[];
  strategyContext: string | undefined;
  auditCtx: { traceId: string } | undefined;
  log: FastifyInstance["log"];
  runId: string;
}): Promise<string | undefined> {
  const { pool, subject, goal, iterations, observations, strategyContext, auditCtx, log, runId } = params;
  if (!(iterations > 1 && iterations % 3 === 0) || turboSkipStrategyRecall(iterations)) return strategyContext;
  try {
    const recentObsSummary = observations.slice(-3).map(o => `- ${o.toolRef}`).join('\n');
    const freshStrategyRecall = await recallProceduralStrategies({
      pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
      goal: `${goal}\n\nCurrent observations:\n${recentObsSummary}`,
      auditContext: { ...auditCtx, subjectId: subject.subjectId },
    });
    if (freshStrategyRecall.strategyCount > 0) {
      log.info({ runId, iteration: iterations, strategyCount: freshStrategyRecall.strategyCount }, "[AgentLoop] P2-1: 动态检索到新的procedural策略");
      return freshStrategyRecall.text || undefined;
    }
    return strategyContext;
  } catch (err: any) {
    log.warn({ err: err?.message, runId, iteration: iterations }, "[AgentLoop] 动态策略检索失败（不影响执行）");
    return strategyContext;
  }
}

/** 意图漂移检测 */
async function fetchIntentDrift(params: {
  pool: Pool;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  runId: string;
  goal: string;
  iterations: number;
  observations: StepObservation[];
  log: FastifyInstance["log"];
}): Promise<IntentDriftResult | null> {
  const { pool, subject, runId, goal, iterations, observations, log } = params;
  if (iterations <= 1 || turboSkipIntentDrift(iterations)) return null;
  try {
    const lastObs = observations[observations.length - 1];
    const currentSignal = lastObs
      ? `Tool: ${lastObs.toolRef}, Status: ${lastObs.status}, Output: ${JSON.stringify(lastObs.outputDigest ?? {}).slice(0, 200)}`
      : goal;
    const intentDrift = await detectIntentBoundary({
      pool,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      runId,
      currentMessage: currentSignal,
      originalGoal: goal,
    });
    if (intentDrift.drifted) {
      log.warn({ runId, iteration: iterations, driftScore: intentDrift.driftScore, reason: intentDrift.reason }, "[AgentLoop] Think 阶段检测到意图漂移");
    }
    return intentDrift;
  } catch (err: any) {
    log.warn({ err: err?.message, runId, iteration: iterations }, "[AgentLoop] 意图漂移检测失败（不影响执行）");
    return null;
  }
}

/* ================================================================== */
/*  迭代上下文构建                                                       */
/* ================================================================== */

export async function buildIterationContext(params: {
  pool: Pool;
  subject: LlmSubject & { spaceId: string };
  runId: string;
  goal: string;
  iterations: number;
  observations: StepObservation[];
  goalGraph: GoalGraph | null;
  worldState: WorldState | null;
  strategyContext: string | undefined;
  auditCtx: { traceId: string } | undefined;
  log: FastifyInstance["log"];
}): Promise<{
  goalGraphContext: string | undefined;
  worldStateContext: string | undefined;
  environmentContext: string | undefined;
  dynamicStrategyContext: string | undefined;
  updatedWorldState: WorldState | null;
  /** Think 阶段意图漂移检测结果 */
  intentDrift: IntentDriftResult | null;
}> {
  const { pool, subject, runId, goal, iterations, observations, goalGraph, strategyContext, auditCtx, log } = params;
  let worldState = params.worldState;

  // GoalGraph 渲染
  let goalGraphContext: string | undefined;
  if (goalGraph && goalGraph.subGoals.length > 0) {
    const progress = computeGoalProgress(goalGraph);
    const executableGoals = getExecutableSubGoals(goalGraph);
    const lines = [`[GoalGraph] Progress: ${Math.round(progress * 100)}%, Sub-goals: ${goalGraph.subGoals.length}`];
    for (const sg of goalGraph.subGoals) {
      const icon = sg.status === "completed" ? "✅" : sg.status === "failed" ? "❌" : sg.status === "in_progress" ? "🔄" : "⏳";
      lines.push(`  ${icon} [${sg.goalId}] ${sg.description} (${sg.status})`);
    }
    if (executableGoals.length > 0) {
      lines.push(`Next executable: ${executableGoals.map(g => g.description).join("; ")}`);
    }
    goalGraphContext = lines.join("\n");
  }

  // WorldState 渲染
  let worldStateContext: string | undefined;
  if (worldState && Object.keys(worldState.entities).length > 0) {
    worldStateContext = worldStateToPromptText(worldState, 1000);
  }

  // 并行执行环境查询、策略检索、意图漂移检测
  const ctxBuildStart = performance.now();
  const [envResult, strategyResult, driftResult] = await Promise.allSettled([
    fetchEnvironmentContext({ pool, subject, iterations, worldState }),
    fetchDynamicStrategy({ pool, subject: subject as any, goal, iterations, observations, strategyContext, auditCtx, log, runId }),
    fetchIntentDrift({ pool, subject: subject as any, runId, goal, iterations, observations, log }),
  ]);
  const ctxBuildDur = Math.round(performance.now() - ctxBuildStart);
  log.debug('[perf] context_build=%dms', ctxBuildDur);

  let environmentContext: string | undefined;
  if (envResult.status === "fulfilled") {
    environmentContext = envResult.value.environmentContext;
    worldState = envResult.value.updatedWorldState;
  }

  const dynamicStrategyContext = strategyResult.status === "fulfilled" ? strategyResult.value : strategyContext;
  const intentDrift = driftResult.status === "fulfilled" ? driftResult.value : null;

  return { goalGraphContext, worldStateContext, environmentContext, dynamicStrategyContext, updatedWorldState: worldState, intentDrift };
}

/* ================================================================== */
/*  LLM 调用（并行/串行）                                                */
/* ================================================================== */

export async function invokeLlmForDecision(params: {
  app: FastifyInstance;
  pool: Pool;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  runId: string;
  goal: string;
  iterations: number;
  observations: StepObservation[];
  lastObs: StepObservation | null;
  userIntervention: string | undefined;
  resumeState: any;
  executionConstraints: ExecutionConstraints | undefined;
  toolCatalog: string;
  memoryContext: string | undefined;
  taskHistory: string | undefined;
  knowledgeContext: string | undefined;
  goalGraphContext: string | undefined;
  worldStateContext: string | undefined;
  environmentContext: string | undefined;
  dynamicStrategyContext: string | undefined;
  /** P2-召回反哺: 信息缺口 */
  informationGaps: string[] | undefined;
  defaultModelRef: string | undefined;
  /** 决策质量重试时，强制使用指定的 purpose tier（为升级模型） */
  forcePurpose?: string;
}): Promise<{ outputText: string; modelUsed: string; llmDurationMs: number }> {
  const {
    app, pool, subject, locale, authorization, traceId, runId, goal,
    iterations, observations, lastObs, userIntervention, resumeState,
    executionConstraints, toolCatalog, memoryContext, taskHistory,
    knowledgeContext, goalGraphContext, worldStateContext, environmentContext,
    dynamicStrategyContext, defaultModelRef,
  } = params;

  const primaryPurpose = params.forcePurpose ?? selectPurposeTier(observations, iterations);

  const { systemPrompt, userPrompt } = buildThinkPrompt({
    goal, toolCatalog: toolCatalog, executionConstraints,
    completedSteps: observations, lastObservation: lastObs,
    userIntervention: (iterations === 1 && !resumeState) ? undefined : userIntervention,
    memoryContext, taskHistory,
    knowledgeContext: [knowledgeContext, goalGraphContext, worldStateContext].filter(Boolean).join("\n\n") || undefined,
    strategyContext: dynamicStrategyContext, environmentContext,
    informationGaps: params.informationGaps,
  });

  // 动态能力画像路由
  let dynamicModelRef: string | undefined;
  if (!defaultModelRef) {
    dynamicModelRef = await tryDynamicModelRoute({
      pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
      purpose: primaryPurpose, observations, iteration: iterations, goal,
      promptTokenEstimate: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
    });
    if (dynamicModelRef) {
      app.log.info({ runId, iteration: iterations, dynamicModelRef, purpose: primaryPurpose }, "[AgentLoop] 动态路由: 能力画像匹配模型");
    }
  }

  const parallelLlmEnabled = resolveBoolean("AGENT_LOOP_PARALLEL_LLM").value;
  const isSimpleProgress = parallelLlmEnabled && lastObs && lastObs.status === "succeeded" && observations.length <= 5 && iterations > 1;

  const llmCallStart = Date.now();

  if (isSimpleProgress) {
    app.log.info({ runId, iteration: iterations, strategy: "parallel_fast_standard" }, "[AgentLoop] 并行调用 fast/standard 模型");
    const modelConstraints = defaultModelRef ? { candidates: [defaultModelRef] } : dynamicModelRef ? { candidates: [dynamicModelRef] } : undefined;
    const msgs = [{ role: "system" as const, content: systemPrompt }, { role: "user" as const, content: userPrompt }];
    const [fastResult, standardResult] = await Promise.allSettled([
      invokeModelChat({ app, subject, locale, authorization, traceId, purpose: "agent.loop.think.fast", messages: msgs, constraints: modelConstraints }).catch(() => null),
      invokeModelChat({ app, subject, locale, authorization, traceId, purpose: "agent.loop.think", messages: msgs, constraints: modelConstraints }).catch(() => null),
    ]);
    const standardOutput = standardResult.status === "fulfilled" && standardResult.value ? standardResult.value.outputText : null;
    const fastOutput = fastResult.status === "fulfilled" && fastResult.value ? fastResult.value.outputText : null;
    app.log.info({ runId, iteration: iterations, standardOk: !!standardOutput, fastOk: !!fastOutput }, "[AgentLoop] 并行调用完成");
    return { outputText: (typeof standardOutput === "string" ? standardOutput : "") || (typeof fastOutput === "string" ? fastOutput : ""), modelUsed: primaryPurpose, llmDurationMs: Date.now() - llmCallStart };
  }

  // 串行调用
  const llmResult = await invokeModelChat({
    app, subject, locale, authorization, traceId, purpose: primaryPurpose,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : dynamicModelRef ? { constraints: { candidates: [dynamicModelRef] } } : {}),
  });
  return { outputText: llmResult?.outputText ?? "", modelUsed: primaryPurpose, llmDurationMs: Date.now() - llmCallStart };
}
