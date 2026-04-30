"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { SchemaUiDataBinding } from "@openslin/shared";
import { apiFetch } from "@/lib/api";

export interface SchemaUiDataResult {
  data: Record<string, unknown[]>;
  loading: boolean;
  error: string | null;
}

/* ── tiny LRU (max 16 entries) ── */
const MAX_CACHE = 16;
const cache = new Map<string, { ts: number; rows: unknown[] }>();

function cacheKey(b: SchemaUiDataBinding): string {
  return `${b.entity}::${b.mode}::${JSON.stringify(b.filter ?? {})}::${
    b.sort ? `${b.sort.field}:${b.sort.order}` : ""
  }::${b.limit ?? ""}`;
}

function cacheGet(key: string, ttl = 30_000): unknown[] | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.rows;
}

function cacheSet(key: string, rows: unknown[]): void {
  if (cache.size >= MAX_CACHE) {
    // evict oldest
    let oldest: string | null = null;
    let oldestTs = Infinity;
    for (const [k, v] of cache) {
      if (v.ts < oldestTs) {
        oldest = k;
        oldestTs = v.ts;
      }
    }
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), rows });
}

/* ── fetch a single binding ── */
async function fetchBinding(b: SchemaUiDataBinding): Promise<unknown[]> {
  const key = cacheKey(b);
  const cached = cacheGet(key);
  if (cached) return cached;

  const entity = encodeURIComponent(b.entity);
  let res: Response;

  if (b.mode === "list") {
    const qs = b.limit ? `?limit=${b.limit}` : "";
    res = await apiFetch(`/api/entities/${entity}/list${qs}`);
  } else {
    res = await apiFetch(`/api/entities/${entity}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filter: b.filter ?? {},
        sort: b.sort ?? undefined,
        limit: b.limit ?? undefined,
      }),
    });
  }

  if (!res.ok) {
    throw new Error(`fetch ${b.entity} failed: ${res.status}`);
  }

  const json: any = await res.json();
  const rows: unknown[] = json?.items ?? json?.rows ?? json?.data ?? [];
  cacheSet(key, rows);
  return rows;
}

/* ── hook ── */
export function useSchemaUiData(
  bindings: SchemaUiDataBinding[] | undefined,
): SchemaUiDataResult {
  const [data, setData] = useState<Record<string, unknown[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // stable ref for bindings to avoid infinite loops
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  const stableKey = JSON.stringify(bindings ?? []);

  const load = useCallback(async () => {
    const list = bindingsRef.current;
    if (!list || list.length === 0) return;

    setLoading(true);
    setError(null);
    try {
      const result: Record<string, unknown[]> = {};
      await Promise.all(
        list.map(async (b) => {
          result[b.entity] = await fetchBinding(b);
        }),
      );
      setData(result);
    } catch (e: any) {
      setError(e?.message ?? "unknown error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stableKey]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, loading, error };
}
