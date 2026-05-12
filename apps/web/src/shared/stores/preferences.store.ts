import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface PreferencesState {
  locale: 'zh-CN' | 'en-US';
  layoutDensity: 'comfortable' | 'compact';
}

interface PreferencesActions {
  setLocale: (l: 'zh-CN' | 'en-US') => void;
  setLayoutDensity: (d: 'comfortable' | 'compact') => void;
}

export const usePreferencesStore = create<PreferencesState & PreferencesActions>()(
  persist(
    (set) => ({
      locale: 'zh-CN',
      layoutDensity: 'comfortable',

      setLocale: (l) => set({ locale: l }),
      setLayoutDensity: (d) => set({ layoutDensity: d }),
    }),
    {
      name: 'mindpal_preferences',
    },
  ),
);
