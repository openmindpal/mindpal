"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/lib/cn";

interface ToolCallCardProps {
  toolRef: string;
  input?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  output?: string;
  className?: string;
}

const statusConfig = {
  pending: {
    dot: "bg-[var(--color-text-muted)]",
    label: "等待中",
    color: "text-[var(--color-text-muted)]",
  },
  running: {
    dot: "bg-[var(--color-text-muted)] animate-pulse",
    label: "执行中",
    color: "text-[var(--color-text-secondary)]",
  },
  done: {
    dot: "bg-[var(--color-success)]",
    label: "完成",
    color: "text-[var(--color-success)]",
  },
  error: {
    dot: "bg-[var(--color-danger)]",
    label: "失败",
    color: "text-[var(--color-danger)]",
  },
} as const;

function ToolCallCard({
  toolRef,
  input,
  status,
  output,
  className,
}: ToolCallCardProps) {
  const config = statusConfig[status];

  return (
    <div className={cn("w-full", className)}>
      <div
        className={cn(
          "rounded-[var(--radius-md)] border border-[var(--color-border)] overflow-hidden",
          "bg-[var(--color-surface)]"
        )}
      >
        {/* Header */}
        <div className="flex w-full items-center gap-2.5 px-3 py-2">
          <span className="flex-1 text-left text-[var(--text-xs)] font-medium text-[var(--color-text)] truncate">
            {toolRef}
          </span>

          {/* Status indicator — small dot */}
          <div className={cn("flex items-center gap-1.5", config.color)}>
            <span className={cn("inline-block h-2 w-2 rounded-full", config.dot)} />
            <span className="text-[var(--text-xs)]">{config.label}</span>
          </div>
        </div>

        {/* Content — always visible */}
        <div className="border-t border-[var(--color-border)] px-3 py-2.5 space-y-2.5">
            {/* Input parameters */}
            {input && Object.keys(input).length > 0 && (
              <div>
                <p className="text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)] mb-1">
                  输入参数
                </p>
                <pre className="text-[var(--text-xs)] leading-relaxed font-[var(--font-mono)] text-[var(--color-text-secondary)] bg-[var(--color-surface-sunken)] rounded-[var(--radius-md)] px-2.5 py-2 overflow-x-auto">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>
            )}

            {/* Output result */}
            {output && (
              <div>
                <p className="text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)] mb-1">
                  输出结果
                </p>
                <div className="prose prose-sm max-w-none text-[var(--color-text)] text-[var(--text-xs)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {output}
                  </ReactMarkdown>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

export { ToolCallCard, type ToolCallCardProps };
