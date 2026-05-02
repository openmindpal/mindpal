import { create } from "zustand";
import type { TaskState } from "@/lib/types";
import type { TaskProgress } from "../app/homeHelpers";

/* ─── Types ─── */

/** Single active-task entry (multi-task map value) */
export type ActiveTaskEntry = {
  taskId: string;
  runId: string;
  taskState: TaskState;
  progress: TaskProgress | null;
  /** Whether polling is active */
  polling: boolean;
};

interface TaskStoreState {
  /* ── single-task compat (legacy) ── */
  activeTask: { taskId: string; runId: string; taskState: TaskState } | null;
  taskProgress: TaskProgress | null;

  /* ── multi-task map ── */
  activeTasksMap: Map<string, ActiveTaskEntry>;

  /* ── actions ── */
  setActiveTask: (
    updater:
      | ({ taskId: string; runId: string; taskState: TaskState } | null)
      | ((prev: { taskId: string; runId: string; taskState: TaskState } | null) => { taskId: string; runId: string; taskState: TaskState } | null),
  ) => void;
  setTaskProgress: (
    updater: TaskProgress | null | ((prev: TaskProgress | null) => TaskProgress | null),
  ) => void;
  setActiveTasksMap: (
    updater: Map<string, ActiveTaskEntry> | ((prev: Map<string, ActiveTaskEntry>) => Map<string, ActiveTaskEntry>),
  ) => void;
  /** Convenience: update a single entry inside activeTasksMap */
  updateTaskEntry: (taskId: string, patch: Partial<ActiveTaskEntry>) => void;
  /** Remove an entry from activeTasksMap */
  removeTaskEntry: (taskId: string) => ActiveTaskEntry | undefined;
}

/* ─── Store (no persist — task state is ephemeral) ─── */

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  activeTask: null,
  taskProgress: null,
  activeTasksMap: new Map(),

  setActiveTask: (updater) =>
    set((s) => ({
      activeTask: typeof updater === "function" ? updater(s.activeTask) : updater,
    })),

  setTaskProgress: (updater) =>
    set((s) => ({
      taskProgress: typeof updater === "function" ? updater(s.taskProgress) : updater,
    })),

  setActiveTasksMap: (updater) =>
    set((s) => ({
      activeTasksMap: typeof updater === "function" ? updater(s.activeTasksMap) : updater,
    })),

  updateTaskEntry: (taskId, patch) => {
    const prev = get().activeTasksMap;
    const existing = prev.get(taskId);
    if (!existing) return;
    const newMap = new Map(prev);
    newMap.set(taskId, { ...existing, ...patch });
    set({ activeTasksMap: newMap });
  },

  removeTaskEntry: (taskId) => {
    const prev = get().activeTasksMap;
    const existing = prev.get(taskId);
    if (!existing) return undefined;
    const newMap = new Map(prev);
    newMap.delete(taskId);
    set({ activeTasksMap: newMap });
    return existing;
  },
}));
