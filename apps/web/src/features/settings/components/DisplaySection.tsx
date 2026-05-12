"use client";

import { useDisplayPrefs, useDisplayPrefsMutation, type DisplayPrefs } from "../hooks/useSettings";
import { useUiStore } from "@/shared/stores/ui.store";
import { usePreferencesStore } from "@/shared/stores/preferences.store";
import { Skeleton } from "@/shared/components/primitives/Skeleton";

const THEME_OPTIONS = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;

export function DisplaySection() {
  const { data, isLoading } = useDisplayPrefs();
  const mutation = useDisplayPrefsMutation();
  const { theme, sidebarCollapsed, setTheme, setSidebarCollapsed } = useUiStore();
  const { layoutDensity, setLayoutDensity } = usePreferencesStore();

  const compact = layoutDensity === "compact";

  const saveAndApply = (patch: Partial<DisplayPrefs>) => {
    mutation.mutate(patch);
  };

  const handleThemeChange = (value: string) => {
    const v = value as DisplayPrefs["theme"];
    setTheme(v);
    saveAndApply({ theme: v });
  };

  const handleSidebarChange = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    saveAndApply({ sidebarCollapsed: collapsed });
  };

  const handleCompactToggle = () => {
    const next = compact ? "comfortable" : "compact";
    setLayoutDensity(next);
    saveAndApply({ compact: next === "compact" });
  };

  if (isLoading) {
    return (
      <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
        <h2 className="mb-4 text-base font-medium text-[var(--color-text)]">显示偏好</h2>
        <div className="space-y-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
      <h2 className="mb-4 text-base font-medium text-[var(--color-text)]">显示偏好</h2>

      <div className="space-y-4">
        {/* Theme */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-[var(--color-text-secondary)]">主题</label>
          <select
            value={theme}
            onChange={(e) => handleThemeChange(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
          >
            {THEME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Sidebar */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-[var(--color-text-secondary)]">侧边栏</label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => handleSidebarChange(false)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                !sidebarCollapsed
                  ? "bg-[var(--color-primary)] text-white"
                  : "border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
              }`}
            >
              展开
            </button>
            <button
              type="button"
              onClick={() => handleSidebarChange(true)}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                sidebarCollapsed
                  ? "bg-[var(--color-primary)] text-white"
                  : "border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-sunken)]"
              }`}
            >
              折叠
            </button>
          </div>
        </div>

        {/* Compact mode */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-[var(--color-text-secondary)]">紧凑模式</label>
          <button
            type="button"
            role="switch"
            aria-checked={compact}
            onClick={handleCompactToggle}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
              compact ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                compact ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}
