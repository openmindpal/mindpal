/**
 * Worker-side: notification_queue 消费者
 *
 * 定期从 notification_queue 表中取出 queued 状态的通知，
 * 通过 channelAdapterRegistry 动态分发投递（零硬编码分支）。
 *
 * 频道适配器在 builtinAdapters.ts 中注册，新增频道无需修改此文件。
 */
import type { Pool } from "pg";
import type { Redis as RedisClient } from "ioredis";
import { dispatchDelivery } from "./channelAdapterRegistry";

export async function tickNotificationQueue(params: { pool: Pool; redis?: RedisClient | null }): Promise<void> {
  const { pool, redis } = params;
  const batchSize = Math.max(1, Math.min(200, Number(process.env.NOTIFICATION_BATCH_SIZE) || 50));

  try {
    // 取出一批待发送的通知（乐观锁更新 status → sending）
    const res = await pool.query<{
      notification_id: string;
      tenant_id: string;
      space_id: string | null;
      subject_id: string | null;
      channel: string;
      event: string;
      title: string;
      body: string;
      metadata: any;
      attempts: number;
    }>(
      `UPDATE notification_queue
       SET status = 'sending', attempts = attempts + 1, updated_at = now()
       WHERE notification_id IN (
         SELECT notification_id FROM notification_queue
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING notification_id, tenant_id, space_id, subject_id, channel, event, title, body, metadata, attempts`,
      [batchSize],
    );

    if (!res.rowCount || res.rowCount === 0) return;

    for (const row of res.rows) {
      try {
        await dispatchDelivery({ pool, redis }, row);
        await pool.query(
          "UPDATE notification_queue SET status = 'sent', sent_at = now(), updated_at = now() WHERE notification_id = $1",
          [row.notification_id],
        );
      } catch (e: any) {
        const maxAttempts = 5;
        const nextStatus = row.attempts >= maxAttempts ? "failed" : "queued";
        await pool.query(
          "UPDATE notification_queue SET status = $2, last_error = $3, updated_at = now() WHERE notification_id = $1",
          [row.notification_id, nextStatus, String(e?.message ?? e).slice(0, 1000)],
        );
        if (nextStatus === "failed") {
          console.warn("[tickNotificationQueue] notification permanently failed", {
            notificationId: row.notification_id,
            channel: row.channel,
            error: String(e?.message ?? e),
          });
        }
      }
    }

    if (res.rowCount > 0) {
      console.log(`[tickNotificationQueue] processed ${res.rowCount} notifications`);
    }
  } catch (e: any) {
    console.warn("[tickNotificationQueue] tick failed", { error: String(e?.message ?? e) });
  }
}


