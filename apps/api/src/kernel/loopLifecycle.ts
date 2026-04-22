/**
 * loopLifecycle — Agent Loop 初始化 / 收尾生命周期
 *
 * 从 agentLoop.ts 的 runAgentLoop() 提取：
 * - initializeLoopState(): 初始化工具发现、记忆召回、目标分解、世界状态等
 * - finalizeLoopProcess(): 停止心跳、更新进程状态、释放槽位、触发反思
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { GoalGraph, WorldState } from "@openslin/shared";
import { discoverEnabledTools, recallRelevantMemory, recallRecentTasks, recallRelevantKnowledge, recallProceduralStrategies, type EnabledTool } from "../modules/agentContext";
import { upsertTaskState } from "../modules/memory/repo";
import { writeCheckpoint, registerProcess, startHeartbeat } from "./loopCheckpoint";
import { decomposeGoal } from "./goalDecomposer";
import { buildWorldStateFromObservations, extractWorldState } from "./worldStateExtractor";
import { prepareRunForExecution } from "./loopStateHelpers";
import { normalizeExecutionConstraints, filterToolDiscoveryByConstraints } from "./loopThinkDecide";
import { getCacheConfig, cacheGet, cacheSet, prepareCacheKey } from "./loopCacheConfig";
import { getMaxStepSeq, upsertGoalGraph } from "./agentLoopRepo";
import { updateProcessStatus } from "./loopCheckpoint";
import { triggerAutoReflexion } from "./loopAutoReflexion";
import type { AgentDecision, StepObservation, AgentLoopParams, ExecutionConstraints, AgentLoopResult } from "./loopTypes";

/* ── 初始化后返回的循环状态 ── */
export interface LoopState {
  loopId: string;
  loopStartedAt: number;
  observations: StepObservation[];
  iterations: number;
  succeededSteps: number;
  failedSteps: number;
  lastDecision: AgentDecision | null;
  currentSeq: number;
  executionConstraints: ExecutionConstraints | null;
  toolDiscovery: { catalog: string; tools: EnabledTool[] };
  memoryContext: string | undefined;
  taskHistory: string | undefined;
  knowledgeContext: string | undefined;
  strategyContext: string | undefined;
  goalGraph: GoalGraph | null;
  worldState: WorldState | null;
  processId: string | null;
  heartbeat: { stop: () => void };
  subjectPayload: Record<string, unknown>;
  auditCtx: { traceId: string } | undefined;
}

/**
 * 初始化循环所有上下文：工具发现、记忆召回、目标分解、世界状态、进程注册、心跳
 */
export async function initializeLoopState(params: AgentLoopParams): Promise<LoopState> {
  const {
    app, pool, subject, locale, authorization, traceId,
    goal, runId, jobId, taskId,
    defaultModelRef, executionConstraints: rawExecutionConstraints,
    resumeLoopId, resumeState,
  } = params;
  const maxIterations = params.maxIterations ?? 15;
  const maxWallTimeMs = params.maxWallTimeMs ?? 10 * 60 * 1000;
  const executionConstraints = normalizeExecutionConstraints(rawExecutionConstraints);
  const loopStartedAt = Date.now();

  // 从 checkpoint 恢复或全新启动
  const observations: StepObservation[] = resumeState?.observations ?? [];
  let iterations = resumeState?.iteration ?? 0;
  const succeededSteps = resumeState?.succeededSteps ?? 0;
  const failedSteps = resumeState?.failedSteps ?? 0;
  const lastDecision: AgentDecision | null = resumeState?.lastDecision ?? null;
  let currentSeq = resumeState?.currentSeq ?? 1;
  const loopId = resumeLoopId ?? (await import("node:crypto")).randomUUID();

  if (!resumeState) {
    currentSeq = (await getMaxStepSeq(pool, runId)) + 1;
  }

  // 并行发现 + 召回
  const auditCtx = traceId ? { traceId } : undefined;
  let toolDiscovery: { catalog: string; tools: EnabledTool[] };
  let memoryContext: string | undefined;
  let taskHistory: string | undefined;
  let knowledgeContext: string | undefined;
  let strategyContext: string | undefined;

  if (resumeState?.toolDiscoveryCache) {
    toolDiscovery = resumeState.toolDiscoveryCache as any;
    memoryContext = resumeState.memoryContext ?? undefined;
    taskHistory = resumeState.taskHistory ?? undefined;
    knowledgeContext = resumeState.knowledgeContext ?? undefined;
    strategyContext = resumeState.strategyContext ?? undefined;
    app.log.info({ runId, loopId, resumeFrom: resumeLoopId }, "[AgentLoop] 从 checkpoint 恢复，使用缓存上下文");
  } else {
    const cacheKeyTool = prepareCacheKey("tool", subject.tenantId, subject.spaceId);
    const cacheKeyStrategy = prepareCacheKey("strategy", subject.tenantId, subject.spaceId);
    const cc = getCacheConfig();
    const cachedTools = cc.ENABLED ? cacheGet<any>(cacheKeyTool) : undefined;
    const cachedStrategy = cc.ENABLED ? cacheGet<string>(cacheKeyStrategy) : undefined;

    const [td, memoryRecall, taskRecall, knowledgeRecall, strategyRecall] = await Promise.all([
      cachedTools ?? discoverEnabledTools({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId, locale }),
      recallRelevantMemory({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, message: goal, auditContext: auditCtx }),
      recallRecentTasks({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, auditContext: auditCtx }),
      recallRelevantKnowledge({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, message: goal, auditContext: auditCtx }),
      cachedStrategy !== undefined
        ? { text: cachedStrategy, strategyCount: 0 }
        : recallProceduralStrategies({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId, goal, auditContext: { ...auditCtx, subjectId: subject.subjectId } }),
    ]);
    toolDiscovery = cachedTools ?? td;
    if (cc.ENABLED && !cachedTools) cacheSet(cacheKeyTool, td, cc.TOOL_DISCOVERY_TTL_MS);
    if (cc.ENABLED && cachedStrategy === undefined && strategyRecall.text) cacheSet(cacheKeyStrategy, strategyRecall.text, cc.STRATEGY_RECALL_TTL_MS);
    memoryContext = memoryRecall.text || undefined;
    taskHistory = taskRecall.text || undefined;
    knowledgeContext = knowledgeRecall.text || undefined;
    strategyContext = strategyRecall.text || undefined;
    if (strategyRecall.strategyCount > 0) {
      app.log.info({ runId, strategyCount: strategyRecall.strategyCount }, "[AgentLoop] P2: 召回 procedural 策略记忆");
    }
  }
  toolDiscovery = filterToolDiscoveryByConstraints(toolDiscovery, locale, executionConstraints);

  let goalGraph: GoalGraph | null = null;
  let worldState: WorldState | null = null;

  const runPrepared = await prepareRunForExecution(pool, runId, { log: app.log });
  if (!runPrepared) throw new Error("run_not_ready_for_execution");

  await upsertTaskState({
    pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
    runId, phase: "executing", clearBlockReason: true, clearNextAction: true,
  });

  const subjectPayload = {
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    subjectId: subject.subjectId,
    roles: subject.roles ?? [],
  };
  await writeCheckpoint({
    pool, loopId,
    tenantId: subject.tenantId, spaceId: subject.spaceId ?? null,
    runId, jobId, taskId,
    iteration: iterations, currentSeq, succeededSteps, failedSteps,
    observations, lastDecision,
    goal, maxIterations, maxWallTimeMs,
    subjectPayload, locale, authorization, traceId,
    defaultModelRef: defaultModelRef ?? null,
    decisionContext: { executionConstraints: executionConstraints ?? null },
    toolDiscoveryCache: toolDiscovery as any,
    memoryContext: memoryContext ?? null,
    taskHistory: taskHistory ?? null,
    knowledgeContext: knowledgeContext ?? null,
    status: "running",
  });

  // 目标分解
  try {
    const decompResult = await decomposeGoal({
      app, pool, subject, locale, authorization, traceId,
      goal, runId, toolCatalog: toolDiscovery.catalog, defaultModelRef,
    });
    goalGraph = decompResult.graph;
    app.log.info({ runId, loopId, subGoalCount: goalGraph.subGoals.length, decompositionOk: decompResult.ok }, "[AgentLoop] GoalGraph 目标分解完成");
    await upsertGoalGraph(pool, {
      goalGraph, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, runId, loopId, goal,
    }).catch((e: unknown) => {
      app.log.error({ err: (e as Error)?.message, runId, loopId, graphId: goalGraph?.graphId }, "[AgentLoop] GoalGraph 持久化失败（不阻塞主流程）");
    });
  } catch (e: any) {
    app.log.warn({ err: e?.message, runId }, "[AgentLoop] GoalGraph 分解失败（降级为纯文本目标）");
  }

  worldState = extractWorldState({
    runId,
    observations,
    userGoal: goal,
    memoryContext,
    knowledgeContext,
  });

  // 进程注册 + 心跳
  let processId: string | null = null;
  try {
    processId = await registerProcess({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId ?? null, runId, loopId });
  } catch (e: any) {
    app.log.warn({ err: e?.message, runId, loopId }, "[AgentLoop] 注册 Agent 进程失败（不影响主流程）");
  }
  const heartbeat = startHeartbeat(pool, loopId);

  return {
    loopId, loopStartedAt, observations, iterations, succeededSteps, failedSteps,
    lastDecision, currentSeq, executionConstraints: executionConstraints ?? null, toolDiscovery,
    memoryContext, taskHistory, knowledgeContext, strategyContext,
    goalGraph, worldState, processId, heartbeat, subjectPayload, auditCtx,
  };
}

/**
 * 循环结束后的收尾：停止心跳、更新进程状态、释放槽位、触发自动反思
 */
export function finalizeLoopProcess(params: {
  pool: Pool;
  app: FastifyInstance;
  state: LoopState;
  result: AgentLoopResult | null;
  releaseSlot: (() => void) | null;
  subject: { tenantId: string; spaceId?: string | null; subjectId: string };
  runId: string;
  goal: string;
}): void {
  const { pool, app, state, result, releaseSlot, subject, runId, goal } = params;

  state.heartbeat.stop();
  if (state.processId) {
    let finalStatus: string;
    if (result?.ok) finalStatus = "succeeded";
    else if (result?.endReason === "ask_user") finalStatus = "paused";
    else finalStatus = "failed";
    updateProcessStatus(pool, state.processId, finalStatus).catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, runId, processId: state.processId, finalStatus }, "[AgentLoop] updateProcessStatus failed");
    });
  }
  if (releaseSlot) releaseSlot();
  if (result) {
    triggerAutoReflexion({
      pool, app, tenantId: subject.tenantId, spaceId: subject.spaceId ?? "",
      subjectId: subject.subjectId, runId, goal, result,
    }).catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, runId }, "[AgentLoop] triggerAutoReflexion failed");
    });
  }
}
