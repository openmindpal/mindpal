/**
 * 设备执行恢复 ticker
 *
 * 定期扫描已完成（succeeded/failed）但关联 run_id/step_id 的 device_executions，
 * 将对应的 run 从 needs_device 恢复为 queued 并将 step 重新入队执行。
 *
 * 这是端侧执行集成的"拉取式恢复"兜底机制，确保即使 API 侧的实时恢复
 * （在 result 回传时触发）因并发或异常未能完成，Worker 也能自行恢复。
 */
import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Queue } from "bullmq";

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function tickDeviceExecutionResume(params: { pool: Pool; queue: Queue }) {
  const { pool, queue } = params;

  // 查找已完成的设备执行，其关联的 run 仍处于 needs_device 状态
  const res = await pool.query(
    `
      SELECT de.device_execution_id, de.tenant_id, de.run_id, de.step_id, de.status AS de_status,
             r.status AS run_status, j.job_id
      FROM device_executions de
      JOIN runs r ON r.run_id::text = de.run_id AND r.tenant_id = de.tenant_id
      JOIN jobs j ON j.tenant_id = r.tenant_id AND j.run_id::text = r.run_id::text
      WHERE de.run_id IS NOT NULL
        AND de.step_id IS NOT NULL
        AND de.status IN ('succeeded', 'failed')
        AND de.completed_at IS NOT NULL
        AND de.completed_at > now() - interval '1 hour'
        AND r.status IN ('needs_device', 'queued')
      ORDER BY de.completed_at ASC
      LIMIT 20
    `,
  );

  if (!res.rowCount) return;

  for (const row of res.rows) {
    const runId = String(row.run_id);
    const stepId = String(row.step_id);
    const jobId = String(row.job_id);
    const tenantId = String(row.tenant_id);
    const deviceExecutionId = String(row.device_execution_id);

    try {
      const runStatus = String(row.run_status ?? "");
      const claimToken = `device-resume:${crypto.randomUUID()}`;
      const claimed = await withTransaction(pool, async (client) => {
        const stepCheck = await client.query(
          `SELECT status, queue_job_id,
                  (input->>'collabRunId') AS collab_run_id,
                  (input->>'spaceId') AS space_id
           FROM steps
           WHERE step_id = $1::uuid
           FOR UPDATE`,
          [stepId],
        );
        if (!stepCheck.rowCount) return { ok: false as const, reason: "step_missing" as const };
        const stepStatus = String(stepCheck.rows[0].status ?? "");
        const currentQueueJobId = String(stepCheck.rows[0].queue_job_id ?? "");
        if (stepStatus !== "pending" && stepStatus !== "needs_device") return { ok: false as const, reason: "step_finished" as const };
        if (currentQueueJobId) return { ok: false as const, reason: "already_claimed" as const };

        const collabRunId = String(stepCheck.rows[0].collab_run_id ?? "");
        const spaceId = String(stepCheck.rows[0].space_id ?? "");

        if (runStatus === "needs_device") {
          const updated = await client.query(
            "UPDATE runs SET status = 'queued', updated_at = now() WHERE run_id = $1::uuid AND tenant_id = $2 AND status = 'needs_device'",
            [runId, tenantId],
          );
          if (!updated.rowCount) return { ok: false as const, reason: "run_already_resumed" as const };

          await client.query(
            "UPDATE jobs SET status = 'queued', updated_at = now() WHERE job_id = $1::uuid AND tenant_id = $2",
            [jobId, tenantId],
          );
        }

        const stepUpdated = await client.query(
          "UPDATE steps SET status = 'pending', queue_job_id = $2, updated_at = now() WHERE step_id = $1::uuid AND status IN ('pending', 'needs_device') AND (queue_job_id IS NULL OR queue_job_id = '') RETURNING 1",
          [stepId, claimToken],
        );
        if (!stepUpdated.rowCount) return { ok: false as const, reason: "step_not_claimed" as const };

        if (collabRunId && runStatus === "needs_device") {
          await client.query(
            "UPDATE collab_runs SET status = 'executing', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2::uuid AND status = 'needs_device'",
            [tenantId, collabRunId],
          );
        }

        if (spaceId && runStatus === "needs_device") {
          await client.query(
            "UPDATE memory_task_states SET phase = 'executing', updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3::uuid AND deleted_at IS NULL",
            [tenantId, spaceId, runId],
          );
        }

        return { ok: true as const, collabRunId, spaceId };
      });
      if (!claimed.ok) continue;

      // 将 step 重新入队
      try {
        const bj = await queue.add(
          "step",
          { jobId, runId, stepId },
          { attempts: 3, backoff: { type: "exponential", delay: 500 } },
        );
        await pool.query(
          "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2::uuid AND queue_job_id = $3",
          [String((bj as any).id), stepId, claimToken],
        );
      } catch (enqueueErr) {
        await withTransaction(pool, async (client) => {
          await client.query(
            "UPDATE steps SET queue_job_id = NULL, updated_at = now() WHERE step_id = $1::uuid AND queue_job_id = $2",
            [stepId, claimToken],
          );
          if (runStatus === "needs_device") {
            await client.query(
              "UPDATE runs SET status = 'needs_device', updated_at = now() WHERE run_id = $1::uuid AND tenant_id = $2 AND status = 'queued'",
              [runId, tenantId],
            );
            await client.query(
              "UPDATE jobs SET status = 'needs_device', updated_at = now() WHERE job_id = $1::uuid AND tenant_id = $2 AND status = 'queued'",
              [jobId, tenantId],
            );
            if (claimed.collabRunId) {
              await client.query(
                "UPDATE collab_runs SET status = 'needs_device', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2::uuid AND status = 'executing'",
                [tenantId, claimed.collabRunId],
              );
            }
            if (claimed.spaceId) {
              await client.query(
                "UPDATE memory_task_states SET phase = 'needs_device', updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3::uuid AND deleted_at IS NULL",
                [tenantId, claimed.spaceId, runId],
              );
            }
          }
        }).catch(() => undefined);
        throw enqueueErr;
      }

      console.log(`[device-resume-ticker] resumed: runId=${runId} stepId=${stepId} deviceExecutionId=${deviceExecutionId} jobId=${jobId}`);
    } catch (err) {
      console.error(`[device-resume-ticker] failed to resume: runId=${runId} stepId=${stepId} deviceExecutionId=${deviceExecutionId}`, err);
    }
  }
}
