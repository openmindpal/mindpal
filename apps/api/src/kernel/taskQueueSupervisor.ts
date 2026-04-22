/**
 * P1-G4: TaskQueue Supervisor — 队列级僵尸任务检测器
 *
 * 与 loopSupervisor（Agent Loop 级心跳/恢复）互补：
 * - loopSupervisor 监控 agent_loop_checkpoints 心跳超时
 * - taskQueueSupervisor 监控 session_task_queue 中的僵尸 executing 任务
 *
 * 检测逻辑：
 * 1. 扫描 status=executing 且 started_at 超过阈值的任务
 * 2. 交叉引用 agent_loop_checkpoints：如果对应 run_id 无活跃心跳，认定为僵尸
 * 3. 僵尸任务标记为 failed，释放并发槽位，触发调度
 *
 * 运行方式：由 API 启动流程中的 setInterval 周期性调用（或在 Worker 进程中）。
 */
import type { Pool } from "pg";
import { StructuredLogger, resolveNumber } from "@openslin/shared";
import { listZombieExecutingEntries, listStaleExecutingEntries, updateEntryStatus } from "./taskQueueRepo";
import { broadcastToSession } from "../lib/sessionEventBus";
import { persistSchedulerMetrics } from "./sessionScheduler";
import type { TaskQueueManager } from "./taskQueueManager";

const logger = new StructuredLogger({ module: "taskQueueSupervisor" });

/* ───── 动态配置 ───── */

function zombieThresholdMs(): number {
  return Math.max(30_000, resolveNumber("TASK_QUEUE_ZOMBIE_THRESHOLD_MS", undefined, undefined, 120_000).value);
}

function supervisorIntervalMs(): number {
  return Math.max(10_000, resolveNumber("TASK_QUEUE_SUPERVISOR_INTERVAL_MS", undefined, undefined, 60_000).value);
}

/* ───── Types ───── */

export interface TaskQueueSupervisorDeps {
  pool: Pool;
  /**
   * P2-1 修复：僵尸任务回调。
   * 如果提供，使用此回调替代直接调用 repo.updateEntryStatus，
   * 让僵尸清理走 Manager.markFailed 触发依赖级联、重试、通知、重调度。
   */
  onZombieDetected?: (entryId: string, error: string) => Promise<void>;
}

export interface TaskQueueSupervisorResult {
  /** 检测到的僵尸任务数 */
  zombieCount: number;
  /** 成功标记为 failed 的数量 */
  failedCount: number;
  /** 处理的 entryIds */
  processedEntries: string[];
}

/* ───── Supervisor Tick ───── */

/**
 * 单次 Supervisor tick。
 * 检测并清理 session_task_queue 中的僵尸 executing 任务。
 */
export async function tickTaskQueueSupervisor(
  deps: TaskQueueSupervisorDeps,
): Promise<TaskQueueSupervisorResult> {
  const { pool } = deps;
  const threshold = zombieThresholdMs();

  // 1. 查找僵尸任务（executing 超时 + 无活跃 agent_loop_checkpoint 心跳）
  const zombies = await listZombieExecutingEntries(pool, threshold);

  if (zombies.length === 0) {
    return { zombieCount: 0, failedCount: 0, processedEntries: [] };
  }

  logger.info(`发现 ${zombies.length} 个僵尸执行任务`, { threshold, zombieCount: zombies.length });

  let failedCount = 0;
  const processedEntries: string[] = [];

  for (const zombie of zombies) {
    try {
      const errorMsg = `zombie_detected: task stuck in executing for >${threshold}ms without active AgentLoop heartbeat`;

      // P2-1 修复：优先使用 Manager.markFailed 回调，触发依赖级联/重试/通知/重调度
      if (deps.onZombieDetected) {
        await deps.onZombieDetected(zombie.entryId, errorMsg);
        failedCount++;
        processedEntries.push(zombie.entryId);
      } else {
        // 回退：无 Manager 时直接更新 DB（仅影响状态，不触发级联）
        const updated = await updateEntryStatus(pool, {
          entryId: zombie.entryId,
          status: "failed",
          lastError: errorMsg,
        });
        if (updated) {
          failedCount++;
          processedEntries.push(zombie.entryId);
        }
      }

      logger.info(`僵尸任务已处理`, {
        entryId: zombie.entryId,
        sessionId: zombie.sessionId,
        runId: zombie.runId,
        startedAt: zombie.startedAt,
        viaManager: !!deps.onZombieDetected,
      });

      // 通知前端（Manager 路径已内置事件发射，回退路径才需要手动广播）
      if (!deps.onZombieDetected) {
        broadcastToSession(zombie.sessionId, zombie.tenantId, "taskFailed", {
          entryId: zombie.entryId,
          taskId: zombie.taskId,
          goal: zombie.goal,
          error: "zombie_detected",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      logger.error(`处理僵尸任务失败`, {
        entryId: zombie.entryId,
        error: err?.message,
      });
    }
  }

  return {
    zombieCount: zombies.length,
    failedCount,
    processedEntries,
  };
}

/**
 * P2-G7: 在 tick 中附带持久化调度器指标。
 */
async function persistMetricsSafe(pool: Pool): Promise<void> {
  try {
    await persistSchedulerMetrics(pool);
  } catch {
    // 非关键操作，失败不影响主流程
  }
}

/* ───── 定时器管理 ───── */

let supervisorTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动 TaskQueue Supervisor 定时器。
 * 在 API 启动后调用。
 */
export function startTaskQueueSupervisor(deps: TaskQueueSupervisorDeps): void {
  if (supervisorTimer) return; // 已启动

  const intervalMs = supervisorIntervalMs();
  logger.info(`启动 (间隔 ${intervalMs}ms, 僵尸阈值 ${zombieThresholdMs()}ms)`);

  supervisorTimer = setInterval(() => {
    tickTaskQueueSupervisor(deps)
      .then(() => persistMetricsSafe(deps.pool))
      .catch((err) => {
        logger.error(`tick 异常: ${err?.message}`);
      });
  }, intervalMs);

  // 不阻止进程退出
  if (supervisorTimer && typeof supervisorTimer === "object" && "unref" in supervisorTimer) {
    (supervisorTimer as any).unref();
  }
}

/**
 * 停止 TaskQueue Supervisor 定时器。
 */
export function stopTaskQueueSupervisor(): void {
  if (supervisorTimer) {
    clearInterval(supervisorTimer);
    supervisorTimer = null;
    logger.info(`已停止`);
  }
}

/* ───── 启动恢复 ───── */

/** 恢复中断任务的结果统计 */
export interface RecoverInterruptedResult {
  /** 扫描到的 stale executing 任务数 */
  staleCount: number;
  /** 成功从检查点恢复的数量 */
  restoredCount: number;
  /** 重置为 queued 的数量（无检查点或检查点损坏） */
  requeuedCount: number;
  /** 处理失败的数量 */
  errorCount: number;
}

/**
 * P0: 启动时恢复中断的 executing 任务。
 *
 * 恢复策略：
 * 1. 扫描所有 status='executing' 且 updated_at 超过阈值的任务
 * 2. 有 checkpoint_ref 的任务 → 尝试从检查点恢复执行
 * 3. 无 checkpoint_ref / 检查点损坏 → 重置为 'queued' 等待重新调度
 *
 * 此函数使用 setImmediate 延迟执行，不阻塞 API 启动。
 */
export function recoverInterruptedTasks(deps: {
  pool: Pool;
  manager: TaskQueueManager;
  /** 恢复阈值 ms，默认 5 分钟 */
  staleThresholdMs?: number;
}): Promise<RecoverInterruptedResult> {
  const { pool, manager, staleThresholdMs = 300_000 } = deps;

  return new Promise<RecoverInterruptedResult>((resolve) => {
    // 使用 setImmediate 延迟执行，不阻塞 API 启动
    setImmediate(async () => {
      const result: RecoverInterruptedResult = {
        staleCount: 0,
        restoredCount: 0,
        requeuedCount: 0,
        errorCount: 0,
      };

      try {
        const staleEntries = await listStaleExecutingEntries(pool, staleThresholdMs);
        result.staleCount = staleEntries.length;

        if (staleEntries.length === 0) {
          logger.info("No stale executing tasks found during startup recovery");
          resolve(result);
          return;
        }

        logger.info(`Found ${staleEntries.length} stale executing tasks, starting recovery`, {
          module: "taskQueueSupervisor",
          action: "startup_recovery",
          staleCount: staleEntries.length,
          thresholdMs: staleThresholdMs,
        });

        for (const entry of staleEntries) {
          try {
            if (entry.checkpointRef) {
              // 有 checkpoint_ref → 尝试恢复
              const checkpoint = await manager.restoreFromCheckpoint(entry.entryId);
              if (checkpoint) {
                // 检查点有效 → 重置为 queued，附带检查点信息供执行器使用
                await updateEntryStatus(pool, {
                  entryId: entry.entryId,
                  status: "queued",
                  // 保留 checkpoint_ref，让执行器在下次执行时读取恢复
                });
                result.restoredCount++;
                logger.info("Task recovered from checkpoint", {
                  module: "taskQueueSupervisor",
                  action: "checkpoint_restore",
                  entryId: entry.entryId,
                  sessionId: entry.sessionId,
                  step: checkpoint.currentStep,
                  savedAt: checkpoint.savedAt,
                });
              } else {
                // 检查点数据损坏或不可读 → 降级到重新排队
                await updateEntryStatus(pool, {
                  entryId: entry.entryId,
                  status: "queued",
                  checkpointRef: null,
                });
                await manager.clearCheckpoint(entry.entryId);
                result.requeuedCount++;
                logger.warn("Checkpoint data corrupted, task requeued", {
                  module: "taskQueueSupervisor",
                  action: "checkpoint_corrupt_requeue",
                  entryId: entry.entryId,
                  sessionId: entry.sessionId,
                });
              }
            } else {
              // 无 checkpoint_ref → 直接重新排队
              await updateEntryStatus(pool, {
                entryId: entry.entryId,
                status: "queued",
              });
              result.requeuedCount++;
              logger.info("Task without checkpoint requeued", {
                module: "taskQueueSupervisor",
                action: "no_checkpoint_requeue",
                entryId: entry.entryId,
                sessionId: entry.sessionId,
              });
            }

            // 通知前端任务状态变更
            broadcastToSession(entry.sessionId, entry.tenantId, "taskResumed", {
              entryId: entry.entryId,
              taskId: entry.taskId,
              goal: entry.goal,
              recoveredFromCheckpoint: !!entry.checkpointRef,
              timestamp: new Date().toISOString(),
            });
          } catch (err: any) {
            result.errorCount++;
            logger.error("Failed to recover stale task", {
              module: "taskQueueSupervisor",
              action: "recovery_error",
              entryId: entry.entryId,
              error: err?.message,
            });

            // 恢复失败也尝试降级重排队，防止永久卡死
            try {
              await updateEntryStatus(pool, {
                entryId: entry.entryId,
                status: "queued",
                checkpointRef: null,
                lastError: `recovery_failed: ${err?.message ?? "unknown"}`,
              });
            } catch {
              // 彻底失败，仅记日志
              logger.error("Last resort requeue also failed", { entryId: entry.entryId });
            }
          }
        }

        logger.info("Startup recovery completed", {
          module: "taskQueueSupervisor",
          action: "recovery_complete",
          ...result,
        });
      } catch (err: any) {
        logger.error("Startup recovery scan failed", {
          module: "taskQueueSupervisor",
          action: "recovery_scan_error",
          error: err?.message,
        });
      }

      resolve(result);
    });
  });
}
