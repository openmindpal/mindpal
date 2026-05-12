"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/shared/lib/api";
import { useSessionStore } from "@/shared/stores/session.store";
import type { ChatFlowItem } from "@/shared/stores/session.store";
import type { DispatchResponse, IntentMode } from "@/shared/types";
import { useChatStream } from "./useChatStream";
import type { UploadedFile } from "./useFileUpload";

/* ─── Types ─── */

export interface UseChatOptions {
  initialConversationId?: string;
  defaultMode?: IntentMode | "auto";
}

export type ChatMode = IntentMode | "auto";

export interface UseChatReturn {
  messages: ChatFlowItem[];
  send: (text: string, mode?: ChatMode, attachments?: UploadedFile[]) => Promise<void>;
  sendStream: (text: string, mode?: ChatMode, attachments?: UploadedFile[]) => void;
  isLoading: boolean;
  error: string | null;
  conversationId: string | null;
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;
  clearChat: () => void;
  streamingContent: string;
  streamPhase: string;
  isStreaming: boolean;
  abortStream: () => void;
}

/* ─── Hook ─── */

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { initialConversationId, defaultMode = "auto" } = options;

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(defaultMode);

  // Store selectors
  const messages = useSessionStore((s) => s.flow);
  const conversationId = useSessionStore((s) => s.conversationId);
  const appendFlowItem = useSessionStore((s) => s.appendFlowItem);
  const setConversationId = useSessionStore((s) => s.setConversationId);
  const clearSession = useSessionStore((s) => s.clearSession);

  // Stream hook
  const { streamingContent, phase: streamPhase, isStreaming, startStream, abortStream } = useChatStream();

  // Initialize conversationId if provided
  if (initialConversationId && !conversationId) {
    setConversationId(initialConversationId);
  }

  /** Resolve or create conversationId */
  const resolveConversationId = useCallback((): string => {
    const existing = useSessionStore.getState().conversationId;
    if (existing) return existing;
    const newId = crypto.randomUUID();
    setConversationId(newId);
    return newId;
  }, [setConversationId]);

  /** Non-streaming send */
  const send = useCallback(async (text: string, sendMode?: ChatMode, attachments?: UploadedFile[]) => {
    setError(null);

    const activeMode = sendMode ?? mode;
    const activeConversationId = resolveConversationId();

    // Append user message to flow
    const userItem: ChatFlowItem = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    appendFlowItem(userItem);

    setIsLoading(true);

    try {
      const body: Record<string, unknown> = {
        message: text,
        conversationId: activeConversationId,
        mode: activeMode,
        locale: "zh-CN",
        contextType: "home_chat",
      };

      if (attachments && attachments.length > 0) {
        body.attachments = attachments.map(a => ({
          objectId: a.id,
          name: a.name,
          mimeType: a.mimeType,
        }));
      }

      const response = await apiFetch("/orchestrator/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(errBody || `Request failed: ${response.status}`);
      }

      const data = (await response.json()) as DispatchResponse;

      // Update conversationId from response
      if (data.conversationId) {
        setConversationId(data.conversationId);
      }

      // Append assistant reply if present
      if (data.replyText) {
        const assistantItem: ChatFlowItem = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.replyText,
          timestamp: Date.now(),
          metadata: {
            mode: data.mode,
            classification: data.classification,
            turnId: data.turnId,
          },
        };
        appendFlowItem(assistantItem);
      }

      // If task-based execution, record metadata for useTaskEvents
      if (data.taskId) {
        const taskItem: ChatFlowItem = {
          id: crypto.randomUUID(),
          role: "system",
          content: "",
          timestamp: Date.now(),
          metadata: {
            type: "task_started",
            taskId: data.taskId,
            runId: data.runId,
            jobId: data.jobId,
            mode: data.mode,
            executionClass: data.executionClass,
            phase: data.phase,
            taskState: data.taskState,
          },
        };
        appendFlowItem(taskItem);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error occurred";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [mode, resolveConversationId, appendFlowItem, setConversationId]);

  /** Streaming send */
  const sendStream = useCallback((text: string, sendMode?: ChatMode, attachments?: UploadedFile[]) => {
    setError(null);

    const activeMode = sendMode ?? mode;
    const activeConversationId = resolveConversationId();

    // If attachments present, fall back to non-streaming send (streaming endpoint doesn't support attachments yet)
    if (attachments && attachments.length > 0) {
      send(text, sendMode, attachments);
      return;
    }

    // Append user message to flow
    const userItem: ChatFlowItem = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    appendFlowItem(userItem);

    // Start stream
    startStream(text, {
      conversationId: activeConversationId,
      mode: activeMode,
      locale: "zh-CN",
    });
  }, [mode, resolveConversationId, appendFlowItem, startStream, send]);

  /** Clear chat */
  const clearChat = useCallback(() => {
    abortStream();
    clearSession();
    setError(null);
    setIsLoading(false);
  }, [abortStream, clearSession]);

  return {
    messages,
    send,
    sendStream,
    isLoading,
    error,
    conversationId,
    mode,
    setMode,
    clearChat,
    streamingContent,
    streamPhase,
    isStreaming,
    abortStream,
  };
}
