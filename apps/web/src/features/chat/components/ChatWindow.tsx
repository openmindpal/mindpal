"use client";

import { useCallback } from "react";
import { MessageSquareText } from "lucide-react";
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

/* ─── Empty Greeting (just the greeting, no input) ─── */

function EmptyGreeting() {
  return (
    <div className="flex w-full flex-1 items-center justify-center px-4 py-10 sm:px-6">
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center text-center">
      <div className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-white/80 px-3 py-1 text-[11px] font-medium text-[var(--color-text-secondary)] shadow-[var(--shadow-xs)] backdrop-blur">
        <MessageSquareText className="h-3.5 w-3.5 text-[var(--color-primary)]" />
        <span>新对话</span>
      </div>

      <div className="mt-6">
        <h2 className="text-3xl font-semibold tracking-tight text-[var(--color-text)] sm:text-4xl">
          灵智 MindPal
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-secondary)] sm:text-base">
          面向企业与端侧的智能体底层系统（Agent OS）--治理、编排、设备运行时与多端互联。
        </p>
      </div>
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
        send(text, undefined, attachments, options?.model);
      } else {
        sendStream(text, undefined, undefined, options?.model);
      }
    },
    [sendStream, send]
  );

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div
      className={cn(
        "flex w-full min-h-0 flex-1 justify-center overflow-hidden bg-[linear-gradient(180deg,rgba(37,99,235,0.06)_0%,rgba(37,99,235,0.015)_18%,transparent_42%)]",
        className
      )}
    >
      <div className="flex w-full min-h-0 max-w-5xl flex-1 flex-col">
        <div className="flex w-full min-h-0 flex-1 flex-col">
          {hasMessages ? (
            <MessageList
              messages={messages}
              streamingContent={streamingContent}
              isStreaming={isStreaming}
              className="px-1 pt-6"
            />
          ) : (
            <EmptyGreeting />
          )}
        </div>

        <div className="shrink-0 w-full pb-6 pt-3">
          <div className="w-full px-4 sm:px-6">
            <ChatComposer
              className="w-full"
              onSend={handleSend}
              isLoading={isLoading || isStreaming}
              mode={mode}
              onModeChange={setMode}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export { ChatWindow, type ChatWindowProps };
