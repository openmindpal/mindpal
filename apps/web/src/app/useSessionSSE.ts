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
 * 4. 自动重连 — 断线后指数退避重连
 * 5. 心跳检测 — 检测连接健康度
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, apiHeaders } from "@/lib/api";

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

export default function useSessionSSE(params: UseSessionSSEParams) {
  const { sessionId, tenantId, locale = "zh-CN", enabled = true, onEvent, onSnapshot } = params;

  const [state, setState] = useState<SessionSSEState>("disconnected");
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const taskHandlersRef = useRef<Map<string, Set<TaskEventHandler>>>(new Map());
  const globalHandlerRef = useRef(onEvent);
  const snapshotHandlerRef = useRef(onSnapshot);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);

  // 保持 ref 最新
  globalHandlerRef.current = onEvent;
  snapshotHandlerRef.current = onSnapshot;

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
  const handleMessage = useCallback((evtName: string, rawData: string) => {
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
            try { handler(evtName, data); } catch {}
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
    } catch {
      // JSON 解析失败，忽略
    }
  }, []);

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

    setState("connecting");
    const url = `${API_BASE}/orchestrator/session-events?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(tenantId)}`;
    const controller = new AbortController();
    abortRef.current = controller;

    // 使用 apiHeaders 自动注入 Authorization / x-tenant-id 等认证头
    const headers = apiHeaders(locale, { tenantId });
    headers["accept"] = "text/event-stream";

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
        reconnectCountRef.current = 0;
        setLastHeartbeat(Date.now());
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
            const lines = part.split("\n");
            let evtName = "message";
            let evtData = "";
            for (const ln of lines) {
              if (ln.startsWith("event: ")) evtName = ln.slice(7).trim();
              else if (ln.startsWith("data: ")) evtData += (evtData ? "\n" : "") + ln.slice(6);
            }
            if (evtData) handleMessage(evtName, evtData);
          }
        }

        // 正常结束（服务端关闭）— 触发重连
        throw new Error("stream_ended");
      } catch (err: any) {
        if (err?.name === "AbortError") {
          // 主动断开，不重连
          return;
        }

        console.warn(`[useSessionSSE] Connection error for session ${sessionId}:`, err?.message);
        abortRef.current = null;

        // 指数退避重连
        reconnectCountRef.current++;
        const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current - 1), 30000);
        setState("reconnecting");

        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          console.log(`[useSessionSSE] Reconnecting (attempt ${reconnectCountRef.current})...`);
          connect();
        }, delay);
      }
    })();
  }, [sessionId, tenantId, locale, enabled, handleMessage]);

  /** 断开连接 */
  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setState("disconnected");
    reconnectCountRef.current = 0;
  }, []);

  // 自动连接/断开
  useEffect(() => {
    if (enabled && sessionId) {
      connect();
    } else {
      disconnect();
    }
    return () => { disconnect(); };
  }, [sessionId, enabled, connect, disconnect]);

  return {
    /** SSE 连接状态 */
    state,
    /** 注册任务事件处理器 */
    onTaskEvent,
    /** 注销特定任务的所有处理器 */
    offTaskEvents,
    /** 手动重连 */
    reconnect: connect,
    /** 手动断开 */
    disconnect,
    /** 最后心跳时间（响应式，心跳到达时触发重渲染） */
    lastHeartbeat,
  };
}
