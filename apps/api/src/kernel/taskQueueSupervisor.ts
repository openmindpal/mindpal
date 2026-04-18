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
import { StructuredLogger } from "@openslin/shared";
import { listZombieExecutingEntries, updateEntryStatus } from "./taskQueueRepo";
import { broadcastToSession } from "../lib/sessionEventBus";
import { persistSchedulerMetrics } from "./sessionScheduler";

const logger = new StructuredLogger({ module: "taskQueueSupervisor" });

/* ───── 动态配置 ───── */

function zombieThresholdMs(): number {
  return Math.max(30_000, Number(process.env.TASK_QUEUE_ZOMBIE_THRESHOLD_MS) || 120_000);
}

function supervisorIntervalMs(): number {
  return Math.max(10_000, Number(process.env.TASK_QUEUE_SUPERVISOR_INTERVAL_MS) || 60_000);
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
