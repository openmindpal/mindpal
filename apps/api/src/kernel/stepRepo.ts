/**
 * stepRepo — 步骤 / 运行数据访问层
 *
 * 将 executionKernel.ts 中散落的步骤/运行 SQL 提取到此处。
 */
import type { Pool } from "pg";

/** 将步骤状态更新为 needs_approval */
export async function markStepNeedsApproval(pool: Pool, stepId: string): Promise<void> {
  await pool.query(
    "UPDATE steps SET status = 'needs_approval', updated_at = now() WHERE step_id = $1",
    [stepId],
  );
}

/** 更新步骤和运行的 input_digest（审批场景） */
export async function updateInputDigest(
  pool: Pool,
  params: { stepId: string; runId: string; inputDigest: unknown },
): Promise<void> {
  const { stepId, runId, inputDigest } = params;
  await pool.query("UPDATE steps SET input_digest = $2 WHERE step_id = $1", [stepId, inputDigest]);
  await pool.query("UPDATE runs SET input_digest = $2 WHERE run_id = $1", [runId, inputDigest]);
}
