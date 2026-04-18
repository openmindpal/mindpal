/**
 * Device WebSocket Connection Registry — 分布式升级版
 *
 * P2-6.2: 从进程内 Map 升级为 Redis 注册表 + 进程本地 Map 双层架构：
 * - 本地 Map：管理当前进程拥有的 WS 连接（低延迟直连推送）
 * - Redis Hash：device→nodeId 映射（跨节点发现 + Pub/Sub 跨节点转发）
 *
 * 单实例部署时行为与原版一致，Redis 不可用时降级到纯本地模式。
 */

/**
 * 最小 WebSocket 接口 — 仅声明 registry 需要的方法，
 * 避免引入 @types/ws 开发依赖。
 */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

// ────────────────────────────────────────────────────────────────
// 类型
// ────────────────────────────────────────────────────────────────

export interface DeviceConnection {
  deviceId: string;
  tenantId: string;
  spaceId: string | null;
  socket: WsLike;
  connectedAt: number;
  lastHeartbeatAt: number;
}

// ────────────────────────────────────────────────────────────────
// 进程本地连接表
// ────────────────────────────────────────────────────────────────

const connections = new Map<string, DeviceConnection>();

/** 当前节点 ID（进程级唯一） */
const NODE_ID = `node-${process.pid}-${Date.now().toString(36)}`;

/** Redis Hash key 存储 device→nodeId 映射 */
const DEVICE_NODE_MAP_KEY = "device:ws:node_map";

/** 跨节点推送 Redis Pub/Sub 频道 */
const CROSS_NODE_PUSH_CHANNEL = "device:ws:cross_push";

/** 心跳超时（毫秒），环境变量可配 */
function heartbeatTimeoutMs(): number {
  return Math.max(5_000, Number(process.env.DEVICE_WS_HEARTBEAT_TIMEOUT_MS) || 90_000);
}

/** 清理定时器间隔（毫秒） */
function cleanupIntervalMs(): number {
  return Math.max(5_000, Number(process.env.DEVICE_WS_CLEANUP_INTERVAL_MS) || 30_000);
}

// ────────────────────────────────────────────────────────────────
// Redis 实例引用（延迟初始化）
// ────────────────────────────────────────────────────────────────

let _redis: any = null;
let _subClient: any = null;
let _crossNodeSetup = false;

/** 注入 Redis 实例（API 启动时调用） */
export function setRegistryRedis(redis: any): void {
  _redis = redis;
}

/** 获取 Redis（可能为 null） */
function getRedis(): any { return _redis; }

// ────────────────────────────────────────────────────────────────
// Redis 注册表操作
// ────────────────────────────────────────────────────────────────

async function redisRegister(deviceId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.hset(DEVICE_NODE_MAP_KEY, deviceId, NODE_ID);
  } catch { /* Redis 不可用降级 */ }
}

async function redisUnregister(deviceId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    // 仅当 nodeId 匹配时删除（防止误删其他节点的注册）
    const current = await redis.hget(DEVICE_NODE_MAP_KEY, deviceId);
    if (current === NODE_ID) {
      await redis.hdel(DEVICE_NODE_MAP_KEY, deviceId);
    }
  } catch { /* ignore */ }
}

async function redisLookupNode(deviceId: string): Promise<string | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    return await redis.hget(DEVICE_NODE_MAP_KEY, deviceId);
  } catch { return null; }
}

// ────────────────────────────────────────────────────────────────
// 跨节点推送
// ────────────────────────────────────────────────────────────────

interface CrossNodePushPayload {
  targetDeviceId: string;
  fromNodeId: string;
  message: Record<string, unknown>;
}

/** 启动跨节点推送订阅（进程级，只需调用一次） */
export async function startCrossNodeSubscriber(): Promise<void> {
  if (_crossNodeSetup) return;
  _crossNodeSetup = true;

  try {
    const { default: Redis } = await import("ioredis");
    const redisCfg = {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null as null,
    };
    _subClient = new Redis(redisCfg);
    await _subClient.subscribe(CROSS_NODE_PUSH_CHANNEL);
    _subClient.on("message", (_ch: string, raw: string) => {
      try {
        const payload: CrossNodePushPayload = JSON.parse(raw);
        // 只处理发给其他节点的请求（自己节点的跳过，避免循环）
        if (payload.fromNodeId === NODE_ID) return;
        const conn = connections.get(payload.targetDeviceId);
        if (conn && conn.socket.readyState === 1) {
          conn.socket.send(JSON.stringify(payload.message));
        }
      } catch { /* ignore malformed */ }
    });
    console.log(`[deviceWsRegistry] cross-node subscriber started, nodeId=${NODE_ID}`);
  } catch (err: any) {
    console.warn(`[deviceWsRegistry] cross-node subscriber failed: ${err?.message}`);
    _crossNodeSetup = false;
  }
}

// ────────────────────────────────────────────────────────────────
// 公共 API
// ────────────────────────────────────────────────────────────────

/** 注册设备连接（同一设备重连时自动关闭旧 socket） */
export function registerDeviceConnection(conn: DeviceConnection): void {
  const existing = connections.get(conn.deviceId);
  if (existing && existing.socket !== conn.socket) {
    try { existing.socket.close(1000, "replaced"); } catch { /* ignore */ }
  }
  connections.set(conn.deviceId, conn);
  // 异步注册到 Redis（fire-and-forget）
  redisRegister(conn.deviceId).catch(() => {});
}

/** 注销设备连接；若传入 socket 则只移除匹配的（避免竞态误删新连接） */
export function unregisterDeviceConnection(deviceId: string, socket?: WsLike): void {
  const conn = connections.get(deviceId);
  if (!conn) return;
  if (socket && conn.socket !== socket) return;
  connections.delete(deviceId);
  // 异步从 Redis 移除
  redisUnregister(deviceId).catch(() => {});
}

/** 刷新心跳时间 */
export function touchDeviceHeartbeat(deviceId: string): void {
  const conn = connections.get(deviceId);
  if (conn) conn.lastHeartbeatAt = Date.now();
}

/** 获取本地设备连接 */
export function getDeviceConnection(deviceId: string): DeviceConnection | null {
  return connections.get(deviceId) ?? null;
}

/**
 * 向目标设备推送 JSON 消息，返回是否成功。
 * P2-6.2: 本地连接直推，否则通过 Redis Pub/Sub 跨节点转发。
 */
export function pushToDevice(deviceId: string, message: Record<string, unknown>): boolean {
  // 优先本地连接
  const conn = connections.get(deviceId);
  if (conn && conn.socket.readyState === 1 /* WebSocket.OPEN */) {
    try {
      conn.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  // 本地无连接 → 尝试跨节点转发
  const redis = getRedis();
  if (redis) {
    const payload: CrossNodePushPayload = {
      targetDeviceId: deviceId,
      fromNodeId: NODE_ID,
      message,
    };
    redis.publish(CROSS_NODE_PUSH_CHANNEL, JSON.stringify(payload)).catch(() => {});
    return true; // 已发布到 Pub/Sub（不保证对端在线）
  }

  return false;
}

/**
 * 查询设备连接所在节点（分布式查找）。
 * 返回 nodeId 或 null（设备不在线）。
 */
export async function lookupDeviceNode(deviceId: string): Promise<string | null> {
  // 本地先查
  if (connections.has(deviceId)) return NODE_ID;
  return redisLookupNode(deviceId);
}

/** 获取当前本地在线设备数 */
export function getOnlineDeviceCount(): number {
  return connections.size;
}

/** 获取本地所有在线设备 ID */
export function getOnlineDeviceIds(): string[] {
  return [...connections.keys()];
}

/** 获取全局在线设备数（需 Redis） */
export async function getGlobalOnlineDeviceCount(): Promise<number> {
  const redis = getRedis();
  if (!redis) return connections.size;
  try {
    return await redis.hlen(DEVICE_NODE_MAP_KEY);
  } catch { return connections.size; }
}

/** 获取当前节点 ID */
export function getNodeId(): string {
  return NODE_ID;
}

// ────────────────────────────────────────────────────────────────
// 心跳超时清理定时器
// ────────────────────────────────────────────────────────────────

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/** 启动心跳超时清理（进程级，只需调用一次） */
export function startHeartbeatCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    const timeout = heartbeatTimeoutMs();
    for (const [deviceId, conn] of connections) {
      if (now - conn.lastHeartbeatAt > timeout) {
        console.log(`[deviceWsRegistry] heartbeat timeout: deviceId=${deviceId}, closing`);
        try { conn.socket.close(1000, "heartbeat_timeout"); } catch { /* ignore */ }
        connections.delete(deviceId);
        // 从 Redis 移除
        redisUnregister(deviceId).catch(() => {});
      }
    }
  }, cleanupIntervalMs());
  cleanupTimer.unref();
}

/** 停止心跳超时清理 */
export function stopHeartbeatCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** 进程退出时批量清理 Redis 注册 */
export async function cleanupNodeRegistrations(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    // 获取所有注册映射，删除属于当前节点的
    const all = await redis.hgetall(DEVICE_NODE_MAP_KEY);
    const toDelete: string[] = [];
    for (const [deviceId, nodeId] of Object.entries(all)) {
      if (nodeId === NODE_ID) toDelete.push(deviceId);
    }
    if (toDelete.length > 0) {
      await redis.hdel(DEVICE_NODE_MAP_KEY, ...toDelete);
    }
  } catch { /* ignore */ }
  // 关闭订阅客户端
  if (_subClient) {
    try { await _subClient.quit(); } catch { /* ignore */ }
    _subClient = null;
  }
}

// ──────────────────────────────────────────────────────────────────
// P1: 流式控制指令推送
// ──────────────────────────────────────────────────────────────────

/** 向设备发起流式执行会话 */
export function pushStreamingStart(deviceId: string, params: {
  sessionId: string;
  steps?: unknown[];
  interStepDelayMs?: number;
  stepTimeoutMs?: number;
  ocrCacheTtlMs?: number;
  maxQueueSize?: number;
  stopOnError?: boolean;
}): boolean {
  return pushToDevice(deviceId, { type: "streaming_start", payload: params });
}

/** 向设备追加流式执行步骤 */
export function pushStreamingSteps(deviceId: string, params: {
  sessionId: string;
  steps: unknown[];
  done?: boolean;
}): boolean {
  return pushToDevice(deviceId, { type: "streaming_step", payload: params });
}

/** 停止设备流式执行 */
export function pushStreamingStop(deviceId: string, sessionId: string): boolean {
  return pushToDevice(deviceId, { type: "streaming_stop", payload: { sessionId } });
}

/** 暂停设备流式执行 */
export function pushStreamingPause(deviceId: string): boolean {
  return pushToDevice(deviceId, { type: "streaming_pause", payload: {} });
}

/** 恢复设备流式执行 */
export function pushStreamingResume(deviceId: string): boolean {
  return pushToDevice(deviceId, { type: "streaming_resume", payload: {} });
}
