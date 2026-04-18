/**
 * Device-OS 内核模块 #5：会话管理与状态同步
 *
 * 通用 DeviceSession + heartbeat + health + resourceSnapshot + capabilitySnapshot
 * 注意：getBrowserSession/getDesktopSession 等场景特化方法已下沉到对应插件。
 *
 * @layer kernel
 */
import { exportCapabilityManifest } from "./capabilityRegistry";
import { exportMetricsSnapshot } from "./toolMetrics";
import { getCachedCapabilityReport } from "../plugins/capabilityProbe";
import type { DeviceCapabilityReport } from "../plugins/capabilityProbe";
export type SessionType = string; // 由插件自行扩展：如 "browser"、"desktop"、"terminal"

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
  intervalMs?: number;
  enabled?: boolean;
  os?: string;
  agentVersion?: string;
};

// ── 内部状态 ──────────────────────────────────────────────

let heartbeatConfig: HeartbeatConfig | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sessionCleanupTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatAt: string | null = null;
let heartbeatFailures = 0;
let heartbeatSender: ((body: any) => Promise<any>) | null = null;
const MAX_HEARTBEAT_FAILURES = 5;

const sessions = new Map<string, DeviceSession>();
const sessionsByType = new Map<SessionType, Set<string>>();

const SESSION_TTL_MS = 30 * 60 * 1000;
const SESSION_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// ── 心跳机制 ──────────────────────────────────────────────

export function initHeartbeat(config: HeartbeatConfig, sendFn?: (body: any) => Promise<any>): void {
  heartbeatConfig = { ...config, intervalMs: config.intervalMs ?? 60_000, enabled: config.enabled ?? true };
  heartbeatSender = sendFn ?? heartbeatSender;
  if (!heartbeatConfig.enabled) { console.log("[session] Heartbeat disabled"); return; }
  if (!heartbeatSender) throw new Error("heartbeat_sender_required");
  sendHeartbeat().catch(() => {});
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => { sendHeartbeat().catch(() => {}); }, heartbeatConfig.intervalMs);
  console.log(`[session] Heartbeat initialized, interval=${heartbeatConfig.intervalMs}ms`);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  heartbeatSender = null;
  console.log("[session] Heartbeat stopped");
}

export async function sendHeartbeat(sendFn?: (body: any) => Promise<any>): Promise<boolean> {
  if (!heartbeatConfig?.enabled) return false;
  const sender = sendFn ?? heartbeatSender;
  if (!sender) throw new Error("heartbeat_sender_required");
  try {
    const activeSessions = getActiveSessions();
    const sessionSummary = { total: activeSessions.length, byType: {} as Record<string, number> };
    for (const s of activeSessions) sessionSummary.byType[s.sessionType] = (sessionSummary.byType[s.sessionType] ?? 0) + 1;
    const res = await sender({ os: heartbeatConfig.os || "unknown", agentVersion: heartbeatConfig.agentVersion || "unknown", timestamp: new Date().toISOString(), sessions: sessionSummary, status: "active", capabilitySnapshot: exportCapabilityManifest(), metricsSnapshot: exportMetricsSnapshot(), deviceCapabilityReport: getCachedCapabilityReport() ?? undefined });
    if (res.status === 200 && res.json?.ok) { lastHeartbeatAt = new Date().toISOString(); heartbeatFailures = 0; return true; }
    heartbeatFailures++;
    console.warn(`[session] Heartbeat failed: status=${res.status}`);
    return false;
  } catch (err: any) {
    heartbeatFailures++;
    console.error(`[session] Heartbeat error: ${err?.message ?? err}`);
    return false;
  }
}

export function getHeartbeatStatus() { return { enabled: heartbeatConfig?.enabled ?? false, lastHeartbeatAt, failures: heartbeatFailures, healthy: heartbeatFailures < MAX_HEARTBEAT_FAILURES }; }

// ── 会话管理（通用，无场景特化） ─────────────────────────

function generateSessionId(): string { return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`; }

export function createSession(params: { sessionType: SessionType; metadata?: Record<string, any>; ttlMs?: number }): DeviceSession {
  const sessionId = generateSessionId();
  const now = new Date().toISOString();
  const session: DeviceSession = { sessionId, sessionType: params.sessionType, createdAt: now, lastActiveAt: now, expiresAt: params.ttlMs ? new Date(Date.now() + params.ttlMs).toISOString() : null, metadata: params.metadata ?? {}, status: "active" };
  sessions.set(sessionId, session);
  if (!sessionsByType.has(params.sessionType)) sessionsByType.set(params.sessionType, new Set());
  sessionsByType.get(params.sessionType)!.add(sessionId);
  return session;
}

export function getSession(sessionId: string): DeviceSession | null { return sessions.get(sessionId) ?? null; }

export function getActiveSessionByType(sessionType: SessionType): DeviceSession | null {
  const typeIds = sessionsByType.get(sessionType);
  if (!typeIds) return null;
  for (const id of typeIds) {
    const session = sessions.get(id);
    if (session && session.status === "active" && (!session.expiresAt || new Date(session.expiresAt) > new Date())) return session;
  }
  return null;
}

export function getOrCreateSession(params: { sessionType: SessionType; metadata?: Record<string, any>; ttlMs?: number }): DeviceSession {
  const existing = getActiveSessionByType(params.sessionType);
  if (existing) { existing.lastActiveAt = new Date().toISOString(); return existing; }
  return createSession(params);
}

export function touchSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.lastActiveAt = new Date().toISOString();
  if (session.status === "idle") session.status = "active";
  return true;
}

export function closeSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.status = "expired";
  sessions.delete(sessionId);
  const typeIds = sessionsByType.get(session.sessionType);
  if (typeIds) typeIds.delete(sessionId);
  return true;
}

export function getActiveSessions(): DeviceSession[] {
  const result: DeviceSession[] = [];
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.expiresAt && new Date(session.expiresAt).getTime() < now) { session.status = "expired"; continue; }
    if (now - new Date(session.lastActiveAt).getTime() > SESSION_IDLE_TIMEOUT_MS && session.status === "active") session.status = "idle";
    if (session.status === "active" || session.status === "idle") result.push(session);
  }
  return result;
}

export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [sessionId, session] of sessions.entries()) {
    if (session.status === "expired" || (session.expiresAt && new Date(session.expiresAt).getTime() < now)) {
      sessions.delete(sessionId);
      const typeIds = sessionsByType.get(session.sessionType);
      if (typeIds) typeIds.delete(sessionId);
      cleaned++;
    }
  }
  return cleaned;
}

export function initSessionManager(config: HeartbeatConfig, apiSendHeartbeat: (body: any) => Promise<any>): void {
  initHeartbeat(config, apiSendHeartbeat);
  if (sessionCleanupTimer) clearInterval(sessionCleanupTimer);
  sessionCleanupTimer = setInterval(() => cleanupExpiredSessions(), 5 * 60 * 1000);
  sessionCleanupTimer.unref?.();
}

export function shutdownSessionManager(): void {
  stopHeartbeat();
  if (sessionCleanupTimer) {
    clearInterval(sessionCleanupTimer);
    sessionCleanupTimer = null;
  }
  for (const id of sessions.keys()) closeSession(id);
}

export function getSessionManagerStatus() {
  const all = Array.from(sessions.values());
  const active = all.filter((s) => s.status === "active");
  const idle = all.filter((s) => s.status === "idle");
  const byType: Record<string, number> = {};
  for (const s of all) byType[s.sessionType] = (byType[s.sessionType] ?? 0) + 1;
  return { heartbeat: getHeartbeatStatus(), sessions: { total: all.length, active: active.length, idle: idle.length, byType } };
}
