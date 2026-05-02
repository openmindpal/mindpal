/**
 * deadLetterRetryTicker.ts — 死信队列自动重试
 *
 * 定期扫描已进入死信队列的可重试任务，按指数退避延迟重新入队。
 * 永久失败的任务标记 permanent_failure = true，不再重试。
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { StructuredLogger } from "@mindpal/shared";
import { classifyDeadLetter, MAX_DEADLETTER_RETRIES } from "./processor/stepErrorClassifier";

const _logger = new StructuredLogger({ module: "worker:deadLetterRetryTicker" });

/** 死信重试延迟：指数退避（30min, 1h, 2h） */
const RETRY_DELAYS_MS = [30 * 60_000, 60 * 60_000, 120 * 60_000];

/** 每次扫描批量限制 */
const BATCH_LIMIT = 10;

/**
 * 根据已重试次数计算当前应等待的延迟（毫秒）。
 * retryCount=0 → 第一次死信重试，对应 RETRY_DELAYS_MS[0]
 */
function getRetryDelayMs(retryCount: number): number {
  return RETRY_DELAYS_MS[Math.min(retryCount, RETRY_DELAYS_MS.length - 1)];
}

/**
 * 扫描可重试的死信任务并重新入队。
 * 此函数可直接被 tickerRegistry 调用。
 */
export async function tickDeadLetterRetry(params: { pool: Pool; queue: Queue }): Promise<void> {
  const { pool, queue } = params;

  // 1. 查询可重试的死信 step（未永久失败、未超重试上限、已过延迟窗口）
  const res = await pool.query(
    `
    SELECT
      s.step_id,
      s.run_id,
      s.deadlettered_at,
      s.deadletter_retry_count,
      s.last_error_digest,
      s.error_category,
      j.job_id,
      r.tenant_id
    FROM steps s
    JOIN runs r ON r.run_id = s.run_id
    JOIN jobs j ON j.run_id::text = r.run_id::text AND j.tenant_id = r.tenant_id
    WHERE s.deadlettered_at IS NOT NULL
      AND s.permanent_failure = false
      AND s.deadletter_retry_count < $1
    ORDER BY s.deadlettered_at ASC
    LIMIT $2
    `,
    [MAX_DEADLETTER_RETRIES, BATCH_LIMIT],
  );

  if (!res.rowCount) return;

  for (const row of res.rows) {
    const stepId = String(row.step_id);
    const runId = String(row.run_id);
    const jobId = String(row.job_id);
    const tenantId = String(row.tenant_id);
    const retryCount = Number(row.deadletter_retry_count ?? 0);
    const deadletteredAt = row.deadlettered_at as Date;

    // 检查是否已过延迟窗口
    const delayMs = getRetryDelayMs(retryCount);
    const readyAt = new Date(deadletteredAt.getTime() + delayMs);
    if (readyAt.getTime() > Date.now()) {
      // 还没到重试时间，跳过
      continue;
    }

    // 使用 last_error_digest 重建错误信息用于分类
    const errorMsg = extractErrorFromDigest(row.last_error_digest);
    const dlCategory = classifyDeadLetter(errorMsg, retryCount);

    if (dlCategory === "permanent_deadletter") {
      // 永久失败：标记并跳过
      try {
        await pool.query(
          `UPDATE steps SET permanent_failure = true, updated_at = now() WHERE step_id = $1`,
          [stepId],
        );
        _logger.info("dead letter marked permanent", {
          stepId,
          runId,
          jobId,
          retryCount,
          errorCategory: row.error_category ?? null,
        });
      } catch (markErr) {
        _logger.error("failed to mark permanent failure", {
          stepId,
          err: (markErr as Error)?.message ?? markErr,
        });
      }
      continue;
    }

    // 可重试：重新入队
    try {
      const bj = await queue.add(
        "step",
        { jobId, runId, stepId },
        { attempts: 3, backoff: { type: "exponential", delay: 500 } },
      );

      // 更新数据库状态：增加重试计数、清除死信标记、恢复 pending 状态
      await pool.query(
        `
        UPDATE steps
        SET deadlettered_at = NULL,
            deadletter_retry_count = deadletter_retry_count + 1,
            status = 'pending',
            queue_job_id = $2,
            finished_at = NULL,
            updated_at = now()
        WHERE step_id = $1
        `,
        [stepId, String((bj as any).id)],
      );

      // 恢复关联 run 和 job 状态
      await pool.query(
        `UPDATE runs SET status = 'queued', finished_at = NULL, updated_at = now() WHERE run_id = $1::uuid AND tenant_id = $2`,
        [runId, tenantId],
      );
      await pool.query(
        `UPDATE jobs SET deadlettered_at = NULL, status = 'queued', updated_at = now() WHERE job_id = $1::uuid AND tenant_id = $2`,
        [jobId, tenantId],
      );

      _logger.info("dead letter re-enqueued", {
        stepId,
        runId,
        jobId,
        retryCount: retryCount + 1,
        maxRetries: MAX_DEADLETTER_RETRIES,
        delayMs,
        queueJobId: String((bj as any).id),
      });
    } catch (enqueueErr) {
      _logger.error("failed to re-enqueue dead letter", {
        stepId,
        runId,
        jobId,
        retryCount,
        err: (enqueueErr as Error)?.message ?? enqueueErr,
      });
    }
  }
}

/**
 * 从 last_error_digest (JSONB) 中提取错误消息字符串，
 * 用于 classifyDeadLetter 分类。
 */
function extractErrorFromDigest(digest: unknown): string {
  if (digest == null) return "unknown";
  if (typeof digest === "string") return digest;
  if (typeof digest === "object") {
    const d = digest as Record<string, unknown>;
    if (typeof d.message === "string") return d.message;
    if (typeof d.error === "string") return d.error;
    // nested value from redactValue wrapper
    if (d.value && typeof d.value === "object") {
      const v = d.value as Record<string, unknown>;
      if (typeof v.message === "string") return v.message;
    }
  }
  return "unknown";
}
