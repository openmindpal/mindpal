"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { DataTable } from "@/features/governance";
import { useResourceList } from "@/features/governance/hooks/useResourceList";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import type { ColumnDef } from "@/features/governance/types";

/* ─── Types ─── */
interface ObservabilitySummary {
  totalRequests: number;
  errorRate: number;
  avgLatencyMs: number;
  activeAlerts: number;
  [key: string]: unknown;
}

interface Operation {
  id: string;
  name: string;
  status: string;
  duration: string;
  timestamp: string;
  [key: string]: unknown;
}

/* ─── Metric Card ─── */
function MetricCard({ label, value, suffix }: { label: string; value: string | number; suffix?: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
      <p className="text-[var(--text-xs)] text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[var(--color-text)]">
        {value}{suffix && <span className="ml-0.5 text-[var(--text-sm)] text-[var(--color-text-secondary)]">{suffix}</span>}
      </p>
    </div>
  );
}

/* ─── Page ─── */
export default function ObservabilityPage() {
  /* ── Summary ── */
  const { data: summary, isLoading: summaryLoading } = useQuery<ObservabilitySummary>({
    queryKey: ["/governance/observability/summary"],
    queryFn: async () => {
      const res = await apiFetch("/governance/observability/summary");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<ObservabilitySummary>;
    },
    staleTime: 30_000,
  });

  /* ── Operations ── */
  const operations = useResourceList<Operation>({
    endpoint: "/governance/observability/operations",
  });

  const opCols: ColumnDef<Operation>[] = [
    { key: "timestamp", label: "时间", sortable: true },
    { key: "name", label: "操作名称", sortable: true },
    { key: "status", label: "状态" },
    { key: "duration", label: "耗时", hiddenOnMobile: true },
  ];

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        可观测性总览
      </h1>

      {/* ── Metric Cards ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {summaryLoading ? (
          <>
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </>
        ) : summary ? (
          <>
            <MetricCard label="总请求量" value={summary.totalRequests} />
            <MetricCard label="错误率" value={summary.errorRate} suffix="%" />
            <MetricCard label="平均延迟" value={summary.avgLatencyMs} suffix="ms" />
            <MetricCard label="活跃告警" value={summary.activeAlerts} />
          </>
        ) : null}
      </div>

      {/* ── Recent Operations ── */}
      <div>
        <h2 className="mb-3 text-[var(--text-base)] font-medium text-[var(--color-text)]">
          最近操作
        </h2>
        <DataTable<Operation>
          columns={opCols}
          data={operations.data}
          loading={operations.isLoading}
          pagination={operations.pagination}
          onPageChange={operations.setPage}
          onPageSizeChange={operations.setPageSize}
          sort={operations.sort}
          onSortChange={operations.setSort}
        />
      </div>
    </div>
  );
}
