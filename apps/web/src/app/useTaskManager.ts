"use client";

import { useTaskStore, type ActiveTaskEntry } from "@/store/taskStore";
import useTaskPolling, { type UseTaskPollingParams } from "./useTaskPolling";
import useTaskActions from "./useTaskActions";
import type { ChatFlowItem } from "./homeHelpers";

/* ─── Re-export the type so existing imports keep working ─── */
export type { ActiveTaskEntry } from "@/store/taskStore";

export interface UseTaskManagerParams extends UseTaskPollingParams {
  setFlow: React.Dispatch<React.SetStateAction<ChatFlowItem[]>>;
  abortRef: React.MutableRefObject<AbortController | null>;
}

/**
 * useTaskManager — thin orchestration shell.
 *
 * Composes:
 *  - taskStore   (Zustand)  → state
 *  - useTaskPolling          → run-state polling with backoff
 *  - useTaskActions          → continue / stop / retry / skip / register / unregister
 */
export default function useTaskManager({
  locale,
  setFlow,
  abortRef,
  onNoProgress,
  onPollTimeout,
}: UseTaskManagerParams) {
  /* ── Zustand state ── */
  const activeTask = useTaskStore((s) => s.activeTask);
  const setActiveTask = useTaskStore((s) => s.setActiveTask);
  const taskProgress = useTaskStore((s) => s.taskProgress);
  const setTaskProgress = useTaskStore((s) => s.setTaskProgress);
  const activeTasksMap = useTaskStore((s) => s.activeTasksMap);

  /* ── Polling ── */
  const { pollTaskState, pollTimersRef } = useTaskPolling({ locale, onNoProgress, onPollTimeout });

  /* ── Actions ── */
  const { taskAction, registerTask, unregisterTask: _unregister } = useTaskActions({ locale, setFlow, abortRef, pollTaskState });

  /** Wrap unregisterTask so callers don't need to pass pollTimersRef */
  const unregisterTask = (taskId: string) => _unregister(taskId, pollTimersRef);

  const activeTaskIds = Array.from(activeTasksMap.keys());

  return {
    // single-task compat
    activeTask, setActiveTask,
    taskProgress, setTaskProgress,
    pollTaskState,
    taskAction,
    // multi-task
    activeTasksMap,
    registerTask,
    unregisterTask,
    activeTaskIds,
  };
}
