"use client";

import { useState, useMemo } from "react";
import { GitBranch, Pause, Play, RotateCcw, Ban } from "lucide-react";
import { DataTable } from "@/features/governance/components/DataTable";
import { StatusBadge } from "@/features/governance/components/StatusBadge";
import { Button } from "@/shared/components/primitives/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/components/primitives/Tabs";
import type { ColumnDef } from "@/features/governance/types";
import {
  useTaskQueueHistory,
  useCancelTask,
  usePauseTask,
  useResumeTask,
  useRetryTask,
} from "../hooks/useTaskQueue";
import type { TaskQueueEntry } from "../hooks/useTaskQueue";
import { QueueTaskSheet } from "./QueueTaskSheet";

/* ─── Constants ─── */
const SESSION_ID = "default";

/* ─── Status filter tabs ─── */
const STATUS_TABS = [
  { value: "all", label: "全部" },
  { value: "queued,ready", label: "等待中" },
  { value: "executing", label: "执行中" },
  { value: "completed", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
  { value: "paused,preempted", label: "已暂停" },
] as const;

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

/* ─── Row type ─── */
type QueueRow = TaskQueueEntry & Record<string, unknown>;

/* ─── Priority label ─── */
function priorityLabel(p: number): string {
  if (p <= 10) return "critical";
  if (p <= 30) return "high";
  if (p <= 60) return "normal";
  return "low";
}

/* ─── Stat Card ─── */
function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center rounded-[var(--radius-md)] border border-[var(--color-border)] px-5 py-3">
      <span className={`text-2xl font-bold ${color}`}>{value}</span>
      <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">{label}</span>
    </div>
  );
}

/* ─── Component ─── */
export function QueueDashboard() {
  const [selectedEntry, setSelectedEntry] = useState<TaskQueueEntry | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const {
    entries,
    total,
    isLoading,
    page,
    pageSize,
    setPage,
    setPageSize,
    statusFilter,
    setStatusFilter,
    refetch,
  } = useTaskQueueHistory(SESSION_ID);

  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
  const retryTask = useRetryTask();

  /* ── Stats derived from entries ── */
  const stats = useMemo(() => {
    const totalCount = total || entries.length;
    let executing = 0;
    let waiting = 0;
    let failed = 0;
    for (const e of entries) {
      if (e.status === "executing") executing++;
      else if (e.status === "queued" || e.status === "ready") waiting++;
      else if (e.status === "failed") failed++;
    }
    return { total: totalCount, executing, waiting, failed };
  }, [entries, total]);

  /* ── Handle row click ── */
  const handleRowClick = (row: QueueRow) => {
    setSelectedEntry(row as TaskQueueEntry);
    setSheetOpen(true);
  };

  /* ── Action handlers ── */
  const handleAction = async (action: "cancel" | "pause" | "resume" | "retry", entryId: string) => {
    switch (action) {
      case "cancel":
        await cancelTask.mutateAsync(entryId);
        break;
      case "pause":
        await pauseTask.mutateAsync(entryId);
        break;
      case "resume":
        await resumeTask.mutateAsync(entryId);
        break;
      case "retry":
        await retryTask.mutateAsync(entryId);
        break;
    }
    refetch();
  };

  /* ── Columns ── */
  const columns: ColumnDef<QueueRow>[] = [
    {
      key: "goal",
      label: "任务名",
      width: "220px",
      render: (value) => (
        <span className="truncate text-[var(--text-sm)] font-medium text-[var(--color-text)]">
          {(value as string) || "—"}
        </span>
      ),
    },
    {
      key: "status",
      label: "状态",
      width: "110px",
      render: (value) => (
        <StatusBadge status={value as string} colorMap={QUEUE_STATUS_COLOR} />
      ),
    },
    {
      key: "priority",
      label: "优先级",
      width: "90px",
      hiddenOnMobile: true,
      render: (value) => (
        <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">
          {priorityLabel(value as number)}
        </span>
      ),
    },
    {
      key: "mode",
      label: "模式",
      width: "80px",
      hiddenOnMobile: true,
      render: (value) => (
        <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">
          {value as string}
        </span>
      ),
    },
    {
      key: "enqueuedAt",
      label: "入队时间",
      hiddenOnMobile: true,
      render: (value) => {
        if (!value) return "—";
        const d = new Date(value as string);
        return (
          <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">
            {d.toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </span>
        );
      },
    },
    {
      key: "entryId",
      label: "操作",
      width: "160px",
      render: (_value, row) => {
        const s = row.status as string;
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {s === "executing" && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[var(--text-xs)]"
                  onClick={() => handleAction("pause", row.entryId)}
                  disabled={pauseTask.isPending}
                >
                  <Pause className="mr-0.5 h-3 w-3" />
                  暂停
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[var(--text-xs)]"
                  onClick={() => handleAction("cancel", row.entryId)}
                  disabled={cancelTask.isPending}
                >
                  <Ban className="mr-0.5 h-3 w-3" />
                  取消
                </Button>
              </>
            )}
            {(s === "paused" || s === "preempted") && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[var(--text-xs)]"
                  onClick={() => handleAction("resume", row.entryId)}
                  disabled={resumeTask.isPending}
                >
                  <Play className="mr-0.5 h-3 w-3" />
                  恢复
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[var(--text-xs)]"
                  onClick={() => handleAction("cancel", row.entryId)}
                  disabled={cancelTask.isPending}
                >
                  <Ban className="mr-0.5 h-3 w-3" />
                  取消
                </Button>
              </>
            )}
            {s === "failed" && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[var(--text-xs)]"
                  onClick={() => handleAction("retry", row.entryId)}
                  disabled={retryTask.isPending}
                >
                  <RotateCcw className="mr-0.5 h-3 w-3" />
                  重试
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-[var(--text-xs)]"
                  onClick={() => handleAction("cancel", row.entryId)}
                  disabled={cancelTask.isPending}
                >
                  <Ban className="mr-0.5 h-3 w-3" />
                  取消
                </Button>
              </>
            )}
            {(s === "queued" || s === "ready") && (
              <Button
                variant="secondary"
                size="sm"
                className="h-7 px-2 text-[var(--text-xs)]"
                onClick={() => handleAction("cancel", row.entryId)}
                disabled={cancelTask.isPending}
              >
                <Ban className="mr-0.5 h-3 w-3" />
                取消
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  /* ── Pagination ── */
  const pagination = {
    page,
    pageSize,
    total: total || entries.length,
  };

  return (
    <div className="flex flex-col gap-6 p-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <GitBranch className="h-6 w-6 text-[var(--color-text-muted)]" />
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">编排中心</h1>
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap items-center gap-3">
        <StatCard label="队列总数" value={stats.total} color="text-[var(--color-text)]" />
        <StatCard label="执行中" value={stats.executing} color="text-[var(--color-info)]" />
        <StatCard label="等待中" value={stats.waiting} color="text-[var(--color-warning)]" />
        <StatCard label="失败" value={stats.failed} color="text-[var(--color-danger)]" />
      </div>

      {/* Status filter tabs */}
      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Table */}
      <DataTable<QueueRow>
        columns={columns}
        data={entries as QueueRow[]}
        loading={isLoading}
        pagination={pagination}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        onRowClick={handleRowClick}
        emptyMessage="暂无队列任务"
      />

      {/* Detail Sheet */}
      <QueueTaskSheet
        entry={selectedEntry}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        sessionId={SESSION_ID}
        onAction={handleAction}
      />
    </div>
  );
}
