/**
 * Device-OS 内核模块 #5：会话管理与状态同步 + 统一执行会话
 *
 * 通用 DeviceSession + heartbeat + health + resourceSnapshot + capabilitySnapshot
 * ExecutionSession 统一管理会话生命周期与任务队列。
 * 注意：getBrowserSession/getDesktopSession 等场景特化方法已下沉到对应插件。
 *
 * @layer kernel
 */
import { exportCapabilityManifest } from "./capabilityRegistry";
import { exportMetricsSnapshot } from "./toolMetrics";
import { getCachedCapabilityReport } from "../plugins/capabilityProbe";
import type { DeviceCapabilityReport } from "../plugins/capabilityProbe";
import { getToolRiskLevel } from "./capabilityRegistry";
import { toolName } from "./types";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import type { TaskState } from "./types";
import { isTerminalState } from "./types";
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

// ══════════════════════════════════════════════════════════════
// ExecutionSession — 统一会话 + 任务队列管理
// ══════════════════════════════════════════════════════════════

export type TaskPriority = "urgent" | "high" | "normal" | "low";
const PRIORITY_WEIGHT: Record<TaskPriority, number> = { urgent: 1000, high: 100, normal: 10, low: 1 };

export interface QueuedTask {
  taskId: string;
  deviceExecutionId: string;
  toolRef: string;
  input?: any;
  priority: TaskPriority;
  state: TaskState;
  enqueuedAt: string;
  claimedAt?: string;
  startedAt?: string;
  completedAt?: string;
  idempotencyKey?: string;
  retryCount: number;
  maxRetries: number;
  timeoutMs: number;
  metadata?: Record<string, any>;
}

export interface TaskResult {
  taskId: string;
  status: "succeeded" | "failed" | "canceled" | "timed_out";
  errorCategory?: string;
  outputDigest?: any;
  evidenceRefs?: string[];
  executedAt: string;
  durationMs: number;
}

export type TaskQueueConfig = { maxQueueSize?: number; defaultPriority?: TaskPriority; defaultTimeoutMs?: number; maxRetries?: number };

// ── 持久化幂等性Map（磁盘+内存两级存储） ──────────────────

class DurableIdempotencyMap {
  private memory = new Map<string, { taskId: string; createdAt: number }>();
  private filePath: string;
  private ttlMs: number;

  constructor(cacheDir: string, ttlMs = 24 * 60 * 60 * 1000) {
    this.filePath = path.join(cacheDir, 'idempotency.json');
    this.ttlMs = ttlMs;
    this.loadFromDisk();
  }

  has(key: string): boolean {
    const entry = this.memory.get(key);
    if (!entry) return false;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.memory.delete(key);
      this.saveToDisk();
      return false;
    }
    return true;
  }

  get(key: string): string | undefined {
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.memory.delete(key);
      this.saveToDisk();
      return undefined;
    }
    return entry.taskId;
  }

  set(key: string, taskId: string): void {
    this.memory.set(key, { taskId, createdAt: Date.now() });
    this.saveToDisk();
  }

  delete(key: string): void {
    this.memory.delete(key);
    this.saveToDisk();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory) {
      if (now - entry.createdAt > this.ttlMs) this.memory.delete(key);
    }
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data: Record<string, { taskId: string; createdAt: number }> = JSON.parse(raw);
      const now = Date.now();
      for (const [key, entry] of Object.entries(data)) {
        if (entry && typeof entry.taskId === 'string' && typeof entry.createdAt === 'number') {
          if (now - entry.createdAt <= this.ttlMs) {
            this.memory.set(key, entry);
          }
        }
      }
    } catch {
      // 启动恢复是尽力而为，文件不存在或损坏时从空Map开始
    }
  }

  private saveToDisk(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: Record<string, { taskId: string; createdAt: number }> = {};
      for (const [key, entry] of this.memory) data[key] = entry;
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf8');
    } catch {
      // 磁盘写入是尽力而为，不阻塞任务执行
    }
  }
}

export interface SessionConfig {
  sessionType: SessionType;
  metadata?: Record<string, any>;
  ttlMs?: number;
  queueConfig?: TaskQueueConfig;
}

/**
 * ExecutionSession — 统一管理会话生命周期与任务队列
 *
 * 将原 session.ts 的会话管理和 taskExecutor.ts 的任务队列
 * 统一到一个类中，提供完整的会话+任务生命周期管理。
 */
export class ExecutionSession {
  private session: DeviceSession;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatConfig: HeartbeatConfig | null = null;
  private heartbeatSender: ((body: any) => Promise<any>) | null = null;
  private heartbeatFailures = 0;
  private lastHeartbeatAt: string | null = null;

  // ── 任务队列 ──
  private queueConfig: TaskQueueConfig;
  private taskQueue: QueuedTask[] = [];
  private executingTasks = new Map<string, { task: QueuedTask; startedAt: number }>();
  private completedTasks = new Map<string, TaskResult>();
  private idempotencyMap: DurableIdempotencyMap;

  constructor(config: SessionConfig) {
    const now = new Date().toISOString();
    this.session = {
      sessionId: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      sessionType: config.sessionType,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: config.ttlMs ? new Date(Date.now() + config.ttlMs).toISOString() : null,
      metadata: config.metadata ?? {},
      status: "active",
    };
    this.queueConfig = {
      maxQueueSize: 100,
      defaultPriority: "normal",
      defaultTimeoutMs: 60_000,
      maxRetries: 3,
      ...config.queueConfig,
    };
    this.idempotencyMap = new DurableIdempotencyMap(
      path.join(os.homedir(), '.openslin', 'cache'),
      24 * 60 * 60 * 1000,
    );
  }

  // ── 会话访问 ──

  getSession(): DeviceSession { return this.session; }

  touch(): void {
    this.session.lastActiveAt = new Date().toISOString();
    if (this.session.status === "idle") this.session.status = "active";
  }

  // ── 心跳 ──

  startHeartbeat(config: HeartbeatConfig, sendFn: (body: any) => Promise<any>): void {
    this.heartbeatConfig = { ...config, intervalMs: config.intervalMs ?? 60_000, enabled: config.enabled ?? true };
    this.heartbeatSender = sendFn;
    if (!this.heartbeatConfig.enabled) { console.log("[ExecutionSession] Heartbeat disabled"); return; }
    this.doSendHeartbeat().catch(() => {});
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => { this.doSendHeartbeat().catch(() => {}); }, this.heartbeatConfig.intervalMs!);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.heartbeatSender = null;
  }

  private async doSendHeartbeat(): Promise<boolean> {
    if (!this.heartbeatConfig?.enabled || !this.heartbeatSender) return false;
    try {
      const res = await this.heartbeatSender({
        os: this.heartbeatConfig.os || "unknown",
        agentVersion: this.heartbeatConfig.agentVersion || "unknown",
        timestamp: new Date().toISOString(),
        status: "active",
        capabilitySnapshot: exportCapabilityManifest(),
        metricsSnapshot: exportMetricsSnapshot(),
        deviceCapabilityReport: getCachedCapabilityReport() ?? undefined,
      });
      if (res.status === 200 && res.json?.ok) { this.lastHeartbeatAt = new Date().toISOString(); this.heartbeatFailures = 0; return true; }
      this.heartbeatFailures++;
      return false;
    } catch {
      this.heartbeatFailures++;
      return false;
    }
  }

  getHeartbeatStatus() {
    return { enabled: this.heartbeatConfig?.enabled ?? false, lastHeartbeatAt: this.lastHeartbeatAt, failures: this.heartbeatFailures, healthy: this.heartbeatFailures < 5 };
  }

  // ── 任务队列 ──

  initTaskQueue(cfg?: TaskQueueConfig): void {
    if (cfg) this.queueConfig = { ...this.queueConfig, ...cfg };
  }

  enqueueTask(params: { deviceExecutionId: string; toolRef: string; input?: any; priority?: TaskPriority; idempotencyKey?: string; timeoutMs?: number; maxRetries?: number; metadata?: Record<string, any> }): QueuedTask | null {
    if (this.taskQueue.length >= (this.queueConfig.maxQueueSize ?? 100)) return null;
    if (params.idempotencyKey && this.idempotencyMap.has(params.idempotencyKey)) {
      const existingId = this.idempotencyMap.get(params.idempotencyKey);
      if (existingId) { const existing = this.taskQueue.find((t) => t.taskId === existingId); if (existing) return existing; }
      this.idempotencyMap.delete(params.idempotencyKey);
    }
    let priority = params.priority ?? this.queueConfig.defaultPriority ?? "normal";
    if (!params.priority) { const risk = getToolRiskLevel(toolName(params.toolRef)); if (risk === "critical" || risk === "high") priority = "high"; }
    const task: QueuedTask = { taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, deviceExecutionId: params.deviceExecutionId, toolRef: params.toolRef, input: params.input, priority, state: "pending", enqueuedAt: new Date().toISOString(), idempotencyKey: params.idempotencyKey, retryCount: 0, maxRetries: params.maxRetries ?? this.queueConfig.maxRetries ?? 3, timeoutMs: params.timeoutMs ?? this.queueConfig.defaultTimeoutMs ?? 60_000, metadata: params.metadata };
    this.taskQueue.push(task); this.sortQueue();
    if (params.idempotencyKey) this.idempotencyMap.set(params.idempotencyKey, task.taskId);
    return task;
  }

  dequeueTask(): QueuedTask | null {
    if (this.taskQueue.length === 0) return null;
    const task = this.taskQueue.shift()!; task.state = "claimed"; task.claimedAt = new Date().toISOString();
    this.executingTasks.set(task.taskId, { task, startedAt: Date.now() });
    return task;
  }

  completeTask(taskId: string, result: Omit<TaskResult, "taskId">): void {
    const executing = this.executingTasks.get(taskId);
    if (!executing) return;
    this.executingTasks.delete(taskId);
    if (executing.task.idempotencyKey) this.idempotencyMap.delete(executing.task.idempotencyKey);
    executing.task.state = result.status === "succeeded" ? "succeeded" : result.status === "timed_out" ? "timed_out" : "failed";
    executing.task.completedAt = new Date().toISOString();
    this.completedTasks.set(taskId, { taskId, ...result });
    if (this.completedTasks.size > 100) { const oldest = this.completedTasks.keys().next().value; if (oldest) this.completedTasks.delete(oldest); }
  }

  cancelTask(taskId: string): boolean {
    const qIdx = this.taskQueue.findIndex((t) => t.taskId === taskId);
    if (qIdx !== -1) { const task = this.taskQueue.splice(qIdx, 1)[0]; task.state = "canceled"; if (task.idempotencyKey) this.idempotencyMap.delete(task.idempotencyKey); return true; }
    const executing = this.executingTasks.get(taskId);
    if (executing) { this.executingTasks.delete(taskId); executing.task.state = "canceled"; if (executing.task.idempotencyKey) this.idempotencyMap.delete(executing.task.idempotencyKey); this.completeTask(taskId, { status: "canceled", executedAt: new Date().toISOString(), durationMs: Date.now() - executing.startedAt }); return true; }
    return false;
  }

  getQueueStatus() {
    const byPriority: Record<TaskPriority, number> = { urgent: 0, high: 0, normal: 0, low: 0 };
    for (const t of this.taskQueue) byPriority[t.priority]++;
    return { queueSize: this.taskQueue.length, executingCount: this.executingTasks.size, completedCount: this.completedTasks.size, byPriority };
  }

  getTask(taskId: string): { task: QueuedTask | null; status: "queued" | "executing" | "completed" | "not_found" } {
    const queued = this.taskQueue.find((t) => t.taskId === taskId); if (queued) return { task: queued, status: "queued" };
    const executing = this.executingTasks.get(taskId); if (executing) return { task: executing.task, status: "executing" };
    if (this.completedTasks.has(taskId)) return { task: null, status: "completed" };
    return { task: null, status: "not_found" };
  }

  getPendingTasks(): QueuedTask[] { return [...this.taskQueue]; }

  private sortQueue(): void {
    this.taskQueue.sort((a, b) => {
      const sa = (PRIORITY_WEIGHT[a.priority] ?? 10) * 1e6 + (Date.now() - new Date(a.enqueuedAt).getTime());
      const sb = (PRIORITY_WEIGHT[b.priority] ?? 10) * 1e6 + (Date.now() - new Date(b.enqueuedAt).getTime());
      return sb - sa;
    });
  }

  // ── 统一生命周期清理 ──

  dispose(): void {
    this.stopHeartbeat();
    this.taskQueue.length = 0;
    this.executingTasks.clear();
    this.completedTasks.clear();
    this.session.status = "expired";
  }
}

// ── 默认全局 ExecutionSession 实例 ──────────────────────────

let _defaultExecutionSession: ExecutionSession | null = null;

export function getDefaultExecutionSession(): ExecutionSession {
  if (!_defaultExecutionSession) {
    _defaultExecutionSession = new ExecutionSession({ sessionType: "default", ttlMs: SESSION_TTL_MS });
  }
  return _defaultExecutionSession;
}

export function resetDefaultExecutionSession(): void {
  if (_defaultExecutionSession) {
    _defaultExecutionSession.dispose();
    _defaultExecutionSession = null;
  }
}
