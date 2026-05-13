"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import type { Node, Edge } from "@xyflow/react";
import type { MemoryNodeData, MemoryEdgeData, MemoryClass } from "../types";

/* ─── Filter Options ─── */
export interface MemoryGraphFilter {
  class?: MemoryClass;
  limit?: number;
  minConfidence?: number;
  offset?: number;
}

/* ─── API Response ─── */
interface MemoryGraphResponse {
  nodes: MemoryNodeData[];
  edges: MemoryEdgeData[];
  total: number;
}

/* ─── Circular layout helper ─── */
function computeCircularLayout(nodes: MemoryNodeData[]): Node[] {
  const count = nodes.length;
  if (count === 0) return [];
  const radius = Math.max(300, count * 20);
  const cx = radius + 100;
  const cy = radius + 100;

  return nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / count;
    return {
      id: node.id,
      type: "memoryNode",
      position: {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      },
      data: node as unknown as Record<string, unknown>,
    };
  });
}

/* ─── Transform edges ─── */
function transformEdges(edges: MemoryEdgeData[]): Edge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "memoryEdge",
    data: { edgeType: edge.type, weight: edge.weight },
  }));
}

/* ─── Hook ─── */
export function useMemoryGraph(filter: MemoryGraphFilter = {}) {
  const { class: memClass, limit = 200, minConfidence = 0.3, offset = 0 } = filter;

  const queryKey = ["memory-graph", memClass, limit, minConfidence, offset];

  const { data, isLoading, error, refetch } = useQuery<{
    nodes: Node[];
    edges: Edge[];
    total: number;
  }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (memClass) params.set("class", memClass);
      params.set("limit", String(limit));
      params.set("minConfidence", String(minConfidence));
      params.set("offset", String(offset));

      const res = await apiFetch(`/memory/graph?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }
      const json = (await res.json()) as MemoryGraphResponse;
      const nodes = computeCircularLayout(json.nodes);
      const edges = transformEdges(json.edges);
      return { nodes, edges, total: json.total };
    },
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
  });

  return {
    nodes: data?.nodes ?? [],
    edges: data?.edges ?? [],
    total: data?.total ?? 0,
    isLoading,
    error: error as Error | null,
    refetch,
  };
}
