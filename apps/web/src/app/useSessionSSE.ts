"use client";

/**
 * useSessionSSE — 会话级持久 SSE 连接 hook
 *
 * 建立到 /orchestrator/session-events 的持久 SSE 连接，
 * 接收多路复用事件流，按 _taskId 路由到对应处理器。
 *
 * 核心能力：
 * 1. 持久连接 — 整个会话生命周期内保持一个 SSE 连接
 * 2. 多路复用 — 单连接承载多个任务的事件流
 * 3. 事件路由 — 按 _taskId 分发到注册的处理器
 * 4. 自动重连 — 断线后指数退避重连（含 ±20% 抖动）
 * 5. 心跳检测 — 45s 无事件判定断线，主动触发重连
 * 6. Last-Event-ID — 重连时携带最后事件 ID，支持续传
 * 7. 事件去重 — 基于 eventId 防止重放导致的重复处理
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, apiHeaders } from "@/lib/api";

/* ─── Constants ─── */

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_RETRIES = 20;
const RECONNECT_JITTER = 0.2;
const HEARTBEAT_TIMEOUT_MS = 45000;

/* ─── Types ─── */

export type SessionSSEEvent = {
  event: string;
  data: Record<string, unknown>;
  taskId: string | null;
};

export type TaskEventHandler = (event: string, data: Record<string, unknown>) => void;
export type GlobalEventHandler = (event: SessionSSEEvent) => void;

export type SessionSSEState = "disconnected" | "connecting" | "connected" | "reconnecting";

/* ─── Hook ─── */

export interface UseSessionSSEParams {
  /** 会话 ID（连接标识） */
  sessionId: string;
  /** 租户 ID */
  tenantId: string;
  /** 当前语言 */
  locale?: string;
  /** 是否启用持久 SSE（false 时不建立连接） */
  enabled?: boolean;
  /** 全局事件处理器（所有事件都会经过） */
  onEvent?: GlobalEventHandler;
  /** 初始快照处理器 */
  onSnapshot?: (data: Record<string, unknown>) => void;
}

/** 计算带抖动的指数退避延迟 */
function computeReconnectDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
  const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(base + jitter));
}

export default function useSessionSSE(params: UseSessionSSEParams) {
  const { sessionId, tenantId, locale = "zh-CN", enabled = true, onEvent, onSnapshot } = params;

  const [state, setState] = useState<SessionSSEState>("disconnected");
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const taskHandlersRef = useRef<Map<string, Set<TaskEventHandler>>>(new Map());
  const globalHandlerRef = useRef(onEvent);
  const snapshotHandlerRef = useRef(onSnapshot);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 已处理的事件 ID 集合（用于去重，最多保留 500 条） */
  const processedEventIdsRef = useRef<Set<string>>(new Set());
  /** 标记是否已因超过最大重试次数而停止 */
  const gaveUpRef = useRef(false);

  // 保持 ref 最新
  globalHandlerRef.current = onEvent;
  snapshotHandlerRef.current = onSnapshot;

  /** 重置心跳超时计时器 */
  const resetHeartbeatTimeout = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
    }
    heartbeatTimeoutRef.current = setTimeout(() => {
      console.warn(`[useSessionSSE] Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS}ms), triggering reconnect`);
      // 主动关闭当前连接，触发重连
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }, []);

  /** 清除心跳超时计时器 */
  const clearHeartbeatTimeout = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  /** 记录已处理的事件 ID（防止缓冲区无限增长） */
  const markEventProcessed = useCallback((eventId: string) => {
    const set = processedEventIdsRef.current;
    set.add(eventId);
    // 超过 500 条时裁剪最早的一半
    if (set.size > 500) {
      const arr = Array.from(set);
      const keep = arr.slice(arr.length - 250);
      processedEventIdsRef.current = new Set(keep);
    }
  }, []);

  /** 注册任务事件处理器 */
  const onTaskEvent = useCallback((taskId: string, handler: TaskEventHandler): (() => void) => {
    if (!taskHandlersRef.current.has(taskId)) {
      taskHandlersRef.current.set(taskId, new Set());
    }
    taskHandlersRef.current.get(taskId)!.add(handler);
    return () => {
      const set = taskHandlersRef.current.get(taskId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) taskHandlersRef.current.delete(taskId);
      }
    };
  }, []);

  /** 注销所有特定 taskId 的处理器 */
  const offTaskEvents = useCallback((taskId: string) => {
    taskHandlersRef.current.delete(taskId);
  }, []);

  /** 处理收到的 SSE 事件 */
  const handleMessage = useCallback((evtName: string, rawData: string, eventId?: string) => {
    // 事件去重：如果该 eventId 已经处理过，跳过
    if (eventId) {
      if (processedEventIdsRef.current.has(eventId)) {
        return; // 已处理，跳过重复事件
      }
      markEventProcessed(eventId);
      // 更新 lastEventId
      lastEventIdRef.current = eventId;
    }

    // 收到任何事件都重置心跳超时
    resetHeartbeatTimeout();

    try {
      const data = JSON.parse(rawData) as Record<string, unknown>;
      const taskId = (data._taskId as string) ?? null;

      // 路由到全局处理器
      const globalHandler = globalHandlerRef.current;
      if (globalHandler) {
        globalHandler({ event: evtName, data, taskId });
      }

      // 路由到任务处理器
      if (taskId) {
        const handlers = taskHandlersRef.current.get(taskId);
        if (handlers) {
          for (const handler of handlers) {
            try { handler(evtName, data); } catch { /* expected: handler may throw */ }
          }
        }
      }

      // 特殊事件处理
      if (evtName === "queueSnapshot") {
        snapshotHandlerRef.current?.(data);
      }

      if (evtName === "heartbeat") {
        setLastHeartbeat(Date.now());
      }
    } catch { // expected: JSON parse may fail on malformed SSE data
    }
  }, [resetHeartbeatTimeout, markEventProcessed]);

  /**
   * 建立 SSE 连接 — 使用 fetch + ReadableStream 替代原生 EventSource，
   * 以便携带 Authorization header 进行认证（EventSource 不支持自定义 header）。
   */
  const connect = useCallback(() => {
    if (!sessionId || !enabled) return;

    // 清理旧连接
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }

    // 检查是否已放弃重连
    if (gaveUpRef.current) return;

    setState("connecting");
    const url = `${API_BASE}/orchestrator/session-events?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(tenantId)}`;
    const controller = new AbortController();
    abortRef.current = controller;

    // 使用 apiHeaders 自动注入 Authorization / x-tenant-id 等认证头
    const headers = apiHeaders(locale, { tenantId });
    headers["accept"] = "text/event-stream";
    // Last-Event-ID：重连时携带，支持服务端续传
    if (lastEventIdRef.current) {
      headers["Last-Event-ID"] = lastEventIdRef.current;
    }

    (async () => {
      try {
        const res = await fetch(url, {
          headers,
          signal: controller.signal,
          credentials: "include",
        });

        if (!res.ok || !res.body) {
          throw new Error(`SSE connect failed: ${res.status}`);
        }

        setState("connected");
        setReconnecting(false);
        setReconnectAttempt(0);
        reconnectCountRef.current = 0;
        gaveUpRef.current = false;
        setLastHeartbeat(Date.now());
        resetHeartbeatTimeout();
        console.log(`[useSessionSSE] Connected to session ${sessionId}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const parts = sseBuffer.split("\n\n");
          sseBuffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;

            // 跳过纯注释行（如 :heartbeat），但重置心跳超时
            if (part.startsWith(":")) {
              resetHeartbeatTimeout();
              continue;
            }

            const lines = part.split("\n");
            let evtName = "message";
            let evtData = "";
            let evtId: string | undefined;
            for (const ln of lines) {
              if (ln.startsWith("event: ")) evtName = ln.slice(7).trim();
              else if (ln.startsWith("data: ")) evtData += (evtData ? "\n" : "") + ln.slice(6);
              else if (ln.startsWith("id: ")) evtId = ln.slice(4).trim();
              else if (ln.startsWith(":")) {
                // SSE 注释行，重置心跳
                resetHeartbeatTimeout();
              }
            }
            if (evtData) handleMessage(evtName, evtData, evtId);
          }
        }

        // 正常结束（服务端关闭）— 触发重连
        throw new Error("stream_ended");
      } catch (err: any) {
        clearHeartbeatTimeout();

        if (err?.name === "AbortError") {
          // 心跳超时导致的 abort 也需要重连（非用户主动断开）
          // 判断：如果 abortRef.current 已经被置空，说明是心跳超时触发的
          if (!abortRef.current) {
            console.warn(`[useSessionSSE] Connection aborted (heartbeat timeout), reconnecting...`);
            // 继续走重连逻辑
          } else {
            // 主动断开，不重连
            return;
          }
        }

        console.warn(`[useSessionSSE] Connection error for session ${sessionId}:`, err?.message);
        abortRef.current = null;

        // 指数退避重连（含抖动）
        reconnectCountRef.current++;
        const attempt = reconnectCountRef.current;

        // 超过最大重试次数 → 停止重连，通知用户
        if (attempt > RECONNECT_MAX_RETRIES) {
          console.error(`[useSessionSSE] Max reconnect attempts (${RECONNECT_MAX_RETRIES}) reached, giving up.`);
          gaveUpRef.current = true;
          setState("disconnected");
          setReconnecting(false);
          setReconnectAttempt(attempt);
          return;
        }

        const delay = computeReconnectDelay(attempt);
        setState("reconnecting");
        setReconnecting(true);
        setReconnectAttempt(attempt);

        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          console.log(`[useSessionSSE] Reconnecting (attempt ${attempt}/${RECONNECT_MAX_RETRIES}, delay ${delay}ms)...`);
          connect();
        }, delay);
      }
    })();
  }, [sessionId, tenantId, locale, enabled, handleMessage, resetHeartbeatTimeout, clearHeartbeatTimeout]);

  /** 断开连接 */
  const disconnect = useCallback(() => {
    clearHeartbeatTimeout();
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState("disconnected");
    setReconnecting(false);
    setReconnectAttempt(0);
    reconnectCountRef.current = 0;
    gaveUpRef.current = false;
  }, [clearHeartbeatTimeout]);

  /** 手动重连（重置放弃标记） */
  const reconnect = useCallback(() => {
    gaveUpRef.current = false;
    reconnectCountRef.current = 0;
    setReconnectAttempt(0);
    connect();
  }, [connect]);

  // 自动连接/断开
  useEffect(() => {
    if (enabled && sessionId) {
      connect();
    } else {
      disconnect();
    }
    return () => { disconnect(); };
  }, [sessionId, enabled, connect, disconnect]);

  // ── 页面可见性感知 ──
  // 后台标签页时浏览器节流定时器，心跳超时会误触发并消耗重连预算；
  // 隐藏时清除心跳超时，恢复可见时自动重连。
  useEffect(() => {
    if (typeof document === "undefined") return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (gaveUpRef.current) {
          reconnect();
        } else {
          resetHeartbeatTimeout();
        }
      } else {
        clearHeartbeatTimeout();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [reconnect, resetHeartbeatTimeout, clearHeartbeatTimeout]);

  return {
    /** SSE 连接状态 */
    state,
    /** 注册任务事件处理器 */
    onTaskEvent,
    /** 注销特定任务的所有处理器 */
    offTaskEvents,
    /** 手动重连（重置重试计数） */
    reconnect,
    /** 手动断开 */
    disconnect,
    /** 最后心跳时间（响应式，心跳到达时触发重渲染） */
    lastHeartbeat,
    /** 是否正在重连中 */
    reconnecting,
    /** 当前重连尝试次数 */
    reconnectAttempt,
  };
}
