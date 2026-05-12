"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSessionSSE from "@/shared/lib/sse/useSessionSSE";
import { useSessionStore } from "@/shared/stores/session.store";
import type { ChatFlowItem } from "@/shared/stores/session.store";

/* ─── Types ─── */

export interface TaskStep {
  seq: number;
  toolRef: string;
  status: string;
  output?: string;
}

export interface TaskProgress {
  taskId: string;
  runId?: string;
  steps: TaskStep[];
  status: "running" | "succeeded" | "failed";
}

export interface UseTaskEventsOptions {
  conversationId: string | null;
  tenantId?: string;
  enabled?: boolean;
}

export interface UseTaskEventsReturn {
  activeTask: TaskProgress | null;
  taskHistory: TaskProgress[];
}

/* ─── Hook ─── */

export function useTaskEvents(options: UseTaskEventsOptions): UseTaskEventsReturn {
  const { conversationId, tenantId = "tenant_dev", enabled = true } = options;

  const [activeTask, setActiveTask] = useState<TaskProgress | null>(null);
  const [taskHistory, setTaskHistory] = useState<TaskProgress[]>([]);

  const activeTaskRef = useRef<TaskProgress | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    activeTaskRef.current = activeTask;
  }, [activeTask]);

  const sessionId = conversationId ?? "";
  const sseEnabled = enabled && !!conversationId;

  const { onTaskEvent } = useSessionSSE({
    sessionId,
    tenantId,
    enabled: sseEnabled,
  });

  /** Handle task events */
  const handleTaskEvent = useCallback((event: string, data: Record<string, unknown>) => {
    const taskId = (data._taskId as string) ?? (data.taskId as string) ?? "";
    const runId = (data.runId as string) ?? undefined;

    switch (event) {
      case "stepProgress": {
        const step = data.step as Record<string, unknown> | undefined;
        if (!step) break;

        const newStep: TaskStep = {
          seq: (step.seq as number) ?? 0,
          toolRef: (step.toolRef as string) ?? "",
          status: (step.status as string) ?? "running",
          output: step.output as string | undefined,
        };

        setActiveTask((prev) => {
          if (prev && prev.taskId === taskId) {
            const existingIdx = prev.steps.findIndex((s) => s.seq === newStep.seq);
            const updatedSteps = existingIdx >= 0
              ? prev.steps.map((s, i) => i === existingIdx ? newStep : s)
              : [...prev.steps, newStep];
            return { ...prev, steps: updatedSteps, runId: runId ?? prev.runId };
          }
          // New task
          return { taskId, runId, steps: [newStep], status: "running" };
        });

        // Update tool exec state in session store
        const toolId = (step.toolRef as string) ?? taskId;
        const stepStatus = (step.status as string) ?? "running";
        const execState = stepStatus === "done" ? "done"
          : stepStatus === "error" ? "error"
          : "running";
        useSessionStore.getState().updateToolExecState(toolId, execState);
        break;
      }

      case "executionReceipt": {
        const receiptStatus = (data.status as string) ?? "done";
        const output = (data.output as string) ?? "";

        // Generate tool ChatFlowItem for the receipt
        const toolItem: ChatFlowItem = {
          id: crypto.randomUUID(),
          role: "tool",
          content: output,
          timestamp: Date.now(),
          metadata: {
            taskId,
            runId,
            status: receiptStatus,
            type: "execution_receipt",
          },
        };
        useSessionStore.getState().appendFlowItem(toolItem);
        break;
      }

      case "runSummary": {
        const ok = data.ok as boolean;
        const summaryStatus = (data.status as string) ?? (ok ? "succeeded" : "failed");
        const finalStatus = summaryStatus === "succeeded" ? "succeeded" : "failed";

        setActiveTask((prev) => {
          if (prev && prev.taskId === taskId) {
            const completed: TaskProgress = { ...prev, status: finalStatus };
            setTaskHistory((h) => [...h, completed]);
            return null;
          }
          return prev;
        });
        break;
      }

      case "agentLoopEnd": {
        // Mark overall completion
        setActiveTask((prev) => {
          if (prev) {
            const completed: TaskProgress = { ...prev, status: "succeeded" };
            setTaskHistory((h) => [...h, completed]);
            return null;
          }
          return prev;
        });
        break;
      }

      default:
        break;
    }
  }, []);

  // Subscribe to task events when conversationId is available
  useEffect(() => {
    if (!sseEnabled || !conversationId) return;

    // Subscribe using wildcard-like pattern: listen on conversationId as taskId
    // The actual taskId routing is done by useSessionSSE's event bus
    const unsubscribe = onTaskEvent(conversationId, handleTaskEvent);

    return () => {
      unsubscribe();
    };
  }, [sseEnabled, conversationId, onTaskEvent, handleTaskEvent]);

  // Also subscribe to any active task specifically
  useEffect(() => {
    if (!sseEnabled || !activeTask?.taskId) return;
    if (activeTask.taskId === conversationId) return; // Already subscribed above

    const unsubscribe = onTaskEvent(activeTask.taskId, handleTaskEvent);
    return () => {
      unsubscribe();
    };
  }, [sseEnabled, activeTask?.taskId, conversationId, onTaskEvent, handleTaskEvent]);

  return {
    activeTask,
    taskHistory,
  };
}
