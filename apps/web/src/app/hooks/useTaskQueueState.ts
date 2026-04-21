"use client";

/**
 * useTaskQueueState — 队列状态管理 Hook
 *
 * 管理前端侧的任务队列核心状态（entries Map、dependencies、progress），
 * 提供快照应用和 SSE 事件驱动的状态更新。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FrontendTaskQueueEntry,
  FrontendQueueStatus,
  FrontendTaskDependency,
  TaskQueueState,
  MultiTaskProgress,
} from "../homeHelpers";
import { TERMINAL_QUEUE_STATUSES, type TaskStepEntry } from "../homeHelpers";
import type { SessionSSEEvent } from "../useSessionSSE";

const TASK_QUEUE_KEY = "openslin_task_queue_state";

/* ─── Helpers ─── */

function toFrontendEntry(raw: any): FrontendTaskQueueEntry {
  return {
    entryId: raw.entryId ?? raw.entry_id ?? "",
    taskId: raw.taskId ?? raw.task_id ?? null,
    runId: raw.runId ?? raw.run_id ?? null,
    goal: raw.goal ?? "",
    mode: raw.mode ?? "execute",
    priority: raw.priority ?? 0,
    position: raw.position ?? 0,
    status: (raw.status ?? "queued") as FrontendQueueStatus,
    foreground: raw.foreground ?? false,
    enqueuedAt: raw.enqueuedAt ?? raw.enqueued_at ? new Date(raw.enqueuedAt ?? raw.enqueued_at).getTime() : Date.now(),
    startedAt: raw.startedAt ?? raw.started_at ? new Date(raw.startedAt ?? raw.started_at).getTime() : null,
    completedAt: raw.completedAt ?? raw.completed_at ? new Date(raw.completedAt ?? raw.completed_at).getTime() : null,
    retryCount: raw.retryCount ?? raw.retry_count ?? 0,
    lastError: raw.lastError ?? raw.last_error ?? null,
  };
}

function toDep(raw: any): FrontendTaskDependency {
  return {
    depId: raw.depId ?? raw.dep_id ?? "",
    fromEntryId: raw.fromEntryId ?? raw.from_entry_id ?? "",
    toEntryId: raw.toEntryId ?? raw.to_entry_id ?? "",
    depType: raw.depType ?? raw.dep_type ?? "finish_to_start",
    status: raw.status ?? "pending",
  };
}

function readSavedTaskQueueState(sessionId: string) {
  try {
    const raw = localStorage.getItem(TASK_QUEUE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as {
      sessionId?: string;
      pendingEntries?: FrontendTaskQueueEntry[];
      dependencies?: FrontendTaskDependency[];
      foregroundEntryId?: string | null;
    };
    if (saved.sessionId && saved.sessionId !== sessionId) return null;
    const entries = new Map<string, FrontendTaskQueueEntry>();
    let activeCount = 0;
    let queuedCount = 0;
    for (const item of Array.isArray(saved.pendingEntries) ? saved.pendingEntries : []) {
      entries.set(item.entryId, item);
      if (item.status === "executing") activeCount++;
      if (item.status === "queued" || item.status === "ready") queuedCount++;
    }
    return {
      entries,
      dependencies: Array.isArray(saved.dependencies) ? saved.dependencies : [],
      foregroundEntryId: saved.foregroundEntryId ?? null,
      activeCount,
      queuedCount,
    };
  } catch { return null; }
}

/* ─── Hook ─── */

export function useTaskQueueState(sessionId: string) {
  const [queueState, setQueueState] = useState<TaskQueueState>({
    sessionId,
    entries: new Map(),
    dependencies: [],
    foregroundEntryId: null,
    activeCount: 0,
    queuedCount: 0,
  });

  const [multiProgress, setMultiProgress] = useState<MultiTaskProgress>({
    progressMap: new Map(),
    completedCount: 0,
    totalCount: 0,
    allDone: true,
  });

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // Restore from localStorage
  useEffect(() => {
    const saved = readSavedTaskQueueState(sessionId);
    if (saved && (saved.entries.size > 0 || saved.dependencies.length > 0)) {
      setQueueState({ sessionId, ...saved });
    }
  }, [sessionId]);

  const recalcProgress = useCallback((entries: Map<string, FrontendTaskQueueEntry>) => {
    setMultiProgress((prev) => {
      let completed = 0;
      let total = 0;
      for (const [, e] of entries) {
        if (e.taskId) { total++; if (TERMINAL_QUEUE_STATUSES.has(e.status)) completed++; }
      }
      return { ...prev, completedCount: completed, totalCount: Math.max(total, prev.progressMap.size), allDone: total > 0 && completed >= total };
    });
  }, []);

  const applySnapshot = useCallback((data: Record<string, unknown>) => {
    const rawEntries = (data.entries ?? data.queue ?? []) as Record<string, unknown>[];
    const rawDeps = (data.dependencies ?? []) as Record<string, unknown>[];
    const entries = new Map<string, FrontendTaskQueueEntry>();
    let fgEntryId: string | null = null;
    let active = 0;
    let queued = 0;

    for (const raw of rawEntries) {
      const entry = toFrontendEntry(raw);
      entries.set(entry.entryId, entry);
      if (entry.foreground && !TERMINAL_QUEUE_STATUSES.has(entry.status)) fgEntryId = entry.entryId;
      if (entry.status === "executing") active++;
      if (entry.status === "queued" || entry.status === "ready") queued++;
    }

    setQueueState({ sessionId: sessionIdRef.current, entries, dependencies: rawDeps.map(toDep), foregroundEntryId: fgEntryId, activeCount: active, queuedCount: queued });
    recalcProgress(entries);
  }, [recalcProgress]);

  const handleSSEEvent = useCallback((evt: SessionSSEEvent) => {
    const { event: evtName, data } = evt;

    switch (evtName) {
      case "queueSnapshot": applySnapshot(data); break;

      case "taskQueued": case "taskStarted": case "taskCompleted": case "taskFailed":
      case "taskCancelled": case "taskPaused": case "taskResumed": case "taskPreempted":
      case "taskReordered": case "taskForeground": case "taskBackground": {
        const rawEntry = (data.entry ?? data) as Record<string, unknown>;
        if (!rawEntry.entryId && !rawEntry.entry_id) break;
        const entry = toFrontendEntry(rawEntry);
        setQueueState((prev) => {
          const newEntries = new Map(prev.entries);
          newEntries.set(entry.entryId, entry);
          let fgId = prev.foregroundEntryId;
          let active = 0; let queued = 0;
          if (evtName === "taskForeground") fgId = entry.entryId;
          if (evtName === "taskBackground" && fgId === entry.entryId) fgId = null;
          for (const [, e] of newEntries) {
            if (e.status === "executing") active++;
            if (e.status === "queued" || e.status === "ready") queued++;
          }
          return { ...prev, entries: newEntries, foregroundEntryId: fgId, activeCount: active, queuedCount: queued };
        });
        break;
      }

      case "depCreated": case "depResolved": case "depBlocked": case "cascadeCancelled": {
        const dep = (data.dependency ?? data) as Record<string, unknown>;
        if (!dep.depId && !dep.dep_id) break;
        const frontDep = toDep(dep);
        setQueueState((prev) => {
          const idx = prev.dependencies.findIndex((d) => d.depId === frontDep.depId);
          const newDeps = [...prev.dependencies];
          if (idx >= 0) newDeps[idx] = frontDep; else newDeps.push(frontDep);
          return { ...prev, dependencies: newDeps };
        });
        break;
      }

      case "stepProgress": {
        const taskId = (data._taskId as string) ?? null;
        if (!taskId) break;
        setMultiProgress((prev) => {
          const newMap = new Map(prev.progressMap);
          const existing = newMap.get(taskId);
          const step = data.step as Record<string, unknown> | undefined;
          if (existing && step) {
            const steps = [...existing.steps];
            const idx = steps.findIndex((s) => s.seq === step.seq);
            const newStep = { id: `ts-${Date.now()}`, seq: step.seq as number, toolRef: String(step.toolRef ?? "unknown"), status: (step.status as TaskStepEntry["status"]) ?? "running", reasoning: typeof step.reasoning === "string" ? step.reasoning.slice(0, 200) : undefined, ts: Date.now() };
            if (idx >= 0) steps[idx] = newStep; else steps.push(newStep);
            newMap.set(taskId, { ...existing, phase: "executing", steps });
          }
          return { ...prev, progressMap: newMap };
        });
        break;
      }

      case "taskCreated": {
        const taskId = (data.taskId as string) ?? null;
        const runId = (data.runId as string) ?? null;
        if (!taskId) break;
        const initialPhase = String((data.taskState as Record<string, unknown> | undefined)?.phase ?? data.phase ?? "queued");
        setMultiProgress((prev) => {
          const newMap = new Map(prev.progressMap);
          newMap.set(taskId, { taskId, runId: runId ?? "", phase: initialPhase, steps: [], createdAt: Date.now(), label: (data.mode as string) ?? "execute" });
          return { ...prev, progressMap: newMap, totalCount: newMap.size, allDone: false };
        });
        break;
      }

      case "taskRetried": {
        const taskId = (data._taskId as string) ?? (data.taskId as string) ?? null;
        if (!taskId) break;
        setMultiProgress((prev) => {
          const newMap = new Map(prev.progressMap);
          const existing = newMap.get(taskId);
          if (!existing) return prev;
          newMap.set(taskId, { ...existing, phase: "queued", createdAt: Date.now() });
          return { ...prev, progressMap: newMap, allDone: false };
        });
        break;
      }

      case "agentLoopEnd": {
        const taskId = (data._taskId as string) ?? null;
        if (!taskId) break;
        const finalPhase = String(data.status ?? (data.ok ? "succeeded" : "failed"));
        setMultiProgress((prev) => {
          const newMap = new Map(prev.progressMap);
          const existing = newMap.get(taskId);
          if (existing) newMap.set(taskId, { ...existing, phase: finalPhase });
          let completed = 0;
          for (const [, p] of newMap) {
            if (p.phase === "succeeded" || p.phase === "failed" || p.phase === "canceled") completed++;
          }
          return { ...prev, progressMap: newMap, completedCount: completed, allDone: completed >= newMap.size };
        });
        break;
      }
    }
  }, [applySnapshot]);

  // Persist non-terminal entries
  useEffect(() => {
    try {
      const pendingEntries = Array.from(queueState.entries.values()).filter((e) => !TERMINAL_QUEUE_STATUSES.has(e.status));
      if (pendingEntries.length === 0 && queueState.dependencies.length === 0) { localStorage.removeItem(TASK_QUEUE_KEY); return; }
      localStorage.setItem(TASK_QUEUE_KEY, JSON.stringify({ sessionId, pendingEntries, dependencies: queueState.dependencies, foregroundEntryId: queueState.foregroundEntryId }));
    } catch { /* storage may fail */ }
  }, [queueState, sessionId]);

  // Derived getters
  const foregroundEntry = useMemo(() => queueState.foregroundEntryId ? queueState.entries.get(queueState.foregroundEntryId) ?? null : null, [queueState.foregroundEntryId, queueState.entries]);
  const activeEntries = useMemo(() => Array.from(queueState.entries.values()).filter((e) => !TERMINAL_QUEUE_STATUSES.has(e.status)).sort((a, b) => a.position - b.position), [queueState.entries]);
  const allEntries = useMemo(() => Array.from(queueState.entries.values()).sort((a, b) => a.position - b.position), [queueState.entries]);
  const activeTaskIds = useMemo(() => activeEntries.map((e) => e.taskId).filter((id): id is string => !!id), [activeEntries]);

  return { queueState, setQueueState, multiProgress, foregroundEntry, activeEntries, allEntries, activeTaskIds, handleSSEEvent, applySnapshot };
}
