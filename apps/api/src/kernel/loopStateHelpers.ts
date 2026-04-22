/**
 * Agent Loop — 状态转换辅助函数
 */
import type { Pool } from "pg";
import { safeTransitionRun, type RunStatus } from "@openslin/shared";

export { safeTransitionRun };

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
