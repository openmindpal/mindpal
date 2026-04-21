"use client";

import { useCallback, useRef } from "react";
import type { TaskEventHandler } from "../useSessionSSE";

export type { TaskEventHandler };

/**
 * useEventBus — 事件路由与分发 Hook
 *
 * 管理 SSE 事件的注册/注销/分发：
 * - 按 taskId 路由到特定任务的处理器
 * - 全局处理器接收所有事件
 * - 基于 eventId 去重防止重复处理
 */
export function useEventBus() {
  const taskHandlersRef = useRef<Map<string, Set<TaskEventHandler>>>(new Map());
  const processedEventIdsRef = useRef<Set<string>>(new Set());
  const lastEventIdRef = useRef<string | null>(null);

  /** 注册任务事件处理器 */
  const onTaskEvent = useCallback((taskId: string, handler: TaskEventHandler): (() => void) => {
    if (!taskHandlersRef.current.has(taskId)) {
      taskHandlersRef.current.set(taskId, new Set());
    }
    taskHandlersRef.current.get(taskId)!.add(handler);
    return () => {
      const set = taskHandlersRef.current.get(taskId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) taskHandlersRef.current.delete(taskId);
      }
    };
  }, []);

  /** 注销所有特定 taskId 的处理器 */
  const offTaskEvents = useCallback((taskId: string) => {
    taskHandlersRef.current.delete(taskId);
  }, []);

  /** 记录已处理的事件 ID */
  const markEventProcessed = useCallback((eventId: string) => {
    const set = processedEventIdsRef.current;
    set.add(eventId);
    if (set.size > 500) {
      const arr = Array.from(set);
      processedEventIdsRef.current = new Set(arr.slice(arr.length - 250));
    }
  }, []);

  /** 检查事件是否已处理过 */
  const isEventProcessed = useCallback((eventId: string) => {
    return processedEventIdsRef.current.has(eventId);
  }, []);

  /** 分发事件到任务处理器 */
  const dispatchToTask = useCallback((taskId: string, evtName: string, data: Record<string, unknown>) => {
    const handlers = taskHandlersRef.current.get(taskId);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(evtName, data); } catch { /* handler may throw */ }
      }
    }
  }, []);

  return {
    onTaskEvent,
    offTaskEvents,
    markEventProcessed,
    isEventProcessed,
    dispatchToTask,
    lastEventIdRef,
  };
}
