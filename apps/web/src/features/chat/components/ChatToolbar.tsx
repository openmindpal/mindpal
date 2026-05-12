"use client";

import * as React from "react";
import { Sparkles, MessageCircle, Zap, Users } from "lucide-react";
import { cn } from "@/shared/lib/cn";

type ChatMode = "auto" | "answer" | "execute" | "collab";

interface ChatToolbarProps {
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  modelRef?: string;
  onModelChange?: (model: string) => void;
  connectionState?: "connected" | "connecting" | "disconnected";
  className?: string;
}

const MODE_OPTIONS: { value: ChatMode; label: string; icon: React.ElementType }[] = [
  { value: "auto", label: "自动", icon: Sparkles },
  { value: "answer", label: "回答", icon: MessageCircle },
  { value: "execute", label: "执行", icon: Zap },
  { value: "collab", label: "协作", icon: Users },
];

function ChatToolbar({
  mode,
  onModeChange,
  modelRef,
  onModelChange,
  connectionState = "connected",
  className,
}: ChatToolbarProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-4 py-2 bg-[var(--color-surface-0)]",
        className
      )}
    >
      {/* Mode selection pills */}
      <div className="flex items-center gap-2">
        {MODE_OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => onModeChange(value)}
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[var(--text-sm)] font-medium transition-colors duration-150 select-none",
              mode === value
                ? "bg-[var(--color-primary)] text-white"
                : "bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Right side: connection state */}
      <div className="flex items-center gap-3">
        {/* Connection state indicator */}
        <div className="flex items-center" aria-label={`连接状态: ${connectionState}`}>
          <span
            className={cn(
              "inline-block h-2 w-2 rounded-full",
              connectionState === "connected" && "bg-green-500",
              connectionState === "connecting" && "bg-yellow-500 animate-pulse",
              connectionState === "disconnected" && "bg-red-500"
            )}
          />
        </div>
      </div>
    </div>
  );
}

export { ChatToolbar, type ChatToolbarProps, type ChatMode };
