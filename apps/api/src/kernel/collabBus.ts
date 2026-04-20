/**
 * Collab Bus — 多智能体实时协作消息总线
 *
 * P1-协作升级：三层消息投递架构
 * - Layer 1: 进程内 EventEmitter（同进程 Agent 间零延迟分发）
 * - Layer 2: Redis Streams（跨进程持久化消息，<50ms，支持消费者组）
 * - Layer 3: DB (collab_envelopes)（审计持久化 + 灾难恢复兜底）
 *
 * 额外能力：
 * - 消息优先级（urgent > high > normal > low）
 * - 背压控制（maxInFlight 限制 + 暂停/恢复语义）
 * - 进程级单例生命周期管理
 *
 * 频道命名：collab:{collabRunId}:{targetRole|"broadcast"}
 * Stream 键名：collabstream:{collabRunId}:{role|"broadcast"}
 */
import type { Pool } from "pg";
import { StructuredLogger, collabConfig } from "@openslin/shared";

const logger = new StructuredLogger({ module: "collabBus" });

// ── 类型 ────────────────────────────────────────────────────

export interface CollabMessage {
  collabRunId: string;
  tenantId: string;
  fromAgent: string;
  fromRole: string;
  toRole: string | null;  // null = broadcast
  kind: string;           // "agent.result" | "shared_state.update" | "request" | "ack"
  payload: Record<string, unknown>;
  timestamp: number;      // epoch ms
  /** P1: 消息优先级 */
  priority?: MessagePriority;
}

export type MessagePriority = "low" | "normal" | "high" | "urgent";

const PRIORITY_WEIGHT: Record<MessagePriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/** 背压配置 */
export interface BackpressureConfig {
  /** 最大并发处理消息数，超过后暂停消费，默认 100 */
  maxInFlight: number;
  /** 恢复消费的阈值百分比，默认 0.7（当 inFlight 降到 maxInFlight*0.7 时恢复） */
  resumeThreshold: number;
}

const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  maxInFlight: collabConfig("COLLAB_BUS_MAX_IN_FLIGHT"),
  resumeThreshold: collabConfig("COLLAB_BUS_RESUME_THRESHOLD"),
};

// ── Redis 频道/Stream 命名 ──────────────────────────────────

function broadcastChannel(collabRunId: string): string {
  return `collab:${collabRunId}:broadcast`;
}

function roleChannel(collabRunId: string, role: string): string {
  return `collab:${collabRunId}:${role}`;
}

function streamKey(collabRunId: string, target: string): string {
  return `collabstream:${collabRunId}:${target}`;
}

// ── 进程级 CollabBusInstance ────────────────────────────────

type MessageHandler = (msg: CollabMessage) => void;

/** 进程内优先级消息队列条目 */
interface PriorityQueueEntry {
  msg: CollabMessage;
  weight: number;
}

/**
 * CollabBusInstance — 进程级消息总线实例
 *
 * 同一进程内的所有 Agent 共享此实例，
 * 实现零延迟同进程消息分发 + 跨进程 Redis Streams 传输。
 */
export interface CollabBusInstance {
  /** 发布消息（三层投递：进程内 → Redis Stream → DB） */
  publish(msg: CollabMessage, opts?: { spaceId?: string | null; taskId?: string }): Promise<void>;
  /** 订阅某个 collabRun 中某角色的消息 */
  subscribe(collabRunId: string, role: string, handler: MessageHandler): CollabSubscription;
  /** 获取背压状态 */
  getBackpressureStats(): { inFlight: number; maxInFlight: number; paused: boolean };
  /** 关闭总线，释放所有资源 */
  close(): Promise<void>;
}

export interface CollabBusConfig {
  pool: Pool;
  redis?: {
    publish(channel: string, message: string): Promise<number>;
    xadd?(key: string, id: string, ...args: string[]): Promise<string>;
  };
  backpressure?: Partial<BackpressureConfig>;
  /** Redis Stream 消费者组名，默认 "collabbus" */
  consumerGroup?: string;
  /** 消费者名称（通常为进程ID），默认 process.pid */
  consumerName?: string;
}

/**
 * 创建进程级 CollabBus 实例。
 * 建议在应用启动时调用一次，所有 Agent 共享此实例。
 */
export function createCollabBusInstance(config: CollabBusConfig): CollabBusInstance {
  const { pool } = config;
  const bp: BackpressureConfig = { ...DEFAULT_BACKPRESSURE, ...config.backpressure };

  // ── Layer 1: 进程内分发 ──
  // Map<channelKey, Set<handler>>
  // channelKey = collabRunId:role 或 collabRunId:broadcast
  const localHandlers = new Map<string, Set<MessageHandler>>();
  let inFlight = 0;
  let paused = false;
  const pendingQueue: PriorityQueueEntry[] = [];

  // ── Layer 2: Redis Streams consumer（惰性初始化） ──
  let streamConsumer: any = null;
  let streamConsumerReady = false;
  let streamPollTimer: ReturnType<typeof setInterval> | null = null;
  const subscribedStreams = new Set<string>();
  const consumerGroup = config.consumerGroup ?? "collabbus";
  const consumerName = config.consumerName ?? `proc-${process.pid}`;

  function localChannelKey(collabRunId: string, role: string): string {
    return `${collabRunId}:${role}`;
  }

  function dispatchToLocalHandlers(msg: CollabMessage): boolean {
    let dispatched = false;
    // 定向消息
    if (msg.toRole) {
      const key = localChannelKey(msg.collabRunId, msg.toRole);
      const hs = localHandlers.get(key);
      if (hs && hs.size > 0) {
        for (const h of hs) { try { h(msg); } catch { /* handler error */ } }
        dispatched = true;
      }
    }
    // 广播消息 → 分发给该 collabRunId 的所有订阅者
    const bcKey = localChannelKey(msg.collabRunId, "broadcast");
    const bcHandlers = localHandlers.get(bcKey);
    if (bcHandlers && bcHandlers.size > 0) {
      for (const h of bcHandlers) { try { h(msg); } catch { /* handler error */ } }
      dispatched = true;
    }
    // 对广播消息，也分发给所有角色订阅者
    if (!msg.toRole) {
      for (const [key, hs] of localHandlers) {
        if (key.startsWith(`${msg.collabRunId}:`) && key !== bcKey && hs.size > 0) {
          for (const h of hs) { try { h(msg); } catch { /* handler error */ } }
          dispatched = true;
        }
      }
    }
    return dispatched;
  }

  /** 背压检查 + 优先级队列消费 */
  function drainPendingQueue(): void {
    if (paused) return;
    // 按优先级排序（高优先级先消费）
    pendingQueue.sort((a, b) => b.weight - a.weight);
    while (pendingQueue.length > 0 && inFlight < bp.maxInFlight) {
      const entry = pendingQueue.shift()!;
      inFlight++;
      dispatchToLocalHandlers(entry.msg);
      inFlight--;
    }
    // 恢复检查
    if (paused && inFlight <= bp.maxInFlight * bp.resumeThreshold) {
      paused = false;
    }
  }

  /** 带背压的本地分发 */
  function dispatchWithBackpressure(msg: CollabMessage): void {
    const weight = PRIORITY_WEIGHT[msg.priority ?? "normal"];
    if (inFlight >= bp.maxInFlight) {
      paused = true;
      pendingQueue.push({ msg, weight });
      return;
    }
    inFlight++;
    dispatchToLocalHandlers(msg);
    inFlight--;
    // 排空可能的积压
    if (pendingQueue.length > 0) drainPendingQueue();
  }

  /** Layer 2: 写 Redis Stream */
  async function writeRedisStream(msg: CollabMessage): Promise<void> {
    const redis = config.redis;
    const channel = msg.toRole
      ? roleChannel(msg.collabRunId, msg.toRole)
      : broadcastChannel(msg.collabRunId);

    if (!redis?.xadd) {
      // 无 xadd 支持，直接降级到 Pub/Sub
      if (redis?.publish) {
        const json = JSON.stringify(msg);
        try {
          await redis.publish(channel, json);
        } catch (e: unknown) {
          logger.warn("collab.bus.degradation", {
            layer: "redis_to_pubsub",
            channel,
            priority: msg.priority ?? "normal",
            errorMessage: (e as Error)?.message,
          });
        }
      }
      return;
    }

    // 写 Redis Stream（带 1 次快速重试）
    const target = msg.toRole ?? "broadcast";
    const sKey = streamKey(msg.collabRunId, target);
    const json = JSON.stringify(msg);
    let streamSent = false;

    try {
      await redis.xadd(sKey, "MAXLEN", "~", "5000", "*",
        "data", json,
        "priority", String(msg.priority ?? "normal"),
        "kind", msg.kind,
        "from", msg.fromRole,
      );
      streamSent = true;
    } catch (err1: unknown) {
      // 快速重试一次（50ms 延迟）
      try {
        await new Promise(r => setTimeout(r, 50));
        await redis.xadd(sKey, "MAXLEN", "~", "5000", "*",
          "data", json,
          "priority", String(msg.priority ?? "normal"),
          "kind", msg.kind,
          "from", msg.fromRole,
        );
        streamSent = true;
      } catch (err2: unknown) {
        logger.warn("collab.bus.redis_retry_exhausted", {
          channel,
          error: (err2 as Error)?.message,
        });
      }
    }

    if (!streamSent) {
      // Redis Streams 失败，降级到 Pub/Sub
      if (redis?.publish) {
        try {
          await redis.publish(channel, json);
          logger.warn("collab.bus.degradation", {
            layer: "redis_to_pubsub",
            channel,
            priority: msg.priority ?? "normal",
            errorMessage: "xadd failed after retry, fell back to Pub/Sub",
          });
        } catch (e2: unknown) {
          logger.error("collab.bus.all_layers_failed", {
            channel,
            priority: msg.priority ?? "normal",
            errorMessage: (e2 as Error)?.message,
          });
        }
      } else {
        logger.error("collab.bus.all_layers_failed", {
          channel,
          priority: msg.priority ?? "normal",
          errorMessage: "xadd failed and no Pub/Sub available",
        });
      }
    }
  }

  /** Layer 3: DB 持久化 */
  async function writeDb(msg: CollabMessage, spaceId?: string | null, taskId?: string): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO collab_envelopes
         (tenant_id, space_id, collab_run_id, task_id, from_role, to_role, broadcast, kind, payload_digest)
         VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9)`,
        [
          msg.tenantId,
          spaceId ?? null,
          msg.collabRunId,
          taskId ?? null,
          msg.fromRole,
          msg.toRole,
          msg.toRole == null,
          msg.kind,
          JSON.stringify(msg.payload),
        ],
      );
    } catch (e: any) {
      logger.warn("DB write failed", { collabRunId: msg.collabRunId, error: String(e?.message ?? e) });
    }
  }

  /** 启动 Redis Stream 消费循环 */
  async function ensureStreamConsumer(): Promise<void> {
    if (streamConsumer || streamConsumerReady) return;
    try {
      const { default: Redis } = await import("ioredis");
      const redisCfg = {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null as null,
      };
      streamConsumer = new Redis(redisCfg);
      streamConsumerReady = true;

      // 轮询 Redis Streams（~20ms 间隔，远低于之前的 3s DB 轮询）
      streamPollTimer = setInterval(async () => {
        if (!streamConsumerReady || subscribedStreams.size === 0) return;
        for (const sKey of subscribedStreams) {
          try {
            // 尝试创建消费者组（幂等）
            try {
              await streamConsumer.xgroup("CREATE", sKey, consumerGroup, "0", "MKSTREAM");
            } catch { /* group already exists */ }

            const entries = await streamConsumer.xreadgroup(
              "GROUP", consumerGroup, consumerName,
              "COUNT", "50", "BLOCK", "10",
              "STREAMS", sKey, ">",
            );
            if (!entries) continue;
            for (const [, msgs] of entries as Array<[string, Array<[string, string[]]>]>) {
              for (const [entryId, fields] of msgs) {
                // fields: ["data", "...", "priority", "..."]
                const dataIdx = fields.indexOf("data");
                if (dataIdx < 0 || dataIdx + 1 >= fields.length) continue;
                try {
                  const msg: CollabMessage = JSON.parse(fields[dataIdx + 1]!);
                  dispatchWithBackpressure(msg);
                } catch { /* malformed */ }
                // ACK
                try {
                  await streamConsumer.xack(sKey, consumerGroup, entryId);
                } catch { /* ack failed */ }
              }
            }
          } catch { /* stream read failed for this key */ }
        }
      }, collabConfig("COLLAB_BUS_POLL_MS")); // Redis Stream 轮询间隔
    } catch {
      streamConsumerReady = false;
    }
  }

  // ── 公共 API ──
  const instance: CollabBusInstance = {
    async publish(msg, opts) {
      // Layer 1: 进程内分发（零延迟）
      dispatchWithBackpressure(msg);

      // Layer 2: Redis Stream / Pub/Sub（跨进程）
      writeRedisStream(msg).catch((e: unknown) => {
        logger.warn("writeRedisStream fire-and-forget failed", { collabRunId: msg.collabRunId, error: (e as Error)?.message });
      });

      // Layer 3: DB 持久化（审计兜底）
      writeDb(msg, opts?.spaceId, opts?.taskId).catch((e: unknown) => {
        logger.warn("writeDb fire-and-forget failed", { collabRunId: msg.collabRunId, error: (e as Error)?.message });
      });
    },

    subscribe(collabRunId, role, handler) {
      const key = localChannelKey(collabRunId, role);
      if (!localHandlers.has(key)) localHandlers.set(key, new Set());
      localHandlers.get(key)!.add(handler);

      // 也订阅 broadcast 频道
      const bcKey = localChannelKey(collabRunId, "broadcast");
      if (!localHandlers.has(bcKey)) localHandlers.set(bcKey, new Set());
      // （broadcast handler 在 dispatchToLocalHandlers 中自动处理）

      // 注册 Redis Stream 消费
      const roleStreamKey = streamKey(collabRunId, role);
      const bcStreamKey = streamKey(collabRunId, "broadcast");
      subscribedStreams.add(roleStreamKey);
      subscribedStreams.add(bcStreamKey);
      ensureStreamConsumer().catch((e: unknown) => {
        logger.warn("ensureStreamConsumer failed", { collabRunId, error: (e as Error)?.message });
      });

      return {
        unsubscribe: async () => {
          localHandlers.get(key)?.delete(handler);
          if (localHandlers.get(key)?.size === 0) {
            localHandlers.delete(key);
            subscribedStreams.delete(roleStreamKey);
          }
          // broadcast stream 可能还有其他订阅者，不轻易删除
        },
      };
    },

    getBackpressureStats() {
      return { inFlight, maxInFlight: bp.maxInFlight, paused };
    },

    async close() {
      localHandlers.clear();
      subscribedStreams.clear();
      pendingQueue.length = 0;
      if (streamPollTimer) { clearInterval(streamPollTimer); streamPollTimer = null; }
      if (streamConsumer) {
        try { await streamConsumer.quit(); } catch { /* ignore */ }
        streamConsumer = null;
        streamConsumerReady = false;
      }
    },
  };

  return instance;
}

// ── 进程级单例 ──────────────────────────────────────────────

let _globalInstance: CollabBusInstance | null = null;

/** 获取或创建进程级 CollabBus 单例 */
export function getCollabBus(config?: CollabBusConfig): CollabBusInstance | null {
  if (_globalInstance) return _globalInstance;
  if (!config) return null;
  _globalInstance = createCollabBusInstance(config);
  return _globalInstance;
}

/** 关闭并释放全局单例 */
export async function closeCollabBus(): Promise<void> {
  if (_globalInstance) {
    await _globalInstance.close();
    _globalInstance = null;
  }
}

// ── 兼容旧 API ─────────────────────────────────────────────
// 保持原有函数签名，内部优先走 CollabBusInstance

export interface CollabSubscription {
  /** 取消订阅 */
  unsubscribe: () => Promise<void>;
}

/**
 * 发布协作消息（三层投递：进程内 → Redis Stream → DB）
 * 保持旧 API 签名，内部优先使用全局 CollabBusInstance。
 */
export async function publishCollabMessage(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  message: CollabMessage;
  spaceId?: string | null;
  taskId?: string;
}): Promise<void> {
  const bus = _globalInstance;
  if (bus) {
    return bus.publish(params.message, { spaceId: params.spaceId, taskId: params.taskId });
  }
  // 降级：无全局实例时走旧路径
  const { pool, redis, message } = params;
  const json = JSON.stringify(message);

  // DB 持久化
  try {
    await pool.query(
      `INSERT INTO collab_envelopes
       (tenant_id, space_id, collab_run_id, task_id, from_role, to_role, broadcast, kind, payload_digest)
       VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9)`,
      [
        message.tenantId,
        params.spaceId ?? null,
        message.collabRunId,
        params.taskId ?? null,
        message.fromRole,
        message.toRole,
        message.toRole == null,
        message.kind,
        JSON.stringify(message.payload),
      ],
    );
  } catch (e: any) {
    logger.warn("DB write failed", { collabRunId: message.collabRunId, error: String(e?.message ?? e) });
  }

  // Redis Pub/Sub
  if (redis) {
    try {
      if (message.toRole) {
        await redis.publish(roleChannel(message.collabRunId, message.toRole), json);
      } else {
        await redis.publish(broadcastChannel(message.collabRunId), json);
      }
    } catch { /* ignore */ }
  }
}

/**
 * 订阅协作消息 — 优先使用全局 CollabBusInstance（毫秒级），降级到 DB 轮询
 */
export async function subscribeCollabMessages(params: {
  pool: Pool;
  collabRunId: string;
  role: string;
  onMessage: (msg: CollabMessage) => void;
  /** DB 轮询间隔（毫秒），默认 3000（仅降级路径使用） */
  pollIntervalMs?: number;
}): Promise<CollabSubscription> {
  const { pool, collabRunId, role, onMessage } = params;

  // 优先使用全局 CollabBus（进程内 + Redis Streams）
  const bus = _globalInstance;
  if (bus) {
    return bus.subscribe(collabRunId, role, onMessage);
  }

  // 降级：旧路径 — Redis Pub/Sub + DB 轮询
  const pollMs = params.pollIntervalMs ?? 3000;
  let stopped = false;
  let subClient: any = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeenAt = new Date().toISOString();

  (async () => {
    try {
      const { default: Redis } = await import("ioredis");
      const redisCfg = {
        host: process.env.REDIS_HOST ?? "127.0.0.1",
        port: Number(process.env.REDIS_PORT ?? 6379),
        maxRetriesPerRequest: null as null,
      };
      subClient = new Redis(redisCfg);
      const channels = [broadcastChannel(collabRunId), roleChannel(collabRunId, role)];
      await subClient.subscribe(...channels);
      subClient.on("message", (_ch: string, raw: string) => {
        if (stopped) return;
        try { onMessage(JSON.parse(raw)); } catch { /* ignore */ }
      });
    } catch { /* Redis 订阅失败，依赖 DB 轮询 */ }
  })();

  pollTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const res = await pool.query(
        `SELECT from_role, kind, payload_digest, created_at FROM collab_envelopes
         WHERE collab_run_id = $1::uuid AND (to_role = $2 OR broadcast = true)
           AND created_at > $3
         ORDER BY created_at ASC LIMIT 50`,
        [collabRunId, role, lastSeenAt],
      );
      for (const r of res.rows) {
        const row = r as Record<string, unknown>;
        lastSeenAt = String(row.created_at);
        try {
          onMessage({
            collabRunId, tenantId: "", fromAgent: "",
            fromRole: String(row.from_role ?? ""),
            toRole: role,
            kind: String(row.kind ?? ""),
            payload: (row.payload_digest ?? {}) as Record<string, unknown>,
            timestamp: new Date(String(row.created_at)).getTime(),
          });
        } catch { /* skip */ }
      }
    } catch { /* DB poll failed */ }
  }, pollMs);

  return {
    unsubscribe: async () => {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (subClient) {
        try { await subClient.quit(); } catch { /* ignore */ }
      }
    },
  };
}

// ── 工具函数（保持旧签名兼容） ──────────────────────────────

/**
 * 将 AgentLoopResult 封装为 CollabMessage 并发布。
 */
export async function publishAgentResult(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  fromAgent: string;
  fromRole: string;
  result: { ok: boolean; endReason: string; message?: string; succeededSteps?: number; failedSteps?: number; iterations?: number };
  runId: string;
}): Promise<void> {
  const { result, runId } = params;
  await publishCollabMessage({
    pool: params.pool,
    redis: params.redis,
    spaceId: params.spaceId,
    taskId: params.taskId,
    message: {
      collabRunId: params.collabRunId,
      tenantId: params.tenantId,
      fromAgent: params.fromAgent,
      fromRole: params.fromRole,
      toRole: null,
      kind: "agent.result",
      payload: {
        ok: result.ok,
        endReason: result.endReason,
        message: result.message ?? "",
        totalSteps: (result.succeededSteps ?? 0) + (result.failedSteps ?? 0),
        totalIterations: result.iterations ?? 0,
        runId,
      },
      timestamp: Date.now(),
      priority: "high",
    },
  });
}

/**
 * 发布共享状态变更通知。
 */
export async function publishSharedStateUpdate(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  updatedByAgent: string;
  updatedByRole: string;
  key: string;
  version: number;
}): Promise<void> {
  const { pool, redis, tenantId, collabRunId, updatedByAgent, updatedByRole, key, version } = params;
  await publishCollabMessage({
    pool,
    redis,
    message: {
      collabRunId,
      tenantId,
      fromAgent: updatedByAgent,
      fromRole: updatedByRole,
      toRole: null,
      kind: "shared_state.update",
      payload: { key, version },
      timestamp: Date.now(),
      priority: "normal",
    },
  });
}
