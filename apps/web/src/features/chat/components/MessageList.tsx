"use client";

import { useRef, useEffect, useState, useCallback } from "react";
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
      return 70;
    case "assistant":
      return 130;
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

/* ─── Scroll-to-bottom threshold (px) ─── */
const BOTTOM_THRESHOLD = 150;

function MessageList({
  messages,
  streamingContent,
  isStreaming = false,
  className,
}: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const prevMsgCountRef = useRef(messages.length);

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

  // Detect scroll position to determine if user is at bottom
  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      setShowScrollBtn(false);
    }
  }, []);

  // Smart auto-scroll: only scroll when user is at bottom
  useEffect(() => {
    if (itemCount > 0 && isAtBottomRef.current) {
      virtualizer.scrollToIndex(itemCount - 1, { align: "end" });
    }
  }, [messages.length, streamingContent, itemCount, virtualizer]);

  // Show floating button when new messages arrive and user is scrolled up
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && !isAtBottomRef.current) {
      setShowScrollBtn(true);
    }
    prevMsgCountRef.current = messages.length;
  }, [messages.length]);

  // Also show button when streaming starts and user is scrolled up
  useEffect(() => {
    if (isStreaming && !isAtBottomRef.current) {
      setShowScrollBtn(true);
    }
  }, [isStreaming]);

  // Scroll to bottom handler for the floating button
  const scrollToBottom = useCallback(() => {
    if (itemCount > 0) {
      virtualizer.scrollToIndex(itemCount - 1, { align: "end" });
    }
    isAtBottomRef.current = true;
    setShowScrollBtn(false);
  }, [itemCount, virtualizer]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={parentRef}
        onScroll={handleScroll}
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
                className="absolute top-0 left-0 w-full px-4 py-1"
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isStreamingRow ? (
                  <div className="flex w-full justify-start">
                    <div className="max-w-[90%] px-0 py-2">
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

      {/* Floating scroll-to-bottom button */}
      <button
        type="button"
        onClick={scrollToBottom}
        aria-label="Scroll to bottom"
        className={cn(
          "absolute left-1/2 -translate-x-1/2 bottom-[80px]",
          "w-8 h-8 rounded-full flex items-center justify-center",
          "bg-white/80 backdrop-blur-sm",
          "hover:bg-white",
          "transition-all duration-150",
          showScrollBtn
            ? "opacity-100 scale-100 pointer-events-auto"
            : "opacity-0 scale-90 pointer-events-none"
        )}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          className="w-4 h-4 text-[var(--color-text-secondary)]"
        >
          <path
            d="M8 3v10m0 0l-4-4m4 4l4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

export { MessageList, type MessageListProps };
