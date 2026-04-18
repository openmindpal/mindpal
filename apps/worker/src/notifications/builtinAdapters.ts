/**
 * builtinAdapters.ts — 内置通知频道适配器
 *
 * 将原 queueConsumer.ts 中 switch/case 的四条硬编码分支
 * 拆分为独立的 ChannelDeliveryAdapter 实现。
 *
 * 启动时调用 registerBuiltinChannelAdapters() 完成注册。
 * 新增频道只需在此文件或外部模块中追加适配器注册，零修改分发逻辑。
 */
import {
  registerChannelAdapter,
  type ChannelDeliveryAdapter,
  type DeliveryContext,
  type NotificationPayload,
} from "./channelAdapterRegistry";

// ── Redis Pub/Sub 频道（与 API realtimeNotification.ts 保持一致） ──
const NOTIF_PUSH_CHANNEL = "notification:ws:push";

// ── inapp ────────────────────────────────────────────────────

const inappAdapter: ChannelDeliveryAdapter = {
  channel: "inapp",

  async deliver(ctx: DeliveryContext, notification: NotificationPayload): Promise<void> {
    // In-app 通知：标记为已送达 + 通过 Redis Pub/Sub 推送到在线用户 WS
    if (ctx.redis && notification.subject_id) {
      try {
        const payload = JSON.stringify({
          targetSubjectId: notification.subject_id,
          targetTenantId: notification.tenant_id,
          fromNodeId: "worker",
          notification: {
            notificationId: notification.notification_id,
            event: notification.event,
            title: notification.title,
            body: notification.body,
            metadata: notification.metadata,
            createdAt: new Date().toISOString(),
          },
        });
        await ctx.redis.publish(NOTIF_PUSH_CHANNEL, payload);
      } catch (e: any) {
        console.warn("[inappAdapter] WS push failed", { error: String(e?.message ?? e) });
      }
    }
  },
};

// ── email ────────────────────────────────────────────────────

const emailAdapter: ChannelDeliveryAdapter = {
  channel: "email",

  async deliver(ctx: DeliveryContext, notification: NotificationPayload): Promise<void> {
    // 委派给已有的 notification_outbox → smtpDelivery 管道
    await ctx.pool.query(
      `INSERT INTO notification_outbox
       (tenant_id, space_id, template_id, channel, recipient, payload, status, created_at, updated_at)
       VALUES ($1, $2, NULL, 'email', $3, $4, 'queued', now(), now())
       ON CONFLICT DO NOTHING`,
      [
        notification.tenant_id,
        notification.space_id,
        notification.subject_id ?? "",
        JSON.stringify({
          event: notification.event,
          title: notification.title,
          body: notification.body,
          metadata: notification.metadata,
        }),
      ],
    );
  },
};

// ── webhook ──────────────────────────────────────────────────

const webhookAdapter: ChannelDeliveryAdapter = {
  channel: "webhook",

  async deliver(ctx: DeliveryContext, notification: NotificationPayload): Promise<void> {
    // 委派给已有的 webhook delivery 管道
    await ctx.pool.query(
      `INSERT INTO webhook_delivery_queue
       (tenant_id, space_id, event, payload, status, created_at)
       VALUES ($1, $2, $3, $4, 'queued', now())
       ON CONFLICT DO NOTHING`,
      [
        notification.tenant_id,
        notification.space_id,
        notification.event,
        JSON.stringify({
          notificationId: notification.notification_id,
          title: notification.title,
          body: notification.body,
          metadata: notification.metadata,
        }),
      ],
    );
  },
};

// ── im ───────────────────────────────────────────────────────

const imAdapter: ChannelDeliveryAdapter = {
  channel: "im",

  async deliver(ctx: DeliveryContext, notification: NotificationPayload): Promise<void> {
    // IM 通知：委派给 channel outbox
    await ctx.pool.query(
      `INSERT INTO channel_outbox
       (tenant_id, space_id, channel, recipient, payload, status, created_at, updated_at)
       VALUES ($1, $2, 'im', $3, $4, 'queued', now(), now())
       ON CONFLICT DO NOTHING`,
      [
        notification.tenant_id,
        notification.space_id,
        notification.subject_id ?? "",
        JSON.stringify({
          event: notification.event,
          title: notification.title,
          body: notification.body,
          metadata: notification.metadata,
        }),
      ],
    );
  },
};

// ── 统一注册入口 ─────────────────────────────────────────────

/**
 * 注册所有内置频道适配器。
 * 在 worker 启动时调用一次即可。
 */
export function registerBuiltinChannelAdapters(): void {
  registerChannelAdapter(inappAdapter);
  registerChannelAdapter(emailAdapter);
  registerChannelAdapter(webhookAdapter);
  registerChannelAdapter(imAdapter);
}
