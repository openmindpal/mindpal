"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

export interface UsePaginatedListOptions<T> {
  /** 获取分页数据的函数，由调用方负责构造请求 */
  fetchFn: (params: { limit: number; offset: number }) => Promise<T[]>;
  /** 每页条数，默认 20 */
  pageSize?: number;
  /** 初始数据（SSR / 首次加载传入） */
  initialData?: T[];
}

export interface UsePaginatedListReturn<T> {
  data: T[];
  page: number;
  setPage: React.Dispatch<React.SetStateAction<number>>;
  pageSize: number;
  busy: boolean;
  error: string;
  setError: (e: string) => void;
  refresh: () => Promise<void>;
  hasMore: boolean;
}

/**
 * usePaginatedList — 通用分页列表 Hook
 *
 * 封装 page / pageSize / busy / error / data 状态，
 * 页码变化时自动触发 fetchFn 刷新。
 */
export function usePaginatedList<T>(options: UsePaginatedListOptions<T>): UsePaginatedListReturn<T> {
  const { fetchFn, pageSize = 20, initialData } = options;

  const [data, setData] = useState<T[]>(initialData ?? []);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fetchRef = useRef(fetchFn);
  fetchRef.current = fetchFn;

  const refresh = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const rows = await fetchRef.current({ limit: pageSize, offset: page * pageSize });
      setData(rows);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }, [page, pageSize]);

  /* 页码变化时自动刷新（跳过首次渲染） */
  const initialized = useRef(false);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      return;
    }
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const hasMore = data.length >= pageSize;

  return { data, page, setPage, pageSize, busy, error, setError, refresh, hasMore };
}
