/**
 * P2-4: Collab Run Checkpoint — 协作运行检查点/恢复模块
 *
 * 同构于 loopCheckpoint.ts，为协作运行（collab_runs）实现：
 * 1. writeCollabCheckpoint — UPDATE checkpoint_state/heartbeat_at
 * 2. loadCollabCheckpoint  — 加载检查点状态
 * 3. acquireCollabResumeLock — CAS 防并发恢复
 * 4. startCollabHeartbeat — 心跳定时器
 *
 * 设计原则：
 * - 复用 collab_runs 表的 checkpoint_state / heartbeat_at / resume_count 字段
 * - 不引入新表、不新增外部依赖
 * - 心跳间隔复用 COLLAB_CONFIG_DEFAULTS.heartbeatIntervalMs 语义
 */
import type { Pool } from "pg";
import { resolveNumber } from "@mindpal/shared";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface CollabCheckpointState {
  phase: string;
  currentTurn: number;
  roleStates: Record<string, unknown>;
  completedStepIds: string[];
  pendingStepIds: string[];
  replanCount: number;
}

/* ================================================================== */
/*  Config — 动态可配，零硬编码                                          */
/* ================================================================== */

/** 协作运行心跳间隔（毫秒），默认 10 秒 */
function collabHeartbeatIntervalMs(): number {
  return Math.max(3_000, resolveNumber("COLLAB_HEARTBEAT_INTERVAL_MS", undefined, undefined, 10_000).value);
}

/* ================================================================== */
/*  1. Checkpoint Writer                                                */
/* ================================================================== */

/**
 * 写入协作运行检查点 — UPDATE collab_runs 的 checkpoint_state/heartbeat_at。
 * 幂等：同一 collabRunId 多次写入仅覆盖。
 */
export async function writeCollabCheckpoint(
  pool: Pool,
  collabRunId: string,
  state: CollabCheckpointState,
): Promise<void> {
  await pool.query(
    `UPDATE collab_runs
     SET checkpoint_state = $2::jsonb,
         heartbeat_at = NOW(),
         updated_at = NOW()
     WHERE collab_run_id = $1`,
    [collabRunId, JSON.stringify(state)],
  );
}

/* ================================================================== */
/*  2. Load Checkpoint                                                  */
/* ================================================================== */

/**
 * 加载协作运行检查点。
 * 返回 null 表示无可恢复的检查点（不存在或 checkpoint_state 为空）。
 */
export async function loadCollabCheckpoint(
  pool: Pool,
  collabRunId: string,
): Promise<{ state: CollabCheckpointState; resumeCount: number; status: string } | null> {
  const { rows } = await pool.query<{
    checkpoint_state: CollabCheckpointState;
    resume_count: number;
    status: string;
  }>(
    `SELECT checkpoint_state, resume_count, status
     FROM collab_runs
     WHERE collab_run_id = $1 AND checkpoint_state IS NOT NULL`,
    [collabRunId],
  );
  if (!rows[0]) return null;
  return {
    state: rows[0].checkpoint_state as CollabCheckpointState,
    resumeCount: rows[0].resume_count,
    status: rows[0].status,
  };
}

/* ================================================================== */
/*  3. CAS Resume Lock                                                  */
/* ================================================================== */

/**
 * CAS 锁获取 — 防止并发恢复。
 * 仅当 status IN ('running','paused') 且 checkpoint_state 非空时成功。
 * 注：collab_runs 没有 node_id 字段，区别于 agent_loop_checkpoints。
 */
export async function acquireCollabResumeLock(
  pool: Pool,
  collabRunId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE collab_runs
     SET status = 'resuming',
         resume_count = resume_count + 1,
         updated_at = NOW()
     WHERE collab_run_id = $1
       AND status IN ('running', 'paused')
       AND checkpoint_state IS NOT NULL`,
    [collabRunId],
  );
  return (rowCount ?? 0) > 0;
}

/* ================================================================== */
/*  4. Heartbeat                                                        */
/* ================================================================== */

/**
 * 启动心跳定时器 — 同构于 loopCheckpoint.startHeartbeat。
 * 返回 stop 函数，协作运行结束时调用。
 */
export function startCollabHeartbeat(
  pool: Pool,
  collabRunId: string,
  intervalMs?: number,
): { stop: () => void } {
  const ms = intervalMs ?? collabHeartbeatIntervalMs();
  const timer = setInterval(() => {
    pool.query(
      `UPDATE collab_runs SET heartbeat_at = NOW() WHERE collab_run_id = $1`,
      [collabRunId],
    ).catch(() => { /* 心跳写入失败不阻塞主流程 */ });
  }, ms);
  timer.unref(); // 不阻止进程退出

  return {
    stop: () => clearInterval(timer),
  };
}
