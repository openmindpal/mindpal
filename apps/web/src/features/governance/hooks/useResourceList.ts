"use client";

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import type { PaginationState, SortState } from "../types";

/* ─── Options ─── */
interface UseResourceListOptions {
  endpoint: string;
  responseKey?: string;
  enabled?: boolean;
}

/* ─── Return type ─── */
interface UseResourceListReturn<T> {
  data: T[];
  isLoading: boolean;
  error: Error | null;
  pagination: PaginationState;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
  sort: SortState | null;
  setSort: (sort: SortState) => void;
  search: string;
  setSearch: (q: string) => void;
  filters: Record<string, string>;
  setFilters: (filters: Record<string, string>) => void;
  refetch: () => void;
}

/* ─── Hook ─── */
function useResourceList<T = Record<string, unknown>>(
  options: UseResourceListOptions,
): UseResourceListReturn<T> {
  const { endpoint, responseKey = "items", enabled = true } = options;

  /* Local state */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(20);
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearchRaw] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});

  /* Reset to page 1 when search / pageSize changes */
  const setSearch = useCallback((q: string) => {
    setSearchRaw(q);
    setPage(1);
  }, []);

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(size);
    setPage(1);
  }, []);

  /* Build query params */
  const queryKey = [endpoint, page, pageSize, sort, search, filters] as const;

  const { data: queryData, isLoading, error, refetch } = useQuery<{
    items: T[];
    total: number;
  }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      if (sort) params.set("sort", `${sort.key}:${sort.direction}`);
      if (search) params.set("search", search);
      Object.entries(filters).forEach(([k, v]) => {
        if (v) params.set(k, v);
      });

      const sep = endpoint.includes("?") ? "&" : "?";
      const res = await apiFetch(`${endpoint}${sep}${params.toString()}`);
      if (!res.ok) {
        throw new Error(`API error: ${res.status}`);
      }
      const json = (await res.json()) as Record<string, unknown>;
      const items = (json[responseKey] ?? json["data"] ?? []) as T[];
      const total =
        typeof json["total"] === "number"
          ? json["total"]
          : typeof json["count"] === "number"
            ? json["count"]
            : items.length;
      return { items, total };
    },
    enabled,
    staleTime: 30_000,
  });

  return {
    data: queryData?.items ?? [],
    isLoading,
    error: error as Error | null,
    pagination: {
      page,
      pageSize,
      total: queryData?.total ?? 0,
    },
    setPage,
    setPageSize,
    sort,
    setSort,
    search,
    setSearch,
    filters,
    setFilters,
    refetch,
  };
}

export { useResourceList, type UseResourceListOptions, type UseResourceListReturn };
