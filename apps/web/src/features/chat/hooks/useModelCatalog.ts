"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */

export interface ModelCatalogItem {
  id: string;
  name: string;
  provider?: string;
  capabilities?: string[];
}

interface BindingApiEntry {
  modelRef: string;
  provider: string;
  model: string;
  baseUrl?: string;
  status?: string;
}

interface BindingsApiResponse {
  scope: { scopeType: string; scopeId: string };
  bindings: BindingApiEntry[];
}

/* ─── 默认模型（当系统未绑定任何模型时展示） ─── */

const DEFAULT_MODEL: ModelCatalogItem = {
  id: "__default__",
  name: "默认模型",
};

/* ─── Transform ─── */

function transformBinding(entry: BindingApiEntry): ModelCatalogItem {
  // Display name: capitalize provider + model name
  const displayName = entry.model
    ? `${entry.model}`
    : entry.modelRef;

  return {
    id: entry.modelRef,
    name: displayName,
    provider: entry.provider,
  };
}

/* ─── Hook ─── */

export function useModelCatalog() {
  const { data, isLoading, error } = useQuery<ModelCatalogItem[]>({
    queryKey: ["model-bindings"],
    queryFn: async () => {
      const res = await apiFetch("/models/bindings");
      if (!res.ok) {
        throw new Error(`Failed to fetch model bindings: ${res.status}`);
      }
      const json = (await res.json()) as BindingsApiResponse;
      const bindings = json.bindings ?? [];
      // Only include enabled bindings
      const enabled = bindings.filter(
        (b) => !b.status || b.status === "enabled"
      );
      return enabled.map(transformBinding);
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const models = data ?? [];

  return {
    models,
    defaultModel: DEFAULT_MODEL,
    hasModels: models.length > 0,
    isLoading,
    error: error as Error | null,
  };
}
