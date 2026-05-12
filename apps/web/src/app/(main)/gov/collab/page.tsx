"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import { Search } from "lucide-react";

/* ─── Types ─── */
interface DiagnosticsResult {
  collabRunId: string;
  status: string;
  diagnostics: unknown;
  [key: string]: unknown;
}

/* ─── Page ─── */
export default function CollabPage() {
  const [inputId, setInputId] = React.useState("");
  const [queryId, setQueryId] = React.useState<string | null>(null);

  const { data, isLoading, error } = useQuery<DiagnosticsResult>({
    queryKey: ["/governance/collab-runs", queryId, "diagnostics"],
    queryFn: async () => {
      const res = await apiFetch(`/governance/collab-runs/${queryId}/diagnostics`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<DiagnosticsResult>;
    },
    enabled: !!queryId,
    staleTime: 0,
  });

  const handleSearch = () => {
    const trimmed = inputId.trim();
    if (trimmed) setQueryId(trimmed);
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        协作运行诊断
      </h1>

      {/* ── Search ── */}
      <div className="flex items-center gap-3">
        <div className="w-full max-w-md">
          <Input
            placeholder="输入 Collab Run ID…"
            value={inputId}
            onChange={(e) => setInputId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            prefix={<Search className="h-4 w-4" />}
          />
        </div>
        <Button size="sm" onClick={handleSearch} disabled={!inputId.trim()}>
          查询
        </Button>
      </div>

      {/* ── Results ── */}
      {isLoading && (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-64" />
        </div>
      )}

      {error && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-danger-soft)] bg-[var(--color-danger-soft)] p-4 text-[var(--text-sm)] text-[var(--color-danger)]">
          {error instanceof Error ? error.message : "查询失败"}
        </div>
      )}

      {data && !isLoading && (
        <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[var(--text-sm)] font-medium text-[var(--color-text)]">
              Run ID: {data.collabRunId}
            </span>
            <span className="text-[var(--text-xs)] text-[var(--color-text-muted)]">
              状态: {data.status}
            </span>
          </div>
          <pre className="max-h-[600px] overflow-auto whitespace-pre-wrap rounded bg-[var(--color-surface-sunken)] p-4 font-mono text-[var(--text-xs)] text-[var(--color-text)]">
            {JSON.stringify(data.diagnostics, null, 2)}
          </pre>
        </div>
      )}

      {!queryId && !isLoading && (
        <p className="text-[var(--text-sm)] text-[var(--color-text-muted)]">
          请输入协作运行 ID 以查询诊断信息。
        </p>
      )}
    </div>
  );
}
