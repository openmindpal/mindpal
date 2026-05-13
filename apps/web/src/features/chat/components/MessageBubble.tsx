"use client";

import { useState, useMemo, useCallback } from "react";
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
  onRegenerate?: () => void;
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

function MessageBubble({ message, isStreaming, className, onRegenerate }: MessageBubbleProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [message.content]);

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
          "max-w-[90%] relative group"
        )}
      >
        {/* Hover toolbar */}
        {message.role !== "system" && (
          <div
            className="absolute top-[-28px] right-0 flex gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity duration-[180ms]"
          >
            <button
              type="button"
              onClick={handleCopy}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
              title="复制"
            >
              {copied ? (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
            {message.role === "assistant" && (
              <button
                type="button"
                onClick={onRegenerate}
                className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
                title="重新生成"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
              </button>
            )}
          </div>
        )}
        {/* User message */}
        {message.role === "user" && (
          <div className="rounded-[4px] bg-[var(--color-surface-sunken)] px-3 py-2">
            <p className="text-[var(--text-sm)] leading-relaxed whitespace-pre-wrap break-words text-[var(--color-text)]">
              {message.content}
            </p>
          </div>
        )}

        {/* Assistant message */}
        {message.role === "assistant" && (
          <div className="px-0 py-2">
            {isStreaming ? (
              <StreamingText
                content={message.content}
                isStreaming={true}
                className="prose prose-sm max-w-none text-[var(--color-text)]"
              />
            ) : (
              <div className="prose prose-sm max-w-none text-[var(--color-text)]">
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
              "mt-1 text-[var(--text-xs)] text-[var(--color-text-muted)]",
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
      <div className="rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] px-4 py-3">
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
