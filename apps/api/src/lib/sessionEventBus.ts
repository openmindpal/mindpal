/**
 * Session Event Bus — 会话级 SSE 多路复用事件总线
 *
 * OS 级 I/O 调度子系统：管理会话级持久 SSE 连接，支持多任务事件多路复用。
 *
 * 核心能力：
 * 1. 会话级连接注册 — 每个会话维护一个持久 SSE 连接
 * 2. 事件多路复用 — 单连接承载多个任务的事件流，通过 taskId 区分
 * 3. 事件广播 — 支持全会话广播（队列管理事件）和定向推送（任务内事件）
 * 4. 连接生命周期 — 自动清理、心跳保活、断线检测
 * 5. 背压感知 — 继承 streamingPipeline 的背压控制
 *
 * 与 streamingPipeline 的关系：
 * - streamingPipeline 管理全局 SSE 连接池（按 connectionId/runId 查找）
 * - sessionEventBus 在其之上增加会话级语义（按 sessionId/taskId 路由）
 */

import { openSse } from "./sse";
import type { RequestDlpPolicyContext } from "./dlpPolicy";
import { StructuredLogger } from "@openslin/shared";

/* ================================================================== */
/*  日志                                                               */
/* ================================================================== */

const _logger = new StructuredLogger({ module: "sessionEventBus" });

function log(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
  _logger[level](msg, ctx);
}

/* ================================================================== */
/*  类型定义                                                            */
/* ================================================================== */

/** 会话 SSE 连接 */
export interface SessionConnection {
  /** 连接唯一标识 */
  readonly connectionId: string;
  /** 会话 ID */
  readonly sessionId: string;
  /** 租户 ID */
  readonly tenantId: string;
  /** 发送事件（自动注入 taskId） */
  sendEvent(event: string, data: unknown): boolean;
  /** 关闭连接 */
  close(): void;
  /** 是否已关闭 */
  isClosed(): boolean;
  /** abort 信号 */
  readonly signal: AbortSignal;
  /** 底层 AbortController */
  readonly abortController: AbortController;
}

/** 事件处理器：接收 SSE 事件 */
export type SessionEventHandler = (event: string, data: unknown) => void;

/** 任务事件处理器：按 taskId 路由的处理器 */
export type TaskEventHandler = (event: string, data: unknown, taskId: string | null) => void;

/* ================================================================== */
/*  全局连接注册中心                                                     */
/* ================================================================== */

interface SessionEntry {
  sessionId: string;
  tenantId: string;
  connections: Map<string, SessionConnection>;
  /** 注册时间 */
  registeredAt: number;
  /** 最后活跃时间 */
  lastActiveAt: number;
  /** 任务级事件处理器 Map<taskId, handler[]> */
  taskHandlers: Map<string, TaskEventHandler[]>;
  /** 会话级事件处理器（接收所有事件） */
  sessionHandlers: TaskEventHandler[];
}

function buildSessionRegistryKey(sessionId: string, tenantId: string): string {
  return `${tenantId}::${sessionId}`;
}

/** 全局连接注册中心：(tenantId, sessionId) → SessionEntry */
const sessionRegistry = new Map<string, SessionEntry>();

/** 心跳定时器 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 15_000;

/* ================================================================== */
/*  连接管理                                                            */
/* ================================================================== */

/**
 * 为会话注册一个 SSE 连接。
 * 同一会话允许存在多个并发连接，适配多标签页/多窗口订阅。
 */
export function registerSessionConnection(params: {
  req: any;
  reply: any;
  sessionId: string;
  tenantId: string;
  dlpContext?: RequestDlpPolicyContext;
  onClose?: () => void | Promise<void>;
}): SessionConnection {
  const { req, reply, sessionId, tenantId, dlpContext, onClose } = params;
  const registryKey = buildSessionRegistryKey(sessionId, tenantId);

  // 创建新 SSE 连接
  const sseHandle = openSse({ req, reply, dlpContext, onClose });
  const connectionId = `sess-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const connection: SessionConnection = {
    connectionId,
    sessionId,
    tenantId,
    sendEvent: (event: string, data: unknown) => {
      if (sseHandle.isClosed()) return false;
      sseHandle.sendEvent(event, data);
      const sent = !sseHandle.isClosed();
      // 更新活跃时间
      const entry = sessionRegistry.get(registryKey);
      if (entry && sent) entry.lastActiveAt = Date.now();
      return sent;
    },
    close: () => {
      sseHandle.close();
      removeConnection(registryKey, connectionId);
      log("info", `Session connection closed`, { sessionId, tenantId, connectionId });
    },
    isClosed: () => sseHandle.isClosed(),
    signal: sseHandle.signal,
    abortController: sseHandle.abortController,
  };

  let entry = sessionRegistry.get(registryKey);
  if (!entry) {
    entry = {
      sessionId,
      tenantId,
      connections: new Map(),
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
      taskHandlers: new Map(),
      sessionHandlers: [],
    };
    sessionRegistry.set(registryKey, entry);
  } else {
    entry.lastActiveAt = Date.now();
  }
  entry.connections.set(connectionId, connection);

  // 连接关闭时自动清理
  sseHandle.signal.addEventListener("abort", () => {
    removeConnection(registryKey, connectionId);
    log("info", `Session connection auto-cleaned on abort`, { sessionId, tenantId, connectionId });
  });

  log("info", `Session connection registered`, {
    sessionId, tenantId, connectionId,
    totalSessions: sessionRegistry.size,
    sessionConnections: entry.connections.size,
  });

  // 确保心跳定时器运行
  ensureHeartbeat();

  return connection;
}

function removeConnection(registryKey: string, connectionId: string) {
  const entry = sessionRegistry.get(registryKey);
  if (!entry) return;
  entry.connections.delete(connectionId);
  if (entry.connections.size === 0) {
    sessionRegistry.delete(registryKey);
  }
}

function getActiveConnectionsForEntry(entry: SessionEntry): SessionConnection[] {
  const active: SessionConnection[] = [];
  for (const [connectionId, connection] of entry.connections.entries()) {
    if (connection.isClosed()) {
      entry.connections.delete(connectionId);
      continue;
    }
    active.push(connection);
  }
  return active;
}

export function getSessionConnections(sessionId: string, tenantId: string): SessionConnection[] {
  const entry = sessionRegistry.get(buildSessionRegistryKey(sessionId, tenantId));
  if (!entry) return [];
  const active = getActiveConnectionsForEntry(entry);
  if (active.length === 0) sessionRegistry.delete(buildSessionRegistryKey(sessionId, tenantId));
  return active;
}

/** 注销会话连接 */
export function unregisterSessionConnection(sessionId: string, tenantId: string): void {
  const registryKey = buildSessionRegistryKey(sessionId, tenantId);
  const entry = sessionRegistry.get(registryKey);
  if (entry) {
    for (const connection of getActiveConnectionsForEntry(entry)) {
      if (!connection.isClosed()) {
        connection.close();
      }
    }
    sessionRegistry.delete(registryKey);
    log("info", `Session connection unregistered`, { sessionId, tenantId });
  }
}

/** 获取会话连接 */
export function getSessionConnection(sessionId: string, tenantId: string): SessionConnection | null {
  return getSessionConnections(sessionId, tenantId)[0] ?? null;
}

/** 检查会话是否有活跃连接 */
export function hasActiveConnection(sessionId: string, tenantId: string): boolean {
  return getSessionConnections(sessionId, tenantId).length > 0;
}

/* ================================================================== */
/*  事件推送                                                            */
/* ================================================================== */

/**
 * 向会话推送事件（多路复用）。
 * 自动将 taskId 注入到事件数据中，前端通过 taskId 路由事件。
 *
 * @param sessionId 会话 ID
 * @param event SSE 事件名（如 delta、stepProgress、taskCreated）
 * @param data 事件载荷
 * @param taskId 关联的任务 ID（null 表示非任务事件，如 answer 模式对话）
 */
export function emitToSession(
  sessionId: string,
  tenantId: string,
  event: string,
  data: unknown,
  taskId?: string | null,
): boolean {
  const registryKey = buildSessionRegistryKey(sessionId, tenantId);
  const entry = sessionRegistry.get(registryKey);
  if (!entry) {
    log("warn", `No active connection for session`, { sessionId, tenantId, event });
    return false;
  }
  const activeConnections = getActiveConnectionsForEntry(entry);
  if (activeConnections.length === 0) {
    sessionRegistry.delete(registryKey);
    log("warn", `No active connection for session`, { sessionId, tenantId, event });
    return false;
  }

  // 注入 taskId 到载荷中（多路复用标识）
  const enrichedData = typeof data === "object" && data !== null
    ? { ...data as Record<string, unknown>, _taskId: taskId ?? null }
    : { value: data, _taskId: taskId ?? null };

  let sent = false;
  for (const connection of activeConnections) {
    sent = connection.sendEvent(event, enrichedData) || sent;
  }

  // 触发本地处理器
  const handlers = [
    ...entry.sessionHandlers,
    ...(taskId ? (entry.taskHandlers.get(taskId) || []) : []),
  ];
  for (const handler of handlers) {
    try {
      handler(event, enrichedData, taskId ?? null);
    } catch (err) {
      log("error", `Event handler error`, { sessionId, event, error: String(err) });
    }
  }

  return sent;
}

/**
 * 向会话广播队列管理事件。
 * 这些事件不关联特定任务，而是关于队列整体状态变化。
 */
export function broadcastToSession(
  sessionId: string,
  tenantId: string,
  event: string,
  data: unknown,
): boolean {
  return emitToSession(sessionId, tenantId, event, data, null);
}

/**
 * 按 taskId 向会话推送任务相关事件。
 */
export function emitTaskEvent(
  sessionId: string,
  tenantId: string,
  taskId: string,
  event: string,
  data: unknown,
): boolean {
  return emitToSession(sessionId, tenantId, event, data, taskId);
}

/* ================================================================== */
/*  事件处理器注册                                                       */
/* ================================================================== */

/** 注册会话级事件处理器（接收该会话的所有事件） */
export function onSessionEvent(sessionId: string, tenantId: string, handler: TaskEventHandler): () => void {
  const entry = sessionRegistry.get(buildSessionRegistryKey(sessionId, tenantId));
  if (!entry) return () => {};

  entry.sessionHandlers.push(handler);
  return () => {
    const idx = entry.sessionHandlers.indexOf(handler);
    if (idx >= 0) entry.sessionHandlers.splice(idx, 1);
  };
}

/** 注册任务级事件处理器（只接收指定 taskId 的事件） */
export function onTaskEvent(sessionId: string, tenantId: string, taskId: string, handler: TaskEventHandler): () => void {
  const entry = sessionRegistry.get(buildSessionRegistryKey(sessionId, tenantId));
  if (!entry) return () => {};

  if (!entry.taskHandlers.has(taskId)) {
    entry.taskHandlers.set(taskId, []);
  }
  entry.taskHandlers.get(taskId)!.push(handler);

  return () => {
    const handlers = entry.taskHandlers.get(taskId);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
      if (handlers.length === 0) entry.taskHandlers.delete(taskId);
    }
  };
}

/* ================================================================== */
/*  QueueEventEmitter 适配器                                            */
/* ================================================================== */

import type { QueueEventEmitter } from "../kernel/taskQueueManager";
import type { QueueEvent } from "../kernel/taskQueue.types";

/**
 * 创建 QueueEventEmitter 适配器，将 TaskQueueManager 的事件
 * 桥接到 SessionEventBus 的 SSE 推送。
 */
export function createQueueEventEmitter(): QueueEventEmitter {
  return {
    emit(event: QueueEvent) {
      const sessionId = event.sessionId;
      if (!sessionId) {
        log("warn", `QueueEvent missing sessionId`, { type: event.type });
        return;
      }
      const tenantId = typeof event.data?.tenantId === "string" ? String(event.data.tenantId) : "";
      if (!tenantId) {
        log("warn", `QueueEvent missing tenantId`, { type: event.type, sessionId });
        return;
      }

      emitToSession(
        sessionId,
        tenantId,
        event.type,
        {
          entryId: event.entryId,
          taskId: event.taskId,
          ...event.data,
          timestamp: event.timestamp,
        },
        event.taskId,
      );
    },
  };
}

/* ================================================================== */
/*  心跳 & 生命周期                                                     */
/* ================================================================== */

/** 启动心跳保活定时器 */
function ensureHeartbeat() {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const staleThreshold = HEARTBEAT_INTERVAL_MS * 4; // 4 次心跳未活跃视为失活

    for (const [registryKey, entry] of sessionRegistry.entries()) {
      const activeConnections = getActiveConnectionsForEntry(entry);
      if (activeConnections.length === 0) {
        sessionRegistry.delete(registryKey);
        continue;
      }

      // 发送心跳
      for (const connection of activeConnections) {
        connection.sendEvent("heartbeat", { ts: now });
      }

      // 检测失活连接
      if (now - entry.lastActiveAt > staleThreshold) {
        log("warn", `Stale session connection detected, closing`, {
          sessionId: registryKey,
          lastActiveAt: new Date(entry.lastActiveAt).toISOString(),
        });
        for (const connection of activeConnections) {
          connection.close();
        }
        sessionRegistry.delete(registryKey);
      }
    }

    // 如果没有活跃连接，停止心跳
    if (sessionRegistry.size === 0 && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }, HEARTBEAT_INTERVAL_MS);

  // 不阻止进程退出
  if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    (heartbeatTimer as any).unref();
  }
}

/** 优雅关闭：关闭所有会话连接 */
export function shutdownAllSessions(): void {
  log("info", `Shutting down all session connections`, { count: sessionRegistry.size });

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  for (const [sessionId, entry] of sessionRegistry.entries()) {
    try {
      for (const connection of getActiveConnectionsForEntry(entry)) {
        if (!connection.isClosed()) {
          connection.sendEvent("shutdown", { reason: "server_shutdown" });
          connection.close();
        }
      }
    } catch {
      // ignore
    }
  }

  sessionRegistry.clear();
}

/* ================================================================== */
/*  指标 & 诊断                                                        */
/* ================================================================== */

/** 获取当前连接统计 */
export function getSessionBusMetrics(): {
  totalSessions: number;
  totalConnections: number;
  sessionIds: string[];
  oldestConnectionAge: number;
} {
  const now = Date.now();
  let oldest = 0;
  const sessionIds: string[] = [];
  let totalConnections = 0;

  for (const [sessionId, entry] of sessionRegistry.entries()) {
    const activeConnections = getActiveConnectionsForEntry(entry);
    if (activeConnections.length === 0) continue;
    sessionIds.push(sessionId);
    totalConnections += activeConnections.length;
    const age = now - entry.registeredAt;
    if (age > oldest) oldest = age;
  }

  return {
    totalSessions: sessionIds.length,
    totalConnections,
    sessionIds,
    oldestConnectionAge: oldest,
  };
}
