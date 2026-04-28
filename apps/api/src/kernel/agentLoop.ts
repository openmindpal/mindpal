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
import { performance } from "node:perf_hooks";
import type { GoalGraph, WorldState, AgentTracingContext, FailureDiagnosis, SemanticAuditEntry } from "@openslin/shared";
import { ErrorCategory, resolveNumber, startAgentTracing, startIteration, startPhase, endPhase, endAgentTracing } from "@openslin/shared";
import { startSpan as otelStartSpan } from "../lib/tracing";
import { discoverEnabledTools, recallRelevantMemory, recallRecentTasks, recallRelevantKnowledge, recallProceduralStrategies, type EnabledTool } from "../modules/agentContext";
import { upsertTaskState } from "../modules/memory/repo";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { writeCheckpoint, finalizeCheckpoint, startHeartbeat, registerProcess, updateProcessStatus, AGENT_LOOP_FULL_CHECKPOINT_INTERVAL, type WriteCheckpointParams } from "./loopCheckpoint";
import { acquireLoopSlot } from "./priorityScheduler";
import { decomposeGoal } from "./goalDecomposer";
import { extractFromObservation, evaluateGoalConditions, buildWorldStateFromObservations, extractWorldState } from "./worldStateExtractor";
import { verifyGoalCompletion, verifySimple, type VerificationResult } from "./verifierAgent";
import { checkAndEnforceIntentBoundary, detectIntentBoundary, type IntentDriftResult } from "./intentAnchoringService";

/* ── 从拆分模块 re-import ── */
import type {
  AgentDecisionAction, AgentDecision, StepObservation,
  AgentLoopParams, ExecutionConstraints, AgentLoopResult,
  LoopBudget,
} from "./loopTypes";
import { isBudgetExhausted, recordTokenUsage, recordCostUsage, createDefaultBudget } from "./loopTypes";
import { prepareRunForExecution, safeTransitionRun } from "./loopStateHelpers";
import { parseAgentDecision, normalizeExecutionConstraints, filterToolDiscoveryByConstraints, extractConfidenceFromOutput, evaluateDecisionQuality, getDecisionQualityConfig } from "./loopThinkDecide";
import type { DecisionQualityScore } from "./loopTypes";
import { executeToolCall, waitForStepCompletion } from "./loopToolExecutor";
import { triggerAutoReflexion } from "./loopAutoReflexion";
import { buildIterationContext, invokeLlmForDecision } from "./loopIterationHelpers";
import { handleDoneAction, handleToolCallAction } from "./loopActHandlers";
import { getCacheConfig, cacheGet, cacheSet, prepareCacheKey, getLightIterationConfig, isLightIteration } from "./loopCacheConfig";
import { getMaxStepSeq, upsertGoalGraph, deletePendingSteps } from "./agentLoopRepo";
import { initializeLoopState, finalizeLoopProcess, type LoopState } from "./loopLifecycle";
import { turboSkipFastCheckpoint, turboSkipDecisionRetry } from "./loopTurboMode";

/* ── re-export（外部文件 import from "./agentLoop"） ── */
export type { AgentDecisionAction, AgentDecision, StepObservation, AgentLoopParams, ExecutionConstraints, AgentLoopResult } from "./loopTypes";
export { buildObservation, buildObservationsBatch, compressStepHistory } from "./loopObservation";
import { buildObservationsBatch, AGENT_LOOP_BATCH_OBSERVE } from "./loopObservation";
export { buildThinkPrompt, parseAgentDecision, extractConfidenceFromOutput, evaluateDecisionQuality, getDecisionQualityConfig } from "./loopThinkDecide";
export { getCacheConfig, getLightIterationConfig, isLightIteration } from "./loopCacheConfig";

/* ── Redis/State/Types 已提取到独立模块 ── */

/* Observe/Think/Decide/Act/ModelRouter → 已提取到独立模块，见文件头注释 */

/* 缓存配置和轻迭代配置已提取到 loopCacheConfig.ts，经 configRegistry 注册 */

/**
 * 将现有 OTel Span API 适配为 AgentTracing 依赖注入接口
 * OTel 未启用时 startSpan 返回 noop span，天然兼容
 */
function createTracerAdapter(): import("@openslin/shared").TracingTracer {
  return {
    startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }) {
      const span = otelStartSpan(name) as any;
      if (options?.attributes) {
        for (const [k, v] of Object.entries(options.attributes)) {
          try { span.setAttribute?.(k, v); } catch { /* noop */ }
        }
      }
      return span;
    },
  };
}

export interface SettledResult<T> {
  index: number;
  status: "fulfilled" | "rejected";
  value?: T;
  error?: unknown;
}

/**
 * O(n) 事件驱动版 —— 按完成顺序收集所有 promise 的结果（含 rejected）。
 */
export async function collectInCompletionOrder<T>(promises: Array<Promise<T>>): Promise<Array<SettledResult<T>>> {
  const settled: Array<SettledResult<T>> = [];
  await Promise.allSettled(
    promises.map((p, index) =>
      p.then(
        (value) => { settled.push({ index, status: "fulfilled", value }); },
        (error) => { settled.push({ index, status: "rejected", error }); },
      ),
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
    defaultModelRef, resumeLoopId, resumeState,
  } = params;
  const maxIterations = params.maxIterations ?? 15;
  const maxWallTimeMs = params.maxWallTimeMs ?? 10 * 60 * 1000;

  /* P1-05: 全局并发入口门 */
  let releaseSlot: (() => void) | null = null;
  try {
    releaseSlot = await acquireLoopSlot({ priority: params.priority ?? 5, timeoutMs: 60_000 });
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

  /* ── 初始化循环状态 ── */
  const s = await initializeLoopState(params);
  const { loopId, observations, subjectPayload } = s;
  let { iterations, succeededSteps, failedSteps, lastDecision, currentSeq } = s;
  let { memoryContext, taskHistory, knowledgeContext, strategyContext, goalGraph, worldState } = s;
  const { informationGaps } = s;
  const executionConstraints = s.executionConstraints ?? undefined;
  const { toolDiscovery, auditCtx, loopStartedAt } = s;

  let _loopFinalResult: AgentLoopResult | null = null;
  const budget: LoopBudget = createDefaultBudget();
  const failureDiagnoses: FailureDiagnosis[] = [];
  const semanticAuditTrail: SemanticAuditEntry[] = [];
  let degradedCompletion = false;

  /* ── Agent Tracing 初始化（静默失败，不影响主流程） ── */
  let tracingCtx: AgentTracingContext | null = null;
  const loopTraceStartMs = Date.now();
  let tracingToolCallCount = 0;
  try {
    tracingCtx = startAgentTracing(
      createTracerAdapter(),
      { runId, tenantId: subject.tenantId, spaceId: subject.spaceId },
    );
  } catch { /* tracing init failure is non-fatal */ }

  function buildResult(endReason: AgentLoopResult["endReason"], message: string, verification?: VerificationResult): AgentLoopResult {
    const r: AgentLoopResult = {
      ok: endReason === "done" || endReason === "ask_user",
      endReason, iterations, succeededSteps, failedSteps,
      message, observations, lastDecision, loopId,
      verification, goalGraph: goalGraph ?? undefined,
      budgetSnapshot: { ...budget },
    };
    _loopFinalResult = r;
    return r;
  }

  /**
   * 优雅降级：在资源耗尽退出前，收集已完成的步骤和中间结果，
   * 将其封装为 AgentLoopResult 返回，标记为 partialResult: true。
   * 核心目标：不丢失中间结果。
   */
  function gracefulDegradation(endReason: AgentLoopResult["endReason"], message: string): AgentLoopResult {
    // 收集已成功完成的步骤摘要
    const completedStepsSummary = observations
      .filter(o => o.status === "succeeded")
      .map(o => `- [${o.toolRef}] seq=${o.seq}: ${JSON.stringify(o.outputDigest ?? {}).slice(0, 150)}`)
      .join("\n");

    // 构建进度摘要
    const progressLines: string[] = [];
    progressLines.push(`已完成 ${succeededSteps}/${succeededSteps + failedSteps} 个步骤 (迭代 ${iterations} 次)`);
    if (lastDecision) {
      progressLines.push(`最后决策: ${lastDecision.action} - ${lastDecision.reasoning.slice(0, 200)}`);
    }
    if (goalGraph && goalGraph.subGoals.length > 0) {
      const completed = goalGraph.subGoals.filter(sg => sg.status === "completed").length;
      progressLines.push(`目标进度: ${completed}/${goalGraph.subGoals.length} 子目标已完成`);
    }
    if (completedStepsSummary) {
      progressLines.push(`\n已完成步骤摘要:\n${completedStepsSummary}`);
    }
    if (failureDiagnoses.length > 0) {
      const diagSummary = failureDiagnoses
        .map(d => `- [${d.failureType}] goal=${d.affectedGoalId.slice(0, 40)} retryable=${d.isRetryable}: ${d.rootCause.slice(0, 120)}`)
        .join("\n");
      progressLines.push(`\n失败诊断 (${failureDiagnoses.length}):\n${diagSummary}`);
    }

    const progressSummary = progressLines.join("\n");
    const degradedMessage = `${message}\n---\n优雅降级: 已保留中间结果\n${progressSummary}`;

    const r: AgentLoopResult = {
      ok: false,
      endReason, iterations, succeededSteps, failedSteps,
      message: degradedMessage,
      observations, lastDecision, loopId,
      goalGraph: goalGraph ?? undefined,
      budgetSnapshot: { ...budget },
      partialResult: true,
      progressSummary,
    };
    _loopFinalResult = r;
    return r;
  }

  try {
    while (iterations < maxIterations) {
      // 检查中断信号
      if (signal?.aborted) {
        await finalizeCheckpoint(pool, loopId, "interrupted").catch((e: unknown) => {
          app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(interrupted) failed");
        });
        const result = buildResult("interrupted", "用户中断了任务执行");
        onLoopEnd?.(result);
        return result;
      }

      // 检查超时
      if (Date.now() - loopStartedAt > maxWallTimeMs) {
        await finalizeCheckpoint(pool, loopId, "failed").catch((e: unknown) => {
          app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(failed/timeout) failed");
        });
        const result = gracefulDegradation("max_wall_time", `执行超时 (>${maxWallTimeMs}ms)`);
        onLoopEnd?.(result);
        return result;
      }

      iterations++;
      const iterStart = performance.now();

      // ── 首次迭代后解析目标分解结果（异步延迟加载） ──
      if (iterations === 2 && s.goalDecompPromise) {
        try {
          const decompResult = await s.goalDecompPromise;
          if (decompResult.graph) {
            goalGraph = decompResult.graph;
          }
          s.goalDecompPromise = null; // 清除引用，避免重复 await
        } catch (e: any) {
          app.log.warn({ err: e?.message, runId }, "[AgentLoop] 延迟加载 GoalGraph 失败（继续使用纯文本目标）");
        }
      }

      // ── Tracing: 迭代开始 ──
      try { if (tracingCtx) startIteration(tracingCtx, iterations); } catch { /* noop */ }

      // ── 预算检查 ──
      const budgetCheck = isBudgetExhausted(budget);
      if (budgetCheck.exhausted) {
        app.log.warn({ runId, iteration: iterations, reason: budgetCheck.reason }, "[AgentLoop] 预算耗尽");
        await safeTransitionRun(pool, runId, "stopped", { log: app.log });
        await finalizeCheckpoint(pool, loopId, "failed").catch((e: unknown) => {
          app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(budget) failed");
        });
        const result = gracefulDegradation("budget_exhausted", `预算耗尽: ${budgetCheck.reason}`);
        onLoopEnd?.(result);
        return result;
      }

      // ── Phase 1: Observe ──
      try { if (tracingCtx) startPhase(tracingCtx, "observe", iterations); } catch { /* noop */ }
      if (iterations === 1 && AGENT_LOOP_BATCH_OBSERVE) {
        const batchResult = await buildObservationsBatch(pool, runId, 0);
        if (batchResult.observations.length > 0) observations.push(...batchResult.observations);
        if (batchResult.dbDurationMs > 0) app.metrics.observeObserveDbDuration({ durationMs: batchResult.dbDurationMs });
      }
      const lastObs = observations.length > 0 ? observations[observations.length - 1] : null;
      try { if (tracingCtx) endPhase(tracingCtx); } catch { /* noop */ }

      // ── Phase 2: Think ──
      try { if (tracingCtx) startPhase(tracingCtx, "think", iterations); } catch { /* noop */ }
      const iterationStartMs = Date.now();
      // 构建迭代上下文（GoalGraph + WorldState + 环境状态 + 动态策略）
      const iterCtx = await buildIterationContext({
        pool, subject: subject as any, runId, goal, iterations, observations,
        goalGraph, worldState, strategyContext, auditCtx, log: app.log,
      });
      worldState = iterCtx.updatedWorldState;

      // LLM 调用（并行/串行）+ 决策质量评估重试循环
      let modelOutputText = "";
      let currentModelUsed = "";
      let decisionRetryCount = 0;
      let forcePurpose: string | undefined;
      let upgradedFrom: string | undefined;
      const qualityConfig = getDecisionQualityConfig();

      try {
        const llmResult = await invokeLlmForDecision({
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
          informationGaps,
          defaultModelRef,
          forcePurpose,
        });
        modelOutputText = llmResult.outputText;
        currentModelUsed = llmResult.modelUsed;
        if (llmResult.llmDurationMs > 0) app.metrics.observeThinkLlmDuration({ durationMs: llmResult.llmDurationMs });
      } catch (llmErr: any) {
        app.log.error({ err: llmErr, runId, iteration: iterations }, "[AgentLoop] LLM 调用失败");
        const result = buildResult("error", `LLM 调用失败：${llmErr?.message ?? "unknown"}`);
        onLoopEnd?.(result);
        return result;
      }

      // 记录 LLM Token 消耗（估算：输入+输出字符数/4）
      const estimatedTokens = Math.ceil(modelOutputText.length / 4);
      recordTokenUsage(budget, estimatedTokens);

      try { if (tracingCtx) endPhase(tracingCtx); } catch { /* noop */ }

      // 处理 Think 阶段意图漂移检测结果
      if (iterCtx.intentDrift?.drifted) {
        app.log.warn({
          runId, iteration: iterations,
          driftScore: iterCtx.intentDrift.driftScore,
          shouldReset: iterCtx.intentDrift.shouldResetAnchor,
        }, "[AgentLoop] 意图漂移检测结果注入决策上下文");
      }
      // P6: 意图漂移指标打点
      if (iterCtx.intentDrift) {
        app.metrics.setDriftScore({ score: iterCtx.intentDrift.driftScore ?? 0 });
        app.metrics.incDriftDetectionMethod({ method: (iterCtx.intentDrift as any).method ?? "keyword" });
      }

      // ── Phase 3: Decide ──
      try { if (tracingCtx) startPhase(tracingCtx, "decide", iterations); } catch { /* noop */ }
      const decideStartMs = Date.now();
      let decision = parseAgentDecision(modelOutputText);

      // ── 决策质量评估：低置信度重试/升级模型（可选增强，不阻塞主流程） ──
      try {
        // 快速模型不触发决策质量重试（降低延迟）
        const isFastTier = currentModelUsed.includes("fast");
        if (isFastTier || turboSkipDecisionRetry()) {
          // 附加基础质量评分但跳过重试
          decision.qualityScore = { confidence: -1, retryCount: 0, modelUsed: currentModelUsed, skippedReason: "fast_tier" } as any;
        } else {
        const rawJsonMatch = modelOutputText.match(/\{[\s\S]*\}/);
        const parsedRaw = rawJsonMatch ? JSON.parse(rawJsonMatch[0]) : {};
        let confidence = extractConfidenceFromOutput(modelOutputText, parsedRaw);
        let qualityAction = evaluateDecisionQuality({ confidence, retryCount: decisionRetryCount, config: qualityConfig });

        while (qualityAction.action !== "accept") {
          if (qualityAction.action === "retry") {
            decisionRetryCount++;
            app.log.info({ runId, iteration: iterations, retryCount: decisionRetryCount, confidence }, "[AgentLoop] 决策置信度过低，重试");
          } else if (qualityAction.action === "upgrade") {
            upgradedFrom = currentModelUsed;
            forcePurpose = "agent.loop.think"; // 升级到标准模型
            decisionRetryCount++;
            app.log.info({ runId, iteration: iterations, upgradedFrom, forcePurpose }, "[AgentLoop] 决策置信度过低且重试耗尽，升级模型");
          }

          // 重新调用 LLM
          try {
            const retryResult = await invokeLlmForDecision({
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
              informationGaps,
              defaultModelRef,
              forcePurpose,
            });
            modelOutputText = retryResult.outputText;
            currentModelUsed = retryResult.modelUsed;
            recordTokenUsage(budget, Math.ceil(modelOutputText.length / 4));
            decision = parseAgentDecision(modelOutputText);

            const retryRawMatch = modelOutputText.match(/\{[\s\S]*\}/);
            const retryParsedRaw = retryRawMatch ? JSON.parse(retryRawMatch[0]) : {};
            confidence = extractConfidenceFromOutput(modelOutputText, retryParsedRaw);
            qualityAction = evaluateDecisionQuality({ confidence, retryCount: decisionRetryCount, config: qualityConfig });
          } catch (retryErr: unknown) {
            app.log.warn({ err: (retryErr as Error)?.message, runId, iteration: iterations }, "[AgentLoop] 决策质量重试失败，使用原始决策");
            break;
          }

          // 升级后无论结果如何都接受，防止无限循环
          if (upgradedFrom) break;
        }

        // 附加质量评分到决策
        const qualityScore: DecisionQualityScore = {
          confidence,
          retryCount: decisionRetryCount,
          modelUsed: currentModelUsed,
          ...(upgradedFrom ? { upgradedFrom } : {}),
        };
        decision.qualityScore = qualityScore;

        // P6: 决策质量细粒度打点
        if (decisionRetryCount > 0) app.metrics.incThinkRetryCount({ count: decisionRetryCount });
        if (confidence >= 0) app.metrics.setThinkConfidence({ confidence });
        }
      } catch (qualityErr: unknown) {
        // 决策质量评估为可选增强，失败不阻塞主流程
        app.log.warn({ err: (qualityErr as Error)?.message, runId, iteration: iterations }, "[AgentLoop] 决策质量评估异常（不影响执行）");
      }

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

      try { if (tracingCtx) endPhase(tracingCtx, { "agent.decision": decision.action }); } catch { /* noop */ }

      // ── Phase 4: Act ──
      try { if (tracingCtx) startPhase(tracingCtx, "act", iterations); } catch { /* noop */ }
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
          await finalizeCheckpoint(pool, loopId, "failed").catch((e: unknown) => {
            app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(failed/abort) failed");
          });
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
          }).catch((e: unknown) => {
            app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] writeCheckpoint(paused) failed");
          });
          const result = buildResult("ask_user", decision.question ?? "需要更多信息");
          onLoopEnd?.(result);
          return result;
        }

        case "replan": {
          // 重新规划：清除 pending 步骤，重新进入下一轮循环让 LLM 产出新的 tool_call
          app.log.info({ runId, iteration: iterations, reasoning: decision.reasoning }, "[AgentLoop] 重新规划");
          // steps 表主链路按 run_id 归属，pending 清理这里沿用同样口径
          await deletePendingSteps(pool, runId);
          continue; // 继续循环，LLM 会在下一轮产出新的 tool_call
        }

        case "parallel_tool_calls": {
          // 并行执行多个独立工具调用
          const calls = decision.parallelCalls ?? [];
          if (calls.length === 0) {
            app.log.warn({ runId, iteration: iterations }, "[AgentLoop] parallel_tool_calls 但 parallelCalls 为空，跳过");
            continue;
          }

          const PARALLEL_TOTAL_TIMEOUT_MS = resolveNumber("AGENT_LOOP_PARALLEL_TOTAL_TIMEOUT_MS").value;

          app.log.info({ runId, iteration: iterations, callCount: calls.length }, "[AgentLoop] 并行执行");

          // 3a: 并行下发所有工具调用（Promise.allSettled 防止单工具 head-of-line blocking）
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
          const execSettled = await Promise.allSettled(execPromises);
          const execResults = execSettled.map((s, i) =>
            s.status === "fulfilled"
              ? s.value
              : { stepId: "", ok: false as const, error: String(s.reason), executionTimeoutMs: 120_000 }
          );

          // 并行等待所有步骤完成
          const stepPromises = execResults.map((r) =>
            r.ok ? waitForStepCompletion(pool, r.stepId, signal, r.executionTimeoutMs) : Promise.resolve({ status: "failed" as const, outputDigest: { error: r.error }, output: null as any, errorCategory: ErrorCategory.INPUT_VALIDATION_FAILED as string | null })
          );

          // 3b: 并行执行总超时 gate
          let totalTimeoutId: ReturnType<typeof setTimeout> | undefined;
          const totalTimeoutPromise = new Promise<never>((_, reject) => {
            totalTimeoutId = setTimeout(() => reject(new Error("parallel_total_timeout")), PARALLEL_TOTAL_TIMEOUT_MS);
          });

          let stepResults: Array<SettledResult<any>>;
          try {
            stepResults = await Promise.race([
              collectInCompletionOrder(stepPromises),
              totalTimeoutPromise,
            ]);
          } catch (err: any) {
            if (err?.message === "parallel_total_timeout") {
              app.log.warn({ runId, callCount: calls.length }, "[AgentLoop] 并行执行总超时");
              stepResults = stepPromises.map((_, i) => ({
                index: i,
                status: "rejected" as const,
                error: "parallel_total_timeout",
              }));
            } else {
              throw err;
            }
          } finally {
            if (totalTimeoutId) clearTimeout(totalTimeoutId);
          }

          // 3c: 收集所有观察（支持 rejected）
          for (const settled of stepResults) {
            const i = settled.index;
            const isRejected = settled.status === "rejected";
            const obs: StepObservation = {
              stepId: isRejected ? "" : (execResults[i].stepId ?? ""),
              seq: currentSeq + i,
              toolRef: calls[i].toolRef,
              status: isRejected ? "failed" : (settled.value?.status ?? "failed"),
              outputDigest: isRejected ? { error: String(settled.error) } : (settled.value?.outputDigest ?? null),
              output: isRejected ? null : (settled.value?.output ?? null),
              errorCategory: isRejected ? ErrorCategory.TOOL_EXECUTION_FAILED : (settled.value?.errorCategory ?? null),
              durationMs: null,
            };
            observations.push(obs);
            if (!isRejected && settled.value?.status === "succeeded") succeededSteps++;
            else failedSteps++;
            if (onStepComplete) await onStepComplete(obs, decision);
          }
          currentSeq += calls.length;

          // 记录并行工具执行的预算消耗
          for (let i = 0; i < calls.length; i++) {
            recordCostUsage(budget, 0);
          }

          // P0-2: 并行工具调用打点
          const parallelSuccessCount = stepResults.filter(s => s.status === "fulfilled" && s.value?.status === "succeeded").length;
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
          const originalToolRef = decision.toolRef ?? "";
          const tcResult = await handleToolCallAction({
            app, pool, queue, subject: subject as any,
            traceId, runId, jobId: jobId ?? "", loopId, goal, iterations,
            decision, currentSeq, executionConstraints, signal, worldState, goalGraph,
            toolCatalog: toolDiscovery.tools.map(t => ({ ref: t.toolRef, category: t.def.category, requiredAction: t.def.action ?? undefined })),
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
            if (tcResult.diagnosis) failureDiagnoses.push(tcResult.diagnosis);
            continue;
          }
          // executed
          observations.push(tcResult.obs);
          if (tcResult.succeeded) succeededSteps++; else failedSteps++;
          currentSeq++;
          recordCostUsage(budget, 0); // 记录工具执行次数（实际成本由计费系统填充）
          if (onStepComplete) await onStepComplete(tcResult.obs, decision);
          worldState = tcResult.worldState;
          goalGraph = tcResult.goalGraph;
          if (tcResult.diagnosis) failureDiagnoses.push(tcResult.diagnosis);

          // ── fallback 后目标重评估 ──
          if (tcResult.fallbackImpact) {
            const fbImpact = tcResult.fallbackImpact;
            // 追加语义审计条目
            if (fbImpact.impact !== "none") {
              semanticAuditTrail.push({
                timestamp: new Date().toISOString(),
                originalToolId: originalToolRef,
                fallbackToolId: decision.toolRef ?? "",
                impact: fbImpact,
                goalId: runId,
              });
            }
            if (fbImpact.impact === "degraded") {
              degradedCompletion = true;
              app.log.info({ runId, iteration: iterations, reason: fbImpact.reason }, "[AgentLoop] Fallback 导致精度降级，标记 degradedCompletion");
            } else if (fbImpact.impact === "goal_unreachable") {
              const driftDiagnosis: FailureDiagnosis = {
                failureType: "tool_semantic_drift",
                affectedGoalId: runId,
                rootCause: fbImpact.reason,
                isRetryable: false,
                suggestedActions: [{ type: "abort_branch", reason: fbImpact.reason }],
              };
              failureDiagnoses.push(driftDiagnosis);
              app.log.warn({ runId, iteration: iterations, reason: fbImpact.reason }, "[AgentLoop] Fallback 导致目标不可达，触发重规划");
              // 清除 pending 步骤，下一轮 LLM 将收到 failureDiagnoses 上下文并重新决策
              await deletePendingSteps(pool, runId);
              continue; // 跳到下一轮循环，让 LLM 根据 failureDiagnoses 重规划
            }
          }
          break;
        }

        default: {
          // 未知决策，安全终止
          await finalizeCheckpoint(pool, loopId, "failed").catch((e: unknown) => {
            app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(failed/unknown) failed");
          });
          const result = buildResult("error", `Unknown decision action: ${(decision as unknown as Record<string, unknown>).action}`);
          onLoopEnd?.(result);
          return result;
        }
      }

      // ── Tracing: act phase 结束 ──
      try {
        if (tracingCtx) {
          const actToolCount = decision.action === "parallel_tool_calls"
            ? (decision.parallelCalls?.length ?? 0)
            : (decision.action === "tool_call" ? 1 : 0);
          endPhase(tracingCtx, { "agent.tool_count": actToolCount });
          tracingToolCallCount += actToolCount;
        }
      } catch { /* noop */ }

      // P0-1: 每次迭代结束后写 checkpoint（分层：fast 轻量 / full 完整）
      const decisionAction: string = decision.action;
      const isPhaseTransition = decisionAction === "replan" || decisionAction === "done" || decisionAction === "abort";
      const checkpointTier: "fast" | "full" = (isPhaseTransition || iterations % AGENT_LOOP_FULL_CHECKPOINT_INTERVAL === 0 || iterations === 1)
        ? "full" : "fast";

      const checkpointParams: WriteCheckpointParams = {
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
      };

      const ckptStart = performance.now();
      if (checkpointTier === "fast" && turboSkipFastCheckpoint()) {
        // turbo mode: 完全跳过 fast tier 检查点写入
      } else if (checkpointTier === "fast") {
        // fast tier 异步写入，不阻塞主循环
        writeCheckpoint(checkpointParams, "fast").catch((e: unknown) => {
          app.log.warn({ err: (e as Error)?.message, runId, loopId, iteration: iterations }, "[AgentLoop] fast checkpoint 写入失败（不阻塞主循环）");
        });
      } else {
        // full tier 仍然 await（保证恢复一致性）
        await writeCheckpoint(checkpointParams, "full").catch((e: unknown) => {
          app.log.warn({ err: (e as Error)?.message, runId, loopId, iteration: iterations }, "[AgentLoop] full checkpoint 写入失败（不阻塞主循环）");
        });
      }
      const ckptDur = Math.round(performance.now() - ckptStart);
      const totalDur = Math.round(performance.now() - iterStart);
      app.log.debug('[perf] iteration=%d checkpoint=%dms total=%dms', iterations, ckptDur, totalDur);
    }

    // 达到最大迭代次数
    await safeTransitionRun(pool, runId, "stopped", { log: app.log });
    await finalizeCheckpoint(pool, loopId, "failed").catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(failed/maxIter) failed");
    });
    const result = gracefulDegradation("max_iterations", `达到最大迭代次数 (${maxIterations})`);
    onLoopEnd?.(result);
    return result;
  } catch (err: any) {
    app.log.error({ err, runId, iteration: iterations }, "[AgentLoop] 循环异常");
    await safeTransitionRun(pool, runId, "failed", { finishedAt: true, log: app.log }).catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] safeTransitionRun(failed) failed");
    });
    await finalizeCheckpoint(pool, loopId, "failed").catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, runId, loopId }, "[AgentLoop] finalizeCheckpoint(failed/error) failed");
    });
    const result = buildResult("error", `Agent Loop 异常: ${err?.message ?? "unknown"}`);
    onLoopEnd?.(result);
    return result;
  } finally {
    // ── 语义偏移审计报告（覆盖所有退出路径） ──
    if (semanticAuditTrail.length > 0) {
      const unreachableCount = semanticAuditTrail.filter(e => e.impact.impact === "goal_unreachable").length;
      const degradedCount = semanticAuditTrail.filter(e => e.impact.impact === "degraded").length;
      const needsHumanConfirmation = unreachableCount > 0;
      app.log.info({
        type: "semantic_drift_report",
        runId,
        totalFallbacks: semanticAuditTrail.length,
        unreachable: unreachableCount,
        degraded: degradedCount,
        degradedCompletion,
        needsHumanConfirmation,
        trail: semanticAuditTrail,
      }, "[AgentLoop] 语义偏移审计报告");
      if (needsHumanConfirmation && _loopFinalResult) {
        (_loopFinalResult as any).needsHumanConfirmation = true;
        (_loopFinalResult as any).semanticAuditTrail = semanticAuditTrail;
      }
    }

    // 将 degradedCompletion 标记写入最终结果，供上层感知精度降级
    if (degradedCompletion && _loopFinalResult) {
      (_loopFinalResult as any).degradedCompletion = true;
    }

    // ── Tracing: 结束 Agent Loop 追踪（静默失败） ──
    try {
      if (tracingCtx) {
        const finalResult = _loopFinalResult as AgentLoopResult | null;
        const tracingStatus = finalResult?.ok ? "completed"
          : finalResult?.endReason === "max_wall_time" ? "timeout"
          : "failed";
        endAgentTracing(tracingCtx, {
          totalIterations: iterations,
          totalLatencyMs: Date.now() - loopTraceStartMs,
          toolCallCount: tracingToolCallCount,
          status: tracingStatus,
          error: finalResult?.ok ? undefined : finalResult?.message,
        });
      }
    } catch { /* tracing finalization failure is non-fatal */ }

    finalizeLoopProcess({
      pool, app, state: s, result: _loopFinalResult,
      releaseSlot, subject, runId, goal,
    });
  }
}

/* Auto-Reflexion → loopAutoReflexion.ts */
