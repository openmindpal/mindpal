"use client";

/**
 * useTaskQueue — 任务队列管理 Hook（HomeChat 用简化封装）
 *
 * 组合 useSessionTaskQueue + useTaskManager，
 * 提供统一的任务进度与队列操作接口。
 */

import { useCallback } from "react";
import useSessionTaskQueue from "../useSessionTaskQueue";
import useTaskManager from "../useTaskManager";

export interface UseTaskQueueParams {
  locale: string;
  conversationId: string;
  setFlow: React.Dispatch<React.SetStateAction<any[]>>;
  abortRef: React.MutableRefObject<AbortController | null>;
}

export function useTaskQueue({ locale, conversationId, setFlow, abortRef }: UseTaskQueueParams) {
  const taskQueue = useSessionTaskQueue({ sessionId: conversationId, locale, enabled: true });
  const taskManager = useTaskManager({ locale, setFlow, abortRef });

  return {
    taskQueue,
    taskManager,
  };
}
