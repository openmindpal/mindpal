import { useCallback, useEffect, useRef, useState } from "react";

/** L3: 服务器状态 hook - 替代 useAsyncState */
export function useServerState<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = []
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetcher();
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, deps);

  useEffect(() => { refresh(); }, [refresh]);

  return { data, loading, error, refresh };
}

/** L3: 轮询 hook - 替代 usePollableData */
export function usePollableState<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = []
) {
  const { data, loading, error, refresh } = useServerState(fetcher, deps);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    timerRef.current = setInterval(refresh, intervalMs);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refresh, intervalMs]);

  return { data, loading, error, refresh };
}
