"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { nextId } from "@/lib/apiError";
import { t } from "@/lib/i18n";
import type { TaskState } from "@/lib/types";
import type { ChatFlowItem, TaskProgress, TaskStepEntry } from "./homeHelpers";

/* ─── Poll Backoff Config ─── */

const POLL_CONFIG = {
  ACTIVE_INTERVAL_MS: 500,     // active execution: 500ms
  BASE_INTERVAL_MS: 1000,      // backoff base interval
  MAX_INTERVAL_MS: 10000,      // max interval 10s
  MULTIPLIER: 2,               // backoff multiplier
  ERROR_INTERVAL_MS: 4000,     // error retry interval
} as const;

/** Compute next poll interval based on task phase and consecutive no-change count */
function computePollInterval(phase: string, consecutiveNoChange: number): number {
  // 活跃执行阶段：固定短间隔
  if (phase === "executing" || phase === "planning" || phase === "running") {
    return POLL_CONFIG.ACTIVE_INTERVAL_MS;
  }
  // 等待/暂停/完成阶段：指数退避
  return Math.min(
    POLL_CONFIG.BASE_INTERVAL_MS * Math.pow(POLL_CONFIG.MULTIPLIER, consecutiveNoChange),
    POLL_CONFIG.MAX_INTERVAL_MS,
  );
}

/* ─── Types ─── */

/** 单个任务的完整状态 */
export type ActiveTaskEntry = {
  taskId: string;
  runId: string;
  taskState: TaskState;
  progress: TaskProgress | null;
  /** 轮询是否活跃 */
  polling: boolean;
};

export interface UseTaskManagerParams {
  locale: string;
  setFlow: React.Dispatch<React.SetStateAction<ChatFlowItem[]>>;
  abortRef: React.MutableRefObject<AbortController | null>;
}

/**
 * useTaskManager — manages task state polling, task actions (continue/stop/retry/skip),
 * activeTask, and taskProgress for the dual-track output.
 */
export default function useTaskManager({
  locale,
  setFlow,
  abortRef,
}: UseTaskManagerParams) {
  // P1-13: 单任务兼容状态（HomeChat 未改造前仍使用）
  const [activeTask, setActiveTask] = useState<{ taskId: string; runId: string; taskState: TaskState } | null>(null);
  const [taskProgress, setTaskProgress] = useState<TaskProgress | null>(null);

  // P1-13: 多任务状态 Map
  const [activeTasksMap, setActiveTasksMap] = useState<Map<string, ActiveTaskEntry>>(new Map());
  /** 轮询计时器 refs（按 runId 索引） */
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const getTaskControlRequest = useCallback((runId: string, action: "continue" | "stop" | "retry" | "skip") => {
    if (action === "continue") {
      return {
        path: `/runs/${runId}/resume`,
        body: {},
      };
    }
    if (action === "retry") {
      return {
        path: `/runs/${runId}/retry`,
        body: {},
      };
    }
    if (action === "skip") {
      return {
        path: `/runs/${runId}/skip`,
        body: {},
      };
    }
    return {
      path: `/runs/${runId}/cancel`,
      body: {},
    };
  }, []);

  const pollTaskState = useCallback(async (runId: string, taskId?: string) => {
    // 若已有该 runId 的轮询，不重复启动
    if (pollTimersRef.current.has(runId)) return;

    const MAX_POLLS = 150;
    let pollCount = 0;
    let lastPhase = "";
    let lastStepCount = 0;
    let lastCurrentStep = 0;
    let lastStatusChangeAt = Date.now();
    let noProgressWarned = false;
    let continueTries = 0;
    const MAX_CONTINUE_RETRIES = 3;
    const NO_PROGRESS_WARN_MS = 15000;

    // 指数退避状态
    let consecutiveNoChange = 0;

    const scheduleNext = (phase: string, isError = false) => {
      pollCount++;
      if (pollCount >= MAX_POLLS) {
        console.log(`[pollTaskState] Polling timed out, stopping runId=${runId}`);
        pollTimersRef.current.delete(runId);
        return;
      }
      const interval = isError
        ? POLL_CONFIG.ERROR_INTERVAL_MS
        : computePollInterval(phase, consecutiveNoChange);
      const timer = setTimeout(poll, interval);
      pollTimersRef.current.set(runId, timer);
    };

    const poll = async () => {
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

        // 检测是否有状态变化，用于退避计算
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
            setTaskProgress((prev) => prev ? { ...prev, phase, steps: [...prev.steps, ...newEntries] } : prev);
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

        // 更新退避计数器
        if (hasChange) {
          consecutiveNoChange = 0;
        } else {
          consecutiveNoChange++;
        }

        if (!noProgressWarned && Date.now() - lastStatusChangeAt > NO_PROGRESS_WARN_MS && status === "running") {
          noProgressWarned = true;
        }

        setActiveTask((prev) => {
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

        // P1-13: 同步到多任务 Map
        if (taskId) {
          setActiveTasksMap((prev) => {
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
          setTaskProgress((prev) => prev ? { ...prev, phase: status } : prev);
          // P1-13: 清理轮询计时器 + 更新 Map
          pollTimersRef.current.delete(runId);
          if (taskId) {
            setActiveTasksMap((prev) => {
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
        if (waitingStatuses.includes(status) && continueTries < MAX_CONTINUE_RETRIES) {
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
  }, [getTaskControlRequest, locale]);

  const taskAction = useCallback(async (action: "continue" | "stop" | "retry" | "skip", targetRunId?: string) => {
    const runId = targetRunId ?? activeTask?.runId;
    if (!runId) return;
    try {
      if (action === "stop") {
        try { abortRef.current?.abort(); } catch { /* expected: abort may throw if already aborted */ }

        const res = await apiFetch(`/runs/${runId}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ runId }),
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({ phase: "stopped" }));
          console.log("[taskAction] stop succeeded:", data);
          setActiveTask((prev) => prev ? { ...prev, taskState: { ...prev.taskState, phase: "stopped" } } : prev);
          setTaskProgress((prev) => prev ? { ...prev, phase: "stopped" } : prev);
          setFlow((prev) => [...prev, { kind: "message", id: nextId("m"), role: "assistant",
            text: t(locale, "taskAction.stopped"), createdAt: Date.now(),
          }]);
        } else {
          const err = await res.json().catch(() => null) as Record<string, unknown> | null;
          const errorCode = String(err?.errorCode ?? "");

          if (res.status === 409 || errorCode === "RUN_NOT_CANCELABLE") {
            console.log("[taskAction] stop: run is already terminal, cancellation not required");
            const terminalPhase = String((err?.run as Record<string, unknown> | undefined)?.status ?? "stopped");
            setActiveTask((prev) => prev ? { ...prev, taskState: { ...prev.taskState, phase: terminalPhase } } : prev);
            setTaskProgress((prev) => prev ? { ...prev, phase: terminalPhase } : prev);
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
          setActiveTask((prev) => prev ? { ...prev, taskState: { ...prev.taskState, phase: data.phase } } : prev);
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
  }, [activeTask?.runId, abortRef, getTaskControlRequest, locale, pollTaskState, setFlow]);

  /** P1-13: 注册新任务到 activeTasksMap */
  const registerTask = useCallback((taskId: string, runId: string, initialState: TaskState, progress?: TaskProgress | null) => {
    setActiveTasksMap((prev) => {
      const newMap = new Map(prev);
      newMap.set(taskId, {
        taskId,
        runId,
        taskState: initialState,
        progress: progress ?? null,
        polling: true,
      });
      return newMap;
    });
    // 自动启动轮询
    void pollTaskState(runId, taskId);
  }, [pollTaskState]);

  /** P1-13: 从 activeTasksMap 移除任务 */
  const unregisterTask = useCallback((taskId: string) => {
    setActiveTasksMap((prev) => {
      const existing = prev.get(taskId);
      if (!existing) return prev;
      // 停止轮询
      const timer = pollTimersRef.current.get(existing.runId);
      if (timer) { clearTimeout(timer); pollTimersRef.current.delete(existing.runId); }
      const newMap = new Map(prev);
      newMap.delete(taskId);
      return newMap;
    });
  }, []);

  // 组件卸载时清理所有轮询 timer，防止内存泄露
  useEffect(() => {
    const timers = pollTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  /** P1-13: 获取所有活跃任务 ID */
  const activeTaskIds = Array.from(activeTasksMap.keys());

  return {
    // 单任务兼容 API
    activeTask, setActiveTask,
    taskProgress, setTaskProgress,
    pollTaskState,
    taskAction,
    // P1-13: 多任务 API
    activeTasksMap,
    registerTask,
    unregisterTask,
    activeTaskIds,
  };
}
