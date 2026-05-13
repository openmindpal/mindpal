"use client";

import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Ban,
  CircleDot,
  RotateCcw,
} from "lucide-react";
import { StatusBadge } from "@/features/governance/components/StatusBadge";
import { Button } from "@/shared/components/primitives/Button";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import { useRunDetail, useCancelRun, useReexecRun } from "../hooks/useRuns";
import type { RunSummary, RunStep } from "../hooks/useRuns";

/* ─── Status color mapping ─── */
const RUN_STATUS_COLOR: Record<string, "default" | "success" | "warning" | "danger"> = {
  queued: "default",
  paused: "default",
  running: "warning",
  needs_approval: "warning",
  succeeded: "success",
  completed: "success",
  failed: "danger",
  canceled: "danger",
};

/* ─── Step status icons ─── */
function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-[var(--color-danger)]" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-[var(--color-warning)]" />;
    case "canceled":
      return <Ban className="h-4 w-4 text-[var(--color-text-muted)]" />;
    case "queued":
      return <Clock className="h-4 w-4 text-[var(--color-text-muted)]" />;
    default:
      return <CircleDot className="h-4 w-4 text-[var(--color-text-muted)]" />;
  }
}

/* ─── Format duration ─── */
function fmtDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

/* ─── Cancelable statuses ─── */
const CANCELABLE = new Set(["queued", "running", "paused", "needs_approval", "needs_device", "needs_arbiter"]);

/* ─── Props ─── */
interface RunDetailSheetProps {
  run: RunSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/* ─── Component ─── */
export function RunDetailSheet({ run, open, onOpenChange }: RunDetailSheetProps) {
  const runId = run?.runId ?? null;
  const { detail, steps, isLoading } = useRunDetail(open ? runId : null);
  const cancelRun = useCancelRun();
  const reexecRun = useReexecRun();

  const displayRun = detail ?? run;
  const canCancel = displayRun ? CANCELABLE.has(displayRun.status) : false;

  const handleCancel = async () => {
    if (!runId) return;
    await cancelRun.mutateAsync(runId);
  };

  const handleReexec = async () => {
    if (!runId) return;
    await reexecRun.mutateAsync(runId);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">
            {displayRun?.runId?.slice(0, 16) ?? "运行详情"}
          </SheetTitle>
          <SheetDescription>运行详情与步骤时间轴</SheetDescription>
        </SheetHeader>

        <SheetBody className="flex flex-col gap-5">
          {/* Run info card */}
          {isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : displayRun ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--text-sm)]">
                <dt className="text-[var(--color-text-muted)]">状态</dt>
                <dd>
                  <StatusBadge status={displayRun.status} colorMap={RUN_STATUS_COLOR} />
                </dd>
                <dt className="text-[var(--color-text-muted)]">Phase</dt>
                <dd className="text-[var(--color-text)]">{displayRun.phase ?? "—"}</dd>
                <dt className="text-[var(--color-text-muted)]">运行 ID</dt>
                <dd className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                  {displayRun.runId}
                </dd>
                <dt className="text-[var(--color-text-muted)]">触发方式</dt>
                <dd className="text-[var(--color-text)]">{displayRun.trigger ?? "—"}</dd>
                <dt className="text-[var(--color-text-muted)]">进度</dt>
                <dd className="text-[var(--color-text)]">
                  {displayRun.progress.current}/{displayRun.progress.total}
                  {displayRun.progress.percentage > 0 && (
                    <span className="ml-1 text-[var(--color-text-muted)]">
                      ({displayRun.progress.percentage}%)
                    </span>
                  )}
                </dd>
                <dt className="text-[var(--color-text-muted)]">耗时</dt>
                <dd className="text-[var(--color-text)]">{fmtDuration(displayRun.durationMs)}</dd>
                <dt className="text-[var(--color-text-muted)]">创建时间</dt>
                <dd className="text-[var(--color-text)]">
                  {new Date(displayRun.createdAt).toLocaleString("zh-CN")}
                </dd>
                <dt className="text-[var(--color-text-muted)]">更新时间</dt>
                <dd className="text-[var(--color-text)]">
                  {new Date(displayRun.updatedAt).toLocaleString("zh-CN")}
                </dd>
              </dl>

              {/* Error info */}
              {displayRun.errorDigest && (
                <div className="mt-3 rounded-[var(--radius-sm)] bg-[var(--color-danger-bg)] px-3 py-2 text-[var(--text-xs)] text-[var(--color-danger)]">
                  <span className="font-medium">
                    {(displayRun.errorDigest as { errorCategory?: string })?.errorCategory ?? "错误"}:
                  </span>{" "}
                  {(displayRun.errorDigest as { message?: string })?.message ?? "未知错误"}
                </div>
              )}
            </div>
          ) : null}

          {displayRun && (
            <SheetFooter className="mt-0 pt-5">
              {canCancel && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCancel}
                  disabled={cancelRun.isPending}
                >
                  <Ban className="mr-1 h-3.5 w-3.5" />
                  {cancelRun.isPending ? "取消中..." : "取消运行"}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleReexec}
                disabled={reexecRun.isPending}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                {reexecRun.isPending ? "执行中..." : "重新执行"}
              </Button>
            </div>
            </SheetFooter>

          {/* Steps timeline */}
          <section className="border-t border-[var(--color-border-light)] pt-5">
              步骤时间轴 ({steps.length})
            </h3>
            {isLoading ? (
            {isLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : steps.length === 0 ? (
              <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">暂无步骤</p>
            ) : (
              <ol className="relative ml-2 border-l border-[var(--color-border)]">
                {steps.map((step: RunStep) => (
                  <li key={step.stepId} className="mb-3 ml-4 last:mb-0">
                    {/* Timeline dot */}
                    <span className="absolute -left-2 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-surface)]">
                      <StepStatusIcon status={step.status} />
                    </span>

                    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2">
                      {/* Step header */}
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-xs)] font-medium text-[var(--color-text)]">
                            #{step.seq}
                          </span>
                          {step.toolRef && (
                            <span className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                              {step.toolRef}
                            </span>
                          )}
                        </div>
                        <StatusBadge status={step.status} colorMap={RUN_STATUS_COLOR} />
                      </div>

                      {/* Step meta */}
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-[var(--text-xs)] text-[var(--color-text-muted)]">
                        {step.createdAt && (
                          <span>
                            开始: {new Date(step.createdAt).toLocaleTimeString("zh-CN")}
                          </span>
                        )}
                        {step.updatedAt && step.status !== "queued" && (
                          <span>
                            结束: {new Date(step.updatedAt).toLocaleTimeString("zh-CN")}
                          </span>
                        )}
                        <span>耗时: {fmtDuration(step.durationMs)}</span>
                      </div>

                      {/* Error info */}
                      {step.errorCategory && (
                        <div className="mt-1 text-[var(--text-xs)] text-[var(--color-danger)]">
                          {step.errorCategory}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {detail?.blockReason && (
            <div className="border-t border-[var(--color-border-light)] pt-5">
              <div className="rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-[var(--text-sm)]">
              <span className="font-medium text-[var(--color-warning)]">阻塞原因: </span>
              <span className="text-[var(--color-text)]">{detail.blockReason}</span>
            </div>
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
