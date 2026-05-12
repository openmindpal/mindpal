"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */

export type QueueEntryStatus =
  | "queued"
  | "ready"
  | "executing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "preempted";

export interface TaskQueueEntry {
  entryId: string;
  tenantId: string;
  spaceId: string | null;
  sessionId: string;
  taskId: string | null;
  runId: string | null;
  jobId: string | null;
  goal: string;
  mode: "answer" | "execute" | "collab";
  priority: number;
  position: number;
  status: QueueEntryStatus;
  foreground: boolean;
  enqueuedAt: string;
  readyAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  estimatedDurationMs: number | null;
  retryCount: number;
  lastError: string | null;
  checkpointRef: string | null;
  createdBySubjectId: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface TaskDependency {
  depId: string;
  tenantId: string;
  sessionId: string;
  fromEntryId: string;
  toEntryId: string;
  depType: "finish_to_start" | "output_to_input" | "cancel_cascade";
  status: "pending" | "resolved" | "blocked" | "overridden";
  outputMapping: Record<string, string> | null;
  source: "auto" | "manual" | "system";
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueSnapshot {
  sessionId: string;
  entries: TaskQueueEntry[];
  dependencies: TaskDependency[];
  activeCount: number;
  queuedCount: number;
  foregroundEntryId: string | null;
}

/* ─── useTaskQueueSnapshot ─── */
export function useTaskQueueSnapshot(sessionId: string) {
  const { data, isLoading, error, refetch } = useQuery<QueueSnapshot>({
    queryKey: ["task-queue", sessionId],
    queryFn: async () => {
      const params = new URLSearchParams({ sessionId });
      const res = await apiFetch(`/orchestrator/task-queue?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      return json as QueueSnapshot;
    },
    enabled: !!sessionId,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

  return {
    entries: data?.entries ?? [],
    dependencies: data?.dependencies ?? [],
    activeCount: data?.activeCount ?? 0,
    queuedCount: data?.queuedCount ?? 0,
    foregroundEntryId: data?.foregroundEntryId ?? null,
    isLoading,
    error: error as Error | null,
    refetch,
  };
}

/* ─── useTaskQueueHistory ─── */
export function useTaskQueueHistory(sessionId: string) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(20);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(size);
    setPage(1);
  }, []);

  const queryKey = ["task-queue-history", sessionId, page, pageSize, statusFilter] as const;

  const { data, isLoading, error, refetch } = useQuery<{ entries: TaskQueueEntry[]; total: number }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ sessionId });
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await apiFetch(`/orchestrator/task-queue/history?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!sessionId,
    staleTime: 15_000,
  });

  return {
    entries: data?.entries ?? [],
    total: data?.total ?? 0,
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

/* ─── useCancelTask ─── */
export function useCancelTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await apiFetch("/orchestrator/task-queue/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-queue"] });
      queryClient.invalidateQueries({ queryKey: ["task-queue-history"] });
    },
  });
}

/* ─── usePauseTask ─── */
export function usePauseTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await apiFetch("/orchestrator/task-queue/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-queue"] });
      queryClient.invalidateQueries({ queryKey: ["task-queue-history"] });
    },
  });
}

/* ─── useResumeTask ─── */
export function useResumeTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await apiFetch("/orchestrator/task-queue/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-queue"] });
      queryClient.invalidateQueries({ queryKey: ["task-queue-history"] });
    },
  });
}

/* ─── useRetryTask ─── */
export function useRetryTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entryId: string) => {
      const res = await apiFetch("/orchestrator/task-queue/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entryId }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["task-queue"] });
      queryClient.invalidateQueries({ queryKey: ["task-queue-history"] });
    },
  });
}
