"use client";

import { useCallback } from "react";
import { Code2, Lightbulb, Zap, Users } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { apiFetch } from "@/shared/lib/api";
import { useChat } from "../hooks/useChat";
import type { UploadedFile } from "../hooks/useChat";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";

/* ─── Types ─── */

interface ChatWindowProps {
  className?: string;
}

/* ─── Quick Suggestions ─── */

const SUGGESTIONS = [
  { text: "帮我写一段代码", icon: Code2 },
  { text: "解释一个概念", icon: Lightbulb },
  { text: "执行一个任务", icon: Zap },
  { text: "开始协作", icon: Users },
] as const;

/* ─── Empty State ─── */

function EmptyState({ onSend }: { onSend: (text: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-16">
      {/* Lightweight inline SVG icon */}
      <svg
        className="h-10 w-10 text-[var(--color-primary)] opacity-60 mb-5"
        viewBox="0 0 48 48"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M24 4C12.954 4 4 11.163 4 20c0 5.105 3.17 9.632 8 12.614V40l5.5-3.5C19.6 36.83 21.77 37 24 37c11.046 0 20-7.163 20-17S35.046 4 24 4z" />
        <circle cx="16" cy="20" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="24" cy="20" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="32" cy="20" r="1.5" fill="currentColor" stroke="none" />
      </svg>

      <h2 className="text-lg font-medium text-[var(--color-text)] mb-1">
        灵智 MindPal
      </h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-10">
        有什么我可以帮助你的？
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2 max-w-md">
        {SUGGESTIONS.map(({ text, icon: Icon }) => (
          <button
            key={text}
            type="button"
            onClick={() => onSend(text)}
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-4 rounded-full",
              "border border-[var(--color-border)]/60 bg-transparent",
              "text-[13px] text-[var(--color-text-secondary)]",
              "hover:border-[var(--color-primary)]/30 hover:text-[var(--color-primary)] hover:bg-[var(--color-primary)]/5",
              "transition-all duration-200"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─── Main Component ─── */

function ChatWindow({ className }: ChatWindowProps) {
  const {
    messages,
    send,
    sendStream,
    isLoading,
    mode,
    setMode,
    streamingContent,
    isStreaming,
  } = useChat();

  const handleSend = useCallback(
    async (text: string, options?: { files?: File[]; model?: string }) => {
      const attachments: UploadedFile[] = [];

      // Upload files if any
      if (options?.files && options.files.length > 0) {
        for (const file of options.files) {
          try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await apiFetch("/media/objects", {
              method: "POST",
              body: formData,
            });
            if (res.ok) {
              const data = await res.json();
              attachments.push({
                id: data.objectId ?? data.id ?? crypto.randomUUID(),
                name: file.name,
                mimeType: file.type || "application/octet-stream",
              });
            }
          } catch {
            // If upload fails, still send message without that file
          }
        }
      }

      if (attachments.length > 0) {
        send(text, undefined, attachments);
      } else {
        sendStream(text);
      }
    },
    [sendStream, send]
  );

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Middle: Messages or Empty State */}
      <div className="flex-1 min-h-0 flex flex-col">
        {hasMessages ? (
          <MessageList
            messages={messages}
            streamingContent={streamingContent}
            isStreaming={isStreaming}
          />
        ) : (
          <EmptyState onSend={handleSend} />
        )}
      </div>

      {/* Bottom: Composer */}
      <div className="border-t border-[var(--color-border)]/50">
        <div className="max-w-3xl mx-auto w-full px-4 py-3">
          <ChatComposer
            onSend={handleSend}
            isLoading={isLoading || isStreaming}
            mode={mode}
            onModeChange={setMode}
          />
        </div>
      </div>
    </div>
  );
}

export { ChatWindow, type ChatWindowProps };
