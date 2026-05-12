"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { toast } from "@/shared/components/feedback/Toast";

/* ─── Types ─── */
export interface LocaleDefaults {
  tenantId: string;
  tenantDefaultLocale: string | null;
  spaceId: string | null;
  spaceDefaultLocale: string | null;
  effectiveLocale: string;
}

export interface DisplayPrefs {
  theme: "light" | "dark" | "system";
  sidebarCollapsed: boolean;
  compact: boolean;
}

const DISPLAY_PREFS_DEFAULTS: DisplayPrefs = {
  theme: "system",
  sidebarCollapsed: false,
  compact: false,
};

/* ─── Locale Query ─── */
export function useLocaleDefaults() {
  return useQuery<LocaleDefaults>({
    queryKey: ["settings", "locale-defaults"],
    queryFn: async () => {
      const res = await apiFetch("/settings/locale-defaults");
      if (!res.ok) throw new Error(`获取语言设置失败 (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });
}

/* ─── Tenant Locale Mutation ─── */
export function useTenantLocaleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (defaultLocale: string) => {
      const res = await apiFetch("/settings/tenant-locale", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultLocale }),
      });
      if (!res.ok) throw new Error(`更新租户语言失败 (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "locale-defaults"] });
      toast.success("租户语言已更新");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

/* ─── Space Locale Mutation ─── */
export function useSpaceLocaleMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (defaultLocale: string) => {
      const res = await apiFetch("/settings/space-locale", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultLocale }),
      });
      if (!res.ok) throw new Error(`更新空间语言失败 (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "locale-defaults"] });
      toast.success("空间语言已更新");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

/* ─── Display Prefs (user-view-configs) ─── */
export function useDisplayPrefs() {
  return useQuery<DisplayPrefs>({
    queryKey: ["settings", "display-prefs"],
    queryFn: async () => {
      const res = await apiFetch("/user-view-configs?targetType=settings");
      if (!res.ok) throw new Error(`获取显示偏好失败 (${res.status})`);
      const data = await res.json();
      const cfg = data.configs?.find(
        (c: { targetId: string }) => c.targetId === "display-prefs",
      );
      if (!cfg?.layout) return DISPLAY_PREFS_DEFAULTS;
      return { ...DISPLAY_PREFS_DEFAULTS, ...cfg.layout } as DisplayPrefs;
    },
    staleTime: 60_000,
  });
}

export function useDisplayPrefsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (prefs: Partial<DisplayPrefs>) => {
      const res = await apiFetch("/user-view-configs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetType: "settings",
          targetId: "display-prefs",
          layout: prefs,
        }),
      });
      if (!res.ok) throw new Error(`更新显示偏好失败 (${res.status})`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "display-prefs"] });
      toast.success("显示偏好已保存");
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
