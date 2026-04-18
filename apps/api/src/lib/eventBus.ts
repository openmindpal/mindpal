/**
 * Unified Event Bus — 统一事件总线实现
 *
 * P1-01: 基于 @openslin/shared 核心类型，Redis Pub/Sub + DB outbox + 进程内分发。
 * P2-触发器: 增强 — Webhook 出站分发 + 事件确认/重试 + 通配符通道 + 统一内外分发。
 * 支持连接复用、自动重连、可靠投递。
 */
import type { Pool } from "pg";
import type {
  EventEnvelope, EventHandler, EventBusSubscription, EventBus,
} from "@openslin/shared";
import { eventBusRedisChannel } from "@openslin/shared";

// re-export shared types for module convenience
export type { EventEnvelope, EventHandler, EventBusSubscription, EventBus };
export { EventChannels } from "@openslin/shared";

// ── P2: 扩展 EventBus 接口 ─────────────────────────────────────

/** Webhook 订阅配置 */
export interface WebhookSubscription {
  /** 订阅 ID */
  subscriptionId: string;
  /** 租户隔离 */
  tenantId: string;
  /** 目标 URL */
  targetUrl: string;
  /** 匹配的事件通道模式（支持 * 通配符，如 "agent.*"） */
  channelPattern: string;
  /** 匹配的事件类型模式（可选，为空匹配全部） */
  eventTypePattern?: string;
  /** 签名密钥（HMAC-SHA256） */
  secret?: string;
  /** 最大重试次数 */
  maxRetries: number;
  /** 状态 */
  status: "active" | "paused" | "disabled";
}

/** 扩展 EventBus: 统一内部事件 + 外部 Webhook 分发 */
export interface ExtendedEventBus extends EventBus {
  /** 发布事件并同时分发到匹配的 Webhook 订阅 */
  publishAndDeliver(event: Omit<EventEnvelope, "eventId" | "timestamp">): Promise<string>;
  /** 查询未确认的事件（需要 ack 但尚未确认） */
  getUnacknowledgedEvents(params: { tenantId: string; limit?: number; olderThanMs?: number }): Promise<EventEnvelope[]>;
  /** 重试一个失败/未确认的事件 */
  retryEvent(eventId: string): Promise<boolean>;
}

// ── 实现 ────────────────────────────────────────────────────

// ── P2: 通配符匹配工具 ─────────────────────────────────────────

/** 检查通道名是否匹配通配符模式（支持 * 单段 和 ** 多段） */
export function channelMatchesPattern(channel: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  if (pattern === channel) return true;
  // 转换 glob 模式到正则
  const regexStr = "^" + pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^.]+")
    .replace(/__DOUBLE_STAR__/g, ".*")
  + "$";
  try {
    return new RegExp(regexStr).test(channel);
  } catch {
    return false;
  }
}

export function createEventBus(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
}): ExtendedEventBus {
  const { pool, redis } = params;
  const handlers = new Map<string, Set<EventHandler>>();

  // P1-01: 复用单个 Redis 订阅连接，而不是每次 subscribe 都新建连接
  let sharedSubClient: any = null;
  let sharedSubReady = false;
  const subscribedRedisChannels = new Set<string>();

  async function ensureSharedSubClient(): Promise<any> {
    if (sharedSubClient && sharedSubReady) return sharedSubClient;
    try {
      const { default: Redis } = await import("ioredis");
      const redisCfg = {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null as null,
        lazyConnect: true,
        connectTimeout: 500,
        retryStrategy(times: number) {
          // 自动重连，指数退避，最大 30s
          return Math.min(times * 500, 30_000);
        },
      };
      sharedSubClient = new Redis(redisCfg);

      sharedSubClient.on("message", (ch: string, raw: string) => {
        // 去掉 eventbus: 前缀获取逻辑频道名
        const logicalChannel = ch.startsWith("eventbus:") ? ch.slice(9) : ch;
        try {
          const event: EventEnvelope = JSON.parse(raw);
          dispatchInProcess(event);
        } catch { /* ignore malformed */ }
      });

      // P2: 通配符订阅的 Redis pmessage 回调
      sharedSubClient.on("pmessage", (_pattern: string, ch: string, raw: string) => {
        const logicalChannel = ch.startsWith("eventbus:") ? ch.slice(9) : ch;
        try {
          const event: EventEnvelope = JSON.parse(raw);
          // pmessage 走通配符分发
          for (const [pat, patHandlers] of wildcardHandlers) {
            if (channelMatchesPattern(logicalChannel, pat)) {
              for (const h of patHandlers) {
                try { h(event); } catch { /* ignore */ }
              }
            }
          }
        } catch { /* ignore malformed */ }
      });

      sharedSubClient.on("ready", () => {
        sharedSubReady = true;
        // 重连后重新订阅所有频道
        if (subscribedRedisChannels.size > 0) {
          sharedSubClient.subscribe(...subscribedRedisChannels).catch(() => {});
        }
      });
      sharedSubClient.on("error", () => { /* ioredis 自动重连 */ });
      sharedSubClient.on("close", () => { sharedSubReady = false; });

      await sharedSubClient.connect();
      sharedSubReady = true;
      return sharedSubClient;
    } catch {
      try {
        sharedSubClient?.disconnect();
      } catch {}
      sharedSubClient = null;
      sharedSubReady = false;
      return null;
    }
  }

  // P2: 通配符订阅注册表（pattern → handlers）
  const wildcardHandlers = new Map<string, Set<EventHandler>>();

  /** 进程内分发（含通配符匹配） */
  function dispatchInProcess(envelope: EventEnvelope) {
    // 精确匹配
    const exact = handlers.get(envelope.channel);
    if (exact) {
      for (const h of exact) {
        try { h(envelope); } catch { /* handler 异常不传播 */ }
      }
    }
    // 通配符匹配
    for (const [pattern, patternHandlers] of wildcardHandlers) {
      if (channelMatchesPattern(envelope.channel, pattern)) {
        for (const h of patternHandlers) {
          try { h(envelope); } catch { /* handler 异常不传播 */ }
        }
      }
    }
  }

  /** P2: Webhook 出站分发 — 将事件投递到匹配的 Webhook 订阅 */
  async function publishToWebhooks(envelope: EventEnvelope): Promise<void> {
    try {
      const subs = await pool.query<{
        subscription_id: string; target_url: string;
        channel_pattern: string; event_type_pattern: string | null;
        secret: string | null; max_retries: number;
      }>(
        `SELECT subscription_id, target_url, channel_pattern, event_type_pattern, secret, max_retries
         FROM event_webhook_subscriptions
         WHERE tenant_id = $1 AND status = 'active'`,
        [envelope.tenantId],
      );
      for (const sub of subs.rows) {
        if (!channelMatchesPattern(envelope.channel, sub.channel_pattern)) continue;
        if (sub.event_type_pattern && !channelMatchesPattern(envelope.eventType, sub.event_type_pattern)) continue;
        // 写入 webhook 投递队列（异步投递，Worker 处理实际 HTTP 调用）
        await pool.query(
          `INSERT INTO webhook_delivery_queue (tenant_id, space_id, event, payload, status, created_at)
           VALUES ($1, NULL, $2, $3, 'queued', now())
           ON CONFLICT DO NOTHING`,
          [
            envelope.tenantId,
            envelope.eventType,
            JSON.stringify({
              subscriptionId: sub.subscription_id,
              targetUrl: sub.target_url,
              envelope,
              secret: sub.secret,
              maxRetries: sub.max_retries,
            }),
          ],
        );
      }
    } catch {
      // Webhook 订阅表可能不存在，静默降级
    }
  }

  return {
    async publish(event) {
      const eventId = crypto.randomUUID();
      const envelope: EventEnvelope = {
        ...event,
        eventId,
        timestamp: Date.now(),
      };

      // DB outbox（可靠持久化）
      try {
        await pool.query(
          `INSERT INTO event_outbox (event_id, channel, event_type, payload, tenant_id, source_module, requires_ack, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT DO NOTHING`,
          [eventId, event.channel, event.eventType, JSON.stringify(event.payload),
           event.tenantId, event.sourceModule, event.requiresAck ?? false],
        );
      } catch {
        // DB outbox 表可能不存在，降级到仅 Redis
      }

      // Redis Pub/Sub（实时推送）
      if (redis) {
        try {
          await redis.publish(eventBusRedisChannel(event.channel), JSON.stringify(envelope));
        } catch { /* Redis 发布失败不影响主流程 */ }
      }

      // 进程内分发（含通配符）
      dispatchInProcess(envelope);

      return eventId;
    },

    async subscribe(channel, handler) {
      const isWildcard = channel.includes("*");

      if (isWildcard) {
        // P2: 通配符订阅 — 进程内匹配
        if (!wildcardHandlers.has(channel)) wildcardHandlers.set(channel, new Set());
        wildcardHandlers.get(channel)!.add(handler);

        // 对于通配符，订阅 Redis psubscribe（模式订阅）
        const redisPattern = eventBusRedisChannel(channel).replace(/\*/g, "*");
        const sub = await ensureSharedSubClient();
        if (sub) {
          try { await sub.psubscribe(redisPattern); } catch { /* ignore */ }
        }

        return {
          unsubscribe: async () => {
            wildcardHandlers.get(channel)?.delete(handler);
            if (!wildcardHandlers.get(channel)?.size) {
              wildcardHandlers.delete(channel);
              if (sharedSubClient && sharedSubReady) {
                try { await sharedSubClient.punsubscribe(redisPattern); } catch { /* ignore */ }
              }
            }
          },
        };
      }

      // 精确匹配（原有逻辑）
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);

      // Redis 订阅（复用共享连接）
      const redisChannel = eventBusRedisChannel(channel);
      if (!subscribedRedisChannels.has(redisChannel)) {
        subscribedRedisChannels.add(redisChannel);
        const sub = await ensureSharedSubClient();
        if (sub) {
          try { await sub.subscribe(redisChannel); } catch { /* ignore */ }
        }
      }

      return {
        unsubscribe: async () => {
          handlers.get(channel)?.delete(handler);
          // 如果该频道没有其他 handler，取消 Redis 订阅
          if (!handlers.get(channel)?.size) {
            handlers.delete(channel);
            subscribedRedisChannels.delete(redisChannel);
            if (sharedSubClient && sharedSubReady) {
              try { await sharedSubClient.unsubscribe(redisChannel); } catch { /* ignore */ }
            }
          }
        },
      };
    },

    async acknowledge(eventId) {
      try {
        await pool.query(
          `UPDATE event_outbox SET acknowledged = true, acknowledged_at = now() WHERE event_id = $1`,
          [eventId],
        );
      } catch { /* 确认失败不影响主流程 */ }
    },

    // P2: publishAndDeliver — 发布事件 + Webhook 出站分发
    async publishAndDeliver(event) {
      const eventId = await this.publish(event);
      const envelope: EventEnvelope = {
        ...event,
        eventId,
        timestamp: Date.now(),
      };
      // 异步分发到 Webhook 订阅（fire-and-forget）
      publishToWebhooks(envelope).catch(() => {});
      return eventId;
    },

    // P2: getUnacknowledgedEvents — 查询未确认事件
    async getUnacknowledgedEvents(params) {
      const { tenantId, limit = 50, olderThanMs = 60_000 } = params;
      try {
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        const res = await pool.query<{
          event_id: string; channel: string; event_type: string;
          payload: any; tenant_id: string; source_module: string;
          requires_ack: boolean; created_at: string;
        }>(
          `SELECT event_id, channel, event_type, payload, tenant_id, source_module, requires_ack, created_at
           FROM event_outbox
           WHERE tenant_id = $1 AND requires_ack = true AND acknowledged = false AND created_at < $2
           ORDER BY created_at ASC LIMIT $3`,
          [tenantId, cutoff, limit],
        );
        return res.rows.map(r => ({
          eventId: r.event_id,
          channel: r.channel,
          eventType: r.event_type,
          payload: typeof r.payload === "string" ? JSON.parse(r.payload) : (r.payload ?? {}),
          tenantId: r.tenant_id,
          sourceModule: r.source_module,
          timestamp: new Date(r.created_at).getTime(),
          requiresAck: r.requires_ack,
        }));
      } catch {
        return [];
      }
    },

    // P2: retryEvent — 重新发布一个未确认事件
    async retryEvent(eventId) {
      try {
        const res = await pool.query<{
          channel: string; event_type: string; payload: any;
          tenant_id: string; source_module: string; requires_ack: boolean;
        }>(
          `SELECT channel, event_type, payload, tenant_id, source_module, requires_ack
           FROM event_outbox WHERE event_id = $1 AND acknowledged = false`,
          [eventId],
        );
        if (!res.rowCount) return false;
        const row = res.rows[0];
        const parsedPayload = typeof row.payload === "string" ? JSON.parse(row.payload) : (row.payload ?? {});
        const envelope: EventEnvelope = {
          eventId,
          channel: row.channel,
          eventType: row.event_type,
          payload: parsedPayload,
          tenantId: row.tenant_id,
          sourceModule: row.source_module,
          timestamp: Date.now(),
          requiresAck: row.requires_ack,
        };
        // 重新通过 Redis + 进程内分发
        if (redis) {
          try {
            await redis.publish(eventBusRedisChannel(row.channel), JSON.stringify(envelope));
          } catch { /* ignore */ }
        }
        dispatchInProcess(envelope);
        // 重新投递到 Webhook
        publishToWebhooks(envelope).catch(() => {});
        return true;
      } catch {
        return false;
      }
    },

    async close() {
      handlers.clear();
      wildcardHandlers.clear();
      subscribedRedisChannels.clear();
      if (sharedSubClient) {
        try { await sharedSubClient.quit(); } catch { /* ignore */ }
        sharedSubClient = null;
        sharedSubReady = false;
      }
    },
  };
}
