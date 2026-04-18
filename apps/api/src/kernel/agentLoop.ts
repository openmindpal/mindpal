/**
 * Agent Loop — 核心智能体循环引擎
 *
 * P2-2 拆分后本文件仅保留 runAgentLoop 主循环骨架。
 * 辅助模块：
 * - loopTypes.ts       — 公共类型
 * - loopRedisClient.ts  — Redis Pub/Sub 懒单例
 * - loopStateHelpers.ts — 安全状态转换
 * - loopObservation.ts  — 观察构建 + 步骤历史渲染
 * - loopThinkDecide.ts  — Think prompt + Decide 解析 + 约束辅助
 * - loopToolExecutor.ts — 工具执行 + 步骤等待
 * - loopModelRouter.ts  — 模型路由策略
 * - loopAutoReflexion.ts — 自动反思
 */
import crypto from "node:crypto";
import type { GoalGraph, WorldState } from "@openslin/shared";
import { discoverEnabledTools, recallRelevantMemory, recallRecentTasks, recallRelevantKnowledge, recallProceduralStrategies, type EnabledTool } from "../modules/agentContext";
import { upsertTaskState } from "../modules/memory/repo";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { writeCheckpoint, finalizeCheckpoint, startHeartbeat, registerProcess, updateProcessStatus } from "./loopCheckpoint";
import { acquireLoopSlot } from "./priorityScheduler";
import { decomposeGoal } from "./goalDecomposer";
import { extractFromObservation, evaluateGoalConditions, buildWorldStateFromObservations } from "./worldStateExtractor";
import { verifyGoalCompletion, verifySimple, type VerificationResult } from "./verifierAgent";
import { checkAndEnforceIntentBoundary } from "./intentAnchoringService";

/* ── 从拆分模块 re-import ── */
import type {
  AgentDecisionAction, AgentDecision, StepObservation,
  AgentLoopParams, ExecutionConstraints, AgentLoopResult,
} from "./loopTypes";
import { prepareRunForExecution, safeTransitionRun } from "./loopStateHelpers";
import { parseAgentDecision, normalizeExecutionConstraints, filterToolDiscoveryByConstraints } from "./loopThinkDecide";
import { executeToolCall, waitForStepCompletion } from "./loopToolExecutor";
import { triggerAutoReflexion } from "./loopAutoReflexion";
import { buildIterationContext, invokeLlmForDecision } from "./loopIterationHelpers";
import { handleDoneAction, handleToolCallAction } from "./loopActHandlers";
import { CACHE_CONFIG, cacheGet, cacheSet, prepareCacheKey, LIGHT_ITERATION_CONFIG, isLightIteration } from "./loopCacheConfig";

/* ── re-export（外部文件 import from "./agentLoop"） ── */
export type { AgentDecisionAction, AgentDecision, StepObservation, AgentLoopParams, ExecutionConstraints, AgentLoopResult } from "./loopTypes";
export { buildObservation, compressStepHistory } from "./loopObservation";
export { buildThinkPrompt, parseAgentDecision } from "./loopThinkDecide";
export { CACHE_CONFIG, LIGHT_ITERATION_CONFIG, isLightIteration } from "./loopCacheConfig";

/* ── Redis/State/Types 已提取到独立模块 ── */

/* Observe/Think/Decide/Act/ModelRouter → 已提取到独立模块，见文件头注释 */

/* 缓存配置和轻迭代配置已提取到 loopCacheConfig.ts，经 configRegistry 注册 */

/**
 * P1-5: O(n) 事件驱动版 —— 每个 promise resolve 时直接 push 到结果数组，
 * 无需 O(n²) 的 Promise.race 轮询。
 */
export async function collectInCompletionOrder<T>(promises: Array<Promise<T>>): Promise<Array<{ index: number; value: T }>> {
  const settled: Array<{ index: number; value: T }> = [];
  await Promise.all(
    promises.map((p, index) =>
      p.then((value) => { settled.push({ index, value }); }),
    ),
  );
  return settled;
}

/* ================================================================== */
/*  Main Loop — Observe → Think → Decide → Act                         */
/* ================================================================== */

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const {
    app, pool, queue, subject, locale, authorization, traceId,
    goal, runId, jobId, taskId,
    signal, userIntervention, onStepComplete, onLoopEnd,
    defaultModelRef, executionConstraints: rawExecutionConstraints,
    resumeLoopId, resumeState,
  } = params;
  const maxIterations = params.maxIterations ?? 15;
  const maxWallTimeMs = params.maxWallTimeMs ?? 10 * 60 * 1000;
  const executionConstraints = normalizeExecutionConstraints(rawExecutionConstraints);

  /* P1-05: 全局并发入口门 — 超限时排队等待，超时抛异常 */
  let releaseSlot: (() => void) | null = null;
  try {
    releaseSlot = await acquireLoopSlot({ priority: (params as any).priority ?? 5, timeoutMs: 60_000 });
  } catch (gateErr: any) {
    app.log.warn({ err: gateErr?.message, runId }, "[AgentLoop] 全局并发入口门拒绝");
    const failResult: AgentLoopResult = {
      ok: false, endReason: "error", iterations: 0, succeededSteps: 0, failedSteps: 0,
      message: gateErr?.message ?? "agent_loop_admission_timeout",
      observations: [], lastDecision: null, loopId: resumeLoopId ?? crypto.randomUUID(),
    };
    onLoopEnd?.(failResult);
    return failResult;
  }

  const loopStartedAt = Date.now();

  // P0-1: 从 checkpoint 恢复或全新启动
  const observations: StepObservation[] = resumeState?.observations ?? [];
  let iterations = resumeState?.iteration ?? 0;
  let succeededSteps = resumeState?.succeededSteps ?? 0;
  let failedSteps = resumeState?.failedSteps ?? 0;
  let lastDecision: AgentDecision | null = resumeState?.lastDecision ?? null;
  let currentSeq = resumeState?.currentSeq ?? 1;

  // P0-1: 生成或复用 loopId
  const loopId = resumeLoopId ?? crypto.randomUUID();

  if (!resumeState) {
    // 全新启动：获取已有步骤数以确定起始 seq
    const existingSteps = await pool.query<{ max_seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps WHERE run_id = $1",
      [runId],
    );
    currentSeq = (existingSteps.rows[0]?.max_seq ?? 0) + 1;
  }

  // 并行：发现可用工具 + 召回记忆 + 召回任务历史 + 召回知识库 + P2:召回策略记忆
  // P0-1: 如果从 checkpoint 恢复且有缓存，跳过重新发现
  const auditCtx = traceId ? { traceId } : undefined;
  let toolDiscovery: { catalog: string; tools: EnabledTool[] };
  let memoryContext: string | undefined;
  let taskHistory: string | undefined;
  let knowledgeContext: string | undefined;
  let strategyContext: string | undefined;

  if (resumeState?.toolDiscoveryCache) {
    // 恢复模式：使用缓存
    toolDiscovery = resumeState.toolDiscoveryCache as any;
    memoryContext = resumeState.memoryContext ?? undefined;
    taskHistory = resumeState.taskHistory ?? undefined;
    knowledgeContext = resumeState.knowledgeContext ?? undefined;
    strategyContext = (resumeState as any).strategyContext ?? undefined;
    app.log.info({ runId, loopId, resumeFrom: resumeLoopId }, "[AgentLoop] 从 checkpoint 恢复，使用缓存上下文");
  } else {
    // 全新启动：P1-8 缓存分层 + 并行发现
    const cacheKeyTool = prepareCacheKey("tool", subject.tenantId, subject.spaceId);
    const cacheKeyStrategy = prepareCacheKey("strategy", subject.tenantId, subject.spaceId);
    const cachedTools = CACHE_CONFIG.ENABLED ? cacheGet<any>(cacheKeyTool) : undefined;
    const cachedStrategy = CACHE_CONFIG.ENABLED ? cacheGet<string>(cacheKeyStrategy) : undefined;

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
    // P1-8: 写入缓存
    if (CACHE_CONFIG.ENABLED && !cachedTools) cacheSet(cacheKeyTool, td, CACHE_CONFIG.TOOL_DISCOVERY_TTL_MS);
    if (CACHE_CONFIG.ENABLED && cachedStrategy === undefined && strategyRecall.text) cacheSet(cacheKeyStrategy, strategyRecall.text, CACHE_CONFIG.STRATEGY_RECALL_TTL_MS);
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
  if (!runPrepared) {
    throw new Error("run_not_ready_for_execution");
  }

  await upsertTaskState({
    pool,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    runId,
    phase: "executing",
    clearBlockReason: true,
    clearNextAction: true,
  });

  const subjectPayload = {
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    subjectId: subject.subjectId,
    roles: (subject as any).roles ?? [],
  };
  await writeCheckpoint({
    pool, loopId,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId ?? null,
    runId, jobId, taskId,
    iteration: iterations,
    currentSeq, succeededSteps, failedSteps,
    observations,
    lastDecision,
    goal, maxIterations, maxWallTimeMs,
    subjectPayload, locale,
    authorization, traceId,
    defaultModelRef: defaultModelRef ?? null,
    decisionContext: { executionConstraints: executionConstraints ?? null },
    toolDiscoveryCache: toolDiscovery as any,
    memoryContext: memoryContext ?? null,
    taskHistory: taskHistory ?? null,
    knowledgeContext: knowledgeContext ?? null,
    status: "running",
  });

  try {
    const decompResult = await decomposeGoal({
      app, pool, subject, locale, authorization, traceId,
      goal, runId, toolCatalog: toolDiscovery.catalog,
      defaultModelRef,
    });
    goalGraph = decompResult.graph;
    app.log.info({
      runId, loopId,
      subGoalCount: goalGraph.subGoals.length,
      decompositionOk: decompResult.ok,
    }, "[AgentLoop] GoalGraph 目标分解完成");
    await pool.query(
      `INSERT INTO goal_graphs (graph_id, tenant_id, space_id, run_id, loop_id, main_goal, graph_json, decomposition_reasoning, decomposed_by_model, status, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (graph_id) DO UPDATE SET graph_json=$7, status=$10, version=$11, updated_at=now()`,
      [
        goalGraph.graphId, subject.tenantId, subject.spaceId ?? null, runId, loopId,
        goal, JSON.stringify(goalGraph),
        goalGraph.decompositionReasoning ?? null, goalGraph.decomposedByModel ?? null,
        goalGraph.status, goalGraph.version,
      ],
    ).catch((e: any) => {
      app.log.error({ err: e?.message, runId, loopId, graphId: goalGraph?.graphId }, "[AgentLoop] GoalGraph 持久化失败（不阻塞主流程）");
    });
  } catch (e: any) {
    app.log.warn({ err: e?.message, runId }, "[AgentLoop] GoalGraph 分解失败（降级为纯文本目标）");
  }

  worldState = buildWorldStateFromObservations(runId, observations);

  let processId: string | null = null;
  try {
    processId = await registerProcess({
      pool,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId ?? null,
      runId, loopId,
    });
  } catch (e: any) {
    app.log.warn({ err: e?.message, runId, loopId }, "[AgentLoop] 注册 Agent 进程失败（不影响主流程）");
  }

  const heartbeat = startHeartbeat(pool, loopId);

  /** 共享结果变量，用于 finally 块中的自动反思 */
  let _loopFinalResult: AgentLoopResult | null = null;

  function buildResult(endReason: AgentLoopResult["endReason"], message: string, verification?: VerificationResult): AgentLoopResult {
    // P1-3 FIX: ok 语义修正 — ask_user 不是失败，而是暂停，也应视为 ok
    const r: AgentLoopResult = {
      ok: endReason === "done" || endReason === "ask_user",
      endReason,
      iterations,
      succeededSteps,
      failedSteps,
      message,
      observations,
      lastDecision,
      loopId,
      verification,
      goalGraph: goalGraph ?? undefined,
    };
    _loopFinalResult = r;
    return r;
  }

  try {
    while (iterations < maxIterations) {
      // 检查中断信号
      if (signal?.aborted) {
        await finalizeCheckpoint(pool, loopId, "interrupted").catch(() => {});
        const result = buildResult("interrupted", "用户中断了任务执行");
        onLoopEnd?.(result);
        return result;
      }

      // 检查超时
      if (Date.now() - loopStartedAt > maxWallTimeMs) {
        await finalizeCheckpoint(pool, loopId, "failed").catch(() => {});
        const result = buildResult("max_wall_time", `执行超时 (>${maxWallTimeMs}ms)`);
        onLoopEnd?.(result);
        return result;
      }

      iterations++;

      // ── Phase 1: Observe ──
      const lastObs = observations.length > 0 ? observations[observations.length - 1] : null;

      // ── Phase 2: Think ──
      const iterationStartMs = Date.now();
      // 构建迭代上下文（GoalGraph + WorldState + 环境状态 + 动态策略）
      const iterCtx = await buildIterationContext({
        pool, subject: subject as any, runId, goal, iterations, observations,
        goalGraph, worldState, strategyContext, auditCtx, log: app.log,
      });
      worldState = iterCtx.updatedWorldState;

      // LLM 调用（并行/串行）
      let modelOutputText = "";
      try {
        modelOutputText = await invokeLlmForDecision({
          app, pool, subject: subject as any, locale, authorization, traceId,
          runId, goal, iterations, observations, lastObs,
          userIntervention: (iterations === 1 && !resumeState) ? undefined : userIntervention,
          resumeState, executionConstraints,
          toolCatalog: toolDiscovery.catalog,
          memoryContext, taskHistory, knowledgeContext,
          goalGraphContext: iterCtx.goalGraphContext,
          worldStateContext: iterCtx.worldStateContext,
          environmentContext: iterCtx.environmentContext,
          dynamicStrategyContext: iterCtx.dynamicStrategyContext,
          defaultModelRef,
        });
      } catch (llmErr: any) {
        app.log.error({ err: llmErr, runId, iteration: iterations }, "[AgentLoop] LLM 调用失败");
        const result = buildResult("error", `LLM 调用失败：${llmErr?.message ?? "unknown"}`);
        onLoopEnd?.(result);
        return result;
      }

      // ── Phase 3: Decide ──
      const decideStartMs = Date.now();
      const decision = parseAgentDecision(modelOutputText);
      lastDecision = decision;
      const decideLatencyMs = Date.now() - decideStartMs;

      // P0-2: Agent Decision 打点
      app.metrics.observeAgentDecision({
        result: "ok",
        decision: (["tool_call", "done", "replan"] as string[]).includes(decision.action)
          ? decision.action as any
          : decision.action === "parallel_tool_calls" ? "tool_call"
          : decision.action === "ask_user" ? "yield"
          : decision.action === "abort" ? "error" : "error",
        latencyMs: Date.now() - iterationStartMs,
        iterationSeq: iterations,
      });

      app.log.info({
        runId, iteration: iterations,
        action: decision.action,
        reasoning: decision.reasoning.slice(0, 200),
        toolRef: decision.toolRef,
      }, "[AgentLoop] 决策");

      // ── Phase 4: Act ──
      switch (decision.action) {
        case "done": {
          const doneResult = await handleDoneAction({
            app, pool, subject: subject as any, locale, authorization, traceId,
            runId, loopId, goal, iterations, maxIterations, defaultModelRef,
            decision, observations, goalGraph, worldState, knowledgeContext,
          });
          if (doneResult.outcome === "rejected_replan") {
            knowledgeContext = doneResult.knowledgeFeedback;
            continue;
          }
          const result = buildResult("done", decision.summary ?? "任务已完成", doneResult.verification);
          onLoopEnd?.(result);
          return result;
        }

        case "abort": {
          await safeTransitionRun(pool, runId, "failed", { finishedAt: true, log: app.log });
          await upsertTaskState({
            pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
            runId, phase: "failed",
            clearBlockReason: true,
            clearNextAction: true,
            clearApprovalStatus: true,
          });
          await finalizeCheckpoint(pool, loopId, "failed").catch(() => {});
          const result = buildResult("aborted", decision.abortReason ?? "任务无法完成");
          onLoopEnd?.(result);
          return result;
        }

        case "ask_user": {
          await safeTransitionRun(pool, runId, "paused", { log: app.log });
          // P1-2 FIX: 写入 blockReason 和 nextAction，让前端能显示结构化追问内容
          await upsertTaskState({
            pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
            runId, phase: "paused",
            blockReason: `ask_user: ${(decision.question ?? "需要更多信息").slice(0, 500)}`,
            nextAction: "waiting_for_user_reply",
          });
          // P0-1: ask_user 是暂停而非终止，checkpoint 保持 paused 状态以便恢复
          await writeCheckpoint({
            pool, loopId,
            tenantId: subject.tenantId, spaceId: subject.spaceId ?? null,
            runId, jobId, taskId,
            iteration: iterations, currentSeq, succeededSteps, failedSteps,
            observations, lastDecision: decision,
            goal, maxIterations, maxWallTimeMs,
            subjectPayload, locale, authorization, traceId,
            defaultModelRef: defaultModelRef ?? null,
            decisionContext: { executionConstraints: executionConstraints ?? null },
            toolDiscoveryCache: toolDiscovery as any,
            memoryContext: memoryContext ?? null,
            taskHistory: taskHistory ?? null,
            knowledgeContext: knowledgeContext ?? null,
            status: "paused",
          }).catch(() => {});
          const result = buildResult("ask_user", decision.question ?? "需要更多信息");
          onLoopEnd?.(result);
          return result;
        }

        case "replan": {
          // 重新规划：清除 pending 步骤，重新进入下一轮循环让 LLM 产出新的 tool_call
          app.log.info({ runId, iteration: iterations, reasoning: decision.reasoning }, "[AgentLoop] 重新规划");
          // steps 表主链路按 run_id 归属，pending 清理这里沿用同样口径
          await pool.query(
            "DELETE FROM steps WHERE run_id = $1 AND status = 'pending'",
            [runId],
          );
          continue; // 继续循环，LLM 会在下一轮产出新的 tool_call
        }

        case "parallel_tool_calls": {
          // 并行执行多个独立工具调用
          const calls = decision.parallelCalls ?? [];
          if (calls.length === 0) {
            app.log.warn({ runId, iteration: iterations }, "[AgentLoop] parallel_tool_calls 但 parallelCalls 为空，跳过");
            continue;
          }

          app.log.info({ runId, iteration: iterations, callCount: calls.length }, "[AgentLoop] 并行执行");

          // 并行下发所有工具调用
          const execPromises = calls.map((call, i) =>
            executeToolCall({
              app, pool, queue,
              tenantId: subject.tenantId,
              spaceId: subject.spaceId,
              subjectId: subject.subjectId,
              traceId,
              runId, jobId,
              decision: { ...decision, action: "tool_call", toolRef: call.toolRef, inputDraft: call.inputDraft },
              seq: currentSeq + i,
              executionConstraints,
            })
          );
          const execResults = await Promise.all(execPromises);

          // 并行等待所有步骤完成
          const stepPromises = execResults.map((r) =>
            r.ok ? waitForStepCompletion(pool, r.stepId, signal) : Promise.resolve({ status: "failed" as const, outputDigest: { error: r.error }, output: null as any, errorCategory: "tool_validation_failed" as string | null })
          );
          const stepResults = await collectInCompletionOrder(stepPromises);

          // 收集所有观察
          for (const settled of stepResults) {
            const i = settled.index;
            const obs: StepObservation = {
              stepId: execResults[i].stepId ?? "",
              seq: currentSeq + i,
              toolRef: calls[i].toolRef,
              status: settled.value.status,
              outputDigest: settled.value.outputDigest,
              output: settled.value.output ?? null,
              errorCategory: settled.value.errorCategory,
              durationMs: null,
            };
            observations.push(obs);
            if (settled.value.status === "succeeded") succeededSteps++;
            else failedSteps++;
            if (onStepComplete) await onStepComplete(obs, decision);
          }
          currentSeq += calls.length;

          // P0-2: 并行工具调用打点
          const parallelSuccessCount = stepResults.filter(s => s.value.status === "succeeded").length;
          const parallelFailedCount = stepResults.length - parallelSuccessCount;
          app.metrics.observeParallelToolCalls({
            result: parallelFailedCount === 0 ? "ok" : parallelSuccessCount > 0 ? "partial" : "error",
            latencyMs: Date.now() - decideStartMs,
            parallelCount: calls.length,
            successCount: parallelSuccessCount,
            failedCount: parallelFailedCount,
          });

          // P0-2: WorldState 增量提取（并行步骤批量提取）
          if (worldState) {
            for (let i = 0; i < calls.length; i++) {
              const lastObs = observations[observations.length - calls.length + i];
              if (lastObs) worldState = extractFromObservation(lastObs, worldState);
            }
            if (goalGraph) goalGraph = evaluateGoalConditions(goalGraph, worldState);
          }
          break;
        }

        case "tool_call": {
          const tcResult = await handleToolCallAction({
            app, pool, queue, subject: subject as any,
            traceId, runId, jobId: jobId ?? "", loopId, goal, iterations,
            decision, currentSeq, executionConstraints, signal, worldState, goalGraph,
          });
          if (tcResult.outcome === "boundary_paused") {
            const result = buildResult("ask_user", `检测到意图冲突，已暂停执行: ${tcResult.reason}`);
            onLoopEnd?.(result);
            return result;
          }
          if (tcResult.outcome === "validation_failed") {
            observations.push(tcResult.failObs);
            failedSteps++;
            currentSeq++;
            continue;
          }
          // executed
          observations.push(tcResult.obs);
          if (tcResult.succeeded) succeededSteps++; else failedSteps++;
          currentSeq++;
          if (onStepComplete) await onStepComplete(tcResult.obs, decision);
          worldState = tcResult.worldState;
          goalGraph = tcResult.goalGraph;
          break;
        }

        default: {
          // 未知决策，安全终止
          await finalizeCheckpoint(pool, loopId, "failed").catch(() => {});
          const result = buildResult("error", `Unknown decision action: ${(decision as any).action}`);
          onLoopEnd?.(result);
          return result;
        }
      }

      // P0-1: 每次迭代结束后写 checkpoint（幂等 UPSERT）
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
        // P1-8 FIX: 常规 checkpoint 也保存缓存字段，避免恢复时丢失上下文
        toolDiscoveryCache: toolDiscovery as any,
        memoryContext: memoryContext ?? null,
        taskHistory: taskHistory ?? null,
        knowledgeContext: knowledgeContext ?? null,
        status: "running",
      }).catch((e: any) => {
        app.log.warn({ err: e?.message, runId, loopId, iteration: iterations }, "[AgentLoop] checkpoint 写入失败（不阻塞主循环）");
      });
    }

    // 达到最大迭代次数
    await safeTransitionRun(pool, runId, "stopped", { log: app.log });
    await finalizeCheckpoint(pool, loopId, "failed").catch(() => {});
    const result = buildResult("max_iterations", `达到最大迭代次数 (${maxIterations})`);
    onLoopEnd?.(result);
    return result;
  } catch (err: any) {
    app.log.error({ err, runId, iteration: iterations }, "[AgentLoop] 循环异常");
    await safeTransitionRun(pool, runId, "failed", { finishedAt: true, log: app.log }).catch(() => {});
    await finalizeCheckpoint(pool, loopId, "failed").catch(() => {});
    const result = buildResult("error", `Agent Loop 异常: ${err?.message ?? "unknown"}`);
    onLoopEnd?.(result);
    return result;
  } finally {
    // P0-1: 停止心跳 + 终结进程
    heartbeat.stop();
    if (processId) {
      // P0-6 FIX: ask_user 返回 ok=false 但实际是 paused，不应标记为 failed
      const loopResult = _loopFinalResult as AgentLoopResult | null;
      let finalStatus: string;
      if (loopResult?.ok) {
        finalStatus = "succeeded";
      } else if (loopResult?.endReason === "ask_user") {
        finalStatus = "paused";
      } else {
        finalStatus = "failed";
      }
      updateProcessStatus(pool, processId, finalStatus).catch(() => {});
    }
    /* P1-05: 释放全局并发槽位 */
    if (releaseSlot) releaseSlot();
    // ── 自动反思：循环结束后异步触发，不阻塞主流程 ──
    if (_loopFinalResult) {
      triggerAutoReflexion({
        pool, app,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        runId, goal,
        result: _loopFinalResult,
      }).catch(() => {});
    }
  }
}

/* Auto-Reflexion → loopAutoReflexion.ts */
