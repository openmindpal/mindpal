/**
 * Task Queue Ops — 批量操作、级联操作、依赖链修复
 *
 * 从 TaskQueueManager 提取的高阶操作函数，
 * 负责跨任务的批量/级联/修复逻辑。
 */
import type { Pool } from "pg";
import type { TaskQueueEntry, QueueEvent, RetryConfig } from "./taskQueue.types";
import { TERMINAL_QUEUE_STATUSES } from "./taskQueue.types";
import * as repo from "./taskQueueRepo";
import {
  notifyBackgroundTaskCompleted,
  notifyBackgroundTaskFailed,
  notifyTaskNeedsIntervention,
} from "./completionNotifier";
import { StructuredLogger } from "@openslin/shared";
import type { TaskDependencyResolver } from "./taskDependencyResolver";

const _logger = new StructuredLogger({ module: "taskQueueOps" });

function log(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
  _logger[level](msg, ctx);
}

/* ================================================================== */
/*  依赖链操作上下文                                                      */
/* ================================================================== */

export interface QueueOpsContext {
  pool: Pool;
  emitEvent: (event: QueueEvent) => void;
  cancelEntry: (entryId: string) => Promise<TaskQueueEntry | null>;
  tryScheduleNext: (tenantId: string, sessionId: string) => Promise<void>;
}

/* ================================================================== */
/*  级联取消                                                              */
/* ================================================================== */

/**
 * 级联取消下游任务（fallback 路径，当无 depResolver 时使用）
 */
export async function cascadeCancel(
  ctx: QueueOpsContext,
  entry: TaskQueueEntry,
): Promise<void> {
  const targets = await repo.getCascadeCancelTargets(ctx.pool, entry.entryId);
  for (const targetId of targets) {
    const target = await repo.getEntry(ctx.pool, targetId);
    if (target && !TERMINAL_QUEUE_STATUSES.has(target.status)) {
      await ctx.cancelEntry(targetId);

      ctx.emitEvent({
        type: "cascadeCancelled",
        sessionId: entry.sessionId,
        entryId: targetId,
        taskId: target.taskId,
        data: { tenantId: entry.tenantId, cascadeFrom: entry.entryId },
        timestamp: new Date().toISOString(),
      });
    }
  }
}

/* ================================================================== */
/*  markCompleted 后的依赖解析                                            */
/* ================================================================== */

/**
 * 处理任务完成后的依赖解析和输出映射
 */
export async function handleCompletionDeps(
  ctx: QueueOpsContext,
  entry: TaskQueueEntry,
  taskOutput: Record<string, unknown> | undefined,
  depResolver: TaskDependencyResolver | null,
): Promise<void> {
  // P3-09: 后台任务完成时推送通知
  if (!entry.foreground) {
    notifyBackgroundTaskCompleted({
      pool: ctx.pool,
      tenantId: entry.tenantId,
      spaceId: entry.spaceId,
      subjectId: entry.createdBySubjectId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      goal: entry.goal,
    }).catch((err) => log("error", `Failed to send bg completion notification`, { entryId: entry.entryId, error: String(err) }));
  }

  // P2-06/07: 使用依赖解析器处理完成后的依赖解析和输出映射
  if (depResolver) {
    const { resolvedDeps, outputMappings } = await depResolver.onTaskCompleted(entry.entryId, taskOutput);
    for (const dep of resolvedDeps) {
      ctx.emitEvent({
        type: "depResolved",
        sessionId: entry.sessionId,
        entryId: dep.fromEntryId,
        data: { tenantId: entry.tenantId, depId: dep.depId, resolvedBy: entry.entryId, depType: dep.depType },
        timestamp: new Date().toISOString(),
      });
    }
    if (outputMappings.length > 0) {
      log("info", `Output mapped to ${outputMappings.length} downstream entries`, { entryId: entry.entryId });
    }
  } else {
    // 回退：直接解析依赖（无 output 映射）
    const resolvedDeps = await repo.resolveUpstreamDeps(ctx.pool, entry.entryId);
    for (const dep of resolvedDeps) {
      ctx.emitEvent({
        type: "depResolved",
        sessionId: entry.sessionId,
        entryId: dep.fromEntryId,
        data: { tenantId: entry.tenantId, depId: dep.depId, resolvedBy: entry.entryId },
        timestamp: new Date().toISOString(),
      });
    }
  }

  // 触发调度：可能有下游任务的依赖刚刚就绪
  await ctx.tryScheduleNext(entry.tenantId, entry.sessionId);
}

/* ================================================================== */
/*  markFailed 后的级联处理                                               */
/* ================================================================== */

/**
 * 处理任务失败后的自动重试、通知、级联取消
 */
export async function handleFailureCascade(
  ctx: QueueOpsContext,
  entry: TaskQueueEntry,
  error: string,
  retryConfig: RetryConfig,
  depResolver: TaskDependencyResolver | null,
  retryFn: (entryId: string) => Promise<TaskQueueEntry | null>,
): Promise<void> {
  // P3-14: 自动重试检查
  const shouldAutoRetry = retryConfig.maxAutoRetries > 0
    && entry.retryCount < retryConfig.maxAutoRetries;

  if (shouldAutoRetry) {
    const delay = Math.min(
      retryConfig.baseDelayMs * Math.pow(2, entry.retryCount),
      retryConfig.maxDelayMs,
    );
    log("info", `Auto-retry scheduled`, {
      entryId: entry.entryId, retryCount: entry.retryCount + 1,
      maxRetries: retryConfig.maxAutoRetries, delayMs: delay,
    });

    ctx.emitEvent({
      type: "taskRetried",
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      data: {
        tenantId: entry.tenantId,
        retryCount: entry.retryCount + 1,
        maxRetries: retryConfig.maxAutoRetries,
        delayMs: delay,
        error,
      },
      timestamp: new Date().toISOString(),
    });

    // 延迟后重试
    setTimeout(() => {
      retryFn(entry.entryId).catch((retryErr) => {
        log("error", `Auto-retry failed`, { entryId: entry.entryId, error: String(retryErr) });
      });
    }, delay);

    return; // 自动重试中，不执行级联操作和通知
  }

  // P3-09: 后台任务失败时推送通知（仅在不再重试时）
  if (!entry.foreground) {
    notifyBackgroundTaskFailed({
      pool: ctx.pool,
      tenantId: entry.tenantId,
      spaceId: entry.spaceId,
      subjectId: entry.createdBySubjectId,
      entryId: entry.entryId,
      taskId: entry.taskId,
      goal: entry.goal,
      error,
    }).catch((err) => log("error", `Failed to send bg failure notification`, { entryId: entry.entryId, error: String(err) }));
  }

  // P2-07: 使用依赖解析器处理失败级联
  if (depResolver) {
    const { blockedDeps, cascadeTargets } = await depResolver.onTaskFailed(entry.entryId, entry.sessionId);
    for (const targetId of cascadeTargets) {
      const target = await repo.getEntry(ctx.pool, targetId);
      if (target && !TERMINAL_QUEUE_STATUSES.has(target.status)) {
        await ctx.cancelEntry(targetId);
        ctx.emitEvent({
          type: "cascadeCancelled",
          sessionId: entry.sessionId,
          entryId: targetId,
          taskId: target.taskId,
          data: { tenantId: entry.tenantId, cascadeFrom: entry.entryId, reason: "upstream_failed" },
          timestamp: new Date().toISOString(),
        });
        // P3-09: 级联取消的任务需要干预通知
        notifyTaskNeedsIntervention({
          pool: ctx.pool,
          tenantId: entry.tenantId,
          spaceId: entry.spaceId,
          subjectId: target.createdBySubjectId,
          entryId: targetId,
          taskId: target.taskId,
          goal: target.goal,
          reason: `上游任务失败导致级联取消 (来源: ${entry.entryId})`,
        }).catch((e: unknown) => {
          _logger.warn("notifyTaskNeedsIntervention failed during cascade cancel", { err: (e as Error)?.message, entryId: targetId });
        });
      }
    }
  } else {
    // 回退：原始逻辑
    const blockedDeps = await repo.blockUpstreamDeps(ctx.pool, entry.entryId);
    for (const dep of blockedDeps) {
      ctx.emitEvent({
        type: "depBlocked",
        sessionId: entry.sessionId,
        entryId: dep.fromEntryId,
        data: { tenantId: entry.tenantId, depId: dep.depId, blockedBy: entry.entryId, error },
        timestamp: new Date().toISOString(),
      });
    }
    await cascadeCancel(ctx, entry);
  }

  // 尝试调度其他任务
  await ctx.tryScheduleNext(entry.tenantId, entry.sessionId);
}

/* ================================================================== */
/*  取消后的级联处理                                                       */
/* ================================================================== */

/**
 * 处理任务取消后的依赖级联
 */
export async function handleCancelCascade(
  ctx: QueueOpsContext,
  entry: TaskQueueEntry,
  depResolver: TaskDependencyResolver | null,
): Promise<void> {
  if (depResolver) {
    const { blockedDeps, cascadeTargets } = await depResolver.onTaskCancelled(entry.entryId, entry.sessionId);
    for (const targetId of cascadeTargets) {
      const target = await repo.getEntry(ctx.pool, targetId);
      if (target && !TERMINAL_QUEUE_STATUSES.has(target.status)) {
        await ctx.cancelEntry(targetId);
        ctx.emitEvent({
          type: "cascadeCancelled",
          sessionId: entry.sessionId,
          entryId: targetId,
          taskId: target.taskId,
          data: { tenantId: entry.tenantId, cascadeFrom: entry.entryId, reason: "upstream_cancelled" },
          timestamp: new Date().toISOString(),
        });
      }
    }
  } else {
    await repo.blockUpstreamDeps(ctx.pool, entry.entryId);
    await cascadeCancel(ctx, entry);
  }

  // 释放槽位，尝试调度下一个
  await ctx.tryScheduleNext(entry.tenantId, entry.sessionId);
}

/* ================================================================== */
/*  依赖链修复                                                            */
/* ================================================================== */

/**
 * 修复因上游失败导致的依赖链断裂。
 * 将 blocked 依赖标记为 overridden，释放下游任务。
 */
export async function repairDependencyChain(
  ctx: QueueOpsContext,
  failedEntryId: string,
  scope?: repo.QueueEntryScope,
): Promise<{ repairedDeps: number; unblockedEntries: string[] }> {
  const entry = await repo.getEntry(ctx.pool, failedEntryId, scope);
  if (!entry) return { repairedDeps: 0, unblockedEntries: [] };

  // 获取被阻塞的下游
  const blockedDownstream = await repo.getBlockedDownstreamEntries(ctx.pool, failedEntryId);

  // 修复依赖：blocked → overridden
  const repairedDeps = await repo.repairBlockedDeps(ctx.pool, failedEntryId);

  for (const dep of repairedDeps) {
    ctx.emitEvent({
      type: "depRepaired",
      sessionId: entry.sessionId,
      entryId: dep.fromEntryId,
      data: {
        tenantId: entry.tenantId,
        depId: dep.depId,
        repairedFrom: failedEntryId,
        depType: dep.depType,
      },
      timestamp: new Date().toISOString(),
    });
  }

  log("info", `Dependency chain repaired`, {
    failedEntryId,
    repairedCount: repairedDeps.length,
    unblockedEntries: blockedDownstream,
  });

  // 触发调度：被修复的下游可能现在可以执行了
  if (blockedDownstream.length > 0) {
    await ctx.tryScheduleNext(entry.tenantId, entry.sessionId);
  }

  return {
    repairedDeps: repairedDeps.length,
    unblockedEntries: blockedDownstream,
  };
}

/* ================================================================== */
/*  批量操作                                                              */
/* ================================================================== */

/**
 * P3-15: 优雅关闭 — 暂停所有活跃任务并写入 checkpoint。
 */
export async function pauseAllForShutdown(
  pool: Pool,
  emitEvent: (event: QueueEvent) => void,
  executor: { pause(entry: TaskQueueEntry): Promise<void> } | null,
): Promise<number> {
  const checkpointRef = `shutdown:${new Date().toISOString()}`;

  // 先通知所有执行中的任务执行器暂停
  const activeEntries = await repo.listGlobalActiveEntries(pool);
  const executingEntries = activeEntries.filter(e => e.status === "executing");

  for (const entry of executingEntries) {
    if (executor) {
      await executor.pause(entry).catch((err) => {
        log("error", `Failed to pause task for shutdown`, {
          entryId: entry.entryId, error: String(err),
        });
      });
    }
  }

  // 批量更新数据库状态
  const count = await repo.batchPauseForShutdown(pool, checkpointRef);

  // 向所有活跃会话发送关闭通知
  const sessionRefs = new Map<string, { tenantId: string; sessionId: string }>();
  for (const entry of activeEntries) {
    sessionRefs.set(`${entry.tenantId}::${entry.sessionId}`, {
      tenantId: entry.tenantId,
      sessionId: entry.sessionId,
    });
  }
  for (const { tenantId, sessionId } of sessionRefs.values()) {
    emitEvent({
      type: "queueSnapshot",
      sessionId,
      data: {
        tenantId,
        reason: "server_shutting_down",
        checkpointRef,
        pausedCount: count,
      },
      timestamp: new Date().toISOString(),
    });
  }

  log("info", `All tasks paused for shutdown`, {
    totalActive: activeEntries.length,
    executingPaused: executingEntries.length,
    batchPaused: count,
    checkpointRef,
  });

  return count;
}
