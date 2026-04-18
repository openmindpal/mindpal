"use client";

/**
 * useSessionTaskQueue — 多任务队列状态管理 hook
 *
 * 管理前端侧的任务队列状态（Map<entryId, Entry>），
 * 通过 SSE 事件实时更新，并暴露队列操作 API（取消/暂停/恢复/重排/优先级/前台切换）。
 *
 * 依赖：
 * - useSessionSSE 的 onTaskEvent / onEvent 回调来驱动状态更新
 * - apiFetch 调用 /orchestrator/task-queue 系列 API
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import type {
  FrontendTaskQueueEntry,
  FrontendQueueStatus,
  FrontendTaskDependency,
  TaskQueueState,
  MultiTaskProgress,
} from "./homeHelpers";
import { TERMINAL_QUEUE_STATUSES } from "./homeHelpers";
import type { SessionSSEEvent } from "./useSessionSSE";

const TASK_QUEUE_KEY = "openslin_task_queue_state";

/* ─── Types ─── */

export interface UseSessionTaskQueueParams {
  /** 会话 ID */
  sessionId: string;
  /** 当前语言 */
  locale: string;
  /** 是否启用（未连接 SSE 时不启用） */
  enabled?: boolean;
}

export interface TaskQueueActions {
  /** 取消单个任务 */
  cancel: (entryId: string) => Promise<boolean>;
  /** 取消会话内所有任务 */
  cancelAll: () => Promise<number>;
  /** 暂停任务 */
  pause: (entryId: string) => Promise<boolean>;
  /** 恢复任务 */
  resume: (entryId: string) => Promise<boolean>;
  /** 重试失败任务 */
  retry: (entryId: string) => Promise<boolean>;
  /** 调整队列顺序 */
  reorder: (entryId: string, newPosition: number) => Promise<boolean>;
  /** 更新优先级 */
  setPriority: (entryId: string, priority: number) => Promise<boolean>;
  /** 切换前台/后台 */
  setForeground: (entryId: string, foreground: boolean) => Promise<boolean>;
  /** 手动创建依赖 (P2-09) */
  createDep: (params: {
    fromEntryId: string;
    toEntryId: string;
    depType: "finish_to_start" | "output_to_input" | "cancel_cascade";
  }) => Promise<{ ok: boolean; error?: string }>;
  /** 移除依赖 (P2-09) */
  removeDep: (depId: string) => Promise<boolean>;
  /** 覆盖依赖 (P2-09) */
  overrideDep: (depId: string) => Promise<boolean>;
  /** DAG 合法性校验 (P2-09) */
  validateDag: () => Promise<{ valid: boolean; errors: string[] }>;
  /** 刷新队列快照（手动） */
  refresh: () => Promise<void>;
}

/* ─── Helpers ─── */

/** 从后端 entry 映射到前端 entry */
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

function readSavedTaskQueueState(sessionId: string): {
  entries: Map<string, FrontendTaskQueueEntry>;
  dependencies: FrontendTaskDependency[];
  foregroundEntryId: string | null;
  activeCount: number;
  queuedCount: number;
} {
  if (typeof window === "undefined") {
    return {
      entries: new Map(),
      dependencies: [],
      foregroundEntryId: null,
      activeCount: 0,
      queuedCount: 0,
    };
  }
  try {
    const raw = localStorage.getItem(TASK_QUEUE_KEY);
    if (!raw) throw new Error("empty");
    const saved = JSON.parse(raw) as {
      sessionId?: string;
      pendingEntries?: FrontendTaskQueueEntry[];
      dependencies?: FrontendTaskDependency[];
      foregroundEntryId?: string | null;
    };
    if (saved.sessionId && saved.sessionId !== sessionId) throw new Error("session mismatch");
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
  } catch {
    return {
      entries: new Map(),
      dependencies: [],
      foregroundEntryId: null,
      activeCount: 0,
      queuedCount: 0,
    };
  }
}

/* ─── Hook ─── */

export default function useSessionTaskQueue(params: UseSessionTaskQueueParams) {
  const { sessionId, locale } = params;
  const [initialState] = useState(() => readSavedTaskQueueState(sessionId));

  // 核心队列状态
  const [queueState, setQueueState] = useState<TaskQueueState>({
    sessionId,
    entries: initialState.entries,
    dependencies: initialState.dependencies,
    foregroundEntryId: initialState.foregroundEntryId,
    activeCount: initialState.activeCount,
    queuedCount: initialState.queuedCount,
  });

  // 多任务进度聚合
  const [multiProgress, setMultiProgress] = useState<MultiTaskProgress>({
    progressMap: new Map(),
    completedCount: 0,
    totalCount: 0,
    allDone: true,
  });

  // 操作中状态
  const [operating, setOperating] = useState(false);

  // 保持 sessionId 同步
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const recalcProgress = useCallback((entries: Map<string, FrontendTaskQueueEntry>) => {
    setMultiProgress((prev) => {
      let completed = 0;
      let total = 0;
      for (const [, e] of entries) {
        if (e.taskId) {
          total++;
          if (TERMINAL_QUEUE_STATUSES.has(e.status)) completed++;
        }
      }
      return {
        ...prev,
        completedCount: completed,
        totalCount: Math.max(total, prev.progressMap.size),
        allDone: total > 0 && completed >= total,
      };
    });
  }, []);

  /* ─── 从快照初始化 ─── */

  const applySnapshot = useCallback((data: Record<string, unknown>) => {
    const rawEntries = (data.entries ?? data.queue ?? []) as any[];
    const rawDeps = (data.dependencies ?? []) as any[];
    const entries = new Map<string, FrontendTaskQueueEntry>();
    let fgEntryId: string | null = null;
    let active = 0;
    let queued = 0;

    for (const raw of rawEntries) {
      const entry = toFrontendEntry(raw);
      entries.set(entry.entryId, entry);
      if (entry.foreground && !TERMINAL_QUEUE_STATUSES.has(entry.status)) {
        fgEntryId = entry.entryId;
      }
      if (entry.status === "executing") active++;
      if (entry.status === "queued" || entry.status === "ready") queued++;
    }

    setQueueState({
      sessionId: sessionIdRef.current,
      entries,
      dependencies: rawDeps.map(toDep),
      foregroundEntryId: fgEntryId,
      activeCount: active,
      queuedCount: queued,
    });

    recalcProgress(entries);
  }, [recalcProgress]);

  /* ─── SSE 事件处理（全局） ─── */

  const handleSSEEvent = useCallback((evt: SessionSSEEvent) => {
    const { event: evtName, data } = evt;

    switch (evtName) {
      case "queueSnapshot":
        applySnapshot(data);
        break;

      case "taskQueued":
      case "taskStarted":
      case "taskCompleted":
      case "taskFailed":
      case "taskCancelled":
      case "taskPaused":
      case "taskResumed":
      case "taskPreempted":
      case "taskReordered":
      case "taskForeground":
      case "taskBackground": {
        const rawEntry = (data.entry ?? data) as Record<string, unknown>;
        if (!rawEntry.entryId && !rawEntry.entry_id) break;
        const entry = toFrontendEntry(rawEntry);

        setQueueState((prev) => {
          const newEntries = new Map(prev.entries);
          newEntries.set(entry.entryId, entry);

          let fgId = prev.foregroundEntryId;
          let active = 0;
          let queued = 0;

          // 处理前台切换
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

      case "depCreated":
      case "depResolved":
      case "depBlocked":
      case "cascadeCancelled": {
        const dep = (data.dependency ?? data) as Record<string, unknown>;
        if (!dep.depId && !dep.dep_id) break;
        const frontDep = toDep(dep);

        setQueueState((prev) => {
          const idx = prev.dependencies.findIndex((d) => d.depId === frontDep.depId);
          const newDeps = [...prev.dependencies];
          if (idx >= 0) {
            newDeps[idx] = frontDep;
          } else {
            newDeps.push(frontDep);
          }
          return { ...prev, dependencies: newDeps };
        });
        break;
      }

      // 任务进度更新（来自 agent loop）
      case "stepProgress": {
        const taskId = (data._taskId as string) ?? null;
        if (!taskId) break;
        setMultiProgress((prev) => {
          const newMap = new Map(prev.progressMap);
          const existing = newMap.get(taskId);
          const step = data.step as any;
          if (existing && step) {
            const steps = [...existing.steps];
            const idx = steps.findIndex((s) => s.seq === step.seq);
            const newStep = {
              id: `ts-${Date.now()}`,
              seq: step.seq,
              toolRef: step.toolRef ?? "unknown",
              status: step.status ?? "running",
              reasoning: step.reasoning?.slice(0, 200),
              ts: Date.now(),
            };
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
        const initialPhase = String(
          (data.taskState as Record<string, unknown> | undefined)?.phase
            ?? data.phase
            ?? "queued",
        );
        setMultiProgress((prev) => {
          const newMap = new Map(prev.progressMap);
          newMap.set(taskId, {
            taskId,
            runId: runId ?? "",
            phase: initialPhase,
            steps: [],
            createdAt: Date.now(),
            label: (data.mode as string) ?? "execute",
          });
          return {
            ...prev,
            progressMap: newMap,
            totalCount: newMap.size,
            allDone: false,
          };
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
          newMap.set(taskId, {
            ...existing,
            phase: "queued",
            createdAt: Date.now(),
          });
          return {
            ...prev,
            progressMap: newMap,
            allDone: false,
          };
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
          if (existing) {
            newMap.set(taskId, { ...existing, phase: finalPhase });
          }
          let completed = 0;
          for (const [, p] of newMap) {
            if (p.phase === "succeeded" || p.phase === "failed" || p.phase === "canceled") completed++;
          }
          return {
            ...prev,
            progressMap: newMap,
            completedCount: completed,
            allDone: completed >= newMap.size,
          };
        });
        break;
      }
    }
  }, [applySnapshot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const pendingEntries = Array.from(queueState.entries.values()).filter(
        (entry) => !TERMINAL_QUEUE_STATUSES.has(entry.status),
      );
      if (pendingEntries.length === 0 && queueState.dependencies.length === 0) {
        localStorage.removeItem(TASK_QUEUE_KEY);
        return;
      }
      localStorage.setItem(TASK_QUEUE_KEY, JSON.stringify({
        sessionId,
        pendingEntries,
        dependencies: queueState.dependencies,
        foregroundEntryId: queueState.foregroundEntryId,
      }));
    } catch {
      // ignore local storage failures
    }
  }, [queueState, sessionId]);

  /* ─── API 操作 ─── */

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
    cancel: useCallback(
      (entryId: string) => apiAction("/cancel", { entryId }),
      [apiAction],
    ),
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
        return (json as any).cancelledCount ?? 0;
      } catch {
        return 0;
      } finally {
        setOperating(false);
      }
    }, [locale]),
    pause: useCallback(
      (entryId: string) => apiAction("/pause", { entryId }),
      [apiAction],
    ),
    resume: useCallback(
      (entryId: string) => apiAction("/resume", { entryId }),
      [apiAction],
    ),
    retry: useCallback(
      (entryId: string) => apiAction("/retry", { entryId }),
      [apiAction],
    ),
    reorder: useCallback(
      (entryId: string, newPosition: number) => apiAction("/reorder", { entryId, newPosition }),
      [apiAction],
    ),
    setPriority: useCallback(
      (entryId: string, priority: number) => apiAction("/priority", { entryId, priority }),
      [apiAction],
    ),
    setForeground: useCallback(
      (entryId: string, foreground: boolean) => apiAction("/foreground", { entryId, foreground }),
      [apiAction],
    ),
    refresh: useCallback(async () => {
      if (!sessionIdRef.current) return;
      try {
        const res = await apiFetch(
          `/orchestrator/task-queue?sessionId=${encodeURIComponent(sessionIdRef.current)}`,
          { locale },
        );
        if (!res.ok) return;
        const json = await res.json();
        applySnapshot(json as Record<string, unknown>);
      } catch {
        // ignore
      }
    }, [locale, applySnapshot]),

    /* P2-09: 依赖管理操作 */
    createDep: useCallback(async (params: {
      fromEntryId: string;
      toEntryId: string;
      depType: "finish_to_start" | "output_to_input" | "cancel_cascade";
    }): Promise<{ ok: boolean; error?: string }> => {
      setOperating(true);
      try {
        const res = await apiFetch("/orchestrator/task-queue/dep/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ sessionId: sessionIdRef.current, ...params }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({})) as any;
          return { ok: false, error: json?.message ?? "Failed" };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      } finally {
        setOperating(false);
      }
    }, [locale]),

    removeDep: useCallback(
      (depId: string) => apiAction("/dep/remove", { depId }),
      [apiAction],
    ),

    overrideDep: useCallback(
      (depId: string) => apiAction("/dep/override", { depId }),
      [apiAction],
    ),

    validateDag: useCallback(async (): Promise<{ valid: boolean; errors: string[] }> => {
      try {
        const res = await apiFetch("/orchestrator/task-queue/dep/validate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          locale,
          body: JSON.stringify({ sessionId: sessionIdRef.current }),
        });
        if (!res.ok) return { valid: false, errors: ["API error"] };
        const json = await res.json() as any;
        return { valid: json.valid ?? false, errors: json.errors ?? [] };
      } catch {
        return { valid: false, errors: ["Network error"] };
      }
    }, [locale]),
  };

  /* ─── 便捷 getter ─── */

  /** 获取前台任务 */
  const foregroundEntry = useMemo(() => queueState.foregroundEntryId
    ? queueState.entries.get(queueState.foregroundEntryId) ?? null
    : null, [queueState.foregroundEntryId, queueState.entries]);

  /** 获取所有活跃（非终态）条目，按 position 排序 */
  const activeEntries = useMemo(() => Array.from(queueState.entries.values())
    .filter((e) => !TERMINAL_QUEUE_STATUSES.has(e.status))
    .sort((a, b) => a.position - b.position), [queueState.entries]);

  /** 获取所有条目列表 */
  const allEntries = useMemo(() => Array.from(queueState.entries.values())
    .sort((a, b) => a.position - b.position), [queueState.entries]);

  /** 获取所有活跃 taskId 列表 */
  const activeTaskIds = useMemo(() => activeEntries
    .map((e) => e.taskId)
    .filter((id): id is string => !!id), [activeEntries]);

  return {
    /** 队列完整状态 */
    queueState,
    /** 多任务进度聚合 */
    multiProgress,
    /** 是否正在执行操作 */
    operating,
    /** 队列操作 */
    actions,
    /** 前台任务条目 */
    foregroundEntry,
    /** 活跃（非终态）条目列表 */
    activeEntries,
    /** 所有条目列表 */
    allEntries,
    /** 活跃 taskId 列表 */
    activeTaskIds,
    /** SSE 全局事件处理器（传给 useSessionSSE 的 onEvent） */
    handleSSEEvent,
    /** 从快照初始化（传给 useSessionSSE 的 onSnapshot） */
    applySnapshot,
  };
}
