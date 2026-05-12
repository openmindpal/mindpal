"use client";

import * as React from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { Button } from "@/shared/components/primitives/Button";
import { Spinner } from "@/shared/components/primitives/Spinner";
import { StatusBadge } from "@/features/governance";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import { Inbox, ChevronDown, Eye } from "lucide-react";

/* ─── Types ─── */
interface PolicySnapshot {
  snapshotId: string;
  policyName: string;
  decision: string;
  createdAt: string;
  [key: string]: unknown;
}

interface SnapshotPage {
  items: PolicySnapshot[];
  nextCursorCreatedAt?: string;
  nextCursorSnapshotId?: string;
  hasMore: boolean;
}

export default function PolicySnapshotsPage() {
  /* ── Infinite query with cursor pagination ── */
  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery<SnapshotPage>({
    queryKey: ["/governance/policy/snapshots"],
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams();
      params.set("limit", "20");
      const cursor = pageParam as { cursorCreatedAt?: string; cursorSnapshotId?: string } | undefined;
      if (cursor?.cursorCreatedAt) params.set("cursorCreatedAt", cursor.cursorCreatedAt);
      if (cursor?.cursorSnapshotId) params.set("cursorSnapshotId", cursor.cursorSnapshotId);

      const res = await apiFetch(`/governance/policy/snapshots?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      const items = (json.items ?? json.data ?? []) as PolicySnapshot[];
      return {
        items,
        nextCursorCreatedAt: json.nextCursorCreatedAt as string | undefined,
        nextCursorSnapshotId: json.nextCursorSnapshotId as string | undefined,
        hasMore: !!json.nextCursorCreatedAt,
      };
    },
    initialPageParam: undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore
        ? { cursorCreatedAt: lastPage.nextCursorCreatedAt, cursorSnapshotId: lastPage.nextCursorSnapshotId }
        : undefined,
    staleTime: 30_000,
  });

  const allSnapshots = React.useMemo(
    () => data?.pages.flatMap((p) => p.items) ?? [],
    [data],
  );

  /* ── Explain detail sheet ── */
  const [explainOpen, setExplainOpen] = React.useState(false);
  const [explainData, setExplainData] = React.useState<Record<string, unknown> | null>(null);
  const [explainLoading, setExplainLoading] = React.useState(false);

  const handleExplain = async (snapshot: PolicySnapshot) => {
    setExplainOpen(true);
    setExplainLoading(true);
    setExplainData(null);
    try {
      const res = await apiFetch(`/governance/policy/snapshots/${snapshot.snapshotId}/explain`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      setExplainData(json as Record<string, unknown>);
    } catch {
      setExplainData({ error: "获取决策解释失败" });
    } finally {
      setExplainLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {/* ── Header ── */}
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        策略快照
      </h1>
      <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">
        策略决策记录，使用游标分页加载
      </p>

      {/* ── Table ── */}
      <div className="w-full overflow-x-auto">
        <table className="w-full border-collapse text-[var(--text-sm)]">
          <thead>
            <tr className="border-b border-[var(--color-border)]">
              <th className="px-3 py-3 text-left font-medium text-[var(--color-text-secondary)]">快照 ID</th>
              <th className="px-3 py-3 text-left font-medium text-[var(--color-text-secondary)]">策略名称</th>
              <th className="px-3 py-3 text-left font-medium text-[var(--color-text-secondary)]">决策</th>
              <th className="hidden px-3 py-3 text-left font-medium text-[var(--color-text-secondary)] sm:table-cell">创建时间</th>
              <th className="px-3 py-3 text-left font-medium text-[var(--color-text-secondary)]" style={{ width: "100px" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`skel-${i}`} className="border-b border-[var(--color-border)]">
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-3 py-3">
                      <div className="h-4 w-full animate-pulse rounded bg-[var(--color-surface-sunken)]" />
                    </td>
                  ))}
                </tr>
              ))}

            {!isLoading && allSnapshots.length === 0 && (
              <tr>
                <td colSpan={5} className="py-16 text-center">
                  <div className="flex flex-col items-center gap-2 text-[var(--color-text-muted)]">
                    <Inbox className="h-10 w-10" />
                    <span>暂无快照记录</span>
                  </div>
                </td>
              </tr>
            )}

            {allSnapshots.map((snap) => (
              <tr
                key={snap.snapshotId}
                className="border-b border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-raised)]"
              >
                <td className="px-3 py-3 font-mono text-[var(--text-xs)] text-[var(--color-text)]">
                  {snap.snapshotId.slice(0, 12)}…
                </td>
                <td className="px-3 py-3 text-[var(--color-text)]">{snap.policyName}</td>
                <td className="px-3 py-3">
                  <StatusBadge
                    status={snap.decision}
                    colorMap={{ allow: "success", deny: "danger" }}
                  />
                </td>
                <td className="hidden px-3 py-3 text-[var(--color-text)] sm:table-cell">{snap.createdAt}</td>
                <td className="px-3 py-3">
                  <Button variant="ghost" size="sm" onClick={() => handleExplain(snap)}>
                    <Eye className="h-3.5 w-3.5" />
                    解释
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Load more ── */}
      {hasNextPage && (
        <div className="flex justify-center pt-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => fetchNextPage()}
          >
            {isFetchingNextPage ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
            加载更多
          </Button>
        </div>
      )}

      {/* ── Explain Sheet ── */}
      <Sheet open={explainOpen} onOpenChange={setExplainOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>决策解释</SheetTitle>
            <SheetDescription className="sr-only">策略决策解释详情</SheetDescription>
          </SheetHeader>
          <div className="flex-1 py-4">
            {explainLoading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner className="h-6 w-6" />
              </div>
            ) : explainData ? (
              <pre className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-[var(--color-surface-sunken)] p-4 text-[var(--text-sm)] text-[var(--color-text)]">
                {JSON.stringify(explainData, null, 2)}
              </pre>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
