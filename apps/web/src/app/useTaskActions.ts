"use client";

import { useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { nextId } from "@/lib/apiError";
import { t } from "@/lib/i18n";
import { useTaskStore } from "@/store/taskStore";
import type { TaskState } from "@/lib/types";
import type { ChatFlowItem, TaskProgress } from "./homeHelpers";

function getTaskControlRequest(runId: string, action: "continue" | "stop" | "retry" | "skip") {
  if (action === "continue") return { path: `/runs/${runId}/resume`, body: {} };
  if (action === "retry") return { path: `/runs/${runId}/retry`, body: {} };
  if (action === "skip") return { path: `/runs/${runId}/skip`, body: {} };
  return { path: `/runs/${runId}/cancel`, body: {} };
}

export interface UseTaskActionsParams {
  locale: string;
  setFlow: (updater: ChatFlowItem[] | ((prev: ChatFlowItem[]) => ChatFlowItem[])) => void;
  abortRef: React.MutableRefObject<AbortController | null>;
  pollTaskState: (runId: string, taskId?: string) => Promise<void>;
}

/**
 * useTaskActions — task control operations (continue / stop / retry / skip),
 * plus register/unregister helpers for the multi-task map.
 * State lives in taskStore (Zustand).
 */
export default function useTaskActions({
  locale,
  setFlow,
  abortRef,
  pollTaskState,
}: UseTaskActionsParams) {
  const taskAction = useCallback(async (action: "continue" | "stop" | "retry" | "skip", targetRunId?: string) => {
    const store = useTaskStore.getState();
    const runId = targetRunId ?? store.activeTask?.runId;
    if (!runId) return;
    try {
      if (action === "stop") {
        try { abortRef.current?.abort(); } catch { /* expected */ }

        const res = await apiFetch(`/runs/${runId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ runId }),
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({ phase: "stopped" }));
          console.log("[taskAction] stop succeeded:", data);
          store.setActiveTask((prev) => prev ? { ...prev, taskState: { ...prev.taskState, phase: "stopped" } } : prev);
          store.setTaskProgress((prev) => prev ? { ...prev, phase: "stopped" } : prev);
          setFlow((prev) => [...prev, { kind: "message", id: nextId("m"), role: "assistant",
            text: t(locale, "taskAction.stopped"), createdAt: Date.now(),
          }]);
        } else {
          const err = await res.json().catch(() => null) as Record<string, unknown> | null;
          const errorCode = String(err?.errorCode ?? "");

          if (res.status === 409 || errorCode === "RUN_NOT_CANCELABLE") {
            console.log("[taskAction] stop: run is already terminal, cancellation not required");
            const terminalPhase = String((err?.run as Record<string, unknown> | undefined)?.status ?? "stopped");
            store.setActiveTask((prev) => prev ? { ...prev, taskState: { ...prev.taskState, phase: terminalPhase } } : prev);
            store.setTaskProgress((prev) => prev ? { ...prev, phase: terminalPhase } : prev);
            setFlow((prev) => [...prev, { kind: "message", id: nextId("m"), role: "assistant",
              text: t(locale, "taskAction.completed"), createdAt: Date.now(),
            }]);
          } else {
            const errMsg = typeof err?.message === "object"
              ? ((err.message as Record<string, string>)?.[locale] ?? (err.message as Record<string, string>)?.["zh-CN"] ?? res.statusText)
              : String(err?.message ?? res.statusText ?? t(locale, "taskAction.stopFailed"));
            console.error(`[taskAction] stop failed (${res.status}):`, errMsg);
            setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
              errorCode: "TASK_ACTION_FAILED",
              message: t(locale, "taskAction.failed").replace("{action}", t(locale, "common.stop")).replace("{message}", errMsg),
              traceId: String(err?.traceId ?? ""),
              createdAt: Date.now(),
            }]);
          }
        }
        return;
      }

      const control = getTaskControlRequest(runId, action);
      const res = await apiFetch(control.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify(control.body),
      });
      if (res.ok) {
        const data = await res.json();
        console.log(`[taskAction] ${action} succeeded:`, data);
        if (data.phase) {
          store.setActiveTask((prev) => prev ? { ...prev, taskState: { ...prev.taskState, phase: data.phase } } : prev);
        }
        void pollTaskState(runId);
      } else {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>;
        console.error(`[taskAction] ${action} failed:`, err);
        setFlow((prev) => [...prev, { kind: "error", id: nextId("e"), role: "assistant",
          errorCode: "TASK_ACTION_FAILED",
          message: t(locale, "taskAction.failed")
            .replace("{action}", action === "continue" ? t(locale, "action.continue") : action === "retry" ? t(locale, "common.retry") : action)
            .replace("{message}", String(err?.message ?? res.statusText)),
          traceId: String(err?.traceId ?? ""),
          createdAt: Date.now(),
        }]);
      }
    } catch (err) {
      console.error(`[taskAction] ${action} error:`, err);
    }
  }, [abortRef, locale, pollTaskState, setFlow]);

  /** Register a new task in the multi-task map and start polling */
  const registerTask = useCallback((taskId: string, runId: string, initialState: TaskState, progress?: TaskProgress | null) => {
    useTaskStore.getState().setActiveTasksMap((prev) => {
      const newMap = new Map(prev);
      newMap.set(taskId, { taskId, runId, taskState: initialState, progress: progress ?? null, polling: true });
      return newMap;
    });
    void pollTaskState(runId, taskId);
  }, [pollTaskState]);

  /** Unregister a task from the multi-task map and stop its polling */
  const unregisterTask = useCallback((taskId: string, pollTimersRef: React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>) => {
    const removed = useTaskStore.getState().removeTaskEntry(taskId);
    if (removed) {
      const timer = pollTimersRef.current.get(removed.runId);
      if (timer) { clearTimeout(timer); pollTimersRef.current.delete(removed.runId); }
    }
  }, []);

  return { taskAction, registerTask, unregisterTask };
}
