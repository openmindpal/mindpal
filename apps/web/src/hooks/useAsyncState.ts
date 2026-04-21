"use client";

import { useCallback, useRef, useState } from "react";

export type AsyncState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

/**
 * useAsyncState — 通用异步数据管理 Hook
 *
 * 封装 loading / error / data 三态模式，
 * 提供 run() 方法执行异步操作并自动管理状态。
 */
export function useAsyncState<T>(initial?: T | null) {
  const [data, setData] = useState<T | null>(initial ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const run = useCallback(async (fn: () => Promise<T>): Promise<T | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (mountedRef.current) {
        setData(result);
        setLoading(false);
      }
      return result;
    } catch (err: any) {
      if (mountedRef.current) {
        setError(typeof err === "string" ? err : err?.message ?? "Unknown error");
        setLoading(false);
      }
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setData(initial ?? null);
    setLoading(false);
    setError(null);
  }, [initial]);

  return { data, loading, error, setData, setError, run, reset };
}
