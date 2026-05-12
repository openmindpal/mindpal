"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */
export interface Task {
  taskId: string;
  tenantId: string;
  spaceId: string | null;
  title: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface TaskRun {
  runId: string;
  status: string;
  jobType: string | null;
  toolRef: string | null;
  traceId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  [key: string]: unknown;
}

export interface TaskMessage {
  messageId: string;
  taskId: string;
  from: { agentId?: string; role: string };
  intent: string;
  inputs: Record<string, unknown> | null;
  outputs: Record<string, unknown> | null;
  createdAt: string;
  [key: string]: unknown;
}

export interface LongTask {
  task: Task;
  run: TaskRun | null;
  progress: { phase: string | null };
  controls: { canCancel: boolean; canContinue: boolean; needsApproval: boolean };
}

/* ─── useTaskList ─── */
export function useTaskList() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(20);

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(size);
    setPage(1);
  }, []);

  const queryKey = ["tasks", page, pageSize] as const;

  const { data, isLoading, error, refetch } = useQuery<{ tasks: Task[] }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      params.set("offset", String((page - 1) * pageSize));
      const res = await apiFetch(`/tasks?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  return {
    tasks: data?.tasks ?? [],
    isLoading,
    error: error as Error | null,
    page,
    pageSize,
    setPage,
    setPageSize,
    refetch,
  };
}

/* ─── useTaskDetail ─── */
export function useTaskDetail(taskId: string | null) {
  const { data, isLoading, error } = useQuery<{ task: Task; runs: TaskRun[] }>({
    queryKey: ["task-detail", taskId],
    queryFn: async () => {
      const res = await apiFetch(`/tasks/${taskId}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!taskId,
    staleTime: 15_000,
  });

  return {
    task: data?.task ?? null,
    runs: data?.runs ?? [],
    isLoading,
    error: error as Error | null,
  };
}

/* ─── useTaskMessages ─── */
export function useTaskMessages(taskId: string | null) {
  const { data, isLoading, error } = useQuery<{ messages: TaskMessage[] }>({
    queryKey: ["task-messages", taskId],
    queryFn: async () => {
      const res = await apiFetch(`/tasks/${taskId}/messages?limit=50`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!taskId,
    staleTime: 15_000,
  });

  return {
    messages: data?.messages ?? [],
    isLoading,
    error: error as Error | null,
  };
}

/* ─── useCreateTask ─── */
export function useCreateTask() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { title?: string }) => {
      const res = await apiFetch("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: params.title }),
      });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<{ task: Task }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
