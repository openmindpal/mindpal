"use client";

import { Wrench, Check, X, Circle } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/shared/lib/cn";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/shared/components/primitives/Collapsible";
import { Spinner } from "@/shared/components/primitives/Spinner";
import { CodeBlock } from "./CodeBlock";

interface ToolCallCardProps {
  toolRef: string;
  input?: Record<string, unknown>;
  status: "pending" | "running" | "done" | "error";
  output?: string;
  className?: string;
}

const statusConfig = {
  pending: {
    icon: <Circle className="h-3 w-3 fill-[var(--color-text-muted)] text-[var(--color-text-muted)]" />,
    label: "等待中",
    color: "text-[var(--color-text-muted)]",
  },
  running: {
    icon: null, // Uses Spinner
    label: "执行中",
    color: "text-[var(--color-primary)]",
  },
  done: {
    icon: <Check className="h-3.5 w-3.5 text-[var(--color-success)]" />,
    label: "完成",
    color: "text-[var(--color-success)]",
  },
  error: {
    icon: <X className="h-3.5 w-3.5 text-[var(--color-danger)]" />,
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
  const defaultOpen = status === "running";

  return (
    <Collapsible defaultOpen={defaultOpen} className={cn("w-full", className)}>
      <div
        className={cn(
          "rounded-[var(--radius-lg)] border border-[var(--color-border)] overflow-hidden",
          "bg-[var(--color-surface)]"
        )}
      >
        {/* Header */}
        <CollapsibleTrigger className="flex w-full items-center gap-3 px-4 py-3 hover:bg-[var(--color-surface-sunken)] transition-colors duration-[var(--duration-fast)]">
          <Wrench className="h-4 w-4 flex-shrink-0 text-[var(--color-text-secondary)]" />
          <span className="flex-1 text-left text-sm font-medium text-[var(--color-text)] truncate">
            {toolRef}
          </span>

          {/* Status indicator */}
          <div className={cn("flex items-center gap-1.5", config.color)}>
            {status === "running" ? (
              <>
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-primary)] opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--color-primary)]" />
                </span>
                <Spinner size="sm" />
              </>
            ) : (
              config.icon
            )}
            <span className="text-xs">{config.label}</span>
          </div>
        </CollapsibleTrigger>

        {/* Collapsible content */}
        <CollapsibleContent>
          <div className="border-t border-[var(--color-border)] px-4 py-3 space-y-3">
            {/* Input parameters */}
            {input && Object.keys(input).length > 0 && (
              <div>
                <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                  输入参数
                </p>
                <CodeBlock language="json">
                  {JSON.stringify(input, null, 2)}
                </CodeBlock>
              </div>
            )}

            {/* Output result */}
            {output && (
              <div>
                <p className="text-xs font-medium text-[var(--color-text-secondary)] mb-1">
                  输出结果
                </p>
                <div className="prose prose-sm max-w-none text-[var(--color-text)]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {output}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export { ToolCallCard, type ToolCallCardProps };
