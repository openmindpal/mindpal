import { create } from "zustand";

interface AppState {
  // 运行状态
  activeRunId: string | null;
  runList: Array<{ id: string; status: string; title?: string }>;
  setActiveRun: (runId: string | null) => void;
  setRunList: (runs: Array<{ id: string; status: string; title?: string }>) => void;

  // UI 状态
  sidebarOpen: boolean;
  commandPaletteOpen: boolean;
  toggleSidebar: () => void;
  toggleCommandPalette: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeRunId: null,
  runList: [],
  setActiveRun: (runId) => set({ activeRunId: runId }),
  setRunList: (runs) => set({ runList: runs }),

  sidebarOpen: true,
  commandPaletteOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
}));
