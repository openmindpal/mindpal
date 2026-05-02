/**
 * Task Queue Manager — 会话级任务队列管理器
 *
 * OS 级进程调度器：管理会话内多任务的生命周期。
 * 核心职责：
 * 1. 入队/出队 — 任务入队后由调度器决定执行时机
 * 2. 并发控制 — 动态决定可同时执行的任务数（无硬编码上限）
 * 3. 依赖就绪检查 — 只有所有前置依赖满足后才允许执行
 * 4. 生命周期管理 — pause/resume/cancel/retry
 * 5. 级联操作 — 任务完成/失败时触发下游依赖处理
 */
import type { Pool } from "pg";
import type {
  TaskQueueEntry, EnqueueParams, EnqueueResult,
  ScheduleDecision, QueueSnapshot, QueueEntryStatus, QueueEvent,
  RetryConfig,
} from "./taskQueue.types";
import { TERMINAL_QUEUE_STATUSES, ACTIVE_STATUSES, RESUMABLE_STATUSES, DEFAULT_RETRY_CONFIG } from "./taskQueue.types";
import * as repo from "./taskQueueRepo";
import type { CheckpointData } from "./taskQueueRepo";
import { AppError } from "../lib/errors";
import { type TaskDependencyResolver } from "./taskDependencyResolver";
import { type SessionScheduler, type SessionConcurrencyConfig } from "./sessionScheduler";
import type { CheckpointService } from "./loopCheckpoint";
import { StructuredLogger, resolveNumber } from "@mindpal/shared";
import {
  cascadeCancel as _cascadeCancel,
  handleCompletionDeps,
  handleFailureCascade,
  handleCancelCascade,
  repairDependencyChain as _repairDependencyChain,
  pauseAllForShutdown as _pauseAllForShutdown,
  type QueueOpsContext,
} from "./taskQueueOps";

/* ================================================================== */
/*  日志                                                               */
/* ================================================================== */

const _logger = new StructuredLogger({ module: "taskQueueManager" });

function log(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
  _logger[level](msg, ctx);
}

/* ================================================================== */
/*  事件回调接口                                                        */
/* ================================================================== */

/** 外部注入的事件广播器 */
export interface QueueEventEmitter {
  emit(event: QueueEvent): void;
}

/** 外部注入的执行器（dispatch 层实现） */
export interface TaskExecutor {
  /** 开始执行一个任务 */
  execute(entry: TaskQueueEntry): Promise<void>;
  /** 暂停一个正在执行的任务 */
  pause(entry: TaskQueueEntry): Promise<void>;
  /** 恢复一个暂停的任务 */
  resume(entry: TaskQueueEntry): Promise<void>;
  /** 取消一个任务 */
  cancel(entry: TaskQueueEntry): Promise<void>;
}

/** Redis 客户端最小接口（仅需 get/set/del） */
export interface CheckpointRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string | string[]): Promise<number>;
}

/* ================================================================== */
/*  TaskCheckpointService — 任务级检查点 CheckpointService 实现           */
/* ================================================================== */

/**
 * 任务级检查点数据（存储于 task_checkpoints 表 + session_task_queue.checkpoint_ref）。
 * 底层存储方式不变，仅统一访问接口。
 */
export interface TaskCheckpointData {
  currentStep: number;
  intermediateResults: Record<string, unknown>[];
  context: Record<string, unknown>;
  savedAt: string;
}

/**
 * 任务级检查点服务 — 实现通用 CheckpointService<TaskCheckpointData> 接口。
 * 底层存储仍然是 task_checkpoints 表 + Redis 缓存，保持现有行为。
 * 心跳 / 锁为空操作（任务检查点不需要独立心跳和恢复锁）。
 */
export class TaskCheckpointService implements CheckpointService<TaskCheckpointData> {
  private pool: Pool;
  private redis: CheckpointRedisClient | null;
  private tenantId: string;
  private static readonly CHECKPOINT_TTL_SEC = resolveNumber("TASK_CHECKPOINT_TTL_SECONDS", undefined, undefined, 86400).value;

  constructor(pool: Pool, tenantId: string, redis?: CheckpointRedisClient | null) {
    this.pool = pool;
    this.tenantId = tenantId;
    this.redis = redis ?? null;
  }

  async write(id: string, data: TaskCheckpointData): Promise<void> {
    const checkpointRef = `checkpoint:${id}:${Date.now()}`;
    const fullData: repo.CheckpointData = {
      currentStep: data.currentStep,
      intermediateResults: data.intermediateResults,
      context: data.context,
      savedAt: data.savedAt,
    };
    const serialized = JSON.stringify(fullData);

    await repo.upsertCheckpoint(this.pool, id, fullData, checkpointRef, this.tenantId);

    if (this.redis) {
      try {
        await this.redis.set(
          `checkpoint:${id}`,
          serialized,
          "EX",
          TaskCheckpointService.CHECKPOINT_TTL_SEC,
        );
      } catch {
        log("warn", `TaskCheckpointService: Redis cache write failed`, { entryId: id });
      }
    }
  }

  async load(id: string): Promise<TaskCheckpointData | null> {
    // 优先从 Redis 加载
    if (this.redis) {
      try {
        const cached = await this.redis.get(`checkpoint:${id}`);
        if (cached) {
          return JSON.parse(cached) as TaskCheckpointData;
        }
      } catch {
        log("warn", `TaskCheckpointService: Redis read failed, falling back to DB`, { entryId: id });
      }
    }
    // 回退到 DB
    const dbData = await repo.loadCheckpoint(this.pool, id);
    if (!dbData) return null;
    return {
      currentStep: dbData.currentStep,
      intermediateResults: dbData.intermediateResults,
      context: dbData.context,
      savedAt: dbData.savedAt,
    };
  }

  /** 任务检查点不需要独立心跳 — 空操作 */
  startHeartbeat(_id: string, _intervalMs?: number): void {
    // no-op for task-level checkpoints
  }

  /** 任务检查点不需要独立心跳 — 空操作 */
  stopHeartbeat(_id: string): void {
    // no-op for task-level checkpoints
  }

  /** 任务检查点不需要恢复锁 — 始终返回 true */
  async acquireLock(_id: string): Promise<boolean> {
    return true;
  }
}

/* ================================================================== */
/*  Manager 实例                                                       */
/* ================================================================== */

export class TaskQueueManager {
  private pool: Pool;
  private emitter: QueueEventEmitter | null = null;
  private executor: TaskExecutor | null = null;
  private depResolver: TaskDependencyResolver | null = null;
  private scheduler: SessionScheduler | null = null;
  private schedulerConfig: Partial<SessionConcurrencyConfig> | null = null;
  private retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG;
  private redis: CheckpointRedisClient | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private normalizeScope(scope?: repo.QueueEntryScope): repo.QueueEntryScope | undefined {
    return scope ? { tenantId: scope.tenantId, spaceId: scope.spaceId, sessionId: scope.sessionId } : undefined;
  }

  /** P3-14: 设置重试配置 */
  setRetryConfig(config: Partial<RetryConfig>) {
    this.retryConfig = { ...this.retryConfig, ...config };
  }

  /** 注入事件广播器 */
  setEmitter(emitter: QueueEventEmitter) {
    this.emitter = emitter;
  }

  /** 注入任务执行器 */
  setExecutor(executor: TaskExecutor) {
    this.executor = executor;
  }

  /** P2-06: 注入依赖解析器 */
  setDependencyResolver(resolver: TaskDependencyResolver) {
    this.depResolver = resolver;
    // P2-07: 将管理器的事件发射能力桥接到解析器
    resolver.setEventCallback((depEvt) => {
      this.emitEvent({
        type: depEvt.type as any,
        sessionId: depEvt.sessionId,
        entryId: depEvt.entryId,
        data: depEvt.data,
        timestamp: new Date().toISOString(),
      });
    });
  }

  /** P3-01: 注入会话级调度器 */
  setSessionScheduler(scheduler: SessionScheduler, config?: Partial<SessionConcurrencyConfig>) {
    this.scheduler = scheduler;
    this.schedulerConfig = config ?? null;
  }

  /** 注入 Redis 客户端（检查点缓存用） */
  setRedis(redis: CheckpointRedisClient) {
    this.redis = redis;
  }

  /* ── 入队 ────────────────────────────────────────────────── */

  /**
   * 将新任务入队。
   * 入队后自动触发调度检查：如果有空闲槽位且依赖就绪，立即开始执行。
   */
  async enqueue(params: EnqueueParams): Promise<EnqueueResult> {
    const entry = await repo.insertQueueEntry(this.pool, params);
    const activeCount = await repo.countExecuting(this.pool, params.tenantId, params.sessionId);

    log("info", `Task enqueued`, {
      entryId: entry.entryId, sessionId: params.sessionId,
      goal: params.goal.slice(0, 80), mode: params.mode,
      priority: entry.priority, position: entry.position, activeCount,
    });

    this.emitEvent({
      type: "taskQueued",
      sessionId: params.sessionId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      data: {
        tenantId: entry.tenantId,
        goal: entry.goal,
        mode: entry.mode,
        priority: entry.priority,
        position: entry.position,
        foreground: entry.foreground,
        activeCount,
      },
      timestamp: new Date().toISOString(),
    });

    // 触发调度检查
    await this.tryScheduleNext(params.tenantId, params.sessionId);

    return { entry, position: entry.position, activeCount };
  }

  /* ── 调度核心 ─────────────────────────────────────────────── */

  /**
   * 尝试从队列中调度下一个可执行的任务。
   * 调度策略：
   * 1. 检查是否有空闲并发槽位
   * 2. 按优先级 + 入队时间获取下一个候选
   * 3. 检查依赖是否全部就绪
   * 4. 满足条件则开始执行
   *
   * 注意：并发数由外部动态配置决定，此处不设硬编码上限。
   */
  async tryScheduleNext(tenantId: string, sessionId: string): Promise<ScheduleDecision> {
    // P3-01: 使用会话级调度器（如果可用）
    // P2-2 修复：循环调度直到无更多可调度任务
    if (this.scheduler) {
      let lastDecision: ScheduleDecision = { immediate: false, reason: "no_schedulable_tasks" };
      const MAX_BATCH = 20; // 安全上限防死循环

      for (let i = 0; i < MAX_BATCH; i++) {
        const { decision, candidate, preemptTarget } = await this.scheduler.decideNext(
          tenantId, sessionId, this.schedulerConfig ?? undefined,
        );

        if (!decision.immediate || !candidate) {
          // 如果本轮没有可调度的，返回上一轮的结果（如果有调度过的话）
          lastDecision = i > 0
            ? { immediate: true, reason: `batch_scheduled_${i}_tasks` }
            : decision;
          break;
        }

        // P3-04: 如果需要抢占，先暂停被抢占任务
        if (preemptTarget) {
          await this.preempt(preemptTarget.entryId, candidate.entryId);
        }

        // 标记为 ready
        if (candidate.status === "queued") {
          await repo.updateEntryStatus(this.pool, {
            entryId: candidate.entryId,
            status: "ready",
          });
        }

        await this.startExecution(candidate);
        lastDecision = decision;
      }

      return lastDecision;
    }

    // 回退：原始调度逻辑（P2-2 修复：批量调度所有就绪任务）
    const schedulable = await repo.listSchedulable(this.pool, tenantId, sessionId);
    if (schedulable.length === 0) {
      return { immediate: false, reason: "no_schedulable_tasks" };
    }

    // 逐个检查依赖就绪状态，批量调度所有就绪的
    let scheduledCount = 0;
    for (const candidate of schedulable) {
      const depsReady = await repo.areAllDepsResolved(this.pool, candidate.entryId);
      if (!depsReady) {
        log("info", `Task waiting for dependencies`, {
          entryId: candidate.entryId, goal: candidate.goal.slice(0, 50),
        });
        continue;
      }

      // 依赖就绪，标记为 ready
      if (candidate.status === "queued") {
        await repo.updateEntryStatus(this.pool, {
          entryId: candidate.entryId,
          status: "ready",
        });
      }

      // 尝试执行
      await this.startExecution(candidate);
      scheduledCount++;
    }

    return scheduledCount > 0
      ? { immediate: true, reason: `batch_scheduled_${scheduledCount}_tasks` }
      : { immediate: false, reason: "all_tasks_blocked_by_dependencies" };
  }

  /** 开始执行一个任务 */
  private async startExecution(entry: TaskQueueEntry): Promise<void> {
    const updated = await repo.updateEntryStatus(this.pool, {
      entryId: entry.entryId,
      status: "executing",
    });
    if (!updated) {
      log("error", `Failed to update entry status to executing`, { entryId: entry.entryId });
      return;
    }

    log("info", `Task execution started`, {
      entryId: entry.entryId, sessionId: entry.sessionId,
      goal: entry.goal.slice(0, 80), mode: entry.mode,
    });

    this.emitEvent({
      type: "taskStarted",
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId, goal: entry.goal, mode: entry.mode },
      timestamp: new Date().toISOString(),
    });

    // 委托给执行器（非阻塞）
    // 注意：executor 内部通过 callbacks.onFailed 统一处理失败，
    // 此处不再重复调用 markFailed，避免双重事件/双重重试。
    if (this.executor) {
      this.executor.execute(updated).catch((err) => {
        log("error", `Task execution error (handled by executor)`, {
          entryId: entry.entryId, error: String(err),
        });
      });
    }
  }

  /* ── 生命周期 ─────────────────────────────────────────────── */

  /** 构建 QueueOpsContext，供 taskQueueOps 模块使用 */
  private buildOpsCtx(): QueueOpsContext {
    return {
      pool: this.pool,
      emitEvent: (evt) => this.emitEvent(evt),
      cancelEntry: (id) => this.cancel(id),
      tryScheduleNext: (t, s) => this.tryScheduleNext(t, s).then(() => {}),
    };
  }

  /** 标记任务完成 */
  async markCompleted(entryId: string, taskOutput?: Record<string, unknown>): Promise<void> {
    const entry = await repo.updateEntryStatus(this.pool, {
      entryId,
      status: "completed",
    });
    if (!entry) return;

    log("info", `Task completed`, { entryId, sessionId: entry.sessionId });

    // 清理检查点数据
    await this.clearCheckpoint(entryId);

    this.emitEvent({
      type: "taskCompleted",
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId, goal: entry.goal },
      timestamp: new Date().toISOString(),
    });

    await handleCompletionDeps(this.buildOpsCtx(), entry, taskOutput, this.depResolver);
  }

  /** 标记任务失败（幂等：仅从非终态/非 paused 状态转换） */
  async markFailed(entryId: string, error: string): Promise<void> {
    // 状态守卫：检查当前状态，防止双重调用和 shutdown 竞态覆写 paused
    const current = await repo.getEntry(this.pool, entryId);
    if (!current) return;
    if (TERMINAL_QUEUE_STATUSES.has(current.status)) {
      log("warn", `markFailed skipped: already terminal`, { entryId, status: current.status });
      return;
    }
    if (current.status === "paused") {
      log("warn", `markFailed skipped: task is paused (likely shutdown)`, { entryId });
      return;
    }

    const entry = await repo.updateEntryStatus(this.pool, {
      entryId,
      status: "failed",
      lastError: error,
    });
    if (!entry) return;

    log("error", `Task failed`, { entryId, sessionId: entry.sessionId, error });

    this.emitEvent({
      type: "taskFailed",
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId, goal: entry.goal, error },
      timestamp: new Date().toISOString(),
    });

    await handleFailureCascade(
      this.buildOpsCtx(), entry, error, this.retryConfig,
      this.depResolver, (id) => this.retry(id),
    );
  }

  /** 暂停任务 */
  async pause(entryId: string, scope?: repo.QueueEntryScope): Promise<TaskQueueEntry | null> {
    const entryScope = this.normalizeScope(scope);
    const entry = await repo.getEntry(this.pool, entryId, entryScope);
    if (!entry || !ACTIVE_STATUSES.has(entry.status)) {
      log("warn", `Cannot pause task: invalid status`, { entryId, status: entry?.status });
      return null;
    }

    const updated = await repo.updateEntryStatus(this.pool, { entryId, status: "paused", scope: entryScope });
    if (!updated) return null;

    log("info", `Task paused`, { entryId, sessionId: entry.sessionId });

    // 通知执行器暂停
    if (this.executor) {
      await this.executor.pause(updated).catch((err) => {
        log("error", `Failed to pause task execution`, { entryId, error: String(err) });
      });
    }

    this.emitEvent({
      type: "taskPaused",
      sessionId: entry.sessionId,
      entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId },
      timestamp: new Date().toISOString(),
    });

    // 暂停释放槽位，尝试调度下一个
    await this.tryScheduleNext(entry.tenantId, entry.sessionId);

    return updated;
  }

  /** 恢复任务 */
  async resume(entryId: string, scope?: repo.QueueEntryScope): Promise<TaskQueueEntry | null> {
    const entryScope = this.normalizeScope(scope);
    const entry = await repo.getEntry(this.pool, entryId, entryScope);
    if (!entry || !RESUMABLE_STATUSES.has(entry.status)) {
      log("warn", `Cannot resume task: invalid status`, { entryId, status: entry?.status });
      return null;
    }

    // 恢复到 ready 状态，由调度器决定何时执行
    const updated = await repo.updateEntryStatus(this.pool, { entryId, status: "ready", scope: entryScope });
    if (!updated) return null;

    log("info", `Task resumed`, { entryId, sessionId: entry.sessionId });

    this.emitEvent({
      type: "taskResumed",
      sessionId: entry.sessionId,
      entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId },
      timestamp: new Date().toISOString(),
    });

    // 触发调度
    await this.tryScheduleNext(entry.tenantId, entry.sessionId);

    return updated;
  }

  /** 取消任务 */
  async cancel(entryId: string, scope?: repo.QueueEntryScope): Promise<TaskQueueEntry | null> {
    const entryScope = this.normalizeScope(scope);
    const entry = await repo.getEntry(this.pool, entryId, entryScope);
    if (!entry || TERMINAL_QUEUE_STATUSES.has(entry.status)) {
      log("warn", `Cannot cancel task: already terminal`, { entryId, status: entry?.status });
      return null;
    }

    // 如果正在执行，先通知执行器取消
    if (ACTIVE_STATUSES.has(entry.status) && this.executor) {
      await this.executor.cancel(entry).catch((err) => {
        log("error", `Failed to cancel task execution`, { entryId, error: String(err) });
      });
    }

    const updated = await repo.updateEntryStatus(this.pool, { entryId, status: "cancelled", scope: entryScope });
    if (!updated) return null;

    log("info", `Task cancelled`, { entryId, sessionId: entry.sessionId });

    // 清理检查点数据
    await this.clearCheckpoint(entryId);

    this.emitEvent({
      type: "taskCancelled",
      sessionId: entry.sessionId,
      entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId },
      timestamp: new Date().toISOString(),
    });

    await handleCancelCascade(this.buildOpsCtx(), entry, this.depResolver);

    return updated;
  }

  /** 重试失败的任务 */
  async retry(entryId: string, scope?: repo.QueueEntryScope): Promise<TaskQueueEntry | null> {
    const entry = await repo.getEntry(this.pool, entryId, this.normalizeScope(scope));
    if (!entry || entry.status !== "failed") {
      log("warn", `Cannot retry task: not in failed state`, { entryId, status: entry?.status });
      return null;
    }

    const updated = await repo.incrementRetry(this.pool, entryId, entry.lastError || "", entry.tenantId);
    if (!updated) return null;

    log("info", `Task retry scheduled`, { entryId, retryCount: updated.retryCount });

    // 触发调度
    await this.tryScheduleNext(entry.tenantId, entry.sessionId);

    return updated;
  }

  /* ── 抢占 ────────────────────────────────────────────────── */

  /** 抢占一个正在执行的低优先级任务 */
  async preempt(entryId: string, byEntryId: string): Promise<TaskQueueEntry | null> {
    const entry = await repo.getEntry(this.pool, entryId);
    if (!entry || entry.status !== "executing") return null;

    // 暂停被抢占的任务
    if (this.executor) {
      await this.executor.pause(entry).catch((err) => {
        log("error", `Failed to preempt task`, { entryId, error: String(err) });
      });
    }

    const updated = await repo.updateEntryStatus(this.pool, { entryId, status: "preempted" });
    if (!updated) return null;

    log("info", `Task preempted`, { entryId, byEntryId, sessionId: entry.sessionId });

    this.emitEvent({
      type: "taskPreempted",
      sessionId: entry.sessionId,
      entryId,
      taskId: entry.taskId,
      data: { tenantId: entry.tenantId, preemptedBy: byEntryId },
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  /* ── 前台/后台 ──────────────────────────────────────────── */

  /** 切换前台/后台 */
  async setForeground(entryId: string, foreground: boolean, scope?: repo.QueueEntryScope): Promise<TaskQueueEntry | null> {
    const updated = await repo.updateForeground(this.pool, entryId, foreground, this.normalizeScope(scope));
    if (!updated) return null;

    this.emitEvent({
      type: foreground ? "taskForeground" : "taskBackground",
      sessionId: updated.sessionId,
      entryId,
      taskId: updated.taskId,
      data: { tenantId: updated.tenantId },
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  /* ── 排序 ────────────────────────────────────────────────── */

  /** 手动调整队列顺序 */
  async reorder(entryId: string, newPosition: number, scope?: repo.QueueEntryScope): Promise<void> {
    const entryScope = this.normalizeScope(scope);
    await repo.reorderEntry(this.pool, entryId, newPosition, entryScope);

    const entry = await repo.getEntry(this.pool, entryId, entryScope);
    if (entry) {
      this.emitEvent({
        type: "taskReordered",
        sessionId: entry.sessionId,
        entryId,
        taskId: entry.taskId,
        data: { tenantId: entry.tenantId, newPosition },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /* ── 查询 ────────────────────────────────────────────────── */

  /** 获取队列快照 */
  async getSnapshot(tenantId: string, sessionId: string): Promise<QueueSnapshot> {
    const [entries, dependencies] = await Promise.all([
      repo.listActiveEntries(this.pool, tenantId, sessionId),
      repo.listSessionDependencies(this.pool, tenantId, sessionId),
    ]);

    const activeCount = entries.filter(e => ACTIVE_STATUSES.has(e.status)).length;
    const queuedCount = entries.filter(e => e.status === "queued" || e.status === "ready").length;
    const fg = entries.find(e => e.foreground && !TERMINAL_QUEUE_STATUSES.has(e.status));

    return {
      sessionId,
      entries,
      dependencies,
      activeCount,
      queuedCount,
      foregroundEntryId: fg?.entryId || null,
    };
  }

  /** 获取会话中正在执行的任务列表 */
  async getExecutingEntries(tenantId: string, sessionId: string): Promise<TaskQueueEntry[]> {
    const entries = await repo.listActiveEntries(this.pool, tenantId, sessionId);
    return entries.filter(e => e.status === "executing");
  }

  /* ── P3-14: 依赖链修复 ──────────────────────────────────── */

  async repairDependencyChain(failedEntryId: string, scope?: repo.QueueEntryScope) {
    return _repairDependencyChain(this.buildOpsCtx(), failedEntryId, this.normalizeScope(scope));
  }

  async retryWithRepair(entryId: string, scope?: repo.QueueEntryScope) {
    const retried = await this.retry(entryId, scope);
    if (!retried) return { entry: null, repairedDeps: 0, unblockedEntries: [] };
    const repair = await this.repairDependencyChain(entryId, scope);
    return { entry: retried, ...repair };
  }

  /* ── 批量操作 ────────────────────────────────────────────── */

  async cancelAll(tenantId: string, sessionId: string): Promise<number> {
    const executing = await this.getExecutingEntries(tenantId, sessionId);
    for (const entry of executing) {
      if (this.executor) {
        await this.executor.cancel(entry).catch((e: unknown) => {
          _logger.warn("executor.cancel failed during cancelAll", { err: (e as Error)?.message, entryId: entry.entryId, tenantId, sessionId });
        });
      }
    }
    const count = await repo.cancelAllActive(this.pool, tenantId, sessionId);
    log("info", `All tasks cancelled`, { tenantId, sessionId, count });
    return count;
  }

  async pauseAllForShutdown(): Promise<number> {
    return _pauseAllForShutdown(this.pool, (evt) => this.emitEvent(evt), this.executor);
  }

  /* ── 检查点 ────────────────────────────────────────────────── */

  /** 任务级检查点服务实例（懒初始化） */
  private _taskCheckpointSvc: TaskCheckpointService | null = null;

  /** 获取或创建 TaskCheckpointService 实例 */
  private getTaskCheckpointService(tenantId: string): TaskCheckpointService {
    if (!this._taskCheckpointSvc || (this._taskCheckpointSvc as TaskCheckpointService)["tenantId"] !== tenantId) {
      this._taskCheckpointSvc = new TaskCheckpointService(this.pool, tenantId, this.redis);
    }
    return this._taskCheckpointSvc;
  }

  /** 检查点 TTL（24 小时） */
  private static readonly CHECKPOINT_TTL_SEC = resolveNumber("TASK_CHECKPOINT_TTL_SECONDS", undefined, undefined, 86400).value;

  /**
   * 保存任务检查点。
   * 委托给 TaskCheckpointService 统一接口处理。
   *
   * 在任务执行关键节点（如每个 step 完成后）调用。
   */
  async saveCheckpoint(entryId: string, checkpointData: Omit<repo.CheckpointData, "savedAt">, tenantId: string): Promise<void> {
    const now = new Date().toISOString();
    const data: TaskCheckpointData = {
      currentStep: checkpointData.currentStep,
      intermediateResults: checkpointData.intermediateResults,
      context: checkpointData.context,
      savedAt: now,
    };

    try {
      const svc = this.getTaskCheckpointService(tenantId);
      await svc.write(entryId, data);
      log("info", `Checkpoint saved`, { entryId, step: data.currentStep });
    } catch (err) {
      log("error", `Failed to save checkpoint`, { entryId, error: String(err) });
      throw new AppError({
        errorCode: "CHECKPOINT_SAVE_FAILED",
        message: { en: `Failed to save checkpoint for entry ${entryId}`, zh: `保存检查点失败: ${entryId}` },
        httpStatus: 500,
        cause: err,
      });
    }
  }

  /**
   * 从检查点恢复任务执行状态。
   * 委托给 TaskCheckpointService 统一接口处理。
   * 返回 null 表示无检查点或数据损坏。
   */
  async restoreFromCheckpoint(entryId: string): Promise<repo.CheckpointData | null> {
    try {
      // 先检查 checkpoint_ref 是否存在
      const entry = await repo.getEntry(this.pool, entryId);
      if (!entry?.checkpointRef) {
        log("info", `No checkpoint_ref for entry`, { entryId });
        return null;
      }

      const svc = this.getTaskCheckpointService(entry.tenantId);
      const data = await svc.load(entryId);
      if (!data) {
        log("warn", `checkpoint_ref exists but no checkpoint data found`, { entryId, checkpointRef: entry.checkpointRef });
        return null;
      }

      log("info", `Checkpoint restored`, { entryId, step: data.currentStep });
      return {
        currentStep: data.currentStep,
        intermediateResults: data.intermediateResults,
        context: data.context,
        savedAt: data.savedAt,
      };
    } catch (err) {
      // 检查点数据损坏，返回 null 触发降级到重新排队
      log("error", `Checkpoint restore failed (data may be corrupted)`, { entryId, error: String(err) });
      return null;
    }
  }

  /**
   * 清理检查点数据（任务完成/取消时调用）。
   */
  async clearCheckpoint(entryId: string): Promise<void> {
    try {
      await repo.deleteCheckpoint(this.pool, entryId);
      if (this.redis) {
        await this.redis.del(this.checkpointRedisKey(entryId)).catch(() => {});
      }
    } catch (err) {
      log("warn", `Failed to clear checkpoint`, { entryId, error: String(err) });
    }
  }

  /** 暴露 pool 给 Supervisor（启动恢复用） */
  getPool(): Pool {
    return this.pool;
  }

  /** 获取关联的 SessionScheduler（跨会话调度用） */
  getSessionScheduler(): SessionScheduler | null {
    return this.scheduler;
  }

  /* ── Manager-Executor 分离：纯选择接口 ─────────────────── */

  /**
   * 仅选择下一个应该执行的任务（不触发执行）。
   * Manager 职责：检查并发限制 → 检查依赖 → 选择任务 → 返回。
   * 实际执行由调用方决定。
   *
   * 与 tryScheduleNext 的区别：
   * - tryScheduleNext 选择+执行（向后兼容，行为不变）
   * - selectNextTask 仅选择，返回候选任务
   */
  async selectNextTask(tenantId: string, sessionId: string): Promise<{
    decision: ScheduleDecision;
    candidate: TaskQueueEntry | null;
    preemptTarget: TaskQueueEntry | null;
  }> {
    if (this.scheduler) {
      return this.scheduler.decideNext(
        tenantId, sessionId, this.schedulerConfig ?? undefined,
      );
    }

    // 回退：原始逻辑
    const schedulable = await repo.listSchedulable(this.pool, tenantId, sessionId);
    if (schedulable.length === 0) {
      return {
        decision: { immediate: false, reason: "no_schedulable_tasks" },
        candidate: null,
        preemptTarget: null,
      };
    }

    for (const candidate of schedulable) {
      const depsReady = await repo.areAllDepsResolved(this.pool, candidate.entryId);
      if (depsReady) {
        return {
          decision: { immediate: true, reason: "slot_available" },
          candidate,
          preemptTarget: null,
        };
      }
    }

    return {
      decision: { immediate: false, reason: "all_tasks_blocked_by_dependencies" },
      candidate: null,
      preemptTarget: null,
    };
  }

  /* ── 内部工具 ────────────────────────────────────────────── */

  /** Redis 检查点缓存 key */
  private checkpointRedisKey(entryId: string): string {
    return `checkpoint:${entryId}`;
  }

  private emitEvent(event: QueueEvent) {
    if (this.emitter) {
      try {
        this.emitter.emit(event);
      } catch (err) {
        log("error", `Failed to emit event`, { type: event.type, error: String(err) });
      }
    }
  }
}

/* ================================================================== */
/*  工厂函数                                                            */
/* ================================================================== */

/** 创建 TaskQueueManager 实例 */
export function createTaskQueueManager(pool: Pool): TaskQueueManager {
  return new TaskQueueManager(pool);
}

/* ================================================================== */
/*  跨会话优先级比较                                                      */
/* ================================================================== */

/**
 * 跨会话候选任务描述。
 * 由各会话的 selectNextTask 返回后汇总而来。
 */
export interface CrossSessionCandidate {
  sessionId: string;
  tenantId: string;
  entry: TaskQueueEntry;
  /** 考虑 globalPriorityBoost 后的有效优先级 */
  effectivePriority: number;
}

/**
 * 跨会话优先级比较 — 当多个会话都有待执行任务时，
 * 比较各会话候选任务的有效优先级（考虑 globalPriorityBoost），
 * 选出全局优先级最高的任务。
 *
 * @param candidates 各会话的候选任务列表
 * @returns 全局优先级最高的候选（null 表示无候选）
 */
export function compareAcrossSessions(
  candidates: CrossSessionCandidate[],
): CrossSessionCandidate | null {
  if (candidates.length === 0) return null;

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i];
    // 有效优先级数值越低 = 优先级越高
    if (c.effectivePriority < best.effectivePriority) {
      best = c;
    } else if (c.effectivePriority === best.effectivePriority) {
      // 同优先级按入队时间（position）FIFO
      if (c.entry.position < best.entry.position) {
        best = c;
      }
    }
  }
  return best;
}
