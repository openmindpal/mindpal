"use client";

/**
 * useSessionSSE — 会话级持久 SSE 连接 hook（组合入口）
 *
 * 内部组合 useSSEConnection + useHeartbeat + useEventBus 三个子 Hook，
 * 对外接口保持不变。
 */

import { useCallback, useEffect, useState } from "react";
import { useSSEConnection } from "./hooks/useSSEConnection";
import { useHeartbeat } from "./hooks/useHeartbeat";
import { useEventBus } from "./hooks/useEventBus";

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
  sessionId: string;
  tenantId: string;
  locale?: string;
  enabled?: boolean;
  onEvent?: GlobalEventHandler;
  onSnapshot?: (data: Record<string, unknown>) => void;
}

export default function useSessionSSE(params: UseSessionSSEParams) {
  const { sessionId, tenantId, locale = "zh-CN", enabled = true, onEvent, onSnapshot } = params;

  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now());

  // Sub-hooks
  const eventBus = useEventBus();

  // Keep refs for callbacks
  const onEventRef = { current: onEvent };
  onEventRef.current = onEvent;
  const onSnapshotRef = { current: onSnapshot };
  onSnapshotRef.current = onSnapshot;

  // Heartbeat — on timeout, abort the SSE connection
  const heartbeat = useHeartbeat(() => {
    connection.abortForHeartbeat();
  });

  /** 处理收到的 SSE 事件 */
  const handleMessage = useCallback((evtName: string, rawData: string, eventId?: string) => {
    if (eventId) {
      if (eventBus.isEventProcessed(eventId)) return;
      eventBus.markEventProcessed(eventId);
    }
    heartbeat.reset();

    try {
      const data = JSON.parse(rawData) as Record<string, unknown>;
      const taskId = (data._taskId as string) ?? null;

      // Global handler
      const globalHandler = onEventRef.current;
      if (globalHandler) globalHandler({ event: evtName, data, taskId });

      // Task-specific handlers
      if (taskId) eventBus.dispatchToTask(taskId, evtName, data);

      // Special events
      if (evtName === "queueSnapshot") onSnapshotRef.current?.(data);
      if (evtName === "heartbeat") setLastHeartbeat(Date.now());
    } catch { /* JSON parse failure */ }
  }, [eventBus, heartbeat]);

  const connection = useSSEConnection({
    sessionId,
    tenantId,
    locale,
    enabled,
    onMessage: handleMessage,
    onComment: heartbeat.reset,
  });

  // Clear heartbeat on disconnect
  useEffect(() => {
    if (connection.state === "connected") heartbeat.reset();
    if (connection.state === "disconnected") heartbeat.clear();
  }, [connection.state, heartbeat]);

  // Visibility-aware heartbeat management
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "visible") heartbeat.reset();
      else heartbeat.clear();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [heartbeat]);

  return {
    state: connection.state,
    onTaskEvent: eventBus.onTaskEvent,
    offTaskEvents: eventBus.offTaskEvents,
    reconnect: connection.reconnect,
    disconnect: connection.disconnect,
    lastHeartbeat,
    reconnecting: connection.reconnecting,
    reconnectAttempt: connection.reconnectAttempt,
  };
}
