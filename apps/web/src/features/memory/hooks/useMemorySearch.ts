"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */
export interface MemorySearchItem {
  id: string;
  title: string;
  contentText: string;
  memoryClass: "episodic" | "semantic" | "procedural";
  confidence: number;
  decayScore: number;
  createdAt: string;
}

export interface MemorySearchResult {
  items: MemorySearchItem[];
  total: number;
}

export interface MemorySearchParams {
  q: string;
  class?: string;
  limit?: number;
  offset?: number;
}

/* ─── Hook ─── */
export function useMemorySearch(params: MemorySearchParams) {
  const { q, class: memoryClass, limit = 20, offset = 0 } = params;

  return useQuery<MemorySearchResult>({
    queryKey: ["memory", "search", q, memoryClass, limit, offset],
    queryFn: async () => {
      const searchParams = new URLSearchParams();
      searchParams.set("q", q);
      if (memoryClass) searchParams.set("class", memoryClass);
      searchParams.set("limit", String(limit));
      searchParams.set("offset", String(offset));

      const res = await apiFetch(`/memory/search?${searchParams.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to search memory: ${res.status}`);
      }
      return res.json() as Promise<MemorySearchResult>;
    },
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });
}
