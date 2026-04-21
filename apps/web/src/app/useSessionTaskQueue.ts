"use client";

/**
 * useSessionTaskQueue — 多任务队列状态管理 hook（组合入口）
 *
 * 内部组合 useTaskQueueState + useTaskQueueActions，对外接口保持不变。
 */

import { useTaskQueueState } from "./hooks/useTaskQueueState";
import { useTaskQueueActions } from "./hooks/useTaskQueueActions";
import type { SessionSSEEvent } from "./useSessionSSE";

/* ─── Types (re-export for consumers) ─── */

export interface UseSessionTaskQueueParams {
  sessionId: string;
  locale: string;
  enabled?: boolean;
}

export interface TaskQueueActions {
  cancel: (entryId: string) => Promise<boolean>;
  cancelAll: () => Promise<number>;
  pause: (entryId: string) => Promise<boolean>;
  resume: (entryId: string) => Promise<boolean>;
  retry: (entryId: string) => Promise<boolean>;
  reorder: (entryId: string, newPosition: number) => Promise<boolean>;
  setPriority: (entryId: string, priority: number) => Promise<boolean>;
  setForeground: (entryId: string, foreground: boolean) => Promise<boolean>;
  createDep: (params: { fromEntryId: string; toEntryId: string; depType: "finish_to_start" | "output_to_input" | "cancel_cascade" }) => Promise<{ ok: boolean; error?: string }>;
  removeDep: (depId: string) => Promise<boolean>;
  overrideDep: (depId: string) => Promise<boolean>;
  validateDag: () => Promise<{ valid: boolean; errors: string[] }>;
  refresh: () => Promise<void>;
}

/* ─── Hook ─── */

export default function useSessionTaskQueue(params: UseSessionTaskQueueParams) {
  const { sessionId, locale } = params;

  const state = useTaskQueueState(sessionId);
  const { actions, operating } = useTaskQueueActions({ sessionId, locale, applySnapshot: state.applySnapshot });

  return {
    queueState: state.queueState,
    multiProgress: state.multiProgress,
    operating,
    actions,
    foregroundEntry: state.foregroundEntry,
    activeEntries: state.activeEntries,
    allEntries: state.allEntries,
    activeTaskIds: state.activeTaskIds,
    handleSSEEvent: state.handleSSEEvent,
    applySnapshot: state.applySnapshot,
  };
}
