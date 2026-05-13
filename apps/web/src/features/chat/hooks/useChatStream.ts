"use client";

import { useCallback, useRef, useState } from "react";
import { API_BASE, apiHeaders } from "@/shared/lib/api";
import { useSessionStore } from "@/shared/stores/session.store";
import type { ChatFlowItem } from "@/shared/stores/session.store";
import type { IntentClassification } from "@/shared/types";

/* ─── Types ─── */

export interface UseChatStreamReturn {
  streamingContent: string;
  phase: string;
  isStreaming: boolean;
  classification: IntentClassification | null;
  startStream: (text: string, options: { conversationId: string; mode: string; locale: string; defaultModelRef?: string }) => void;
  abortStream: () => void;
}

/* ─── SSE line parser helpers ─── */

interface SSEFrame {
  event: string;
  data: string;
}

function parseSSELines(buffer: string): { frames: SSEFrame[]; remainder: string } {
  const frames: SSEFrame[] = [];
  const lines = buffer.split("\n");
  let currentEvent = "";
  let currentData = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Empty line → dispatch accumulated event
    if (line === "" || line === "\r") {
      if (currentData) {
        frames.push({ event: currentEvent || "message", data: currentData });
      }
      currentEvent = "";
      currentData = "";
      i++;
      continue;
    }

    // Check if this is the last line without a trailing newline (incomplete)
    if (i === lines.length - 1 && !buffer.endsWith("\n")) {
      // This line is incomplete; return as remainder
      break;
    }

    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      currentData = line.slice(5).trim();
    } else if (line.startsWith(":")) {
      // Comment line, ignore
    }

    i++;
  }

  // Remainder is anything from index i onward
  const remainder = i < lines.length ? lines.slice(i).join("\n") : "";
  return { frames, remainder };
}

/* ─── Hook ─── */

export function useChatStream(): UseChatStreamReturn {
  const [streamingContent, setStreamingContent] = useState("");
  const [phase, setPhase] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [classification, setClassification] = useState<IntentClassification | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const contentBufferRef = useRef("");

  const flush = useCallback(() => {
    const content = contentBufferRef.current;
    if (content) {
      const item: ChatFlowItem = {
        id: crypto.randomUUID(),
        role: "assistant",
        content,
        timestamp: Date.now(),
      };
      useSessionStore.getState().appendFlowItem(item);
    }
    contentBufferRef.current = "";
    setStreamingContent("");
    setIsStreaming(false);
    setPhase("");
    setClassification(null);
  }, []);

  const abortStream = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    flush();
  }, [flush]);

  const startStream = useCallback((text: string, options: { conversationId: string; mode: string; locale: string; defaultModelRef?: string }) => {
    // Abort any existing stream
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Reset state
    contentBufferRef.current = "";
    setStreamingContent("");
    setPhase("thinking");
    setIsStreaming(true);
    setClassification(null);

    const headers = apiHeaders(options.locale);
    headers["content-type"] = "application/json";

    const body = JSON.stringify({
      message: text,
      conversationId: options.conversationId,
      mode: options.mode,
      locale: options.locale,
      contextType: "home_chat",
      ...(options.defaultModelRef ? { defaultModelRef: options.defaultModelRef } : {}),
    });

    const url = `${API_BASE}/orchestrator/dispatch/stream`;

    (async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`Stream request failed: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error("No readable stream available");
        }

        const decoder = new TextDecoder();
        let sseBuffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });
          const { frames, remainder } = parseSSELines(sseBuffer);
          sseBuffer = remainder;

          for (const frame of frames) {
            handleSSEFrame(frame);
          }
        }

        // Process any remaining buffer
        if (sseBuffer.trim()) {
          const { frames } = parseSSELines(sseBuffer + "\n\n");
          for (const frame of frames) {
            handleSSEFrame(frame);
          }
        }

        // Ensure flush on stream end
        if (contentBufferRef.current) {
          flush();
        } else {
          setIsStreaming(false);
          setPhase("");
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          // Intentional abort, do nothing
          return;
        }
        // On error, flush whatever we have
        flush();
      }
    })();

    function handleSSEFrame(frame: SSEFrame) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(frame.data) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (frame.event) {
        case "delta": {
          const deltaText = (data.text as string) ?? "";
          contentBufferRef.current += deltaText;
          setStreamingContent(contentBufferRef.current);
          break;
        }
        case "status": {
          const newPhase = (data.phase as string) ?? "";
          setPhase(newPhase);
          if (newPhase === "done") {
            flush();
          }
          break;
        }
        case "classification": {
          setClassification(data as unknown as IntentClassification);
          break;
        }
        case "stepProgress":
        case "executionReceipt":
        case "runSummary": {
          // These are handled by useTaskEvents via session SSE
          // But we can store conversationId if provided
          const convId = data.conversationId as string | undefined;
          if (convId) {
            useSessionStore.getState().setConversationId(convId);
          }
          break;
        }
        default:
          break;
      }
    }
  }, [flush]);

  return {
    streamingContent,
    phase,
    isStreaming,
    classification,
    startStream,
    abortStream,
  };
}
