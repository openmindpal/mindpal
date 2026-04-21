"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface UsePollableDataOptions<T> {
  /** 轮询函数 */
  fetcher: () => Promise<T>;
  /** 轮询间隔（ms），默认 5000 */
  interval?: number;
  /** 是否启用轮询 */
  enabled?: boolean;
  /** 最大重试次数（连续错误后暂停），默认 3 */
  maxRetries?: number;
}

/**
 * usePollableData — 轮询策略封装 Hook
 *
 * 支持可配置间隔、暂停/恢复、连续失败自动停止、手动刷新。
 */
export function usePollableData<T>(options: UsePollableDataOptions<T>) {
  const { fetcher, interval = 5000, enabled = true, maxRetries = 3 } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const poll = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      setData(result);
      setError(null);
      retriesRef.current = 0;
    } catch (err: any) {
      retriesRef.current++;
      setError(typeof err === "string" ? err : err?.message ?? "Poll failed");
      if (retriesRef.current >= maxRetries) return; // stop scheduling
    } finally {
      setLoading(false);
    }
  }, [maxRetries]);

  const refresh = useCallback(() => {
    retriesRef.current = 0;
    return poll();
  }, [poll]);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    void poll();
    timerRef.current = setInterval(() => {
      if (retriesRef.current < maxRetries) void poll();
    }, interval);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [enabled, interval, maxRetries, poll]);

  return { data, loading, error, refresh };
}
