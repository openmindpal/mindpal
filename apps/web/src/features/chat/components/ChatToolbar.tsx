"use client";

import * as React from "react";
import { Sparkles, MessageCircle, Zap, Users, Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { useModelCatalog } from "@/features/chat/hooks/useModelCatalog";

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
  const { models, hasModels, defaultModel, isLoading } = useModelCatalog();

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

      {/* Right side: model select + connection state */}
      <div className="flex items-center gap-3">
        {/* Model select */}
        {onModelChange && (
          <div className="relative inline-flex items-center">
            {isLoading ? (
              <div className="h-8 flex items-center px-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-text-secondary)]" />
              </div>
            ) : !hasModels ? (
              <span className="h-8 flex items-center px-2 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
                {defaultModel.name}
              </span>
            ) : models.length === 1 ? (
              <span className="h-8 flex items-center px-2 rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--text-sm)] text-[var(--color-text)]">
                {models[0].name}
              </span>
            ) : (
              <>
                <select
                  value={modelRef ?? models[0]?.id}
                  onChange={(e) => onModelChange(e.target.value)}
                  className="h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 pr-6 text-[var(--text-sm)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}{model.provider ? ` (${model.provider})` : ""}
                    </option>
                  ))}
                </select>
                {isLoading && (
                  <Loader2 className="absolute right-1.5 h-3.5 w-3.5 animate-spin text-[var(--color-text-secondary)] pointer-events-none" />
                )}
              </>
            )}
          </div>
        )}

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
