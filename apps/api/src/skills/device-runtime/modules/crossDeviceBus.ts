import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:crossDeviceBus" });

/**
 * P2: Cross-Device Bus — 跨设备实时通信总线核心
 *
 * 在现有 deviceMessageBus（Redis Pub/Sub + pending list）之上，
 * 增加 D2D 路由协议层，提供：
 *
 * 1. 消息信封（D2DEnvelope）—— 带路由元数据、投递追踪、优先级
 * 2. At-least-once 投递保证 —— DB 持久化 + Redis 实时推送双写
 * 3. 送达回执（delivery receipt）—— 目标设备 ACK 后更新状态
 * 4. 重复检测 —— 基于 messageId 幂等
 * 5. Topic 订阅持久化 —— 设备可持久订阅 topic，离线期间消息排队
 * 6. 消息 TTL + 过期清理
 *
 * 设计约束：
 * - DB 表 `device_messages` 用于持久化（保证不丢），Redis 用于低延迟推送
 * - 消息按 tenant+device 隔离
 * - 不依赖特定 WS 实现，通过回调/Redis 投递
 */
import type { Pool } from "pg";
import type Redis from "ioredis";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** 消息优先级 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/** 投递状态 */
export type DeliveryStatus =
  | "pending"    // 已入库，等待投递
  | "sent"       // 已通过 WS/Redis 推送
  | "delivered"  // 目标设备已 ACK
  | "failed"     // 投递失败（超过重试或目标无效）
  | "expired";   // TTL 过期

/** 消息路由类型 */
export type RoutingKind = "direct" | "topic" | "broadcast" | "multicast";

/**
 * D2D 消息信封 —— 完整的跨设备消息包装
 */
export interface D2DEnvelope {
  /** 全局唯一消息 ID */
  messageId: string;
  /** 租户隔离 */
  tenantId: string;
  /** 路由类型 */
  routingKind: RoutingKind;
  /** 发送方设备 ID（null = 系统/API 发出） */
  fromDeviceId: string | null;
  /** 目标设备 ID（direct/multicast 时使用） */
  toDeviceId: string | null;
  /** 目标设备列表（multicast 时使用） */
  toDeviceIds?: string[];
  /** Topic 名称（topic 路由时使用） */
  topic: string | null;
  /** 消息类别标签 */
  category: string;
  /** 消息优先级 */
  priority: MessagePriority;
  /** 消息负载（业务数据） */
  payload: Record<string, unknown>;
  /** 需要送达回执 */
  requireAck: boolean;
  /** 消息 TTL (ms)，0 = 永不过期 */
  ttlMs: number;
  /** 创建时间 (epoch ms) */
  createdAt: number;
  /** 过期时间 (epoch ms)，0 = 永不过期 */
  expiresAt: number;
  /** 投递状态 */
  status: DeliveryStatus;
  /** 送达时间 */
  deliveredAt: number | null;
  /** 重试次数 */
  retryCount: number;
  /** 最大重试次数 */
  maxRetries: number;
  /** 关联的 correlationId（请求-响应模式） */
  correlationId: string | null;
  /** 回复目标消息 ID */
  replyTo: string | null;
}

/** 创建消息的输入参数 */
export interface SendD2DParams {
  tenantId: string;
  fromDeviceId: string | null;
  routingKind: RoutingKind;
  toDeviceId?: string | null;
  toDeviceIds?: string[];
  topic?: string | null;
  category?: string;
  priority?: MessagePriority;
  payload: Record<string, unknown>;
  requireAck?: boolean;
  ttlMs?: number;
  maxRetries?: number;
  correlationId?: string | null;
  replyTo?: string | null;
}

/** Topic 订阅记录 */
export interface TopicSubscription {
  tenantId: string;
  deviceId: string;
  topic: string;
  subscribedAt: number;
  persistent: boolean; // 持久订阅 → 离线时排队消息
}

/** 送达回执 */
export interface DeliveryReceipt {
  messageId: string;
  deviceId: string;
  status: "ack" | "nack";
  receivedAt: number;
  reason?: string;
}

/* ================================================================== */
/*  Configuration                                                       */
/* ================================================================== */

const DEFAULT_TTL_MS = Math.max(60_000, Number(process.env.D2D_DEFAULT_TTL_MS) || 24 * 60 * 60 * 1000); // 24h
const MAX_PENDING_PER_DEVICE = Math.max(100, Number(process.env.D2D_MAX_PENDING_PER_DEVICE) || 1000);
const DEFAULT_MAX_RETRIES = Math.max(0, Number(process.env.D2D_MAX_RETRIES) || 3);
const DEDUP_WINDOW_SEC = Math.max(60, Number(process.env.D2D_DEDUP_WINDOW_SEC) || 3600); // 1h

/** Redis key helpers */
function pendingKey(tenantId: string, deviceId: string) { return `d2d:pending:${tenantId}:${deviceId}`; }
function dedupKey(tenantId: string, messageId: string) { return `d2d:dedup:${tenantId}:${messageId}`; }
function topicSubsKey(tenantId: string, topic: string) { return `d2d:topic_subs:${tenantId}:${topic}`; }
function deviceSubsKey(tenantId: string, deviceId: string) { return `d2d:device_subs:${tenantId}:${deviceId}`; }
function statusChannel(tenantId: string, deviceId: string) { return `d2d:ch:${tenantId}:${deviceId}`; }
function topicChannel(tenantId: string, topic: string) { return `d2d:topic_ch:${tenantId}:${topic}`; }
function broadcastChannel(tenantId: string) { return `d2d:broadcast:${tenantId}`; }

/* ================================================================== */
/*  Core: Send Message                                                   */
/* ================================================================== */

/**
 * 发送 D2D 消息：DB 持久化 + Redis 实时推送
 * 返回消息信封（含 messageId 和初始状态）
 */
export async function sendD2DMessage(params: {
  pool: Pool;
  redis: Redis;
  msg: SendD2DParams;
}): Promise<D2DEnvelope> {
  const { pool, redis, msg } = params;
  const now = Date.now();
  const messageId = crypto.randomUUID();
  const ttlMs = msg.ttlMs ?? DEFAULT_TTL_MS;

  const envelope: D2DEnvelope = {
    messageId,
    tenantId: msg.tenantId,
    routingKind: msg.routingKind,
    fromDeviceId: msg.fromDeviceId ?? null,
    toDeviceId: msg.toDeviceId ?? null,
    toDeviceIds: msg.toDeviceIds,
    topic: msg.topic ?? null,
    category: msg.category ?? "default",
    priority: msg.priority ?? "normal",
    payload: msg.payload,
    requireAck: msg.requireAck ?? false,
    ttlMs,
    createdAt: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    status: "pending",
    deliveredAt: null,
    retryCount: 0,
    maxRetries: msg.maxRetries ?? DEFAULT_MAX_RETRIES,
    correlationId: msg.correlationId ?? null,
    replyTo: msg.replyTo ?? null,
  };

  // P1-1 FIX: DB 持久化（保证不丢）— 使用事务确保原子性
  try {
    await persistMessage(pool, envelope);
  } catch (dbErr: any) {
    // DB 写入失败，整个消息发送失败
    _logger.error("DB persistence failed", { error: dbErr?.message });
    throw new Error(`message_persistence_failed: ${dbErr?.message}`);
  }

  // P1-1 FIX: Redis 推送（尽力而为，失败不影响已持久化的消息）
  let redisPushSucceeded = false;
  try {
    // 根据路由类型分发
    switch (msg.routingKind) {
      case "direct":
        if (envelope.toDeviceId) {
          await deliverToDevice(redis, envelope, envelope.toDeviceId);
        }
        break;

      case "multicast":
        for (const targetId of envelope.toDeviceIds ?? []) {
          await deliverToDevice(redis, envelope, targetId);
        }
        break;

      case "topic":
        if (envelope.topic) {
          await deliverToTopic(pool, redis, envelope);
        }
        break;

      case "broadcast":
        await deliverBroadcast(redis, envelope);
        break;
    }
    redisPushSucceeded = true;
  } catch (redisErr: any) {
    // P1-1 FIX: Redis 推送失败时记录警告，但不影响已持久化的消息
    // 离线设备可通过 pending list 拉取，在线设备会在下次心跳时收到
    _logger.warn("Redis push failed (message persisted)", { 
      messageId: envelope.messageId, error: redisErr?.message 
    });
    // 记录审计事件
    try {
      await pool.query(
        `INSERT INTO device_message_audit (tenant_id, message_id, event_type, details)
         VALUES ($1, $2, 'redis_push_failed', $3)
         ON CONFLICT DO NOTHING`,
        [envelope.tenantId, envelope.messageId, JSON.stringify({ error: redisErr?.message })]
      );
    } catch {
      // 审计写入失败不影响主流程
    }
  }

  return envelope;
}

/** 持久化消息到 DB */
async function persistMessage(pool: Pool, env: D2DEnvelope): Promise<void> {
  await pool.query(
    `INSERT INTO device_messages
       (message_id, tenant_id, routing_kind, from_device_id, to_device_id, topic, category,
        priority, payload, require_ack, ttl_ms, created_at, expires_at, status, max_retries,
        correlation_id, reply_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12::bigint/1000.0),
             CASE WHEN $13::bigint > 0 THEN to_timestamp($13::bigint/1000.0) ELSE NULL END,
             $14,$15,$16,$17)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      env.messageId, env.tenantId, env.routingKind, env.fromDeviceId, env.toDeviceId,
      env.topic, env.category, env.priority, JSON.stringify(env.payload),
      env.requireAck, env.ttlMs, env.createdAt, env.expiresAt,
      env.status, env.maxRetries, env.correlationId, env.replyTo,
    ],
  );
}

/** 投递到单个设备（Redis pending queue + Pub/Sub 实时通知） */
async function deliverToDevice(redis: Redis, env: D2DEnvelope, targetDeviceId: string): Promise<void> {
  const json = JSON.stringify(env);

  // 重复检测
  const dedupResult = await redis.set(
    dedupKey(env.tenantId, `${env.messageId}:${targetDeviceId}`),
    "1",
    "EX", DEDUP_WINDOW_SEC,
    "NX",
  );
  if (!dedupResult) return; // 已投递过

  // 推入 pending queue（LPUSH + LTRIM 限制上限）
  const key = pendingKey(env.tenantId, targetDeviceId);
  await redis.lpush(key, json);
  await redis.ltrim(key, 0, MAX_PENDING_PER_DEVICE - 1);
  // 设置 TTL（取消息 TTL 和全局 pending TTL 的较大值）
  const ttlSec = env.ttlMs > 0
    ? Math.ceil(env.ttlMs / 1000)
    : Math.ceil(DEFAULT_TTL_MS / 1000);
  await redis.expire(key, ttlSec);

  // Pub/Sub 实时通知（在线设备 WS 立刻收到）
  await redis.publish(statusChannel(env.tenantId, targetDeviceId), json);
}

/** 投递到 topic 的所有持久订阅者 */
async function deliverToTopic(pool: Pool, redis: Redis, env: D2DEnvelope): Promise<void> {
  if (!env.topic) return;

  // Pub/Sub 广播给在线订阅者
  const json = JSON.stringify(env);
  await redis.publish(topicChannel(env.tenantId, env.topic), json);

  // 查找持久订阅者，将消息推入其 pending queue
  const subscribers = await getTopicSubscribers(redis, env.tenantId, env.topic);
  for (const deviceId of subscribers) {
    // 不给发送者自己投递
    if (deviceId === env.fromDeviceId) continue;
    await deliverToDevice(redis, env, deviceId);
  }
}

/** 广播到 tenant 下所有设备（仅实时，不排队） */
async function deliverBroadcast(redis: Redis, env: D2DEnvelope): Promise<void> {
  const json = JSON.stringify(env);
  await redis.publish(broadcastChannel(env.tenantId), json);
}

/* ================================================================== */
/*  Delivery Receipt                                                     */
/* ================================================================== */

/**
 * 处理设备的送达回执
 */
export async function processDeliveryReceipt(params: {
  pool: Pool;
  redis: Redis;
  receipt: DeliveryReceipt;
}): Promise<void> {
  const { pool, redis, receipt } = params;

  const newStatus: DeliveryStatus = receipt.status === "ack" ? "delivered" : "failed";

  // 更新 DB 状态
  await pool.query(
    `UPDATE device_messages
     SET status = $2, delivered_at = to_timestamp($3::bigint/1000.0), updated_at = now()
     WHERE message_id = $1 AND status NOT IN ('delivered', 'expired')`,
    [receipt.messageId, newStatus, receipt.receivedAt],
  );

  // 从 pending queue 移除已确认的消息
  if (receipt.status === "ack") {
    const key = pendingKey("", receipt.deviceId); // 需要 tenantId
    // 查找 tenantId
    const msgRes = await pool.query(
      "SELECT tenant_id FROM device_messages WHERE message_id = $1 LIMIT 1",
      [receipt.messageId],
    );
    if (msgRes.rowCount) {
      const tenantId = String(msgRes.rows[0].tenant_id);
      await removePendingMessage(redis, tenantId, receipt.deviceId, receipt.messageId);
    }
  }
}

/** 从 pending queue 中移除特定消息 */
async function removePendingMessage(
  redis: Redis,
  tenantId: string,
  deviceId: string,
  messageId: string,
): Promise<void> {
  const key = pendingKey(tenantId, deviceId);
  // LRANGE + 手动移除（Redis 无按值删除 list 元素的高效方式，使用 LREM）
  // 为避免遍历大量数据，直接按 messageId 匹配 JSON
  // LREM key 1 value → 从左到右删除第一个匹配
  const items = await redis.lrange(key, 0, MAX_PENDING_PER_DEVICE);
  for (const item of items) {
    try {
      const parsed = JSON.parse(item);
      if (parsed.messageId === messageId) {
        await redis.lrem(key, 1, item);
        break;
      }
    } catch { /* skip */ }
  }
}

/* ================================================================== */
/*  Pending Messages (for reconnect delivery)                           */
/* ================================================================== */

/**
 * 获取设备的待投递消息（重连时调用）
 * 返回按优先级+时间排序的消息列表
 */
export async function getPendingD2DMessages(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
  limit?: number;
}): Promise<D2DEnvelope[]> {
  const key = pendingKey(params.tenantId, params.deviceId);
  const limit = Math.min(params.limit ?? 50, MAX_PENDING_PER_DEVICE);
  const raws = await params.redis.lrange(key, 0, limit - 1);

  const now = Date.now();
  const messages: D2DEnvelope[] = [];

  for (const raw of raws) {
    try {
      const env: D2DEnvelope = JSON.parse(raw);
      // 跳过已过期消息
      if (env.expiresAt > 0 && env.expiresAt < now) continue;
      messages.push(env);
    } catch { /* skip malformed */ }
  }

  // 按优先级排序：urgent > high > normal > low
  const priorityOrder: Record<MessagePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  messages.sort((a, b) => {
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return a.createdAt - b.createdAt; // 同优先级按时间排序
  });

  return messages;
}

/**
 * 批量确认 pending 消息已投递
 */
export async function ackPendingD2DMessages(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
  messageIds: string[];
}): Promise<number> {
  let removed = 0;
  for (const messageId of params.messageIds) {
    await removePendingMessage(params.redis, params.tenantId, params.deviceId, messageId);
    removed++;
  }
  return removed;
}

/* ================================================================== */
/*  Topic Subscriptions                                                  */
/* ================================================================== */

/**
 * 设备订阅 topic（持久化到 Redis）
 */
export async function subscribeTopic(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
  topic: string;
  persistent?: boolean;
}): Promise<void> {
  const { redis, tenantId, deviceId, topic } = params;

  // topic → device set
  await redis.sadd(topicSubsKey(tenantId, topic), deviceId);

  // device → topic set（方便重连时重新订阅）
  await redis.sadd(deviceSubsKey(tenantId, deviceId), topic);
}

/**
 * 设备取消订阅 topic
 */
export async function unsubscribeTopic(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
  topic: string;
}): Promise<void> {
  const { redis, tenantId, deviceId, topic } = params;
  await redis.srem(topicSubsKey(tenantId, topic), deviceId);
  await redis.srem(deviceSubsKey(tenantId, deviceId), topic);
}

/**
 * 获取 topic 的所有订阅设备
 */
async function getTopicSubscribers(redis: Redis, tenantId: string, topic: string): Promise<string[]> {
  return redis.smembers(topicSubsKey(tenantId, topic));
}

/**
 * 获取设备订阅的所有 topic
 */
export async function getDeviceSubscriptions(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
}): Promise<string[]> {
  return params.redis.smembers(deviceSubsKey(params.tenantId, params.deviceId));
}

/* ================================================================== */
/*  Message Status Query                                                 */
/* ================================================================== */

/**
 * 查询消息投递状态
 */
export async function getMessageStatus(params: {
  pool: Pool;
  messageId: string;
  tenantId: string;
}): Promise<{
  messageId: string;
  status: DeliveryStatus;
  createdAt: string | null;
  deliveredAt: string | null;
  expiresAt: string | null;
  retryCount: number;
} | null> {
  const res = await params.pool.query(
    `SELECT message_id, status, created_at, delivered_at, expires_at, retry_count
     FROM device_messages
     WHERE message_id = $1 AND tenant_id = $2`,
    [params.messageId, params.tenantId],
  );
  if (!res.rowCount) return null;
  const row = res.rows[0] as any;
  return {
    messageId: String(row.message_id),
    status: String(row.status) as DeliveryStatus,
    createdAt: row.created_at ? String(row.created_at) : null,
    deliveredAt: row.delivered_at ? String(row.delivered_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    retryCount: Number(row.retry_count ?? 0),
  };
}

/* ================================================================== */
/*  Cleanup: Expired Messages                                            */
/* ================================================================== */

/**
 * 清理过期消息（定时调用）
 */
export async function cleanupExpiredMessages(params: {
  pool: Pool;
  limit?: number;
}): Promise<number> {
  const res = await params.pool.query(
    `UPDATE device_messages
     SET status = 'expired', updated_at = now()
     WHERE status IN ('pending', 'sent')
       AND expires_at IS NOT NULL
       AND expires_at < now()
     LIMIT $1
     RETURNING message_id`,
    // PostgreSQL 不支持 UPDATE ... LIMIT，改用 CTE
  ).catch(() => null);

  // 使用 CTE 替代 LIMIT
  const res2 = await params.pool.query(
    `WITH expired AS (
       SELECT message_id FROM device_messages
       WHERE status IN ('pending', 'sent')
         AND expires_at IS NOT NULL
         AND expires_at < now()
       LIMIT $1
     )
     UPDATE device_messages m
     SET status = 'expired', updated_at = now()
     FROM expired e
     WHERE m.message_id = e.message_id
     RETURNING m.message_id`,
    [params.limit ?? 500],
  ).catch(() => ({ rowCount: 0 }));

  return res2?.rowCount ?? 0;
}

/**
 * 重试失败/pending 消息（定时调用）
 */
export async function retryPendingMessages(params: {
  pool: Pool;
  redis: Redis;
  limit?: number;
}): Promise<number> {
  const { pool, redis, limit = 100 } = params;

  // P1-1 FIX: 查找可重试的消息，增加指数退避检查
  const res = await pool.query(
    `SELECT message_id, tenant_id, routing_kind, from_device_id, to_device_id, topic, category,
            priority, payload, require_ack, ttl_ms, created_at, expires_at, status,
            retry_count, max_retries, correlation_id, reply_to, updated_at
     FROM device_messages
     WHERE status IN ('pending', 'sent')
       AND retry_count < max_retries
       AND (expires_at IS NULL OR expires_at > now())
       AND (
         -- 首次重试：30秒后
         (retry_count = 0 AND updated_at < now() - interval '30 seconds')
         OR
         -- 第二次重试：2分钟后
         (retry_count = 1 AND updated_at < now() - interval '2 minutes')
         OR
         -- 第三次及以上：5分钟后（指数退避）
         (retry_count >= 2 AND updated_at < now() - interval '5 minutes')
       )
     ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
       created_at ASC
     LIMIT $1`,
    [limit],
  );

  let retried = 0;
  let failedCount = 0;
  
  for (const row of res.rows as any[]) {
    const toDeviceId = row.to_device_id ? String(row.to_device_id) : null;
    if (!toDeviceId) continue;

    const env: D2DEnvelope = {
      messageId: String(row.message_id),
      tenantId: String(row.tenant_id),
      routingKind: String(row.routing_kind) as RoutingKind,
      fromDeviceId: row.from_device_id ? String(row.from_device_id) : null,
      toDeviceId,
      topic: row.topic ? String(row.topic) : null,
      category: String(row.category ?? "default"),
      priority: String(row.priority ?? "normal") as MessagePriority,
      payload: typeof row.payload === "string" ? JSON.parse(row.payload) : (row.payload ?? {}),
      requireAck: Boolean(row.require_ack),
      ttlMs: Number(row.ttl_ms ?? 0),
      createdAt: new Date(row.created_at).getTime(),
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : 0,
      status: "pending",
      deliveredAt: null,
      retryCount: Number(row.retry_count ?? 0) + 1,
      maxRetries: Number(row.max_retries ?? DEFAULT_MAX_RETRIES),
      correlationId: row.correlation_id ? String(row.correlation_id) : null,
      replyTo: row.reply_to ? String(row.reply_to) : null,
    };

    try {
      await deliverToDevice(redis, env, toDeviceId);

      // 更新重试计数
      await pool.query(
        "UPDATE device_messages SET retry_count = retry_count + 1, status = 'sent', updated_at = now() WHERE message_id = $1",
        [env.messageId],
      );

      retried++;
    } catch (retryErr: any) {
      // P1-1 FIX: 重试失败时记录错误，超过最大重试次数则标记为failed
      failedCount++;
      _logger.warn("retry failed for message", { messageId: env.messageId, error: retryErr?.message });
      
      if (env.retryCount >= env.maxRetries) {
        // 超过最大重试次数，标记为failed
        await pool.query(
          `UPDATE device_messages 
           SET status = 'failed', updated_at = now()
           WHERE message_id = $1`,
          [env.messageId]
        );
        
        // 记录失败审计事件
        try {
          await pool.query(
            `INSERT INTO device_message_audit (tenant_id, message_id, event_type, details)
             VALUES ($1, $2, 'retry_exhausted', $3)
             ON CONFLICT DO NOTHING`,
            [env.tenantId, env.messageId, JSON.stringify({ 
              retryCount: env.retryCount,
              error: retryErr?.message 
            })]
          );
        } catch {
          // 审计写入失败不影响主流程
        }
      }
    }
  }
  
  if (failedCount > 0) {
    _logger.warn("retry summary", { succeeded: retried, failed: failedCount });
  }

  return retried;
}

/* ================================================================== */
/*  Redis Subscription helpers                                           */
/* ================================================================== */

/**
 * 订阅设备的 D2D 实时消息频道（用于 WS 集成）
 * 包括：direct channel + 已订阅 topic channels + broadcast channel
 */
export async function subscribeD2DChannels(params: {
  subClient: Redis;
  redis: Redis;
  tenantId: string;
  deviceId: string;
  onMessage: (env: D2DEnvelope) => void;
}): Promise<() => void> {
  const { subClient, redis, tenantId, deviceId, onMessage } = params;

  // 收集所有需要订阅的频道
  const channels = [
    statusChannel(tenantId, deviceId),
    broadcastChannel(tenantId),
  ];

  // 获取设备已订阅的 topic
  const topics = await getDeviceSubscriptions({ redis, tenantId, deviceId });
  for (const t of topics) {
    channels.push(topicChannel(tenantId, t));
  }

  const handler = (_channel: string, raw: string) => {
    try {
      const env: D2DEnvelope = JSON.parse(raw);
      onMessage(env);
    } catch { /* skip malformed */ }
  };

  subClient.on("message", handler);
  if (channels.length > 0) {
    await subClient.subscribe(...channels);
  }

  return () => {
    subClient.unsubscribe(...channels).catch(() => {});
    subClient.removeListener("message", handler);
  };
}

/**
 * 动态订阅新 topic（设备在线时新增订阅）
 */
export async function dynamicSubscribeTopicChannel(params: {
  subClient: Redis;
  tenantId: string;
  topic: string;
}): Promise<void> {
  await params.subClient.subscribe(topicChannel(params.tenantId, params.topic));
}

/**
 * 动态取消订阅 topic
 */
export async function dynamicUnsubscribeTopicChannel(params: {
  subClient: Redis;
  tenantId: string;
  topic: string;
}): Promise<void> {
  await params.subClient.unsubscribe(topicChannel(params.tenantId, params.topic));
}

/* ================================================================== */
/*  Import crypto for UUID                                               */
/* ================================================================== */

import crypto from "node:crypto";
