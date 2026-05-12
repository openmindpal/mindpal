"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */
export interface MemoryClassStats {
  count: number;
  avgConfidence: number;
}

export interface DecayBucket {
  range: string;
  count: number;
}

export interface ActivityEntry {
  date: string;
  created: number;
  decayed: number;
}

export interface MemoryStatsData {
  totalByClass: {
    episodic: MemoryClassStats;
    semantic: MemoryClassStats;
    procedural: MemoryClassStats;
  };
  decayDistribution: DecayBucket[];
  recentActivity: ActivityEntry[];
}

/* ─── Hook ─── */
export function useMemoryStats() {
  return useQuery<MemoryStatsData>({
    queryKey: ["memory", "stats"],
    queryFn: async () => {
      const res = await apiFetch("/memory/stats");
      if (!res.ok) {
        throw new Error(`Failed to fetch memory stats: ${res.status}`);
      }
      return res.json() as Promise<MemoryStatsData>;
    },
    staleTime: 60_000,
  });
}
