"use client";
import { useState, useEffect, useCallback, useRef } from "react";

export type ActionStatus = "idle" | "loading" | "done" | "error";

export interface UseBottomPanelOptions<T> {
  fetchFn: () => Promise<T[]>;
  refreshInterval?: number;
  enabled?: boolean;
}

export interface UseBottomPanelReturn<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  actionStates: Record<string, ActionStatus>;
  setActionState: (id: string, status: ActionStatus) => void;
  resetActionState: (id: string, delayMs?: number) => void;
  itemCount: number;
}

export function useBottomPanel<T>(options: UseBottomPanelOptions<T>): UseBottomPanelReturn<T> {
  const { fetchFn, refreshInterval = 30000, enabled = true } = options;

  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Record<string, ActionStatus>>({});

  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      setLoading(true);
      const result = await fetchFn();
      if (mountedRef.current) {
        setItems(result);
        setError(null);
      }
    } catch (e: unknown) {
      if (mountedRef.current) {
        setError(e instanceof Error ? e.message : "fetch_error");
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [fetchFn]);

  // Initial fetch
  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-refresh interval
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(reload, refreshInterval);
    return () => clearInterval(timer);
  }, [reload, refreshInterval, enabled]);

  const setActionState = useCallback((id: string, status: ActionStatus) => {
    setActionStates((prev) => ({ ...prev, [id]: status }));
  }, []);

  const resetActionState = useCallback((id: string, delayMs?: number) => {
    if (delayMs && delayMs > 0) {
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setActionStates((prev) => ({ ...prev, [id]: "idle" }));
        }
        timersRef.current.delete(timer);
      }, delayMs);
      timersRef.current.add(timer);
    } else {
      setActionStates((prev) => ({ ...prev, [id]: "idle" }));
    }
  }, []);

  return {
    items,
    loading,
    error,
    reload,
    actionStates,
    setActionState,
    resetActionState,
    itemCount: items.length,
  };
}
