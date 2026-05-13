"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { Button } from "@/shared/components/primitives/Button";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import { StatusBadge } from "@/features/governance";
import { toast } from "@/shared/components/feedback/Toast";
import { Upload, RotateCcw, Pencil } from "lucide-react";

/* ─── Types ─── */
interface ComponentRegistry {
  id: string;
  version: string;
  status: string;
  draftContent: string | null;
  releasedContent: string;
  updatedAt: string;
  [key: string]: unknown;
}

/* ─── Page ─── */
export default function UIComponentPage() {
  const queryClient = useQueryClient();
  const [isActing, setIsActing] = React.useState(false);
  const [draftEdit, setDraftEdit] = React.useState<string | null>(null);

  const { data, isLoading } = useQuery<ComponentRegistry>({
    queryKey: ["/governance/ui/component-registry"],
    queryFn: async () => {
      const res = await apiFetch("/governance/ui/component-registry");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<ComponentRegistry>;
    },
    staleTime: 30_000,
  });

  const act = React.useCallback(
    async (action: "publish" | "rollback" | "draft", body?: Record<string, unknown>) => {
      setIsActing(true);
      try {
        const method = action === "draft" ? "PUT" : "POST";
        const path =
          action === "draft"
            ? "/governance/ui/component-registry/draft"
            : `/governance/ui/component-registry/${action}`;
        const res = await apiFetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) throw new Error(`操作失败 (${res.status})`);
        toast.success("操作成功");
        queryClient.invalidateQueries({ queryKey: ["/governance/ui/component-registry"] });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "操作失败");
      } finally {
        setIsActing(false);
      }
    },
    [queryClient],
  );

  const handleSaveDraft = () => {
    if (draftEdit != null) {
      act("draft", { content: draftEdit });
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
            UI 组件注册表
          </h1>
          {data && (
            <p className="mt-1 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
              版本: {data.version} · <StatusBadge status={data.status} />
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={isActing}
            onClick={() => act("rollback")}
          >
            <RotateCcw className="h-4 w-4" />
            回滚
          </Button>
          <Button size="sm" disabled={isActing} onClick={() => act("publish")}>
            <Upload className="h-4 w-4" />
            发布
          </Button>
        </div>
      </div>

      {/* ── Version Compare ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Released */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <h3 className="mb-2 text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
            已发布内容
          </h3>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-sunken)] p-3 font-mono text-[var(--text-xs)] text-[var(--color-text)]">
            {data?.releasedContent ?? "—"}
          </pre>
        </div>

        {/* Draft */}
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
              草稿内容
            </h3>
            <div className="flex gap-2">
              {draftEdit == null ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraftEdit(data?.draftContent ?? "")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  编辑
                </Button>
              ) : (
                <Button size="sm" disabled={isActing} onClick={handleSaveDraft}>
                  保存草稿
                </Button>
              )}
            </div>
          </div>
          {draftEdit != null ? (
            <textarea
              className="h-96 w-full resize-none rounded bg-[var(--color-surface-sunken)] p-3 font-mono text-[var(--text-xs)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-border-focus)]"
              value={draftEdit}
              onChange={(e) => setDraftEdit(e.target.value)}
            />
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-sunken)] p-3 font-mono text-[var(--text-xs)] text-[var(--color-text)]">
              {data?.draftContent ?? "（无草稿）"}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
