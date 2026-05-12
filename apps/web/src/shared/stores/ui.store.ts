import { create } from 'zustand';

interface UiState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  theme: 'light' | 'dark' | 'system';
  activePanel: string | null;
}

interface UiActions {
  toggleSidebar: () => void;
  setSidebarCollapsed: (v: boolean) => void;
  toggleCommandPalette: () => void;
  setTheme: (t: 'light' | 'dark' | 'system') => void;
  setActivePanel: (p: string | null) => void;
}

export const useUiStore = create<UiState & UiActions>()((set) => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  theme: 'system',
  activePanel: null,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
  setTheme: (t) => set({ theme: t }),
  setActivePanel: (p) => set({ activePanel: p }),
}));
