/**
 * Device Message Bus — 跨设备实时通信核心
 *
 * 通信模式：
 * 1. 直连（deviceId 寻址）：通过 Redis Pub/Sub 实时推送，离线 → Redis pending list
 * 2. 主题（topic 发布）  ：publish 到 topic channel，订阅者实时接收
 * 3. 广播（tenantId 全体）：publish 到 tenant-wide channel
 *
 * 离线设备通过 GET /device-agent/messages/pending 拉取未读消息。
 */
import type Redis from "ioredis";

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface DeviceMessage {
  messageId: string;
  tenantId: string;
  fromDeviceId: string | null;       // null = 系统/API 发出
  toDeviceId: string | null;         // null = topic/broadcast
  topic: string | null;              // null = 直连消息
  payload: Record<string, unknown>;
  createdAt: number;                 // epoch ms
}

/** Redis key 命名约定 */
function directChannel(tenantId: string, deviceId: string)  { return `device:msg:${tenantId}:${deviceId}`; }
function topicChannel(tenantId: string, topic: string)      { return `device:topic:${tenantId}:${topic}`; }
function broadcastChannel(tenantId: string)                  { return `device:broadcast:${tenantId}`; }
function pendingListKey(tenantId: string, deviceId: string)  { return `device:pending:${tenantId}:${deviceId}`; }

/** Pending 消息 TTL（秒），环境变量可配，默认 24h */
function pendingTtlSec(): number {
  return Math.max(60, Number(process.env.DEVICE_MSG_PENDING_TTL_SEC) || 86400);
}

/** Pending 队列上限 */
function pendingMaxLen(): number {
  return Math.max(10, Number(process.env.DEVICE_MSG_PENDING_MAX) || 500);
}

// ────────────────────────────────────────────────────────────────
// 发送消息
// ────────────────────────────────────────────────────────────────

/**
 * 发送直连消息到指定设备。
 * 同时 publish 到 Redis channel（在线设备通过 WS 订阅接收），
 * 并推入 pending list（离线设备通过 HTTP 拉取）。
 */
export async function sendDirectMessage(params: {
  redis: Redis;
  message: DeviceMessage;
}): Promise<void> {
  const { redis, message } = params;
  const toDeviceId = message.toDeviceId;
  if (!toDeviceId) throw new Error("sendDirectMessage requires toDeviceId");

  const json = JSON.stringify(message);

  // 1. 推入 pending list（无论在线与否，保证不丢消息）
  const key = pendingListKey(message.tenantId, toDeviceId);
  await redis.lpush(key, json);
  await redis.ltrim(key, 0, pendingMaxLen() - 1);
  await redis.expire(key, pendingTtlSec());

  // 2. publish 到设备 channel（在线设备 WS 实时接收）
  await redis.publish(directChannel(message.tenantId, toDeviceId), json);
}

/**
 * 发布 topic 消息。
 * 仅 publish，不存入 pending（topic 订阅者需在线接收）。
 */
export async function publishTopicMessage(params: {
  redis: Redis;
  message: DeviceMessage;
}): Promise<void> {
  const { redis, message } = params;
  if (!message.topic) throw new Error("publishTopicMessage requires topic");
  const json = JSON.stringify(message);
  await redis.publish(topicChannel(message.tenantId, message.topic), json);
}

/**
 * 广播消息到 tenant 下所有设备。
 * 仅 publish，不存入 pending。
 */
export async function broadcastMessage(params: {
  redis: Redis;
  message: DeviceMessage;
}): Promise<void> {
  const { redis, message } = params;
  const json = JSON.stringify(message);
  await redis.publish(broadcastChannel(message.tenantId), json);
}

// ────────────────────────────────────────────────────────────────
// 拉取 / 确认
// ────────────────────────────────────────────────────────────────

/**
 * 获取指定设备的 pending 消息（FIFO 顺序）。
 * 调用方可通过 ackPendingMessages 确认消费后清除。
 */
export async function getPendingMessages(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
  limit?: number;
}): Promise<DeviceMessage[]> {
  const key = pendingListKey(params.tenantId, params.deviceId);
  const limit = Math.min(params.limit ?? 50, 200);
  // LRANGE 0..limit-1（最新在左端）
  const raws = await params.redis.lrange(key, 0, limit - 1);
  const msgs: DeviceMessage[] = [];
  for (const raw of raws) {
    try { msgs.push(JSON.parse(raw)); } catch { /* skip malformed */ }
  }
  return msgs;
}

/**
 * 确认指定设备的 pending 消息已消费（清除前 N 条）。
 */
export async function ackPendingMessages(params: {
  redis: Redis;
  tenantId: string;
  deviceId: string;
  count: number;
}): Promise<number> {
  const key = pendingListKey(params.tenantId, params.deviceId);
  // LTRIM 保留 count 之后的元素
  const len = await params.redis.llen(key);
  if (len === 0) return 0;
  const toRemove = Math.min(params.count, len);
  // 因为最新在左（LPUSH），oldest 在右端
  // pending 的消费应该从最旧开始 → RPOP count 次
  for (let i = 0; i < toRemove; i++) {
    await params.redis.rpop(key);
  }
  return toRemove;
}

// ────────────────────────────────────────────────────────────────
// Redis 订阅（供 WS 路由使用）
// ────────────────────────────────────────────────────────────────

/**
 * 订阅指定设备的消息 channel + tenant 广播 channel。
 * 返回 unsubscribe 函数。
 */
export async function subscribeDeviceChannels(params: {
  subClient: Redis;
  tenantId: string;
  deviceId: string;
  onMessage: (msg: DeviceMessage) => void;
}): Promise<() => void> {
  const { subClient, tenantId, deviceId, onMessage } = params;
  const channels = [
    directChannel(tenantId, deviceId),
    broadcastChannel(tenantId),
  ];

  const handler = (_channel: string, raw: string) => {
    try {
      const msg: DeviceMessage = JSON.parse(raw);
      onMessage(msg);
    } catch { /* skip malformed */ }
  };

  subClient.on("message", handler);
  await subClient.subscribe(...channels);

  return () => {
    subClient.unsubscribe(...channels).catch(() => {});
    subClient.removeListener("message", handler);
  };
}
