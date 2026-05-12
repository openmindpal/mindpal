"use client";

import { useMemo, useState } from "react";
import { Plus, Database } from "lucide-react";
import { DataTable } from "@/features/governance/components/DataTable";
import { Button } from "@/shared/components/primitives/Button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/shared/components/primitives/Select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/shared/components/primitives/Dialog";
import { Textarea } from "@/shared/components/primitives/Textarea";
import { Skeleton } from "@/shared/components/primitives/Skeleton";
import type { ColumnDef, PaginationState } from "@/features/governance/types";
import { useSchemaList, useEntityList, useCreateEntity } from "../hooks/useEntities";
import type { EntityRecord } from "../hooks/useEntities";

/* ─── Flatten entity record for DataTable ─── */
type FlatRow = Record<string, unknown>;

function flattenRecord(record: EntityRecord): FlatRow {
  return {
    id: record.id,
    ...record.payload,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/* ─── Props ─── */
interface EntityListProps {
  onSelectRecord: (record: EntityRecord) => void;
}

/* ─── Component ─── */
export function EntityList({ onSelectRecord }: EntityListProps) {
  const { schemas, isLoading: schemasLoading } = useSchemaList();

  /* Extract unique entity names from all schemas */
  const entityTypes = useMemo(() => {
    const set = new Set<string>();
    for (const s of schemas) {
      if (s.schema?.entities) {
        for (const name of Object.keys(s.schema.entities)) {
          set.add(name);
        }
      }
    }
    return Array.from(set).sort();
  }, [schemas]);

  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  /* Auto-select first entity when types load */
  const currentEntity = selectedEntity ?? entityTypes[0] ?? null;

  const { items, isLoading, page, pageSize, setPage, setPageSize, refetch } = useEntityList(currentEntity);
  const createMutation = useCreateEntity(currentEntity);

  /* Create dialog */
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newPayloadRaw, setNewPayloadRaw] = useState("");

  /* Dynamic columns based on data */
  const columns = useMemo<ColumnDef<FlatRow>[]>(() => {
    const cols: ColumnDef<FlatRow>[] = [
      {
        key: "id",
        label: "ID",
        width: "180px",
        render: (value) => (
          <span className="truncate font-mono text-[var(--text-xs)]">
            {String(value ?? "").slice(0, 12)}...
          </span>
        ),
      },
    ];

    /* Derive business columns from first record's payload */
    if (items.length > 0) {
      const payloadKeys = Object.keys(items[0].payload ?? {}).slice(0, 3);
      for (const key of payloadKeys) {
        cols.push({
          key,
          label: key,
          hiddenOnMobile: true,
          render: (value) => {
            if (value === null || value === undefined) return "—";
            if (typeof value === "object") return JSON.stringify(value).slice(0, 40);
            return String(value).slice(0, 60);
          },
        });
      }
    }

    cols.push({
      key: "updatedAt",
      label: "更新时间",
      width: "140px",
      hiddenOnMobile: true,
      render: (value) => {
        if (!value) return "—";
        const d = new Date(value as string);
        return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
      },
    });

    return cols;
  }, [items]);

  /* Flat data for table */
  const flatData = useMemo(() => items.map(flattenRecord), [items]);

  /* Pagination (simple approach, API returns limited records) */
  const pagination: PaginationState = {
    page,
    pageSize,
    total: items.length < pageSize ? (page - 1) * pageSize + items.length : page * pageSize + 1,
  };

  /* Create handler */
  const handleCreate = async () => {
    try {
      const payload = JSON.parse(newPayloadRaw || "{}");
      await createMutation.mutateAsync(payload);
      setNewPayloadRaw("");
      setCreateDialogOpen(false);
    } catch (e) {
      // JSON parse error or API error - mutation.error will show
    }
  };

  const handleEntityChange = (value: string) => {
    setSelectedEntity(value);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">实体管理</h1>
        <Button size="sm" onClick={() => setCreateDialogOpen(true)} disabled={!currentEntity}>
          <Plus className="mr-1 h-4 w-4" />
          新建实体
        </Button>
      </div>

      {/* Entity type selector */}
      <div className="flex items-center gap-3">
        <span className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">实体类型:</span>
        {schemasLoading ? (
          <Skeleton className="h-9 w-48" />
        ) : entityTypes.length === 0 ? (
          <span className="text-[var(--text-sm)] text-[var(--color-text-muted)]">暂无已发布 Schema</span>
        ) : (
          <Select value={currentEntity ?? ""} onValueChange={handleEntityChange}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="选择实体类型" />
            </SelectTrigger>
            <SelectContent>
              {entityTypes.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={!currentEntity || isLoading}>
          刷新
        </Button>
      </div>

      {/* Empty state when no entity selected */}
      {!currentEntity && !schemasLoading && (
        <div className="flex flex-col items-center justify-center gap-4 py-16">
          <Database className="h-12 w-12 text-[var(--color-text-muted)]" />
          <p className="text-[var(--color-text-secondary)]">请先发布 Schema 以定义实体类型</p>
        </div>
      )}

      {/* Table */}
      {currentEntity && (
        <DataTable<FlatRow>
          columns={columns}
          data={flatData}
          loading={isLoading}
          pagination={pagination}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRowClick={(row) => {
            const original = items.find((r) => r.id === row.id);
            if (original) onSelectRecord(original);
          }}
          emptyMessage="暂无实体记录"
        />
      )}

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建实体</DialogTitle>
            <DialogDescription>
              为 <code className="rounded bg-[var(--color-surface-raised)] px-1 py-0.5">{currentEntity}</code> 创建新记录，输入 JSON 格式数据
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text)]">
                Payload (JSON)
              </span>
              <Textarea
                placeholder='{"field1": "value1", "field2": 123}'
                value={newPayloadRaw}
                onChange={(e) => setNewPayloadRaw(e.target.value)}
                rows={6}
                className="font-mono text-[var(--text-sm)]"
              />
            </label>
            {createMutation.error && (
              <p className="text-[var(--text-sm)] text-red-500">
                {(createMutation.error as Error).message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCreateDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "创建中..." : "创建"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
