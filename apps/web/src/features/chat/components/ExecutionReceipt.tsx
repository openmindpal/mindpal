"use client";

import { useState } from "react";
import { CheckCircle, XCircle, ChevronDown } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/components/primitives/Badge";
import { Spinner } from "@/shared/components/primitives/Spinner";

/* ─── Types ─── */

interface ExecutionStep {
  seq: number;
  toolRef: string;
  status: string;
}

interface ExecutionReceiptProps {
  taskId: string;
  runId?: string;
  status: "running" | "succeeded" | "failed";
  steps?: ExecutionStep[];
  className?: string;
}

/* ─── Status config ─── */

const statusMap = {
  running: {
    label: "执行中...",
    badgeVariant: "default" as const,
    icon: null, // uses Spinner
    textColor: "text-[var(--color-text-secondary)]",
  },
  succeeded: {
    label: "执行完成",
    badgeVariant: "success" as const,
    icon: CheckCircle,
    textColor: "text-[var(--color-success)]",
  },
  failed: {
    label: "执行失败",
    badgeVariant: "danger" as const,
    icon: XCircle,
    textColor: "text-[var(--color-danger)]",
  },
} as const;

/* ─── Step status icon ─── */

function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "done":
    case "succeeded":
      return <CheckCircle className="h-3.5 w-3.5 text-[var(--color-success)]" />;
    case "error":
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-[var(--color-danger)]" />;
    case "running":
      return (
        <span className="relative flex h-3.5 w-3.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-text-muted)] opacity-75" />
          <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-[var(--color-text-muted)]" />
        </span>
      );
    default:
      return <span className="h-3.5 w-3.5 rounded-full border border-[var(--color-border)]" />;
  }
}

/* ─── Component ─── */

function ExecutionReceipt({
  taskId,
  runId,
  status,
  steps,
  className,
}: ExecutionReceiptProps) {
  const config = statusMap[status];
  const StatusIcon = config.icon;
  const hasSteps = steps && steps.length > 0;
  const [stepsOpen, setStepsOpen] = useState(false);

  return (
    <div
      className={cn(
        "border rounded-lg p-4 bg-[var(--color-surface-raised)]",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {status === "running" ? (
          <Spinner size="sm" />
        ) : StatusIcon ? (
          <StatusIcon className={cn("h-5 w-5", config.textColor)} />
        ) : null}
        <span className={cn("text-sm font-medium", config.textColor)}>
          {config.label}
        </span>
        <Badge variant={config.badgeVariant} className="ml-auto">
          {status}
        </Badge>
      </div>

      {/* Info row */}
      <div className="mt-2 flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
        <span>Task: {taskId}</span>
        {runId && (
          <>
            <span className="text-[var(--color-border)]">|</span>
            <span>Run: {runId}</span>
          </>
        )}
      </div>

      {/* Steps (collapsible) */}
      {hasSteps && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setStepsOpen((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", stepsOpen && "rotate-180")} />
            <span>步骤详情 ({steps.length})</span>
          </button>
          {stepsOpen && (
            <div className="mt-2 space-y-1.5">
              {steps.map((step) => (
                <div
                  key={step.seq}
                  className={cn(
                    "flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-2 text-sm",
                    "bg-[var(--color-surface-sunken)]",
                    step.status === "running" && "animate-pulse"
                  )}
                >
                  <span className="text-xs text-[var(--color-text-muted)] w-5 text-right">
                    #{step.seq}
                  </span>
                  <span className="flex-1 font-medium text-[var(--color-text)] truncate">
                    {step.toolRef}
                  </span>
                  <StepStatusIcon status={step.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { ExecutionReceipt, type ExecutionReceiptProps };
