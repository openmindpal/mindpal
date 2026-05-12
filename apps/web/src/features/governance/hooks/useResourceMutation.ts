"use client";

import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { toast } from "@/shared/components/feedback/Toast";

/* ─── Options ─── */
interface UseResourceMutationOptions {
  endpoint: string;
  listQueryKey: string[];
  onSuccess?: () => void;
}

/* ─── Return type ─── */
interface UseResourceMutationReturn {
  create: (data: Record<string, unknown>) => Promise<void>;
  update: (id: string, data: Record<string, unknown>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  customAction: (id: string, action: string, data?: Record<string, unknown>) => Promise<void>;
  isLoading: boolean;
}

/* ─── Internal mutation runner ─── */
interface MutationInput {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/* ─── Hook ─── */
function useResourceMutation(options: UseResourceMutationOptions): UseResourceMutationReturn {
  const { endpoint, listQueryKey, onSuccess } = options;
  const queryClient = useQueryClient();
  const [activeCount, setActiveCount] = useState(0);

  const mutation = useMutation<unknown, Error, MutationInput>({
    mutationFn: async ({ method, path, body }) => {
      const init: RequestInit & { idempotencyKey?: string } = {
        method,
        headers: { "Content-Type": "application/json" },
      };
      if (body) init.body = JSON.stringify(body);
      if (method !== "GET" && method !== "DELETE") {
        init.idempotencyKey = crypto.randomUUID();
      }
      const res = await apiFetch(path, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `请求失败 (${res.status})`);
      }
      /* Some endpoints return 204 No Content */
      if (res.status === 204) return null;
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: listQueryKey });
      toast.success("操作成功");
      onSuccess?.();
    },
    onError: (err) => {
      toast.error(err.message || "操作失败");
    },
    onSettled: () => {
      setActiveCount((c) => Math.max(0, c - 1));
    },
  });

  const run = useCallback(
    async (input: MutationInput) => {
      setActiveCount((c) => c + 1);
      await mutation.mutateAsync(input);
    },
    [mutation],
  );

  const create = useCallback(
    (data: Record<string, unknown>) =>
      run({ method: "POST", path: endpoint, body: data }),
    [run, endpoint],
  );

  const update = useCallback(
    (id: string, data: Record<string, unknown>) =>
      run({ method: "PUT", path: `${endpoint}/${id}`, body: data }),
    [run, endpoint],
  );

  const remove = useCallback(
    (id: string) => run({ method: "DELETE", path: `${endpoint}/${id}` }),
    [run, endpoint],
  );

  const customAction = useCallback(
    (id: string, action: string, data?: Record<string, unknown>) =>
      run({ method: "POST", path: `${endpoint}/${id}/${action}`, body: data }),
    [run, endpoint],
  );

  return {
    create,
    update,
    remove,
    customAction,
    isLoading: activeCount > 0,
  };
}

export { useResourceMutation, type UseResourceMutationOptions, type UseResourceMutationReturn };
