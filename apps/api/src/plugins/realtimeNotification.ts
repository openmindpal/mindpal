/**
 * P3-06a: WebSocket 实时通知插件
 *
 * 功能：
 * 1. /ws/notifications — 认证的 WebSocket 端点，客户端连接后实时接收 inapp 通知
 * 2. Redis Pub/Sub 跨节点推送 — 多 API 实例时通知可路由到目标用户所在节点
 * 3. 心跳保活 — 服务端定期 ping，客户端无响应则断开
 * 4. 连接注册表 — 进程内 Map + Redis Hash 双层，支持在线状态查询
 *
 * 客户端消息协议（JSON）：
 *   → { type: "ping" }
 *   ← { type: "pong", ts: number }
 *   ← { type: "notification", payload: { notificationId, event, title, body, metadata, createdAt } }
 *   ← { type: "connected", connectionId: string, nodeId: string }
 *   → { type: "ack", notificationId: string }   // 客户端确认已收到
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "realtimeNotification" });

// ────────────────────────────────────────────────────────────────
// 最小 WS 接口（避免引入 @types/ws）
// ────────────────────────────────────────────────────────────────

interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
  ping?(data?: any): void;
  pong?(data?: any): void;
}

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface NotifWsConnection {
  connectionId: string;
  tenantId: string;
  subjectId: string;
  socket: WsLike;
  connectedAt: number;
  lastPongAt: number;
}

export interface RealtimeNotificationPayload {
  notificationId: string;
  event: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ────────────────────────────────────────────────────────────────
// 进程级状态
// ────────────────────────────────────────────────────────────────

/** subjectId → Set<NotifWsConnection>（同一用户可能多标签页连接） */
const connectionsBySubject = new Map<string, Set<NotifWsConnection>>();

/** connectionId → NotifWsConnection */
const connectionById = new Map<string, NotifWsConnection>();

/** 当前节点 ID */
const NODE_ID = `notif-${process.pid}-${Date.now().toString(36)}`;

/** Redis Pub/Sub 频道 */
const NOTIF_PUSH_CHANNEL = "notification:ws:push";

/** Redis Hash: subjectId → nodeId 映射 */
const NOTIF_SUBJECT_NODE_MAP = "notification:ws:subject_node_map";

// 心跳配置
const HEARTBEAT_INTERVAL_MS = Math.max(5_000, Number(process.env.NOTIF_WS_HEARTBEAT_INTERVAL_MS) || 30_000);
const HEARTBEAT_TIMEOUT_MS = Math.max(10_000, Number(process.env.NOTIF_WS_HEARTBEAT_TIMEOUT_MS) || 90_000);
const MAX_CONNECTIONS_PER_SUBJECT = Math.max(1, Number(process.env.NOTIF_WS_MAX_PER_SUBJECT) || 5);

// ────────────────────────────────────────────────────────────────
// Redis 引用
// ────────────────────────────────────────────────────────────────

let _redis: any = null;
let _subClient: any = null;
let _crossNodeSetup = false;

export function setNotifRedis(redis: any): void {
  _redis = redis;
}

function getRedis(): any {
  return _redis;
}

// ────────────────────────────────────────────────────────────────
// Redis 注册表
// ────────────────────────────────────────────────────────────────

async function redisRegisterSubject(subjectId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.hset(NOTIF_SUBJECT_NODE_MAP, subjectId, NODE_ID);
  } catch { /* 降级 */ }
}

async function redisUnregisterSubject(subjectId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const current = await redis.hget(NOTIF_SUBJECT_NODE_MAP, subjectId);
    if (current === NODE_ID) {
      await redis.hdel(NOTIF_SUBJECT_NODE_MAP, subjectId);
    }
  } catch { /* ignore */ }
}

// ────────────────────────────────────────────────────────────────
// 跨节点推送
// ────────────────────────────────────────────────────────────────

interface CrossNodeNotifPayload {
  targetSubjectId: string;
  targetTenantId: string;
  fromNodeId: string;
  notification: RealtimeNotificationPayload;
}

async function startNotifCrossNodeSubscriber(): Promise<void> {
  if (_crossNodeSetup) return;
  _crossNodeSetup = true;

  try {
    const { default: Redis } = await import("ioredis");
    const redisCfg = {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null as null,
      lazyConnect: true,
      connectTimeout: 500,
    };
    _subClient = new Redis(redisCfg);
    _subClient.on("error", () => undefined);
    await _subClient.connect();
    await _subClient.subscribe(NOTIF_PUSH_CHANNEL);
    _subClient.on("message", (_ch: string, raw: string) => {
      try {
        const payload: CrossNodeNotifPayload = JSON.parse(raw);
        if (payload.fromNodeId === NODE_ID) return;
        pushToLocalSubject(payload.targetSubjectId, payload.notification);
      } catch { /* ignore malformed */ }
    });
        _logger.info("cross-node subscriber started", { nodeId: NODE_ID });
  } catch (err: any) {
        _logger.warn("cross-node subscriber failed", { err: err?.message });
    _crossNodeSetup = false;
  }
}

// ────────────────────────────────────────────────────────────────
// 连接管理
// ────────────────────────────────────────────────────────────────

function registerConnection(conn: NotifWsConnection): void {
  let set = connectionsBySubject.get(conn.subjectId);
  if (!set) {
    set = new Set();
    connectionsBySubject.set(conn.subjectId, set);
  }

  // 超过最大连接数时踢掉最早的
  if (set.size >= MAX_CONNECTIONS_PER_SUBJECT) {
    let oldest: NotifWsConnection | null = null;
    for (const c of set) {
      if (!oldest || c.connectedAt < oldest.connectedAt) oldest = c;
    }
    if (oldest) {
      try { oldest.socket.close(4001, "max_connections_exceeded"); } catch { /* ignore */ }
      removeConnection(oldest);
    }
  }

  set.add(conn);
  connectionById.set(conn.connectionId, conn);

  // 注册到 Redis
  redisRegisterSubject(conn.subjectId).catch(() => {});
}

function removeConnection(conn: NotifWsConnection): void {
  connectionById.delete(conn.connectionId);
  const set = connectionsBySubject.get(conn.subjectId);
  if (set) {
    set.delete(conn);
    if (set.size === 0) {
      connectionsBySubject.delete(conn.subjectId);
      // 该用户在本节点无连接了，从 Redis 移除
      redisUnregisterSubject(conn.subjectId).catch(() => {});
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 推送逻辑
// ────────────────────────────────────────────────────────────────

/** 推送到本地连接 */
function pushToLocalSubject(subjectId: string, notification: RealtimeNotificationPayload): boolean {
  const set = connectionsBySubject.get(subjectId);
  if (!set || set.size === 0) return false;

  const message = JSON.stringify({ type: "notification", payload: notification });
  let sent = false;
  for (const conn of set) {
    if (conn.socket.readyState === 1 /* OPEN */) {
      try {
        conn.socket.send(message);
        sent = true;
      } catch { /* ignore */ }
    }
  }
  return sent;
}

/**
 * 向指定用户推送实时通知（对外 API）。
 * 本地优先直推，否则通过 Redis Pub/Sub 跨节点转发。
 */
export function pushNotificationToSubject(
  subjectId: string,
  tenantId: string,
  notification: RealtimeNotificationPayload,
): boolean {
  // 本地推送
  if (pushToLocalSubject(subjectId, notification)) return true;

  // 跨节点
  const redis = getRedis();
  if (redis) {
    const payload: CrossNodeNotifPayload = {
      targetSubjectId: subjectId,
      targetTenantId: tenantId,
      fromNodeId: NODE_ID,
      notification,
    };
    redis.publish(NOTIF_PUSH_CHANNEL, JSON.stringify(payload)).catch(() => {});
    return true;
  }

  return false;
}

/**
 * 查询用户是否在线（本地 + Redis 双层查找）
 */
export async function isSubjectOnline(subjectId: string): Promise<boolean> {
  if (connectionsBySubject.has(subjectId)) return true;
  const redis = getRedis();
  if (!redis) return false;
  try {
    const nodeId = await redis.hget(NOTIF_SUBJECT_NODE_MAP, subjectId);
    return !!nodeId;
  } catch { return false; }
}

/** 获取当前本地在线通知连接数 */
export function getNotifOnlineCount(): number {
  return connectionById.size;
}

/** 获取当前本地在线用户数 */
export function getNotifOnlineSubjectCount(): number {
  return connectionsBySubject.size;
}

/** 获取节点 ID */
export function getNotifNodeId(): string {
  return NODE_ID;
}

// ────────────────────────────────────────────────────────────────
// 心跳清理定时器
// ────────────────────────────────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeatCleanup(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [, conn] of connectionById) {
      // 发送 ping
      if (conn.socket.readyState === 1 && typeof conn.socket.ping === "function") {
        try { conn.socket.ping(); } catch { /* ignore */ }
      }
      // 超时检测
      if (now - conn.lastPongAt > HEARTBEAT_TIMEOUT_MS) {
                _logger.info("heartbeat timeout", { subjectId: conn.subjectId, connectionId: conn.connectionId });
        try { conn.socket.close(1000, "heartbeat_timeout"); } catch { /* ignore */ }
        removeConnection(conn);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
}

function stopHeartbeatCleanup(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ────────────────────────────────────────────────────────────────
// 进程退出清理
// ────────────────────────────────────────────────────────────────

export async function cleanupNotifConnections(): Promise<void> {
  // 关闭所有连接
  for (const [, conn] of connectionById) {
    try { conn.socket.close(1001, "server_shutdown"); } catch { /* ignore */ }
  }
  connectionById.clear();
  connectionsBySubject.clear();

  // 清理 Redis
  const redis = getRedis();
  if (redis?.status === "ready") {
    try {
      const all = await redis.hgetall(NOTIF_SUBJECT_NODE_MAP);
      const toDelete: string[] = [];
      for (const [subjectId, nodeId] of Object.entries(all)) {
        if (nodeId === NODE_ID) toDelete.push(subjectId);
      }
      if (toDelete.length > 0) {
        await redis.hdel(NOTIF_SUBJECT_NODE_MAP, ...toDelete);
      }
    } catch { /* ignore */ }
  }

  if (_subClient) {
    try {
      await Promise.race([
        _subClient.quit(),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    } catch { /* ignore */ }
    try { _subClient.disconnect(); } catch { /* ignore */ }
    _subClient = null;
  }

  stopHeartbeatCleanup();
}

// ────────────────────────────────────────────────────────────────
// Fastify 插件
// ────────────────────────────────────────────────────────────────

function extractSubjectFromReq(req: FastifyRequest): { tenantId: string; subjectId: string } | null {
  const subject = req.ctx?.subject;
  if (!subject) return null;
  const tenantId = subject.tenantId as string | undefined;
  const subjectId = subject.subjectId as string | undefined;
  if (!tenantId || !subjectId) return null;
  return { tenantId, subjectId };
}

export const realtimeNotificationPlugin: FastifyPluginAsync = async (app) => {
  // 注入 Redis + 启动跨节点订阅
  try {
    setNotifRedis(app.redis);
    startNotifCrossNodeSubscriber().catch(() => {});
  } catch { /* ignore */ }

  // 启动心跳清理
  startHeartbeatCleanup();

  // ── WebSocket 端点 ──────────────────────────────────────────
  app.get("/ws/notifications", { websocket: true }, (socket: any, req) => {
    const auth = extractSubjectFromReq(req);
    if (!auth) {
      try { socket.close(4401, "unauthorized"); } catch { /* ignore */ }
      return;
    }

    const connectionId = crypto.randomUUID();
    const now = Date.now();
    const conn: NotifWsConnection = {
      connectionId,
      tenantId: auth.tenantId,
      subjectId: auth.subjectId,
      socket: socket as WsLike,
      connectedAt: now,
      lastPongAt: now,
    };

    registerConnection(conn);

    // 发送连接确认
    try {
      socket.send(JSON.stringify({
        type: "connected",
        connectionId,
        nodeId: NODE_ID,
        ts: now,
      }));
    } catch { /* ignore */ }

    // 记录连接到 DB（fire-and-forget）
    const db = app.db;
    if (db) {
      db.query(
        `INSERT INTO notification_ws_connections (connection_id, tenant_id, subject_id, node_id, connected_at, user_agent, ip_address)
         VALUES ($1, $2, $3, $4, now(), $5, $6)
         ON CONFLICT DO NOTHING`,
        [connectionId, auth.tenantId, auth.subjectId, NODE_ID, req.headers["user-agent"] ?? null, req.ip ?? null],
      ).catch(() => {});
    }

    // 发送未读通知计数
    if (db) {
      db.query(
        `SELECT COUNT(*) as count FROM notification_queue nq
         WHERE nq.tenant_id = $1 AND nq.subject_id = $2 AND nq.channel = 'inapp' AND nq.status = 'sent'
           AND NOT EXISTS (
             SELECT 1 FROM notification_read_status nrs
             WHERE nrs.tenant_id = nq.tenant_id AND nrs.subject_id = $2 AND nrs.notification_id = nq.notification_id
           )`,
        [auth.tenantId, auth.subjectId],
      ).then((res: any) => {
        const count = Number(res.rows[0]?.count ?? 0);
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "unread_count", count }));
        }
      }).catch(() => {});
    }

    // 处理客户端消息
    socket.on("message", (raw: any) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        switch (msg.type) {
          case "ping":
            conn.lastPongAt = Date.now();
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
            }
            break;
          case "ack":
            // 客户端确认收到通知 → 可选标记已读
            if (msg.notificationId && db) {
              db.query(
                `INSERT INTO notification_read_status (tenant_id, subject_id, notification_id)
                 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [auth.tenantId, auth.subjectId, msg.notificationId],
              ).catch(() => {});
            }
            break;
          default:
            // 忽略未知消息类型
            break;
        }
      } catch { /* ignore malformed */ }
    });

    // pong 事件（ws 原生 ping/pong）
    socket.on("pong", () => {
      conn.lastPongAt = Date.now();
    });

    // 连接关闭
    socket.on("close", () => {
      removeConnection(conn);
      // 清理 DB 记录
      if (db) {
        db.query(
          "DELETE FROM notification_ws_connections WHERE connection_id = $1",
          [connectionId],
        ).catch(() => {});
      }
    });

    socket.on("error", () => {
      removeConnection(conn);
    });
  });

  // ── 查询在线状态的 HTTP 端点 ──────────────────────────────────
  app.get("/notifications/ws/status", async (req) => {
    const auth = extractSubjectFromReq(req);
    if (!auth) return { online: false };
    const online = await isSubjectOnline(auth.subjectId);
    return {
      online,
      localConnections: getNotifOnlineCount(),
      localSubjects: getNotifOnlineSubjectCount(),
      nodeId: NODE_ID,
    };
  });

  // ── 关闭钩子 ──────────────────────────────────────────────────
  app.addHook("onClose", async () => {
    await cleanupNotifConnections();
  });
};
