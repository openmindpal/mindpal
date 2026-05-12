"use client";

import { useCallback } from "react";
import { MessageSquare, Code2, Lightbulb, Zap, Users } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { useChat } from "../hooks/useChat";
import { useTaskEvents } from "../hooks/useTaskEvents";
import { useVideoStream } from "../hooks/useVideoStream";
import type { UploadedFile } from "../hooks/useFileUpload";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { ExecutionReceipt } from "./ExecutionReceipt";
import { VideoStreamPanel } from "./VideoStreamPanel";

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
    <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
      <MessageSquare className="h-12 w-12 text-[var(--color-text-muted)] mb-4" />
      <h2 className="text-xl font-semibold text-[var(--color-text)] mb-1">
        灵智 MindPal
      </h2>
      <p className="text-sm text-[var(--color-text-muted)] mb-8">
        有什么我可以帮助你的？
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {SUGGESTIONS.map(({ text, icon: Icon }) => (
          <button
            key={text}
            type="button"
            onClick={() => onSend(text)}
            className={cn(
              "inline-flex items-center gap-2 h-9 px-4 rounded-full",
              "border border-[var(--color-border)] bg-[var(--color-surface)]",
              "text-sm text-[var(--color-text-secondary)]",
              "hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]",
              "transition-colors duration-150"
            )}
          >
            <Icon className="h-4 w-4" />
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
    conversationId,
  } = useChat();

  const { activeTask } = useTaskEvents({
    conversationId,
    enabled: !!conversationId,
  });

  // Video stream
  const video = useVideoStream();

  const handleSend = useCallback(
    (text: string, attachments?: UploadedFile[]) => {
      sendStream(text, undefined, attachments);
    },
    [sendStream]
  );

  const hasMessages = messages.length > 0 || isStreaming;

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* Video Stream Panel */}
      {video.state !== 'idle' && (
        <VideoStreamPanel
          state={video.state}
          latestAnalysis={video.latestAnalysis}
          error={video.error}
          videoRef={video.videoRef}
          canvasRef={video.canvasRef}
          fps={video.fps}
          onStop={video.stopStream}
        />
      )}

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

      {/* Active Task Receipt */}
      {activeTask && (
        <div className="max-w-3xl mx-auto w-full px-4 pb-2">
          <ExecutionReceipt
            taskId={activeTask.taskId}
            runId={activeTask.runId}
            status={activeTask.status}
            steps={activeTask.steps}
          />
        </div>
      )}

      {/* Bottom: Composer */}
      <div className="border-t border-[var(--color-border)]">
        <div className="max-w-3xl mx-auto w-full px-4 py-3">
          <ChatComposer
            onSend={handleSend}
            isLoading={isLoading || isStreaming}
            videoState={video.state}
            onVideoStart={video.startStream}
            onVideoStop={video.stopStream}
            mode={mode}
            onModeChange={setMode}
          />
        </div>
      </div>
    </div>
  );
}

export { ChatWindow, type ChatWindowProps };
