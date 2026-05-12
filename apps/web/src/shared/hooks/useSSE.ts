"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { eventBus } from "@/shared/lib/event-bus";
import { apiFetch } from "@/shared/lib/api";

export type SSEConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

interface UseSSEOptions {
  sessionId: string;
  tenantId: string;
  locale?: string;
  enabled?: boolean;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 20;
const HEARTBEAT_TIMEOUT_MS = 45000;

/** Unified SSE hook that publishes all events through EventBus. */
export function useSSE({ sessionId, tenantId, locale = "zh-CN", enabled = true }: UseSSEOptions) {
  const [state, setState] = useState<SSEConnectionState>("disconnected");
  const abortRef = useRef<AbortController | null>(null);
  const attemptRef = useRef(0);
  const heartbeatRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenIds = useRef(new Set<string>());
  const mountedRef = useRef(true);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearTimeout(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const resetHeartbeat = useCallback(() => {
    clearHeartbeat();
    heartbeatRef.current = setTimeout(() => {
      // Heartbeat timeout — force reconnect
      abortRef.current?.abort();
    }, HEARTBEAT_TIMEOUT_MS);
  }, [clearHeartbeat]);

  const connect = useCallback(async () => {
    if (!enabled || !sessionId) return;

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setState("connecting");
      eventBus.publish("sse:state", { state: "connecting" });

      const url = `/orchestrator/session-events?sessionId=${encodeURIComponent(sessionId)}`;
      const res = await apiFetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "text/event-stream",
          "x-tenant-id": tenantId,
          "x-user-locale": locale,
        },
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: ${res.status}`);
      }

      setState("connected");
      attemptRef.current = 0;
      eventBus.publish("sse:state", { state: "connected" });
      resetHeartbeat();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let currentEventName = "message";
        let currentEventId: string | undefined;

        for (const line of lines) {
          if (line.startsWith(":")) {
            // Comment line = heartbeat
            resetHeartbeat();
            continue;
          }
          if (line.startsWith("event:")) {
            currentEventName = line.slice(6).trim();
          } else if (line.startsWith("id:")) {
            currentEventId = line.slice(3).trim();
          } else if (line.startsWith("data:")) {
            const rawData = line.slice(5).trim();
            if (!rawData) continue;

            // Deduplicate by event ID
            if (currentEventId) {
              if (seenIds.current.has(currentEventId)) continue;
              seenIds.current.add(currentEventId);
              // Keep set bounded
              if (seenIds.current.size > 500) {
                const arr = Array.from(seenIds.current);
                seenIds.current = new Set(arr.slice(-250));
              }
            }

            try {
              const parsed = JSON.parse(rawData);
              // Publish through EventBus
              eventBus.publish(`sse:${currentEventName}`, parsed);
              eventBus.publish("sse:event", { name: currentEventName, data: parsed, id: currentEventId });

              // Route task-specific events
              const taskId = parsed?._taskId;
              if (taskId) {
                eventBus.publish(`sse:task:${taskId}`, { name: currentEventName, data: parsed });
              }
            } catch {
              // Non-JSON data
              eventBus.publish(`sse:${currentEventName}`, rawData);
            }

            resetHeartbeat();
            currentEventName = "message";
            currentEventId = undefined;
          } else if (line === "") {
            // Empty line = end of event block
            currentEventName = "message";
            currentEventId = undefined;
          }
        }
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return;
      console.error("[SSE] Connection error:", err);
    } finally {
      clearHeartbeat();
      if (!mountedRef.current) return;

      // Attempt reconnect
      if (enabled && attemptRef.current < RECONNECT_MAX_ATTEMPTS) {
        attemptRef.current++;
        const delay = Math.min(
          RECONNECT_BASE_MS * Math.pow(2, attemptRef.current - 1),
          RECONNECT_MAX_MS
        );
        const jitter = delay * (0.8 + Math.random() * 0.4); // ±20%

        setState("reconnecting");
        eventBus.publish("sse:state", { state: "reconnecting", attempt: attemptRef.current });

        await new Promise((r) => setTimeout(r, jitter));
        if (mountedRef.current && enabled) {
          connect();
        }
      } else {
        setState("disconnected");
        eventBus.publish("sse:state", { state: "disconnected" });
      }
    }
  }, [enabled, sessionId, tenantId, locale, resetHeartbeat, clearHeartbeat]);

  const disconnect = useCallback(() => {
    abortRef.current?.abort();
    clearHeartbeat();
    setState("disconnected");
    eventBus.publish("sse:state", { state: "disconnected" });
  }, [clearHeartbeat]);

  const reconnect = useCallback(() => {
    disconnect();
    attemptRef.current = 0;
    connect();
  }, [disconnect, connect]);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) connect();
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, tenantId]);

  // Visibility-aware: reconnect when page becomes visible
  useEffect(() => {
    const unsub = eventBus.subscribe<{ visible: boolean }>("system:visibility", ({ visible }) => {
      if (visible && state === "disconnected" && enabled) {
        reconnect();
      }
    });
    return unsub;
  }, [state, enabled, reconnect]);

  return { state, reconnect, disconnect };
}
