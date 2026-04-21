"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE, apiHeaders } from "@/lib/api";

/* ─── Constants ─── */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_RETRIES = 20;
const RECONNECT_JITTER = 0.2;

export type SSEConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface UseSSEConnectionParams {
  sessionId: string;
  tenantId: string;
  locale?: string;
  enabled?: boolean;
  /** 每收到一条 SSE message 时的回调 */
  onMessage: (evtName: string, rawData: string, eventId?: string) => void;
  /** 收到 SSE 注释（如 :heartbeat）时回调 */
  onComment?: () => void;
}

function computeReconnectDelay(attempt: number): number {
  const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
  const jitter = base * RECONNECT_JITTER * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * useSSEConnection — SSE 连接建立与断线重连 Hook
 *
 * 管理 fetch-based SSE 连接生命周期：
 * 建立连接、流式读取、指数退避重连、Last-Event-ID续传。
 */
export function useSSEConnection(params: UseSSEConnectionParams) {
  const { sessionId, tenantId, locale = "zh-CN", enabled = true, onMessage, onComment } = params;

  const [state, setState] = useState<SSEConnectionState>("disconnected");
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectCountRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const gaveUpRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  const onCommentRef = useRef(onComment);
  onMessageRef.current = onMessage;
  onCommentRef.current = onComment;

  const connect = useCallback(() => {
    if (!sessionId || !enabled) return;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    if (gaveUpRef.current) return;

    setState("connecting");
    const url = `${API_BASE}/orchestrator/session-events?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(tenantId)}`;
    const controller = new AbortController();
    abortRef.current = controller;

    const headers = apiHeaders(locale, { tenantId });
    headers["accept"] = "text/event-stream";
    if (lastEventIdRef.current) headers["Last-Event-ID"] = lastEventIdRef.current;

    (async () => {
      try {
        const res = await fetch(url, { headers, signal: controller.signal, credentials: "include" });
        if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

        setState("connected");
        setReconnecting(false);
        setReconnectAttempt(0);
        reconnectCountRef.current = 0;
        gaveUpRef.current = false;

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
            if (part.startsWith(":")) { onCommentRef.current?.(); continue; }

            const lines = part.split("\n");
            let evtName = "message";
            let evtData = "";
            let evtId: string | undefined;
            for (const ln of lines) {
              if (ln.startsWith("event: ")) evtName = ln.slice(7).trim();
              else if (ln.startsWith("data: ")) evtData += (evtData ? "\n" : "") + ln.slice(6);
              else if (ln.startsWith("id: ")) evtId = ln.slice(4).trim();
              else if (ln.startsWith(":")) onCommentRef.current?.();
            }
            if (evtData) {
              if (evtId) lastEventIdRef.current = evtId;
              onMessageRef.current(evtName, evtData, evtId);
            }
          }
        }
        throw new Error("stream_ended");
      } catch (err: any) {
        if (err?.name === "AbortError") {
          if (!abortRef.current) {
            /* heartbeat timeout abort — reconnect */
          } else return;
        }
        abortRef.current = null;
        reconnectCountRef.current++;
        const attempt = reconnectCountRef.current;

        if (attempt > RECONNECT_MAX_RETRIES) {
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
        reconnectTimerRef.current = setTimeout(() => connect(), delay);
      }
    })();
  }, [sessionId, tenantId, locale, enabled]);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setState("disconnected");
    setReconnecting(false);
    setReconnectAttempt(0);
    reconnectCountRef.current = 0;
    gaveUpRef.current = false;
  }, []);

  const reconnect = useCallback(() => {
    gaveUpRef.current = false;
    reconnectCountRef.current = 0;
    setReconnectAttempt(0);
    connect();
  }, [connect]);

  /** 触发心跳超时重连（abort 当前连接） */
  const abortForHeartbeat = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
  }, []);

  useEffect(() => {
    if (enabled && sessionId) connect(); else disconnect();
    return () => { disconnect(); };
  }, [sessionId, enabled, connect, disconnect]);

  // 页面可见性感知
  useEffect(() => {
    if (typeof document === "undefined") return;
    const handler = () => {
      if (document.visibilityState === "visible" && gaveUpRef.current) reconnect();
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [reconnect]);

  return { state, reconnecting, reconnectAttempt, reconnect, disconnect, abortForHeartbeat };
}
