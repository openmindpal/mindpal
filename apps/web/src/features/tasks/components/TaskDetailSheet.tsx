"use client";

import { StatusBadge } from "@/features/governance/components/StatusBadge";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import { useTaskDetail, useTaskMessages } from "../hooks/useTasks";
import type { Task } from "../hooks/useTasks";

/* ─── Status color mapping ─── */
const TASK_STATUS_COLOR: Record<string, "default" | "success" | "warning" | "danger"> = {
  pending: "default",
  created: "default",
  running: "warning",
  completed: "success",
  succeeded: "success",
  done: "success",
  failed: "danger",
  error: "danger",
};

/* ─── Props ─── */
interface TaskDetailSheetProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/* ─── Component ─── */
export function TaskDetailSheet({ task, open, onOpenChange }: TaskDetailSheetProps) {
  const taskId = task?.taskId ?? null;
  const { task: detail, runs, isLoading: detailLoading } = useTaskDetail(open ? taskId : null);
  const { messages, isLoading: messagesLoading } = useTaskMessages(open ? taskId : null);

  const displayTask = detail ?? task;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{displayTask?.title || "未命名任务"}</SheetTitle>
          <SheetDescription>任务详情与关联信息</SheetDescription>
        </SheetHeader>

        {/* Task info */}
        <div className="mt-4 flex flex-col gap-4">
          {detailLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ) : displayTask ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[var(--text-sm)]">
                <dt className="text-[var(--color-text-muted)]">状态</dt>
                <dd>
                  <StatusBadge status={displayTask.status} colorMap={TASK_STATUS_COLOR} />
                </dd>
                <dt className="text-[var(--color-text-muted)]">任务 ID</dt>
                <dd className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                  {displayTask.taskId}
                </dd>
                <dt className="text-[var(--color-text-muted)]">创建时间</dt>
                <dd className="text-[var(--color-text)]">
                  {new Date(displayTask.createdAt).toLocaleString("zh-CN")}
                </dd>
                <dt className="text-[var(--color-text-muted)]">更新时间</dt>
                <dd className="text-[var(--color-text)]">
                  {new Date(displayTask.updatedAt).toLocaleString("zh-CN")}
                </dd>
              </dl>
            </div>
          ) : null}

          {/* Runs section */}
          <section>
            <h3 className="mb-2 text-[var(--text-sm)] font-medium text-[var(--color-text)]">
              关联运行 ({runs.length})
            </h3>
            {detailLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : runs.length === 0 ? (
              <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">暂无关联运行</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {runs.map((run) => (
                  <li
                    key={run.runId}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate font-mono text-[var(--text-xs)] text-[var(--color-text-secondary)]">
                        {run.runId.slice(0, 8)}...
                      </span>
                      <StatusBadge status={run.status} colorMap={TASK_STATUS_COLOR} />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[var(--text-xs)] text-[var(--color-text-muted)]">
                      {run.jobType && <span>{run.jobType}</span>}
                      {run.startedAt && (
                        <span>{new Date(run.startedAt).toLocaleString("zh-CN")}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Messages section */}
          <section>
            <h3 className="mb-2 text-[var(--text-sm)] font-medium text-[var(--color-text)]">
              消息历史 ({messages.length})
            </h3>
            {messagesLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">暂无消息</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {messages.map((msg) => (
                  <li
                    key={msg.messageId}
                    className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[var(--text-sm)] font-medium text-[var(--color-text)]">
                        {msg.from.role}
                        {msg.from.agentId && (
                          <span className="ml-1 text-[var(--text-xs)] text-[var(--color-text-muted)]">
                            ({msg.from.agentId})
                          </span>
                        )}
                      </span>
                      <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
                        {msg.intent}
                      </span>
                    </div>
                    <div className="mt-1 text-[var(--text-xs)] text-[var(--color-text-muted)]">
                      {new Date(msg.createdAt).toLocaleString("zh-CN")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
