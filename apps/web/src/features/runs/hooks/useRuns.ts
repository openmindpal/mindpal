"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */

export interface RunProgress {
  current: number;
  total: number;
  percentage: number;
}

export interface RunCurrentStep {
  stepId: string;
  seq: number;
  status: string;
  toolRef: string | null;
  name: string | null;
  attempt: number;
}

export interface RunSummary {
  runId: string;
  status: string;
  phase: string | null;
  createdAt: string;
  updatedAt: string;
  traceId: string | null;
  trigger: string | null;
  jobType: string | null;
  progress: RunProgress;
  currentStep: RunCurrentStep | null;
  durationMs: number | null;
  outputDigest: unknown | null;
  errorDigest: { errorCategory: string | null; message: string | null } | null;
  [key: string]: unknown;
}

export interface RunStep {
  stepId: string;
  seq: number;
  status: string;
  toolRef: string | null;
  inputDigest: unknown | null;
  outputDigest: unknown | null;
  errorCategory: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface RunDetail extends RunSummary {
  steps: RunStep[];
  blockReason: string | null;
  nextAction: string | null;
  createdBySubjectId: string | null;
  idempotencyKey: string | null;
}

/* ─── useRunList ─── */
export function useRunList() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(size);
    setPage(1);
  }, []);

  const queryKey = ["runs", page, pageSize, statusFilter] as const;

  const { data, isLoading, error, refetch } = useQuery<{ runs: RunSummary[] }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await apiFetch(`/runs?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 15_000,
  });

  return {
    runs: data?.runs ?? [],
    isLoading,
    error: error as Error | null,
    page,
    pageSize,
    setPage,
    setPageSize,
    statusFilter,
    setStatusFilter,
    refetch,
  };
}

/* ─── useActiveRuns ─── */
export function useActiveRuns() {
  const { data, isLoading, error } = useQuery<{ activeRuns: RunSummary[] }>({
    queryKey: ["runs-active"],
    queryFn: async () => {
      const res = await apiFetch("/runs/active?limit=50");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  return {
    activeRuns: data?.activeRuns ?? [],
    activeCount: data?.activeRuns?.length ?? 0,
    isLoading,
    error: error as Error | null,
  };
}

/* ─── useRunDetail ─── */
export function useRunDetail(runId: string | null) {
  const { data, isLoading, error } = useQuery<RunDetail>({
    queryKey: ["run-detail", runId],
    queryFn: async () => {
      const res = await apiFetch(`/runs/${runId}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!runId,
    staleTime: 10_000,
  });

  return {
    detail: data ?? null,
    steps: data?.steps ?? [],
    isLoading,
    error: error as Error | null,
  };
}

/* ─── useCancelRun ─── */
export function useCancelRun() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiFetch(`/runs/${runId}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["runs-active"] });
      queryClient.invalidateQueries({ queryKey: ["run-detail"] });
    },
  });
}

/* ─── useReexecRun ─── */
export function useReexecRun() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (runId: string) => {
      const res = await apiFetch(`/runs/${runId}/reexec`, { method: "POST" });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["runs-active"] });
    },
  });
}
