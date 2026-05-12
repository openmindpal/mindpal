"use client";

import { useMemo } from "react";
import { Activity } from "lucide-react";
import { DataTable } from "@/features/governance/components/DataTable";
import { StatusBadge } from "@/features/governance/components/StatusBadge";
import { Badge } from "@/shared/components/primitives/Badge";
import { Tabs, TabsList, TabsTrigger } from "@/shared/components/primitives/Tabs";
import type { ColumnDef, PaginationState } from "@/features/governance/types";
import { useRunList, useActiveRuns } from "../hooks/useRuns";
import type { RunSummary } from "../hooks/useRuns";

/* ─── Status filter tabs ─── */
const STATUS_TABS = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "succeeded", label: "已完成" },
  { value: "failed", label: "失败" },
  { value: "canceled", label: "已取消" },
] as const;

/* ─── Status color mapping ─── */
const RUN_STATUS_COLOR: Record<string, "default" | "success" | "warning" | "danger"> = {
  queued: "default",
  paused: "default",
  running: "warning",
  needs_approval: "warning",
  needs_device: "warning",
  needs_arbiter: "warning",
  succeeded: "success",
  completed: "success",
  failed: "danger",
  canceled: "danger",
  compensated: "danger",
};

/* ─── Row type ─── */
type RunRow = RunSummary & Record<string, unknown>;

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

/* ─── Columns ─── */
const columns: ColumnDef<RunRow>[] = [
  {
    key: "runId",
    label: "运行 ID",
    width: "180px",
    render: (value) => (
      <span className="truncate font-mono text-[var(--text-xs)]">
        {(value as string)?.slice(0, 12) ?? "—"}
      </span>
    ),
  },
  {
    key: "status",
    label: "状态",
    width: "120px",
    render: (value) => (
      <StatusBadge status={value as string} colorMap={RUN_STATUS_COLOR} />
    ),
  },
  {
    key: "phase",
    label: "Phase",
    width: "100px",
    hiddenOnMobile: true,
    render: (value) => (
      <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">
        {(value as string) ?? "—"}
      </span>
    ),
  },
  {
    key: "progress",
    label: "步骤",
    width: "80px",
    hiddenOnMobile: true,
    render: (_value, row) => {
      const p = row.progress;
      return (
        <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">
          {p.current}/{p.total}
        </span>
      );
    },
  },
  {
    key: "durationMs",
    label: "耗时",
    width: "90px",
    hiddenOnMobile: true,
    render: (value) => (
      <span className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">
        {fmtDuration(value as number | null)}
      </span>
    ),
  },
  {
    key: "createdAt",
    label: "创建时间",
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
          })}
        </span>
      );
    },
  },
];

/* ─── Props ─── */
interface RunListProps {
  onSelectRun: (run: RunSummary) => void;
}

/* ─── Component ─── */
export function RunList({ onSelectRun }: RunListProps) {
  const {
    runs,
    isLoading,
    page,
    pageSize,
    setPage,
    setPageSize,
    statusFilter,
    setStatusFilter,
  } = useRunList();
  const { activeCount } = useActiveRuns();

  /* Client-side filter for tab display */
  const filteredRuns = useMemo(() => {
    if (statusFilter === "all") return runs;
    return runs;
  }, [runs, statusFilter]);

  /* Pagination (server-side via offset, approx total) */
  const pagination: PaginationState = {
    page,
    pageSize,
    total:
      filteredRuns.length < pageSize
        ? (page - 1) * pageSize + filteredRuns.length
        : page * pageSize + 1,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">运行管理</h1>
        <Badge variant="secondary" className="flex items-center gap-1.5">
          <Activity className="h-3.5 w-3.5" />
          活跃运行: {activeCount}
        </Badge>
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
      <DataTable<RunRow>
        columns={columns}
        data={filteredRuns as RunRow[]}
        loading={isLoading}
        pagination={pagination}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        onRowClick={(row) => onSelectRun(row as RunSummary)}
        emptyMessage="暂无运行记录"
      />
    </div>
  );
}
