/**
 * Device Session Manager — 设备会话状态管理
 *
 * 核心职责：
 * 1. 心跳机制：定期向服务端上报设备活跃状态
 * 2. 会话生命周期：管理浏览器、桌面等资源的活跃状态
 * 3. 资源池：复用已打开的资源实例，减少启动开销
 *
 * 解决问题：
 * - 修复 browser.screenshot 等工具因 'no_active_device_for_tool' 失败的问题
 * - 设备离线后自动恢复会话
 */
import { apiPostJson } from "./api";

// ── 类型定义 ──────────────────────────────────────────────────────

export type SessionType = "browser" | "desktop" | "terminal" | "custom";

export type DeviceSession = {
  sessionId: string;
  sessionType: SessionType;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string | null;
  metadata: Record<string, any>;
  status: "active" | "idle" | "expired" | "error";
};

export type HeartbeatConfig = {
  apiBase: string;
  deviceToken: string;
  deviceId: string;
  intervalMs?: number; // 默认 60 秒
  enabled?: boolean;
  os?: string;
  agentVersion?: string;
};

// ── 内部状态 ──────────────────────────────────────────────────────

let heartbeatConfig: HeartbeatConfig | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatAt: string | null = null;
let heartbeatFailures = 0;
const MAX_HEARTBEAT_FAILURES = 5;

// 会话存储
const sessions = new Map<string, DeviceSession>();
const sessionsByType = new Map<SessionType, Set<string>>();

// 会话过期时间（毫秒）
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 分钟
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟无活动则标记为 idle

// ── 心跳机制 ──────────────────────────────────────────────────────

/**
 * 初始化心跳机制
 */
export function initHeartbeat(config: HeartbeatConfig): void {
  heartbeatConfig = {
    ...config,
    intervalMs: config.intervalMs ?? 60_000,
    enabled: config.enabled ?? true,
  };

  if (!heartbeatConfig.enabled) {
    console.log("[session-manager] Heartbeat disabled by configuration");
    return;
  }

  // 立即发送一次心跳
  sendHeartbeat().catch(() => {});

  // 启动定时心跳
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    sendHeartbeat().catch(() => {});
  }, heartbeatConfig.intervalMs);

  console.log(`[session-manager] Heartbeat initialized, interval=${heartbeatConfig.intervalMs}ms`);
}

/**
 * 停止心跳
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  console.log("[session-manager] Heartbeat stopped");
}

/**
 * 发送心跳
 */
export async function sendHeartbeat(): Promise<boolean> {
  if (!heartbeatConfig || !heartbeatConfig.enabled) {
    return false;
  }

  try {
    const activeSessions = getActiveSessions();
    const sessionSummary = {
      total: activeSessions.length,
      byType: {} as Record<string, number>,
    };
    for (const s of activeSessions) {
      sessionSummary.byType[s.sessionType] = (sessionSummary.byType[s.sessionType] ?? 0) + 1;
    }

    const res = await apiPostJson<{ ok: boolean; serverTime?: string }>({
      apiBase: heartbeatConfig.apiBase,
      path: "/device-agent/heartbeat",
      token: heartbeatConfig.deviceToken,
      body: {
        os: heartbeatConfig.os || "unknown",
        agentVersion: heartbeatConfig.agentVersion || "unknown",
        timestamp: new Date().toISOString(),
        sessions: sessionSummary,
        status: "active",
      },
    });

    if (res.status === 200 && res.json?.ok) {
      lastHeartbeatAt = new Date().toISOString();
      heartbeatFailures = 0;
      return true;
    }

    heartbeatFailures++;
    console.warn(`[session-manager] Heartbeat failed: status=${res.status}, failures=${heartbeatFailures}`);

    if (heartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
      console.error(`[session-manager] Too many heartbeat failures, marking device as potentially offline`);
    }

    return false;
  } catch (err: any) {
    heartbeatFailures++;
    console.error(`[session-manager] Heartbeat error: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * 获取心跳状态
 */
export function getHeartbeatStatus(): {
  enabled: boolean;
  lastHeartbeatAt: string | null;
  failures: number;
  healthy: boolean;
} {
  return {
    enabled: heartbeatConfig?.enabled ?? false,
    lastHeartbeatAt,
    failures: heartbeatFailures,
    healthy: heartbeatFailures < MAX_HEARTBEAT_FAILURES,
  };
}

// ── 会话管理 ──────────────────────────────────────────────────────

function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 创建新会话
 */
export function createSession(params: {
  sessionType: SessionType;
  metadata?: Record<string, any>;
  ttlMs?: number;
}): DeviceSession {
  const sessionId = generateSessionId();
  const now = new Date().toISOString();
  const ttl = params.ttlMs ?? SESSION_TTL_MS;

  const session: DeviceSession = {
    sessionId,
    sessionType: params.sessionType,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: ttl > 0 ? new Date(Date.now() + ttl).toISOString() : null,
    metadata: params.metadata ?? {},
    status: "active",
  };

  sessions.set(sessionId, session);

  // 按类型索引
  if (!sessionsByType.has(params.sessionType)) {
    sessionsByType.set(params.sessionType, new Set());
  }
  sessionsByType.get(params.sessionType)!.add(sessionId);

  console.log(`[session-manager] Session created: id=${sessionId} type=${params.sessionType}`);
  return session;
}

/**
 * 获取会话
 */
export function getSession(sessionId: string): DeviceSession | null {
  return sessions.get(sessionId) ?? null;
}

/**
 * 获取指定类型的活跃会话
 */
export function getActiveSessionByType(sessionType: SessionType): DeviceSession | null {
  const typeIds = sessionsByType.get(sessionType);
  if (!typeIds) return null;

  for (const id of typeIds) {
    const session = sessions.get(id);
    if (session && session.status === "active") {
      // 检查是否过期
      if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
        session.status = "expired";
        continue;
      }
      return session;
    }
  }
  return null;
}

/**
 * 获取或创建指定类型的会话
 */
export function getOrCreateSession(params: {
  sessionType: SessionType;
  metadata?: Record<string, any>;
  ttlMs?: number;
}): DeviceSession {
  const existing = getActiveSessionByType(params.sessionType);
  if (existing) {
    // 更新活跃时间
    existing.lastActiveAt = new Date().toISOString();
    return existing;
  }
  return createSession(params);
}

/**
 * 更新会话活跃时间
 */
export function touchSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.lastActiveAt = new Date().toISOString();

  // 如果是 idle 状态，恢复为 active
  if (session.status === "idle") {
    session.status = "active";
  }

  return true;
}

/**
 * 更新会话元数据
 */
export function updateSessionMetadata(
  sessionId: string,
  metadata: Record<string, any>,
): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.metadata = { ...session.metadata, ...metadata };
  session.lastActiveAt = new Date().toISOString();

  return true;
}

/**
 * 关闭会话
 */
export function closeSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.status = "expired";
  sessions.delete(sessionId);

  // 从类型索引中移除
  const typeIds = sessionsByType.get(session.sessionType);
  if (typeIds) {
    typeIds.delete(sessionId);
  }

  console.log(`[session-manager] Session closed: id=${sessionId}`);
  return true;
}

/**
 * 获取所有活跃会话
 */
export function getActiveSessions(): DeviceSession[] {
  const result: DeviceSession[] = [];
  const now = Date.now();

  for (const session of sessions.values()) {
    // 检查过期
    if (session.expiresAt && new Date(session.expiresAt).getTime() < now) {
      session.status = "expired";
      continue;
    }

    // 检查 idle 超时
    const lastActive = new Date(session.lastActiveAt).getTime();
    if (now - lastActive > SESSION_IDLE_TIMEOUT_MS && session.status === "active") {
      session.status = "idle";
    }

    if (session.status === "active" || session.status === "idle") {
      result.push(session);
    }
  }

  return result;
}

/**
 * 清理过期会话
 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, session] of sessions.entries()) {
    const expired =
      session.status === "expired" ||
      (session.expiresAt && new Date(session.expiresAt).getTime() < now);

    if (expired) {
      sessions.delete(sessionId);
      const typeIds = sessionsByType.get(session.sessionType);
      if (typeIds) {
        typeIds.delete(sessionId);
      }
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[session-manager] Cleaned up ${cleaned} expired sessions`);
  }

  return cleaned;
}


// ── 初始化与清理 ──────────────────────────────────────────────────

/**
 * 初始化会话管理器
 */
export function initSessionManager(config: HeartbeatConfig): void {
  // 初始化心跳
  initHeartbeat(config);

  // P0-5: 保存清理定时器引用，确保 shutdown 时可清除
  if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
  sessionCleanupTimer = setInterval(() => {
    cleanupExpiredSessions();
  }, 5 * 60 * 1000);

  console.log("[session-manager] Session manager initialized");
}

/**
 * 关闭会话管理器
 */
export function shutdownSessionManager(): void {
  stopHeartbeat();

  // P0-5: 清除会话清理定时器
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer);
    sessionCleanupTimer = null;
  }

  // 关闭所有会话
  for (const sessionId of sessions.keys()) {
    closeSession(sessionId);
  }

  console.log("[session-manager] Session manager shutdown");
}

/**
 * 获取会话管理器状态
 */
export function getSessionManagerStatus(): {
  heartbeat: ReturnType<typeof getHeartbeatStatus>;
  sessions: {
    total: number;
    active: number;
    idle: number;
    byType: Record<string, number>;
  };
} {
  const allSessions = Array.from(sessions.values());
  const activeSessions = allSessions.filter((s) => s.status === "active");
  const idleSessions = allSessions.filter((s) => s.status === "idle");

  const byType: Record<string, number> = {};
  for (const s of allSessions) {
    byType[s.sessionType] = (byType[s.sessionType] ?? 0) + 1;
  }

  return {
    heartbeat: getHeartbeatStatus(),
    sessions: {
      total: allSessions.length,
      active: activeSessions.length,
      idle: idleSessions.length,
      byType,
    },
  };
}
