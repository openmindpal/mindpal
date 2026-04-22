/**
 * AgentLoopTaskExecutor — 队列调度 ↔ AgentLoop 执行桥接器
 *
 * 实现 TaskExecutor 接口，是多任务并发队列系统的执行引擎。
 *
 * 核心职责：
 * 1. AbortController 生命周期管理 — 每个执行中的任务一个 AC，cancel/pause 通过 signal 传播
 * 2. 执行上下文注册 — dispatch.stream.ts 在 enqueue 前注册 SSE 回调等上下文
 * 3. 完成等待器 — 前台任务的 dispatch.stream.ts 可以等待执行结果
 * 4. 后台任务自动完成 — 无等待器时自动调用 markCompleted/markFailed
 * 5. 与 sessionEventBus 集成 — 后台任务事件仅通过 eventBus 推送
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { TaskQueueEntry } from "./taskQueue.types";
import type { TaskExecutor } from "./taskQueueManager";
import type { AgentLoopResult, AgentLoopParams, StepObservation, AgentDecision } from "./loopTypes";
import { runAgentLoop } from "./agentLoop";
import { emitTaskEvent } from "../lib/sessionEventBus";
import { StructuredLogger } from "@openslin/shared";

/* ================================================================== */
/*  日志                                                               */
/* ================================================================== */

const _logger = new StructuredLogger({ module: "agentLoopTaskExecutor" });

function log(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
  _logger[level](msg, ctx);
}

function normalizeStepPresentationStatus(status: string): string {
  const value = String(status ?? "").trim();
  if (!value) return "failed";
  if (
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled" ||
    value === "deadletter" ||
    value === "needs_approval" ||
    value === "needs_device" ||
    value === "needs_arbiter" ||
    value === "paused"
  ) {
    return value;
  }
  return "failed";
}

function deriveLoopPresentationStatus(loopResult: AgentLoopResult): "succeeded" | "paused" | "failed" {
  if (loopResult.endReason === "ask_user") return "paused";
  return loopResult.ok ? "succeeded" : "failed";
}

async function resolveApprovalContextForStep(params: {
  app: FastifyInstance;
  tenantId: string;
  runId: string;
  stepId?: string | null;
}): Promise<{ approvalId: string; riskLevel: string; humanSummary: string; inputDigest: any } | null> {
  const { app, tenantId, runId, stepId } = params;
  if (!stepId) return null;
  try {
    const res = await (app as any).db.query(
      `SELECT approval_id, assessment_context, input_digest
         FROM approvals
        WHERE tenant_id = $1
          AND run_id = $2
          AND step_id = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, runId, stepId],
    );
    if (!res.rowCount) return null;
    const row = res.rows[0];
    const ctx = typeof row.assessment_context === "string"
      ? JSON.parse(row.assessment_context)
      : (row.assessment_context ?? {});
    return {
      approvalId: String(row.approval_id ?? ""),
      riskLevel: ctx.riskLevel ?? "medium",
      humanSummary: ctx.humanSummary ?? "",
      inputDigest: row.input_digest ?? null,
    };
  } catch {
    return null;
  }
}

function createBackgroundStepCallback(params: {
  app: FastifyInstance;
  tenantId: string;
  sessionId?: string | null;
  taskId?: string | null;
  runId: string;
  traceId?: string | null;
}) {
  const { app, tenantId, sessionId, taskId, runId, traceId } = params;
  return async (obs: StepObservation, stepDecision: AgentDecision): Promise<void> => {
    if (!sessionId) return;
    const normalizedStatus = normalizeStepPresentationStatus(obs.status);
    emitTaskEvent(sessionId, tenantId, taskId ?? "", "stepProgress", {
      runId,
      taskId: taskId ?? null,
      traceId: traceId ?? null,
      requestId: null,
      step: {
        seq: obs.seq,
        stepId: obs.stepId ?? null,
        toolRef: obs.toolRef,
        status: obs.status,
        reasoning: stepDecision.reasoning.slice(0, 300),
        outputDigest: obs.outputDigest ? JSON.stringify(obs.outputDigest).slice(0, 200) : null,
        errorCategory: obs.errorCategory,
      },
    });
    emitTaskEvent(sessionId, tenantId, taskId ?? "", "executionReceipt", {
      runId,
      stepId: obs.stepId ?? null,
      toolRef: obs.toolRef,
      traceId: traceId ?? null,
      requestId: null,
      status: normalizedStatus,
      output: obs.outputDigest ? JSON.stringify(obs.outputDigest).slice(0, 500) : null,
      error: obs.errorCategory ?? null,
      latencyMs: obs.durationMs ?? null,
    });
    if (obs.status === "needs_approval") {
      const approvalCtx = await resolveApprovalContextForStep({
        app,
        tenantId,
        runId,
        stepId: obs.stepId ?? null,
      });
      emitTaskEvent(sessionId, tenantId, taskId ?? "", "approvalNode", {
        approvalId: approvalCtx?.approvalId ?? "",
        runId,
        taskId: taskId ?? null,
        stepId: obs.stepId ?? null,
        toolRef: obs.toolRef,
        traceId: traceId ?? null,
        requestId: null,
        status: "pending",
        requestedAt: new Date().toISOString(),
        decidedAt: null,
        // 审批上下文增强字段
        riskLevel: approvalCtx?.riskLevel ?? "medium",
        humanSummary: approvalCtx?.humanSummary ?? `工具 ${obs.toolRef} 需要审批`,
        inputDigest: approvalCtx?.inputDigest ?? null,
      });
    }
    const toolName = obs.toolRef.replace(/@\d+$/, "");
    const shortText =
      normalizedStatus === "succeeded"
        ? `\n\n✅ ${toolName} succeeded\n`
        : normalizedStatus === "needs_approval"
          ? `\n\n⏸️ ${toolName} awaiting approval\n`
          : normalizedStatus === "needs_device"
            ? `\n\n⏸️ ${toolName} awaiting device result\n`
            : normalizedStatus === "needs_arbiter"
              ? `\n\n⏸️ ${toolName} awaiting arbiter\n`
              : normalizedStatus === "paused"
                ? `\n\n⏸️ ${toolName} paused\n`
                : normalizedStatus === "canceled"
                  ? `\n\n🚫 ${toolName} canceled\n`
                  : `\n\n❌ ${toolName} failed\n`;
    emitTaskEvent(sessionId, tenantId, taskId ?? "", "delta", { text: shortText });
  };
}

function createBackgroundLoopEndCallback(params: {
  tenantId: string;
  sessionId?: string | null;
  taskId?: string | null;
  runId: string;
  traceId?: string | null;
}) {
  const { tenantId, sessionId, taskId, runId, traceId } = params;
  return (loopResult: AgentLoopResult): void => {
    if (!sessionId) return;
    const presentationStatus = deriveLoopPresentationStatus(loopResult);
    emitTaskEvent(sessionId, tenantId, taskId ?? "", "agentLoopEnd", {
      runId,
      taskId: taskId ?? null,
      traceId: traceId ?? null,
      requestId: null,
      ok: loopResult.ok,
      status: presentationStatus,
      endReason: loopResult.endReason,
      iterations: loopResult.iterations,
      succeededSteps: loopResult.succeededSteps,
      failedSteps: loopResult.failedSteps,
    });
    emitTaskEvent(sessionId, tenantId, taskId ?? "", "runSummary", {
      runId,
      taskId: taskId ?? null,
      traceId: traceId ?? null,
      requestId: null,
      status: presentationStatus,
      totalSteps: loopResult.iterations,
      completedSteps: loopResult.succeededSteps,
      totalLatencyMs: null,
      artifacts: [],
    });
  };
}

/* ================================================================== */
/*  执行上下文                                                          */
/* ================================================================== */

/** 前台任务注册的执行上下文（包含 SSE 回调） */
export interface ExecutionContext {
  app: FastifyInstance;
  pool: Pool;
  queue: any; // WorkflowQueue
  subject: { tenantId: string; spaceId: string; subjectId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  maxIterations: number;
  maxWallTimeMs: number;
  executionConstraints?: { allowedTools?: string[]; allowWrites?: boolean };
  defaultModelRef?: string;
  /** 可选 SSE 回调（前台任务由 dispatch.stream.ts 提供） */
  onStepComplete?: AgentLoopParams["onStepComplete"];
  onLoopEnd?: AgentLoopParams["onLoopEnd"];
  /** 可选: requestId（用于日志追踪） */
  requestId?: string;
}

/** 完成等待器 */
interface CompletionWaiter {
  resolve: (result: AgentLoopResult | null) => void;
  reject: (err: unknown) => void;
}

/** 回调：通知队列管理器任务完成/失败 */
export interface ExecutorCallbacks {
  onCompleted(entryId: string, result?: AgentLoopResult): Promise<void>;
  onFailed(entryId: string, error: string): Promise<void>;
}

/* ================================================================== */
/*  AgentLoopTaskExecutor                                              */
/* ================================================================== */

export class AgentLoopTaskExecutor implements TaskExecutor {
  /** 运行中任务的 AbortController */
  private controllers = new Map<string, AbortController>();
  /** 按 taskId 索引的预注册执行上下文（enqueue 前注册） */
  private pendingContexts = new Map<string, ExecutionContext>();
  /** P3-1 修复：按 entryId 索引的已消费上下文（用于抢占恢复） */
  private activeContexts = new Map<string, ExecutionContext>();
  /** 按 taskId 索引的完成等待器 */
  private waiters = new Map<string, CompletionWaiter>();
  /** 队列管理器回调（避免循环依赖） */
  private callbacks: ExecutorCallbacks | null = null;
  /** 默认 app 引用（用于后台任务构建上下文） */
  private app: FastifyInstance;

  constructor(app: FastifyInstance) {
    this.app = app;
  }

  /** 注入队列管理器回调（在 setExecutor 后调用） */
  setCallbacks(callbacks: ExecutorCallbacks) {
    this.callbacks = callbacks;
  }

  /* ── 上下文注册 + 等待 ────────────────────────────────── */

  /**
   * 前台任务：注册执行上下文并返回完成 Promise。
   * 必须在 enqueue 之前调用，因为 enqueue 可能立即触发 execute()。
   *
   * @param taskId 任务 ID（用作关联键，因为 entryId 在 enqueue 前不可知）
   * @param ctx 执行上下文（含 SSE 回调等）
   * @returns Promise<AgentLoopResult | null> — 任务完成时 resolve
   */
  prepareAndWait(taskId: string, ctx: ExecutionContext): Promise<AgentLoopResult | null> {
    this.pendingContexts.set(taskId, ctx);
    return new Promise((resolve, reject) => {
      this.waiters.set(taskId, { resolve, reject });
    });
  }

  /**
   * 检查指定 taskId 是否有预注册的上下文。
   */
  hasContext(taskId: string): boolean {
    return this.pendingContexts.has(taskId);
  }

  /* ── TaskExecutor 接口实现 ──────────────────────────────── */

  /**
   * 开始执行任务。
   * 由 TaskQueueManager.startExecution() 调用（非阻塞）。
   */
  async execute(entry: TaskQueueEntry): Promise<void> {
    const taskId = entry.taskId;

    // 查找预注册的前台上下文
    let ctx = taskId ? this.pendingContexts.get(taskId) : null;
    // P3-1 修复：抢占恢复时从 activeContexts 查找保留的上下文
    if (!ctx) {
      ctx = this.activeContexts.get(entry.entryId) ?? null;
    }
    const waiter = taskId ? this.waiters.get(taskId) : null;
    const isForeground = !!waiter || !!ctx;

    if (ctx && taskId) {
      this.pendingContexts.delete(taskId);
      // P3-1: 保留上下文用于抢占恢复
      this.activeContexts.set(entry.entryId, ctx);
    }
    if (waiter && taskId) {
      this.waiters.delete(taskId);
    }

    // 创建 AbortController
    const ac = new AbortController();
    this.controllers.set(entry.entryId, ac);

    log("info", `Executing task`, {
      entryId: entry.entryId, taskId, mode: isForeground ? "foreground" : "background",
    });

    try {
      const loopParams = ctx
        ? this.buildForegroundParams(entry, ctx, ac.signal)
        : this.buildBackgroundParams(entry, ac.signal);

      const result = await runAgentLoop(loopParams);

      // 通知等待器（前台任务）
      if (isForeground && waiter) {
        waiter.resolve(result);
      } else {
        // 后台任务：自动标记完成
        if (this.callbacks) {
          await this.callbacks.onCompleted(entry.entryId, result);
        }
      }
    } catch (err: any) {
      const errMsg = String(err?.message || err);

      // P0-2 + P1-1 修复：识别受控 abort 信号，不触发 onFailed
      const isControlledAbort = errMsg.includes("task_paused")
        || errMsg.includes("task_cancelled")
        || ac.signal.aborted;

      if (isForeground && waiter) {
        waiter.reject(err);
      } else if (!isControlledAbort) {
        // 后台任务：仅对真实错误调用 onFailed，受控 abort 不触发
        if (this.callbacks) {
          await this.callbacks.onFailed(entry.entryId, errMsg).catch((e2: unknown) => {
            _logger.warn("callbacks.onFailed fire-and-forget failed", { err: (e2 as Error)?.message, entryId: entry.entryId });
          });
        }
      } else {
        log("info", `Task execution aborted (controlled)`, {
          entryId: entry.entryId, reason: errMsg,
        });
      }
      // 不再 re-throw：executor 已统一处理完毕，避免 startExecution catch 重复 markFailed
    } finally {
      this.controllers.delete(entry.entryId);
      // P3-1: 正常完成/失败时清理上下文，抢占保留
      // 受控 abort（task_paused）时保留 activeContext 供恢复使用
      const errMsg = ac.signal.reason ? String(ac.signal.reason?.message || ac.signal.reason) : "";
      if (!errMsg.includes("task_paused")) {
        this.activeContexts.delete(entry.entryId);
      }
    }
  }

  /**
   * 暂停正在执行的任务。
   * 通过 abort signal 通知 AgentLoop 停止。
   */
  async pause(entry: TaskQueueEntry): Promise<void> {
    const ac = this.controllers.get(entry.entryId);
    if (ac) {
      log("info", `Pausing task via AbortController`, { entryId: entry.entryId });
      ac.abort(new Error("task_paused"));
    } else {
      log("warn", `No AbortController found for pause`, { entryId: entry.entryId });
    }
  }

  /**
   * 恢复暂停的任务。
   * 由 TaskQueueManager.resume() → tryScheduleNext → startExecution → execute() 重新驱动。
   * 恢复时会创建新的 AbortController。
   */
  async resume(entry: TaskQueueEntry): Promise<void> {
    // resume 实际上走的是 tryScheduleNext → startExecution → execute()
    // 这里只做日志记录
    log("info", `Task resume requested (will be re-scheduled)`, { entryId: entry.entryId });
  }

  /**
   * 取消正在执行的任务。
   * 通过 abort signal 通知 AgentLoop 停止。
   */
  async cancel(entry: TaskQueueEntry): Promise<void> {
    const ac = this.controllers.get(entry.entryId);
    if (ac) {
      log("info", `Cancelling task via AbortController`, { entryId: entry.entryId });
      ac.abort(new Error("task_cancelled"));
    } else {
      log("warn", `No AbortController found for cancel`, { entryId: entry.entryId });
    }

    // 清理关联的等待器和上下文（如果有）
    this.activeContexts.delete(entry.entryId);
    if (entry.taskId) {
      const waiter = this.waiters.get(entry.taskId);
      if (waiter) {
        waiter.resolve(null); // resolve 为 null 表示被取消
        this.waiters.delete(entry.taskId);
      }
      this.pendingContexts.delete(entry.taskId);
    }
  }

  /* ── 查询方法 ──────────────────────────────────────────── */

  /** 获取当前执行中的任务数 */
  getActiveCount(): number {
    return this.controllers.size;
  }

  /** 检查指定任务是否正在执行 */
  isExecuting(entryId: string): boolean {
    return this.controllers.has(entryId);
  }

  /** 获取指定任务的 AbortSignal（用于外部集成） */
  getSignal(entryId: string): AbortSignal | null {
    return this.controllers.get(entryId)?.signal ?? null;
  }

  /* ── 内部方法 ──────────────────────────────────────────── */

  /** 构建前台任务的 AgentLoop 参数（使用预注册的 SSE 回调） */
  private buildForegroundParams(
    entry: TaskQueueEntry,
    ctx: ExecutionContext,
    signal: AbortSignal,
  ): AgentLoopParams {
    return {
      app: ctx.app,
      pool: ctx.pool,
      queue: ctx.queue,
      subject: ctx.subject as any,
      locale: ctx.locale,
      authorization: ctx.authorization,
      traceId: ctx.traceId,
      goal: entry.goal,
      runId: entry.runId!,
      jobId: entry.jobId!,
      taskId: entry.taskId!,
      maxIterations: ctx.maxIterations,
      maxWallTimeMs: ctx.maxWallTimeMs,
      executionConstraints: ctx.executionConstraints,
      defaultModelRef: ctx.defaultModelRef,
      signal,
      onStepComplete: ctx.onStepComplete,
      onLoopEnd: ctx.onLoopEnd,
    };
  }

  /**
   * 构建后台任务的 AgentLoop 参数。
   * 从 entry.metadata 或最小上下文构建，事件仅通过 sessionEventBus 推送。
   */
  private buildBackgroundParams(entry: TaskQueueEntry, signal: AbortSignal): AgentLoopParams {
    const meta = (entry.metadata ?? {}) as Record<string, any>;
    const app = this.app;
    const pool = (app as any).db as Pool;
    const queue = (app as any).queue;

    // P1-G6b: 将上游任务注入的 output 数据合并到 goal 上下文
    let goal = entry.goal;
    const injectedInputs = meta._injectedInputs as Record<string, Record<string, unknown>> | undefined;
    if (injectedInputs && Object.keys(injectedInputs).length > 0) {
      const injectedSummary = Object.entries(injectedInputs)
        .map(([fromEntryId, data]) => `[upstream ${fromEntryId}]: ${JSON.stringify(data)}`)
        .join("\n");
      goal = `${entry.goal}\n\n--- Injected inputs from upstream tasks ---\n${injectedSummary}`;
    }

    const sessionId = entry.sessionId;
    const taskId = entry.taskId;

    const subject = {
      tenantId: entry.tenantId,
      spaceId: entry.spaceId || meta.spaceId || "",
      subjectId: entry.createdBySubjectId,
    };

    const onStepComplete = createBackgroundStepCallback({
      app,
      tenantId: subject.tenantId,
      sessionId,
      taskId,
      runId: entry.runId!,
      traceId: meta.traceId ?? null,
    });

    const onLoopEnd = createBackgroundLoopEndCallback({
      tenantId: entry.tenantId,
      sessionId,
      taskId,
      runId: entry.runId!,
      traceId: meta.traceId ?? null,
    });

    return {
      app,
      pool,
      queue,
      subject: subject as any,
      locale: meta.locale || "zh-CN",
      authorization: meta.authorization || null,
      traceId: meta.traceId || null,
      goal,
      runId: entry.runId!,
      jobId: entry.jobId!,
      taskId: entry.taskId!,
      maxIterations: meta.maxIterations || 15,
      maxWallTimeMs: meta.maxWallTimeMs || 10 * 60 * 1000,
      executionConstraints: meta.executionConstraints,
      defaultModelRef: meta.defaultModelRef,
      signal,
      onStepComplete,
      onLoopEnd,
    };
  }
}

/* ================================================================== */
/*  工厂函数                                                            */
/* ================================================================== */

/** 创建 AgentLoopTaskExecutor 单例（绑定到 app） */
export function createAgentLoopTaskExecutor(app: FastifyInstance): AgentLoopTaskExecutor {
  return new AgentLoopTaskExecutor(app);
}
