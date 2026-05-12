"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/shared/lib/api";
import { Button } from "@/shared/components/primitives/Button";
import { Input } from "@/shared/components/primitives/Input";
import { Spinner } from "@/shared/components/primitives/Spinner";
import { DataTable, StatusBadge } from "@/features/governance";
import type { ColumnDef, PaginationState, SortState } from "@/features/governance";
import { toast } from "@/shared/components/feedback/Toast";
import { Save } from "lucide-react";

/* ─── Types ─── */
interface EmbeddingConfig {
  modelName: string;
  dimensions: number;
  batchSize: number;
  [key: string]: unknown;
}

interface EmbeddingJob {
  id: string;
  status: string;
  documentCount: number;
  createdAt: string;
  completedAt: string;
  [key: string]: unknown;
}

/* ─── Job table columns ─── */
const jobColumns: ColumnDef<EmbeddingJob>[] = [
  { key: "id", label: "任务 ID", width: "220px" },
  {
    key: "status",
    label: "状态",
    width: "120px",
    render: (value) => <StatusBadge status={String(value)} />,
  },
  { key: "documentCount", label: "文档数", width: "100px" },
  { key: "createdAt", label: "创建时间", sortable: true, hiddenOnMobile: true },
  { key: "completedAt", label: "完成时间", hiddenOnMobile: true },
];

export default function KnowledgeEmbeddingPage() {
  const queryClient = useQueryClient();

  /* ── Embedding config query ── */
  const configQuery = useQuery<EmbeddingConfig>({
    queryKey: ["/governance/knowledge/embedding-config"],
    queryFn: async () => {
      const res = await apiFetch("/governance/knowledge/embedding-config");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json() as Promise<EmbeddingConfig>;
    },
    staleTime: 60_000,
  });

  /* ── Local form state ── */
  const [modelName, setModelName] = React.useState("");
  const [dimensions, setDimensions] = React.useState("");
  const [batchSize, setBatchSize] = React.useState("");
  const [formDirty, setFormDirty] = React.useState(false);

  React.useEffect(() => {
    if (configQuery.data) {
      setModelName(configQuery.data.modelName ?? "");
      setDimensions(String(configQuery.data.dimensions ?? ""));
      setBatchSize(String(configQuery.data.batchSize ?? ""));
      setFormDirty(false);
    }
  }, [configQuery.data]);

  /* ── Save config mutation ── */
  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        modelName,
        dimensions: Number(dimensions),
        batchSize: Number(batchSize),
      };
      const res = await apiFetch("/governance/knowledge/embedding-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`保存失败 (${res.status})`);
    },
    onSuccess: () => {
      toast.success("Embedding 配置已保存");
      queryClient.invalidateQueries({ queryKey: ["/governance/knowledge/embedding-config"] });
      setFormDirty(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  /* ── Jobs list query ── */
  const [jobPage, setJobPage] = React.useState(1);
  const [jobPageSize, setJobPageSize] = React.useState(20);
  const [jobSort, setJobSort] = React.useState<SortState | null>(null);

  const jobsQuery = useQuery<{ items: EmbeddingJob[]; total: number }>({
    queryKey: ["/governance/knowledge/embedding-jobs", jobPage, jobPageSize, jobSort],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(jobPageSize));
      params.set("offset", String((jobPage - 1) * jobPageSize));
      if (jobSort) params.set("sort", `${jobSort.key}:${jobSort.direction}`);
      const res = await apiFetch(`/governance/knowledge/embedding-jobs?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      const items = (json.items ?? json.data ?? []) as EmbeddingJob[];
      const total = typeof json.total === "number" ? json.total : items.length;
      return { items, total };
    },
    staleTime: 30_000,
  });

  const jobPagination: PaginationState = {
    page: jobPage,
    pageSize: jobPageSize,
    total: jobsQuery.data?.total ?? 0,
  };

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      {/* ── Header ── */}
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        向量化配置
      </h1>

      {/* ── Config Form ── */}
      <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-5">
        <h2 className="mb-4 text-[var(--text-base)] font-medium text-[var(--color-text)]">
          Embedding 模型配置
        </h2>
        {configQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner className="h-6 w-6" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                模型名称
              </label>
              <Input
                value={modelName}
                onChange={(e) => { setModelName(e.target.value); setFormDirty(true); }}
                placeholder="text-embedding-3-small"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                维度
              </label>
              <Input
                type="number"
                value={dimensions}
                onChange={(e) => { setDimensions(e.target.value); setFormDirty(true); }}
                placeholder="1536"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                批次大小
              </label>
              <Input
                type="number"
                value={batchSize}
                onChange={(e) => { setBatchSize(e.target.value); setFormDirty(true); }}
                placeholder="100"
              />
            </div>
            <div className="sm:col-span-3">
              <Button
                size="sm"
                disabled={!formDirty || saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                <Save className="h-4 w-4" />
                {saveMutation.isPending ? "保存中…" : "保存配置"}
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* ── Jobs Table ── */}
      <section>
        <h2 className="mb-3 text-[var(--text-base)] font-medium text-[var(--color-text)]">
          向量化任务
        </h2>
        <DataTable<EmbeddingJob>
          columns={jobColumns}
          data={jobsQuery.data?.items ?? []}
          loading={jobsQuery.isLoading}
          pagination={jobPagination}
          onPageChange={setJobPage}
          onPageSizeChange={setJobPageSize}
          sort={jobSort}
          onSortChange={setJobSort}
        />
      </section>
    </div>
  );
}
