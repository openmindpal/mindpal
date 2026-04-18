/**
 * Streaming Pipeline — 统一 SSE 推送管理层
 *
 * OS 思维：SSE 连接是「文件描述符」，StreamingPipeline 是内核的 I/O 调度子系统。
 * 每个连接有独立的 backpressure 感知、心跳保活和生命周期管理。
 *
 * 核心能力:
 * 1. 连接注册中心 — 全局跟踪所有活跃 SSE 连接，支持按 tenantId/runId 查找
 * 2. Backpressure — 检测 socket drain，write 返回 false 时暂停上游生产者
 * 3. 并发连接限制 — 全局 + 租户级上限，超限拒绝新连接
 * 4. 心跳保活 — 统一 heartbeat 定时器，避免代理/LB 超时断开
 * 5. 指标导出 — 活跃连接数、总事件数、丢弃事件数、字节数
 * 6. 优雅关闭 — SIGTERM 时排空所有连接
 */

import { openSse } from "./sse";
import { resolveFallbackRequestDlpPolicyContext, type RequestDlpPolicyContext } from "./dlpPolicy";
import { sanitizeSseEvent } from "./streamDlp";

/* ================================================================== */
/*  配置                                                               */
/* ================================================================== */

const MAX_GLOBAL_SSE_CONNECTIONS = Math.max(
  1,
  Number(process.env.MAX_GLOBAL_SSE_CONNECTIONS) || 500,
);
const MAX_TENANT_SSE_CONNECTIONS = Math.max(
  1,
  Number(process.env.MAX_TENANT_SSE_CONNECTIONS) || 50,
);
const HEARTBEAT_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.SSE_HEARTBEAT_INTERVAL_MS) || 15_000,
);
const BACKPRESSURE_HIGH_WATER_MARK = Math.max(
  1,
  Number(process.env.SSE_BACKPRESSURE_HIGH_WATER) || 64,
);

/* ================================================================== */
/*  类型定义                                                            */
/* ================================================================== */

export interface ManagedSseConnection {
  /** 连接唯一标识 */
  readonly connectionId: string;
  /** 租户 ID */
  readonly tenantId: string;
  /** 可选：关联的 runId */
  readonly runId?: string;
  /** 发送一个 SSE 事件（backpressure-aware） */
  sendEvent(event: string, data: unknown): boolean;
  /** 优雅关闭连接 */
  close(): void;
  /** 连接是否已关闭 */
  isClosed(): boolean;
  /** abort 信号 */
  readonly signal: AbortSignal;
  /** 底层 AbortController */
  readonly abortController: AbortController;

  /* ── 背压控制 ── */
  /** 当前是否处于背压暂停状态 */
  isPaused(): boolean;
  /** 注册 drain 回调（背压解除时触发） */
  onDrain(cb: () => void): void;
  /** 等待背压解除（Promise 版本） */
  waitForDrain(): Promise<void>;
}

export interface StreamingPipelineMetrics {
  /** 当前活跃连接数 */
  activeConnections: number;
  /** 各租户活跃连接数 */
  tenantConnections: Record<string, number>;
  /** 累计发送事件数 */
  totalEventsSent: number;
  /** 累计因背压丢弃的事件数 */
  totalEventsDropped: number;
  /** 累计发送字节数 */
  totalBytesSent: number;
  /** 全局上限 */
  maxGlobal: number;
  /** 租户上限 */
  maxPerTenant: number;
}

/* ================================================================== */
/*  内部状态                                                            */
/* ================================================================== */

interface ConnectionEntry {
  conn: ManagedSseConnection;
  tenantId: string;
  runId?: string;
  sessionId?: string;
  taskIds: Set<string>;
  createdAt: number;
  eventCount: number;
  bytesSent: number;
  droppedEvents: number;
  rawReply: any;
  drainCallbacks: Array<() => void>;
  paused: boolean;
}

/** 全局连接注册中心 */
const registry = new Map<string, ConnectionEntry>();

/** 累计指标 */
let totalEventsSent = 0;
let totalEventsDropped = 0;
let totalBytesSent = 0;

/** 全局心跳定时器 */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** 连接 ID 计数器 */
let connIdSeq = 0;

/* ================================================================== */
/*  心跳管理                                                            */
/* ================================================================== */

function ensureHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of registry) {
      if (entry.conn.isClosed()) {
        registry.delete(id);
        continue;
      }
      try {
        entry.conn.sendEvent("ping", { ts: now });
      } catch {
        // 发送失败，连接可能已断开，由 close 事件清理
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // unref 使得心跳不阻塞进程退出
  if (heartbeatTimer && typeof heartbeatTimer === "object" && "unref" in heartbeatTimer) {
    (heartbeatTimer as any).unref();
  }
}

function maybeStopHeartbeat(): void {
  if (registry.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/* ================================================================== */
/*  连接工厂                                                            */
/* ================================================================== */

export interface OpenManagedSseParams {
  req: any;
  reply: any;
  tenantId: string;
  runId?: string;
  /** 关联的会话 ID（多任务队列支持） */
  sessionId?: string;
  /** 额外 SSE 响应头 */
  headers?: Record<string, string>;
  /** 已解析的请求级 DLP 策略 */
  dlpContext?: RequestDlpPolicyContext;
  /** 连接关闭时的收尾回调 */
  onClose?: () => void | Promise<void>;
}

/**
 * 创建一个受管理的 SSE 连接。
 *
 * 相比 openSse，额外提供:
 * - 全局 / 租户级并发连接限制
 * - 自动 heartbeat（无需调用方 setInterval）
 * - Backpressure 检测（write 返回 false → 暂停标记 + drain 回调）
 * - 连接级指标追踪
 *
 * @throws 如果全局或租户连接数超限，抛出 503 错误
 */
export function openManagedSse(params: OpenManagedSseParams): ManagedSseConnection {
  const { req, reply, tenantId, runId, sessionId, headers, dlpContext, onClose } = params;
  const effectiveDlpContext = dlpContext ?? resolveFallbackRequestDlpPolicyContext();

  // ── 并发连接限制 ──
  if (registry.size >= MAX_GLOBAL_SSE_CONNECTIONS) {
    throw Object.assign(new Error("SSE connection limit reached (global)"), {
      statusCode: 503,
      errorCode: "SSE_GLOBAL_LIMIT",
    });
  }
  let tenantCount = 0;
  for (const entry of registry.values()) {
    if (entry.tenantId === tenantId) tenantCount++;
  }
  if (tenantCount >= MAX_TENANT_SSE_CONNECTIONS) {
    throw Object.assign(new Error("SSE connection limit reached (tenant)"), {
      statusCode: 503,
      errorCode: "SSE_TENANT_LIMIT",
    });
  }

  // ── 打开底层 SSE ──
  const sse = openSse({ req, reply, headers, dlpContext: effectiveDlpContext, onClose });
  const connectionId = `sse_${Date.now().toString(36)}_${(++connIdSeq).toString(36)}`;

  // ── 背压状态 ──
  const rawStream = reply.raw as import("stream").Writable;
  const drainCallbacks: Array<() => void> = [];
  let paused = false;

  // 监听 drain 事件
  const onDrain = () => {
    paused = false;
    const cbs = drainCallbacks.splice(0);
    for (const cb of cbs) {
      try { cb(); } catch { /* ignore */ }
    }
  };
  rawStream.on("drain", onDrain);

  // ── 连接条目 ──
  const entry: ConnectionEntry = {
    conn: null as any, // 下面赋值
    tenantId,
    runId,
    sessionId,
    taskIds: new Set(),
    createdAt: Date.now(),
    eventCount: 0,
    bytesSent: 0,
    droppedEvents: 0,
    rawReply: reply,
    drainCallbacks,
    paused: false,
  };

  // ── 构建 ManagedSseConnection ──
  const connection: ManagedSseConnection = {
    connectionId,
    tenantId,
    runId,
    signal: sse.signal,
    abortController: sse.abortController,

    sendEvent(event: string, data: unknown): boolean {
      if (sse.isClosed()) return false;

      // 背压检查：如果队列过深，丢弃非关键事件
      if (paused && event !== "error" && event !== "done" && event !== "ping") {
        entry.droppedEvents++;
        totalEventsDropped++;
        return false;
      }

      try {
        const sanitized = sanitizeSseEvent({
          event,
          data,
          req,
          dlpContext: effectiveDlpContext,
        });
        const payload = `event: ${sanitized.event}\ndata: ${JSON.stringify(sanitized.data)}\n\n`;
        const bytes = Buffer.byteLength(payload, "utf8");
        const canContinue = rawStream.write(payload, "utf8");

        entry.eventCount++;
        entry.bytesSent += bytes;
        totalEventsSent++;
        totalBytesSent += bytes;

        if (!canContinue) {
          paused = true;
          entry.paused = true;
        }
        if (sanitized.denied) {
          sse.close();
          return false;
        }
        return canContinue;
      } catch {
        return false;
      }
    },

    close(): void {
      sse.close();
      rawStream.off("drain", onDrain);
      registry.delete(connectionId);
      maybeStopHeartbeat();
    },

    isClosed: sse.isClosed,

    isPaused(): boolean {
      return paused;
    },

    onDrain(cb: () => void): void {
      if (!paused) {
        // 已经不在背压状态，立即回调
        try { cb(); } catch { /* ignore */ }
        return;
      }
      drainCallbacks.push(cb);
    },

    async waitForDrain(): Promise<void> {
      if (!paused) return;
      return new Promise<void>((resolve) => {
        drainCallbacks.push(resolve);
      });
    },
  };

  entry.conn = connection;
  registry.set(connectionId, entry);

  // ── 自动清理：客户端断开时从注册中心移除 ──
  const autoCleanup = () => {
    rawStream.off("drain", onDrain);
    registry.delete(connectionId);
    maybeStopHeartbeat();
  };
  req.raw.on("close", autoCleanup);
  reply.raw.on("close", autoCleanup);

  // ── 确保心跳运行 ──
  ensureHeartbeat();

  return connection;
}

/* ================================================================== */
/*  连接查询                                                            */
/* ================================================================== */

/** 获取指定 runId 的所有活跃连接 */
export function getConnectionsByRunId(runId: string): ManagedSseConnection[] {
  const result: ManagedSseConnection[] = [];
  for (const entry of registry.values()) {
    if (entry.runId === runId && !entry.conn.isClosed()) {
      result.push(entry.conn);
    }
  }
  return result;
}

/** 获取指定租户的所有活跃连接 */
export function getConnectionsByTenant(tenantId: string): ManagedSseConnection[] {
  const result: ManagedSseConnection[] = [];
  for (const entry of registry.values()) {
    if (entry.tenantId === tenantId && !entry.conn.isClosed()) {
      result.push(entry.conn);
    }
  }
  return result;
}

/** 向指定 runId 的所有连接广播事件 */
export function broadcastToRun(runId: string, event: string, data: unknown): number {
  let sent = 0;
  for (const conn of getConnectionsByRunId(runId)) {
    if (conn.sendEvent(event, data)) sent++;
  }
  return sent;
}

/* ── 多任务队列扩展 ────────────────────────────────────────── */

/** 获取指定 sessionId 的所有活跃连接 */
export function getConnectionsBySessionId(sessionId: string): ManagedSseConnection[] {
  const result: ManagedSseConnection[] = [];
  for (const entry of registry.values()) {
    if (entry.sessionId === sessionId && !entry.conn.isClosed()) {
      result.push(entry.conn);
    }
  }
  return result;
}

/** 向指定 sessionId 的所有连接广播事件（多路复用：携带 taskId） */
export function broadcastToSession(sessionId: string, event: string, data: unknown, taskId?: string | null): number {
  let sent = 0;
  const enrichedData = typeof data === "object" && data !== null
    ? { ...data as Record<string, unknown>, _taskId: taskId ?? null }
    : { value: data, _taskId: taskId ?? null };
  for (const conn of getConnectionsBySessionId(sessionId)) {
    if (conn.sendEvent(event, enrichedData)) sent++;
  }
  return sent;
}

/** 为连接关联 taskId 标签（支持多个） */
export function tagConnectionWithTask(connectionId: string, taskId: string): void {
  const entry = registry.get(connectionId);
  if (entry) entry.taskIds.add(taskId);
}

/** 移除连接的 taskId 标签 */
export function untagConnectionTask(connectionId: string, taskId: string): void {
  const entry = registry.get(connectionId);
  if (entry) entry.taskIds.delete(taskId);
}

/* ================================================================== */
/*  背压感知的流式转发器                                                  */
/* ================================================================== */

export interface StreamForwarderOptions {
  /** 目标 SSE 连接 */
  connection: ManagedSseConnection;
  /** SSE 事件名 */
  eventName?: string;
  /** 当背压触发时是否等待 drain（true）还是丢弃（false） */
  waitOnBackpressure?: boolean;
}

/**
 * 创建一个 onDelta 回调，将 LLM token 流式转发到 SSE 连接。
 * 内置背压感知：当 socket 写入队列满时，可选等待 drain 或丢弃 token。
 *
 * 9.3 FIX: waitOnBackpressure 模式下真正 await drain 后再发送，
 * 而非仅创建 Promise 却不等待就调用 sendEvent。
 */
export function createStreamForwarder(opts: StreamForwarderOptions): (text: string) => void | Promise<void> {
  const { connection, eventName = "delta", waitOnBackpressure = false } = opts;

  return (text: string): void | Promise<void> => {
    if (connection.isClosed()) return;

    if (waitOnBackpressure && connection.isPaused()) {
      // 9.3 FIX: 返回 Promise，等待 drain 后再发送
      return connection.waitForDrain().then(() => {
        if (!connection.isClosed()) {
          connection.sendEvent(eventName, { text });
        }
      });
    }

    connection.sendEvent(eventName, { text });
  };
}

/* ================================================================== */
/*  指标与诊断                                                          */
/* ================================================================== */

/** 获取流式管道全局指标 */
export function getStreamingPipelineMetrics(): StreamingPipelineMetrics {
  const tenantConnections: Record<string, number> = {};
  let active = 0;
  for (const entry of registry.values()) {
    if (!entry.conn.isClosed()) {
      active++;
      tenantConnections[entry.tenantId] = (tenantConnections[entry.tenantId] || 0) + 1;
    }
  }
  return {
    activeConnections: active,
    tenantConnections,
    totalEventsSent,
    totalEventsDropped,
    totalBytesSent,
    maxGlobal: MAX_GLOBAL_SSE_CONNECTIONS,
    maxPerTenant: MAX_TENANT_SSE_CONNECTIONS,
  };
}

/** 获取指定连接的详细指标 */
export function getConnectionMetrics(connectionId: string): {
  eventCount: number;
  bytesSent: number;
  droppedEvents: number;
  ageMs: number;
  paused: boolean;
} | null {
  const entry = registry.get(connectionId);
  if (!entry) return null;
  return {
    eventCount: entry.eventCount,
    bytesSent: entry.bytesSent,
    droppedEvents: entry.droppedEvents,
    ageMs: Date.now() - entry.createdAt,
    paused: entry.paused,
  };
}

/* ================================================================== */
/*  优雅关闭                                                            */
/* ================================================================== */

/**
 * 关闭所有活跃 SSE 连接（用于优雅关闭流程）。
 * 向每个连接发送 error 事件后关闭。
 */
export async function drainAllConnections(reason?: string): Promise<number> {
  const count = registry.size;
  const msg = reason || "server_shutting_down";
  for (const [id, entry] of registry) {
    try {
      entry.conn.sendEvent("error", {
        errorCode: "SERVER_SHUTDOWN",
        message: msg,
      });
    } catch { /* ignore */ }
    try {
      entry.conn.close();
    } catch { /* ignore */ }
    registry.delete(id);
  }
  maybeStopHeartbeat();
  return count;
}

/* ================================================================== */
/*  AsyncIterable 流式消费器                                            */
/* ================================================================== */

/**
 * 将 onDelta 回调模式转换为 AsyncIterable。
 *
 * 用法:
 * ```ts
 * const { iterable, onDelta, done } = createDeltaIterable();
 * // 传给上游: invokeModelChatUpstreamStream({ ..., onDelta })
 * // 在消费端:
 * for await (const chunk of iterable) { connection.sendEvent("delta", { text: chunk }); }
 * ```
 */
export function createDeltaIterable(): {
  iterable: AsyncIterable<string>;
  onDelta: (text: string) => void;
  done: (error?: Error) => void;
} {
  const queue: Array<{ value: string } | { error: Error } | { done: true }> = [];
  let resolve: ((v: any) => void) | null = null;
  let finished = false;

  function push(item: typeof queue[0]): void {
    if (finished) return;
    if (resolve) {
      const r = resolve;
      resolve = null;
      r(item);
    } else {
      queue.push(item);
    }
  }

  const onDelta = (text: string): void => {
    push({ value: text });
  };

  const done = (error?: Error): void => {
    if (finished) return;
    finished = true;
    if (error) {
      push({ error });
    } else {
      push({ done: true });
    }
  };

  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<string>> {
          while (true) {
            if (queue.length > 0) {
              const item = queue.shift()!;
              if ("done" in item) return { done: true, value: undefined };
              if ("error" in item) throw item.error;
              return { done: false, value: item.value };
            }
            // 等待新数据
            const item = await new Promise<typeof queue[0]>((r) => {
              resolve = r;
            });
            if ("done" in item) return { done: true, value: undefined };
            if ("error" in item) throw item.error;
            return { done: false, value: item.value };
          }
        },
      };
    },
  };

  return { iterable, onDelta, done };
}
