"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";

/* ─── Types ─── */

export interface SchemaInfo {
  id: string;
  name: string;
  version: number;
  status: string;
  schema: {
    name: string;
    entities: Record<string, { displayName?: Record<string, string>; fields: Record<string, { type: string; displayName?: Record<string, string> }> }>;
  };
  createdAt: string;
  publishedAt: string | null;
}

export interface EntityRecord {
  id: string;
  tenantId: string;
  spaceId: string | null;
  entityName: string;
  schemaName: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  ownerSubjectId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

/* ─── useSchemaList ─── */
export function useSchemaList() {
  const { data, isLoading, error } = useQuery<{ schemas: SchemaInfo[] }>({
    queryKey: ["schemas"],
    queryFn: async () => {
      const res = await apiFetch("/schemas");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  return {
    schemas: data?.schemas ?? [],
    isLoading,
    error: error as Error | null,
  };
}

/* ─── useEntityList ─── */
export function useEntityList(entityName: string | null) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(20);

  const setPageSize = useCallback((size: number) => {
    setPageSizeRaw(size);
    setPage(1);
  }, []);

  const queryKey = ["entities", entityName, page, pageSize] as const;

  const { data, isLoading, error, refetch } = useQuery<{ items: EntityRecord[] }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(pageSize));
      const res = await apiFetch(`/entities/${entityName}?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!entityName,
    staleTime: 15_000,
  });

  return {
    items: data?.items ?? [],
    isLoading,
    error: error as Error | null,
    page,
    pageSize,
    setPage,
    setPageSize,
    refetch,
  };
}

/* ─── useEntityDetail ─── */
export function useEntityDetail(entityName: string | null, entityId: string | null) {
  const { data, isLoading, error } = useQuery<EntityRecord>({
    queryKey: ["entity-detail", entityName, entityId],
    queryFn: async () => {
      const res = await apiFetch(`/entities/${entityName}/${entityId}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    enabled: !!entityName && !!entityId,
    staleTime: 15_000,
  });

  return {
    record: data ?? null,
    isLoading,
    error: error as Error | null,
  };
}

/* ─── useCreateEntity ─── */
export function useCreateEntity(entityName: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const idempotencyKey = crypto.randomUUID();
      const res = await apiFetch(`/entities/${entityName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        idempotencyKey,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.message?.["zh-CN"] ?? `API error: ${res.status}`);
      }
      return res.json() as Promise<EntityRecord>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entities", entityName] });
    },
  });
}

/* ─── useUpdateEntity ─── */
export function useUpdateEntity(entityName: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const idempotencyKey = crypto.randomUUID();
      const res = await apiFetch(`/entities/${entityName}/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        idempotencyKey,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.message?.["zh-CN"] ?? `API error: ${res.status}`);
      }
      return res.json() as Promise<EntityRecord>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entities", entityName] });
    },
  });
}

/* ─── useDeleteEntity ─── */
export function useDeleteEntity(entityName: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const idempotencyKey = crypto.randomUUID();
      const res = await apiFetch(`/entities/${entityName}/${id}`, {
        method: "DELETE",
        idempotencyKey,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.message?.["zh-CN"] ?? `API error: ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entities", entityName] });
    },
  });
}
