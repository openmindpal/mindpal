"use client";

import { useCallback, useEffect, useRef } from "react";
import { apiFetch } from "@/lib/api";
import { nextId } from "@/lib/apiError";
import { useTaskStore } from "@/store/taskStore";
import type { TaskStepEntry } from "./homeHelpers";

/* ─── Poll Backoff Config ─── */

const POLL_CONFIG = {
  ACTIVE_INTERVAL_MS: 500,
  BASE_INTERVAL_MS: 1000,
  MAX_INTERVAL_MS: 10000,
  MULTIPLIER: 2,
  ERROR_INTERVAL_MS: 4000,
  MAX_POLLS: 150,
  MAX_CONTINUE_RETRIES: 3,
  NO_PROGRESS_WARN_MS: 15000,
} as const;

function computePollInterval(phase: string, consecutiveNoChange: number): number {
  if (phase === "executing" || phase === "planning" || phase === "running") {
    return POLL_CONFIG.ACTIVE_INTERVAL_MS;
  }
  return Math.min(
    POLL_CONFIG.BASE_INTERVAL_MS * Math.pow(POLL_CONFIG.MULTIPLIER, consecutiveNoChange),
    POLL_CONFIG.MAX_INTERVAL_MS,
  );
}

export interface UseTaskPollingParams {
  locale: string;
  onNoProgress?: (runId: string, elapsedMs: number) => void;
  onPollTimeout?: (runId: string) => void;
}

function getTaskControlRequest(runId: string, action: "continue" | "stop" | "retry" | "skip") {
  if (action === "continue") return { path: `/runs/${runId}/resume`, body: {} };
  if (action === "retry") return { path: `/runs/${runId}/retry`, body: {} };
  if (action === "skip") return { path: `/runs/${runId}/skip`, body: {} };
  return { path: `/runs/${runId}/cancel`, body: {} };
}

/**
 * useTaskPolling — handles run-state polling with exponential backoff.
 * State lives in taskStore (Zustand).
 */
export default function useTaskPolling({
  locale,
  onNoProgress,
  onPollTimeout,
}: UseTaskPollingParams) {
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const { setActiveTask, setTaskProgress, setActiveTasksMap } = useTaskStore.getState();

  const pollTaskState = useCallback(async (runId: string, taskId?: string) => {
    if (pollTimersRef.current.has(runId)) return;

    let pollCount = 0;
    let lastPhase = "";
    let lastStepCount = 0;
    let lastCurrentStep = 0;
    let lastStatusChangeAt = Date.now();
    let noProgressWarned = false;
    let continueTries = 0;
    let consecutiveNoChange = 0;

    const scheduleNext = (phase: string, isError = false) => {
      pollCount++;
      if (pollCount >= POLL_CONFIG.MAX_POLLS) {
        console.log(`[pollTaskState] Polling timed out, stopping runId=${runId}`);
        pollTimersRef.current.delete(runId);
        onPollTimeout?.(runId);
        return;
      }
      const interval = isError
        ? POLL_CONFIG.ERROR_INTERVAL_MS
        : computePollInterval(phase, consecutiveNoChange);
      const timer = setTimeout(poll, interval);
      pollTimersRef.current.set(runId, timer);
    };

    const poll = async () => {
      const store = useTaskStore.getState();
      try {
        const res = await apiFetch(`/runs/${runId}`, { method: "GET", locale, cache: "no-store" });
        if (!res.ok) {
          console.error("[pollTaskState] Failed to fetch task status:", res.status);
          consecutiveNoChange++;
          scheduleNext(lastPhase, true);
          return;
        }
        const data = await res.json();

        const status = String(data?.status ?? data?.run?.status ?? "");
        const phase = String(data?.phase ?? data?.run?.status ?? status);
        const stepCount = data?.stepCount ?? (Array.isArray(data?.steps) ? data.steps.length : 0);
        const succeededCount = data?.currentStep ?? (Array.isArray(data?.steps) ? data.steps.filter((s: any) => String(s.status) === "succeeded").length : 0);
        const blockReason = data?.blockReason ?? undefined;
        const nextAction = data?.nextAction ?? undefined;

        let hasChange = false;

        if (stepCount > lastStepCount || succeededCount > lastCurrentStep) {
          hasChange = true;
          lastStatusChangeAt = Date.now();
          noProgressWarned = false;

          const steps = Array.isArray(data?.steps) ? data.steps : [];
          const newEntries: TaskStepEntry[] = [];
          for (let i = lastStepCount; i < steps.length; i++) {
            const s = steps[i];
            const sStatus = String(s?.status ?? "running");
            const toolRef = String(s?.tool_ref ?? s?.toolRef ?? "");
            newEntries.push({
              id: nextId("ts"),
              seq: i + 1,
              toolRef: toolRef || "unknown",
              status: sStatus as TaskStepEntry["status"],
              ts: Date.now(),
            });
          }
          if (newEntries.length > 0) {
            store.setTaskProgress((prev) => prev ? { ...prev, phase, steps: [...prev.steps, ...newEntries] } : prev);
          }
          lastStepCount = stepCount;
          lastCurrentStep = succeededCount;
        }

        if (phase !== lastPhase) {
          hasChange = true;
          lastStatusChangeAt = Date.now();
          noProgressWarned = false;
          lastPhase = phase;
          continueTries = 0;
        }

        if (hasChange) { consecutiveNoChange = 0; } else { consecutiveNoChange++; }

        if (!noProgressWarned && Date.now() - lastStatusChangeAt > POLL_CONFIG.NO_PROGRESS_WARN_MS && status === "running") {
          const elapsed = Date.now() - lastStatusChangeAt;
          console.warn(`[pollTaskState] No progress for ${elapsed}ms on runId=${runId}`);
          noProgressWarned = true;
          onNoProgress?.(runId, elapsed);
        }

        store.setActiveTask((prev) => {
          if (!prev || prev.runId !== runId) return prev;
          return {
            ...prev,
            taskState: {
              phase,
              stepCount: stepCount ?? prev.taskState.stepCount,
              currentStep: succeededCount ?? prev.taskState.currentStep,
              needsApproval: status === "needs_approval" || phase === "needs_approval",
              blockReason,
              nextAction,
            },
          };
        });

        // Sync to multi-task map
        if (taskId) {
          store.setActiveTasksMap((prev) => {
            const existing = prev.get(taskId);
            if (!existing) return prev;
            const newMap = new Map(prev);
            newMap.set(taskId, {
              ...existing,
              taskState: {
                phase,
                stepCount: stepCount ?? existing.taskState.stepCount,
                currentStep: succeededCount ?? existing.taskState.currentStep,
                needsApproval: status === "needs_approval" || phase === "needs_approval",
                blockReason,
                nextAction,
              },
            });
            return newMap;
          });
        }

        const terminalStatuses = ["succeeded", "failed", "stopped", "canceled", "compensated"];
        if (terminalStatuses.includes(status)) {
          console.log(`[pollTaskState] Task ${runId} completed: ${status}`);
          store.setTaskProgress((prev) => prev ? { ...prev, phase: status } : prev);
          pollTimersRef.current.delete(runId);
          if (taskId) {
            store.setActiveTasksMap((prev) => {
              const existing = prev.get(taskId);
              if (!existing) return prev;
              const newMap = new Map(prev);
              newMap.set(taskId, { ...existing, polling: false, progress: existing.progress ? { ...existing.progress, phase: status } : null });
              return newMap;
            });
          }
          return;
        }

        const waitingStatuses = ["waiting", "step_done"];
        if (waitingStatuses.includes(status) && continueTries < POLL_CONFIG.MAX_CONTINUE_RETRIES) {
          console.log(`[pollTaskState] Task ${runId} is waiting (${status}); auto-triggering continue.`);
          continueTries++;
          try {
            const control = getTaskControlRequest(runId, "continue");
            const contRes = await apiFetch(control.path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              locale,
              body: JSON.stringify(control.body),
            });
            if (contRes.ok) {
              console.log("[pollTaskState] run resume succeeded");
            } else {
              console.warn(`[pollTaskState] run resume failed: ${contRes.status}`);
            }
          } catch (contErr) {
            console.warn("[pollTaskState] run resume error:", contErr);
          }
        }

        scheduleNext(phase);
      } catch (err) {
        console.error("[pollTaskState] Polling error:", err);
        consecutiveNoChange++;
        scheduleNext(lastPhase, true);
      }
    };

    const timer = setTimeout(poll, POLL_CONFIG.ACTIVE_INTERVAL_MS);
    pollTimersRef.current.set(runId, timer);
  }, [locale, onNoProgress, onPollTimeout]);

  // Cleanup all timers on unmount
  useEffect(() => {
    const timers = pollTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { pollTaskState, pollTimersRef };
}
