"use client";

import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/lib/cn";
import { CodeBlock } from "./CodeBlock";
import { ToolCallCard } from "./ToolCallCard";
import { StreamingText } from "./StreamingText";

interface MessageBubbleProps {
  message: {
    id: string;
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    timestamp: number;
    metadata?: Record<string, unknown>;
  };
  isStreaming?: boolean;
  className?: string;
}

/** Format relative timestamp */
function formatTimestamp(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟前`;

  const date = new Date(ts);
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

const COLLAPSE_THRESHOLD = 200;

function MessageBubble({ message, isStreaming, className }: MessageBubbleProps) {
  const [expanded, setExpanded] = useState(false);
  const shouldCollapse = message.role === "assistant" && message.content.length > COLLAPSE_THRESHOLD && !isStreaming;

  const timestamp = useMemo(() => formatTimestamp(message.timestamp), [message.timestamp]);

  return (
    <div
      className={cn(
        "flex w-full",
        message.role === "user" && "justify-end",
        message.role === "system" && "justify-center",
        (message.role === "assistant" || message.role === "tool") && "justify-start",
        className
      )}
    >
      <div
        className={cn(
          "max-w-[80%] relative",
          message.role === "system" && "max-w-[90%]"
        )}
      >
        {/* User message */}
        {message.role === "user" && (
          <div className="rounded-2xl rounded-br-md bg-[var(--color-primary)]/10 px-4 py-2.5">
            <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-[var(--color-text)]">
              {message.content}
            </p>
          </div>
        )}

        {/* Assistant message */}
        {message.role === "assistant" && (
          <div className="rounded-2xl rounded-bl-md bg-[var(--color-surface)] px-4 py-3 border border-[var(--color-border)]/50">
            {isStreaming ? (
              <StreamingText
                content={message.content}
                isStreaming={true}
                className="prose prose-sm max-w-none text-[var(--color-text)]"
              />
            ) : (
              <div className="relative">
                <div
                  className={cn(
                    "prose prose-sm max-w-none text-[var(--color-text)] overflow-hidden transition-[max-height] duration-[var(--duration-normal)]",
                    shouldCollapse && !expanded && "max-h-[120px]"
                  )}
                >
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      code({ className: codeClassName, children, ...props }) {
                        const match = /language-(\w+)/.exec(codeClassName || "");
                        const codeString = String(children).replace(/\n$/, "");

                        if (match) {
                          return <CodeBlock language={match[1]}>{codeString}</CodeBlock>;
                        }

                        return (
                          <code
                            className={cn(
                              "rounded px-1.5 py-0.5 bg-[var(--color-surface-sunken)] text-sm font-[var(--font-mono)]",
                              codeClassName
                            )}
                            {...props}
                          >
                            {children}
                          </code>
                        );
                      },
                    }}
                  >
                    {message.content}
                  </ReactMarkdown>
                </div>

                {/* Gradient mask + expand/collapse */}
                {shouldCollapse && !expanded && (
                  <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[var(--color-surface-raised)] to-transparent pointer-events-none" />
                )}
                {shouldCollapse && (
                  <button
                    type="button"
                    onClick={() => setExpanded(!expanded)}
                    className="mt-1 text-xs text-[var(--color-primary)] hover:text-[var(--color-primary-hover)] transition-colors"
                  >
                    {expanded ? "收起" : "展开全文"}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* System message */}
        {message.role === "system" && (
          <div className="px-4 py-2 text-center">
            <p className="text-xs italic text-[var(--color-text-muted)]">
              {message.content}
            </p>
          </div>
        )}

        {/* Tool message */}
        {message.role === "tool" && <ToolCallBubble content={message.content} />}

        {/* Timestamp */}
        {message.role !== "system" && (
          <p
            className={cn(
              "mt-1 text-[10px] text-[var(--color-text-muted)]/60",
              message.role === "user" ? "text-right" : "text-left"
            )}
          >
            {timestamp}
          </p>
        )}
      </div>
    </div>
  );
}

/** Parse tool message content and render as ToolCallCard */
function ToolCallBubble({ content }: { content: string }) {
  const parsed = useMemo(() => {
    try {
      return JSON.parse(content) as {
        toolRef?: string;
        input?: Record<string, unknown>;
        status?: "pending" | "running" | "done" | "error";
        output?: string;
      };
    } catch {
      return null;
    }
  }, [content]);

  if (!parsed || !parsed.toolRef) {
    return (
      <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-raised)] px-4 py-3 border border-[var(--color-border)]">
        <pre className="text-xs text-[var(--color-text-secondary)] whitespace-pre-wrap font-[var(--font-mono)]">
          {content}
        </pre>
      </div>
    );
  }

  return (
    <ToolCallCard
      toolRef={parsed.toolRef}
      input={parsed.input}
      status={parsed.status || "done"}
      output={parsed.output}
    />
  );
}

export { MessageBubble, type MessageBubbleProps };
