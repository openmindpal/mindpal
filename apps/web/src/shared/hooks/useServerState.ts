"use client";

import { useQuery } from '@tanstack/react-query';

export function useServerState<T>(
  key: string[],
  fetcher: () => Promise<T>,
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: fetcher,
    enabled: options?.enabled,
    refetchInterval: options?.refetchInterval,
  });
}

export function usePollableState<T>(
  key: string[],
  fetcher: () => Promise<T>,
  intervalMs: number,
) {
  return useServerState<T>(key, fetcher, {
    refetchInterval: intervalMs,
  });
}
