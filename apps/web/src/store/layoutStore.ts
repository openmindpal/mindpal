import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { WorkspaceTab } from "../app/homeHelpers";

/* ─── SSR-safe JSON storage factory ─── */

function ssrSafeStorage() {
  return createJSONStorage(() => {
    if (typeof window === "undefined") {
      return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    }
    return localStorage;
  });
}

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Split-layout store                                                    */
/* ═══════════════════════════════════════════════════════════════════════ */

const SPLIT_KEY = "mindpal_split_layout";

interface SplitLayoutState {
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;

  setLeftWidth: (v: number | ((p: number) => number)) => void;
  setLeftCollapsed: (v: boolean | ((p: boolean) => boolean)) => void;
  setRightCollapsed: (v: boolean | ((p: boolean) => boolean)) => void;
}

export const useSplitLayoutStore = create<SplitLayoutState>()(
  persist(
    (set) => ({
      leftWidth: 50,
      leftCollapsed: false,
      rightCollapsed: false,

      setLeftWidth: (v) =>
        set((s) => ({ leftWidth: typeof v === "function" ? v(s.leftWidth) : v })),
      setLeftCollapsed: (v) =>
        set((s) => ({ leftCollapsed: typeof v === "function" ? v(s.leftCollapsed) : v })),
      setRightCollapsed: (v) =>
        set((s) => ({ rightCollapsed: typeof v === "function" ? v(s.rightCollapsed) : v })),
    }),
    {
      name: SPLIT_KEY,
      storage: ssrSafeStorage(),
      partialize: (s) => ({
        leftWidth: s.leftWidth,
        leftCollapsed: s.leftCollapsed,
        rightCollapsed: s.rightCollapsed,
      }),
    },
  ),
);

/* ═══════════════════════════════════════════════════════════════════════ */
/*  Workspace-tabs store                                                  */
/* ═══════════════════════════════════════════════════════════════════════ */

const WORKSPACE_KEY = "mindpal_workspace_tabs";

interface WorkspaceTabsState {
  pinnedTabs: WorkspaceTab[];
  activeTabId: string | null;

  setPinnedTabs: (v: WorkspaceTab[] | ((p: WorkspaceTab[]) => WorkspaceTab[])) => void;
  setActiveTabId: (v: string | null | ((p: string | null) => string | null)) => void;
}

export const useWorkspaceTabsStore = create<WorkspaceTabsState>()(
  persist(
    (set) => ({
      pinnedTabs: [],
      activeTabId: null,

      setPinnedTabs: (v) =>
        set((s) => ({
          pinnedTabs: typeof v === "function" ? v(s.pinnedTabs) : v,
        })),
      setActiveTabId: (v) =>
        set((s) => ({
          activeTabId: typeof v === "function" ? v(s.activeTabId) : v,
        })),
    }),
    {
      name: WORKSPACE_KEY,
      storage: ssrSafeStorage(),
      partialize: (s) => ({
        pinnedTabs: s.pinnedTabs,
        activeTabId: s.activeTabId,
      }),
    },
  ),
);
