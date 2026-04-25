"use client";

/**
 * useTaskQueueActions — 队列操作 Hook
 *
 * 封装对 /orchestrator/task-queue 系列 API 的调用操作。
 */

import { useCallback, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { TaskQueueActions } from "../useSessionTaskQueue";

export type { TaskQueueActions };

export function useTaskQueueActions(params: {
  sessionId: string;
  locale: string;
  applySnapshot: (data: Record<string, unknown>) => void;
}) {
  const { locale, applySnapshot } = params;
  const [operating, setOperating] = useState(false);
  const sessionIdRef = useRef(params.sessionId);
  // eslint-disable-next-line react-hooks/refs -- keep sessionId ref in sync
  sessionIdRef.current = params.sessionId;

  const apiAction = useCallback(async (path: string, body: Record<string, unknown>): Promise<boolean> => {
    setOperating(true);
    try {
      const res = await apiFetch(`/orchestrator/task-queue${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      setOperating(false);
    }
  }, [locale]);

  const actions: TaskQueueActions = {
    cancel: useCallback((entryId: string) => apiAction("/cancel", { entryId }), [apiAction]),
    cancelAll: useCallback(async () => {
      setOperating(true);
      try {
        const res = await apiFetch("/orchestrator/task-queue/cancel-all", {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        });
        if (!res.ok) return 0;
        const json = await res.json().catch(() => ({}));
        return Number((json as Record<string, unknown>).cancelledCount ?? 0);
      } catch { return 0; }
      finally { setOperating(false); }
    }, [locale]),
    pause: useCallback((entryId: string) => apiAction("/pause", { entryId }), [apiAction]),
    resume: useCallback((entryId: string) => apiAction("/resume", { entryId }), [apiAction]),
    retry: useCallback((entryId: string) => apiAction("/retry", { entryId }), [apiAction]),
    reorder: useCallback((entryId: string, newPosition: number) => apiAction("/reorder", { entryId, newPosition }), [apiAction]),
    setPriority: useCallback((entryId: string, priority: number) => apiAction("/priority", { entryId, priority }), [apiAction]),
    setForeground: useCallback((entryId: string, foreground: boolean) => apiAction("/foreground", { entryId, foreground }), [apiAction]),
    refresh: useCallback(async () => {
      if (!sessionIdRef.current) return;
      try {
        const res = await apiFetch(`/orchestrator/task-queue?sessionId=${encodeURIComponent(sessionIdRef.current)}`, { locale });
        if (!res.ok) return;
        const json = await res.json();
        applySnapshot(json as Record<string, unknown>);
      } catch { /* refresh failed */ }
    }, [locale, applySnapshot]),
    createDep: useCallback(async (depParams: { fromEntryId: string; toEntryId: string; depType: "finish_to_start" | "output_to_input" | "cancel_cascade" }) => {
      setOperating(true);
      try {
        const res = await apiFetch("/orchestrator/task-queue/dep/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ sessionId: sessionIdRef.current, ...depParams }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({})) as Record<string, unknown>;
          return { ok: false, error: String(json?.message ?? "Failed") };
        }
        return { ok: true };
      } catch (err) { return { ok: false, error: String(err) }; }
      finally { setOperating(false); }
    }, [locale]),
    removeDep: useCallback((depId: string) => apiAction("/dep/remove", { depId }), [apiAction]),
    overrideDep: useCallback((depId: string) => apiAction("/dep/override", { depId }), [apiAction]),
    validateDag: useCallback(async () => {
      try {
        const res = await apiFetch("/orchestrator/task-queue/dep/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        });
        if (!res.ok) return { valid: false, errors: ["API error"] };
        const json = await res.json() as Record<string, unknown>;
        return { valid: (json.valid as boolean) ?? false, errors: (json.errors as string[]) ?? [] };
      } catch { return { valid: false, errors: ["Network error"] }; }
    }, [locale]),
  };

  return { actions, operating };
}
