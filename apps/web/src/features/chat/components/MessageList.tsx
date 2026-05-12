"use client";

import { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/shared/lib/cn";
import { MessageBubble } from "./MessageBubble";
import { StreamingText } from "./StreamingText";
import { ToolCallCard } from "./ToolCallCard";

/* ─── Types ─── */

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface MessageListProps {
  messages: Message[];
  streamingContent?: string;
  isStreaming?: boolean;
  className?: string;
}

/* ─── Height estimation per role ─── */

function estimateSize(role: Message["role"]): number {
  switch (role) {
    case "user":
      return 80;
    case "assistant":
      return 150;
    case "tool":
      return 120;
    case "system":
      return 50;
    default:
      return 100;
  }
}

/* ─── Tool message parser (fallback to text) ─── */

function ToolMessageRenderer({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content) as {
      toolRef?: string;
      input?: Record<string, unknown>;
      status?: "pending" | "running" | "done" | "error";
      output?: string;
    };

    if (parsed && parsed.toolRef) {
      return (
        <ToolCallCard
          toolRef={parsed.toolRef}
          input={parsed.input}
          status={parsed.status || "done"}
          output={parsed.output}
        />
      );
    }
  } catch {
    // fallback to plain text
  }

  return (
    <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-raised)] px-4 py-3 border border-[var(--color-border)]">
      <pre className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap font-[var(--font-mono)]">
        {content}
      </pre>
    </div>
  );
}

/* ─── Component ─── */

function MessageList({
  messages,
  streamingContent,
  isStreaming = false,
  className,
}: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Total items: messages + 1 streaming row (if streaming)
  const itemCount = messages.length + (isStreaming ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      if (index < messages.length) {
        return estimateSize(messages[index].role);
      }
      // Streaming row estimate
      return 150;
    },
    overscan: 5,
  });

  // Auto-scroll to bottom on new messages or streaming content changes
  useEffect(() => {
    if (itemCount > 0) {
      virtualizer.scrollToIndex(itemCount - 1, { align: "end" });
    }
  }, [messages.length, streamingContent, itemCount, virtualizer]);

  return (
    <div
      ref={parentRef}
      className={cn("overflow-y-auto flex-1", className)}
    >
      <div
        className="relative w-full max-w-3xl mx-auto"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const index = virtualRow.index;
          const isStreamingRow = index >= messages.length;

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full px-4 py-3"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {isStreamingRow ? (
                <div className="flex w-full justify-start">
                  <div className="max-w-[80%] rounded-[var(--radius-2xl)] rounded-bl-[var(--radius-sm)] bg-[var(--color-surface-raised)] px-4 py-3 border border-[var(--color-border)]">
                    <StreamingText
                      content={streamingContent ?? ""}
                      isStreaming={true}
                      className="prose prose-sm max-w-none text-[var(--color-text)]"
                    />
                  </div>
                </div>
              ) : (
                <MessageBubble
                  message={messages[index]}
                  isStreaming={
                    isStreaming &&
                    index === messages.length - 1 &&
                    messages[index].role === "assistant"
                  }
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { MessageList, type MessageListProps };
