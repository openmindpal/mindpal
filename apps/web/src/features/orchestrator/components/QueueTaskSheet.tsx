"use client";

import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  Ban,
  Pause,
  Play,
  RotateCcw,
  CircleDot,
  Link2,
} from "lucide-react";
import { StatusBadge } from "@/features/governance/components/StatusBadge";
import { Button } from "@/shared/components/primitives/Button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import { useTaskQueueSnapshot } from "../hooks/useTaskQueue";
import type { TaskQueueEntry, TaskDependency } from "../hooks/useTaskQueue";

/* ─── Status color mapping ─── */
const QUEUE_STATUS_COLOR: Record<string, "default" | "success" | "warning" | "danger"> = {
  queued: "default",
  ready: "default",
  executing: "warning",
  paused: "default",
  preempted: "default",
  completed: "success",
  failed: "danger",
  cancelled: "danger",
};

/* ─── Status icon ─── */
function EntryStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-[var(--color-danger)]" />;
    case "executing":
      return <Loader2 className="h-4 w-4 animate-spin text-[var(--color-warning)]" />;
    case "cancelled":
      return <Ban className="h-4 w-4 text-[var(--color-text-muted)]" />;
    case "paused":
    case "preempted":
      return <Pause className="h-4 w-4 text-[var(--color-text-muted)]" />;
    case "queued":
    case "ready":
      return <Clock className="h-4 w-4 text-[var(--color-text-muted)]" />;
    default:
      return <CircleDot className="h-4 w-4 text-[var(--color-text-muted)]" />;
  }
}

/* ─── Priority label ─── */
function priorityLabel(p: number): string {
  if (p <= 10) return "critical";
  if (p <= 30) return "high";
  if (p <= 60) return "normal";
  return "low";
}

/* ─── Props ─── */
interface QueueTaskSheetProps {
  entry: TaskQueueEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  onAction: (action: "cancel" | "pause" | "resume" | "retry", entryId: string) => Promise<void>;
}

/* ─── Component ─── */
export function QueueTaskSheet({ entry, open, onOpenChange, sessionId, onAction }: QueueTaskSheetProps) {
  const { dependencies } = useTaskQueueSnapshot(open ? sessionId : "");

  /* Find dependencies related to current entry */
  const entryDeps = entry
    ? dependencies.filter((d: TaskDependency) => d.fromEntryId === entry.entryId || d.toEntryId === entry.entryId)
    : [];

  const incomingDeps = entry
    ? entryDeps.filter((d: TaskDependency) => d.fromEntryId === entry.entryId)
    : [];

  const outgoingDeps = entry
    ? entryDeps.filter((d: TaskDependency) => d.toEntryId === entry.entryId)
    : [];

  const status = entry?.status ?? "";
  const canPause = status === "executing";
  const canResume = status === "paused" || status === "preempted";
  const canRetry = status === "failed";
  const canCancel = ["queued", "ready", "executing", "paused", "preempted"].includes(status);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-base">
            {entry && <EntryStatusIcon status={entry.status} />}
            <span className="truncate">{entry?.goal || "任务详情"}</span>
          </SheetTitle>
          <SheetDescription>任务详情与依赖关系</SheetDescription>
        </SheetHeader>

        {entry && (
          <div className="mt-4 flex flex-col gap-5">
            {/* Info card */}
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--text-sm)]">
                <dt className="text-[var(--color-text-muted)]">状态</dt>
                <dd>
                  <StatusBadge status={entry.status} colorMap={QUEUE_STATUS_COLOR} />
                </dd>
                <dt className="text-[var(--color-text-muted)]">模式</dt>
                <dd className="text-[var(--color-text)]">{entry.mode}</dd>
                <dt className="text-[var(--color-text-muted)]">优先级</dt>
                <dd className="text-[var(--color-text)]">
                  {entry.priority} ({priorityLabel(entry.priority)})
                </dd>
                <dt className="text-[var(--color-text-muted)]">位置</dt>
                <dd className="text-[var(--color-text)]">#{entry.position}</dd>
                <dt className="text-[var(--color-text-muted)]">前台</dt>
                <dd className="text-[var(--color-text)]">{entry.foreground ? "是" : "否"}</dd>
                <dt className="text-[var(--color-text-muted)]">重试次数</dt>
                <dd className="text-[var(--color-text)]">{entry.retryCount}</dd>
                <dt className="text-[var(--color-text-muted)]">Entry ID</dt>
                <dd className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                  {entry.entryId}
                </dd>
                <dt className="text-[var(--color-text-muted)]">入队时间</dt>
                <dd className="text-[var(--color-text)]">
                  {new Date(entry.enqueuedAt).toLocaleString("zh-CN")}
                </dd>
                {entry.startedAt && (
                  <>
                    <dt className="text-[var(--color-text-muted)]">开始时间</dt>
                    <dd className="text-[var(--color-text)]">
                      {new Date(entry.startedAt).toLocaleString("zh-CN")}
                    </dd>
                  </>
                )}
                {entry.completedAt && (
                  <>
                    <dt className="text-[var(--color-text-muted)]">完成时间</dt>
                    <dd className="text-[var(--color-text)]">
                      {new Date(entry.completedAt).toLocaleString("zh-CN")}
                    </dd>
                  </>
                )}
              </dl>
            </div>

            {/* Error info */}
            {entry.lastError && (
              <div className="rounded-[var(--radius-sm)] bg-[var(--color-danger-bg)] px-3 py-2 text-[var(--text-xs)] text-[var(--color-danger)]">
                <span className="font-medium">错误信息: </span>
                {entry.lastError}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2">
              {canPause && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction("pause", entry.entryId)}
                >
                  <Pause className="mr-1 h-3.5 w-3.5" />
                  暂停
                </Button>
              )}
              {canResume && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction("resume", entry.entryId)}
                >
                  <Play className="mr-1 h-3.5 w-3.5" />
                  恢复
                </Button>
              )}
              {canRetry && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction("retry", entry.entryId)}
                >
                  <RotateCcw className="mr-1 h-3.5 w-3.5" />
                  重试
                </Button>
              )}
              {canCancel && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction("cancel", entry.entryId)}
                >
                  <Ban className="mr-1 h-3.5 w-3.5" />
                  取消
                </Button>
              )}
            </div>

            {/* Dependencies section */}
            <section>
              <h3 className="mb-3 flex items-center gap-1.5 text-[var(--text-sm)] font-medium text-[var(--color-text)]">
                <Link2 className="h-4 w-4" />
                依赖关系 ({entryDeps.length})
              </h3>

              {entryDeps.length === 0 ? (
                <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">无依赖关系</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {incomingDeps.length > 0 && (
                    <div>
                      <p className="mb-1 text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)]">
                        依赖（需等待完成）
                      </p>
                      {incomingDeps.map((dep: TaskDependency) => (
                        <div
                          key={dep.depId}
                          className="mb-1 flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5"
                        >
                          <span className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                            {dep.toEntryId.slice(0, 12)}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
                              {dep.depType}
                            </span>
                            <StatusBadge status={dep.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {outgoingDeps.length > 0 && (
                    <div>
                      <p className="mb-1 text-[var(--text-xs)] font-medium text-[var(--color-text-secondary)]">
                        被依赖（阻塞下游）
                      </p>
                      {outgoingDeps.map((dep: TaskDependency) => (
                        <div
                          key={dep.depId}
                          className="mb-1 flex items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5"
                        >
                          <span className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                            {dep.fromEntryId.slice(0, 12)}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
                              {dep.depType}
                            </span>
                            <StatusBadge status={dep.status} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Metadata */}
            {entry.metadata && Object.keys(entry.metadata).length > 0 && (
              <section>
                <h3 className="mb-2 text-[var(--text-sm)] font-medium text-[var(--color-text)]">
                  元数据
                </h3>
                <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--color-surface)] p-3 text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                  {JSON.stringify(entry.metadata, null, 2)}
                </pre>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
