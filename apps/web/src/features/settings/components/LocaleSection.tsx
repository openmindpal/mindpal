"use client";

import { useLocaleDefaults, useTenantLocaleMutation, useSpaceLocaleMutation } from "../hooks/useSettings";
import { usePreferencesStore } from "@/shared/stores/preferences.store";
import { setLocale } from "@/shared/lib/api";
import { Skeleton } from "@/shared/components/primitives/Skeleton";

const LOCALE_OPTIONS = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
] as const;

const SPACE_LOCALE_OPTIONS = [
  { value: "__follow__", label: "跟随租户" },
  ...LOCALE_OPTIONS,
] as const;

export function LocaleSection() {
  const { data, isLoading } = useLocaleDefaults();
  const tenantMutation = useTenantLocaleMutation();
  const spaceMutation = useSpaceLocaleMutation();
  const { locale: uiLocale, setLocale: setStoreLocale } = usePreferencesStore();

  const handleUiLocaleChange = (value: string) => {
    const v = value as "zh-CN" | "en-US";
    setStoreLocale(v);
    setLocale(v);
  };

  const handleTenantLocaleChange = (value: string) => {
    tenantMutation.mutate(value);
  };

  const handleSpaceLocaleChange = (value: string) => {
    const localeValue = value === "__follow__" ? (data?.tenantDefaultLocale ?? "zh-CN") : value;
    spaceMutation.mutate(localeValue);
  };

  return (
    <section className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-0)] p-5">
      <h2 className="mb-4 text-base font-medium text-[var(--color-text)]">语言与区域</h2>

      <div className="space-y-4">
        {/* UI Locale */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-[var(--color-text-secondary)]">界面语言</label>
          <select
            value={uiLocale}
            onChange={(e) => handleUiLocaleChange(e.target.value)}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
          >
            {LOCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Tenant Locale */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-[var(--color-text-secondary)]">租户语言</label>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <select
              value={data?.tenantDefaultLocale ?? "zh-CN"}
              onChange={(e) => handleTenantLocaleChange(e.target.value)}
              disabled={tenantMutation.isPending}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:opacity-50"
            >
              {LOCALE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
        </div>

        {/* Space Locale */}
        <div className="flex items-center justify-between">
          <label className="text-sm text-[var(--color-text-secondary)]">空间语言</label>
          {isLoading ? (
            <Skeleton className="h-8 w-24" />
          ) : (
            <select
              value={
                data?.spaceDefaultLocale === data?.tenantDefaultLocale || !data?.spaceDefaultLocale
                  ? "__follow__"
                  : data.spaceDefaultLocale
              }
              onChange={(e) => handleSpaceLocaleChange(e.target.value)}
              disabled={spaceMutation.isPending || !data?.spaceId}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 disabled:opacity-50"
            >
              {SPACE_LOCALE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          )}
        </div>
      </div>
    </section>
  );
}
