/**
 * Agent Loop — 状态转换辅助函数
 */
import type { Pool } from "pg";
import { tryTransitionRun, type RunStatus } from "@openslin/shared";

/**
 * 安全状态转换：先通过状态机校验，再执行 SQL 更新。
 * 如果转换不合法则记录警告并跳过更新（降级而非阻塞）。
 */
export async function safeTransitionRun(
  pool: Pool,
  runId: string,
  toStatus: RunStatus,
  opts?: { finishedAt?: boolean; log?: { warn: (...a: any[]) => void } },
): Promise<boolean> {
  const res = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE run_id = $1 LIMIT 1",
    [runId],
  );
  if (!res.rowCount) return false;
  const from = res.rows[0].status as RunStatus;
  const transition = tryTransitionRun(from, toStatus);
  if (!transition.ok) {
    opts?.log?.warn(
      { runId, from, to: toStatus, violation: transition.violation?.message },
      "[AgentLoop] 状态转换被状态机拒绝，跳过更新",
    );
    return false;
  }
  const setFinished = opts?.finishedAt ? ", finished_at = COALESCE(finished_at, now())" : "";
  await pool.query(
    `UPDATE runs SET status = $2, updated_at = now()${setFinished} WHERE run_id = $1`,
    [runId, toStatus],
  );
  return true;
}

export async function prepareRunForExecution(
  pool: Pool,
  runId: string,
  opts?: { log?: { warn: (...a: any[]) => void } },
): Promise<boolean> {
  const res = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE run_id = $1 LIMIT 1",
    [runId],
  );
  if (!res.rowCount) return false;
  const current = res.rows[0].status as RunStatus;

  if (current === "running") return true;
  if (current === "queued") return safeTransitionRun(pool, runId, "running", opts);

  if (current === "created" || current === "paused" || current === "needs_approval" || current === "needs_device" || current === "needs_arbiter" || current === "failed") {
    const queued = await safeTransitionRun(pool, runId, "queued", opts);
    if (!queued) return false;
    return safeTransitionRun(pool, runId, "running", opts);
  }

  opts?.log?.warn?.({ runId, from: current, to: "running" }, "[AgentLoop] Run 当前状态不允许启动执行");
  return false;
}
