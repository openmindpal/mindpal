/**
 * jobRepo — Worker 端 Job 数据访问层
 */
import type { Pool } from "pg";

/** 查询 job 的类型 */
export async function getJobType(pool: Pool, jobId: string): Promise<string> {
  const res = await pool.query("SELECT job_type FROM jobs WHERE job_id = $1 LIMIT 1", [jobId]);
  return res.rowCount ? String(res.rows[0].job_type ?? "") : "";
}
