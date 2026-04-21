"use client";

import { useCallback, useRef } from "react";

const HEARTBEAT_TIMEOUT_MS = 45000;

/**
 * useHeartbeat — 心跳检测与超时处理 Hook
 *
 * 管理 SSE 连接的心跳超时计时器，
 * 超时后通过 onTimeout 回调通知外部触发重连。
 */
export function useHeartbeat(onTimeout: () => void) {
  const heartbeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  const reset = useCallback(() => {
    if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
    heartbeatTimeoutRef.current = setTimeout(() => {
      console.warn(`[useHeartbeat] Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS}ms), triggering reconnect`);
      onTimeoutRef.current();
    }, HEARTBEAT_TIMEOUT_MS);
  }, []);

  const clear = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  return { reset, clear };
}
