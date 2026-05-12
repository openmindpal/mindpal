"use client";

import * as React from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/components/primitives/Tabs";
import { DataTable, StatusBadge } from "@/features/governance";
import { useResourceList } from "@/features/governance/hooks/useResourceList";
import { useResourceMutation } from "@/features/governance/hooks/useResourceMutation";
import { Button } from "@/shared/components/primitives/Button";
import { Trash2 } from "lucide-react";
import type { ColumnDef } from "@/features/governance/types";

/* ─── Row Types ─── */
interface ConfigEntry {
  key: string;
  scope: string;
  type: string;
  description: string;
  updatedAt: string;
  [k: string]: unknown;
}

interface ConfigOverride {
  id: string;
  configKey: string;
  value: string;
  scope: string;
  createdAt: string;
  [k: string]: unknown;
}

interface AuditLogEntry {
  id: string;
  action: string;
  configKey: string;
  actor: string;
  timestamp: string;
  [k: string]: unknown;
}

/* ─── Page ─── */
export default function ConfigPage() {
  /* ── Registry ── */
  const registry = useResourceList<ConfigEntry>({
    endpoint: "/governance/config/registry",
  });

  const registryCols: ColumnDef<ConfigEntry>[] = [
    { key: "key", label: "配置键", sortable: true },
    { key: "scope", label: "作用域" },
    { key: "type", label: "类型" },
    { key: "description", label: "描述", hiddenOnMobile: true },
    { key: "updatedAt", label: "更新时间", sortable: true, hiddenOnMobile: true },
  ];

  /* ── Overrides ── */
  const overrides = useResourceList<ConfigOverride>({
    endpoint: "/governance/config/overrides",
  });

  const overrideMutations = useResourceMutation({
    endpoint: "/governance/config/overrides",
    listQueryKey: ["/governance/config/overrides"],
  });

  const overrideCols: ColumnDef<ConfigOverride>[] = [
    { key: "configKey", label: "配置键", sortable: true },
    { key: "value", label: "值" },
    { key: "scope", label: "作用域" },
    { key: "createdAt", label: "创建时间", sortable: true, hiddenOnMobile: true },
    {
      key: "id",
      label: "操作",
      width: "80px",
      render: (_v, row) => (
        <Button
          variant="danger"
          size="sm"
          onClick={() => overrideMutations.remove(row.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ];

  /* ── Audit Log ── */
  const auditLog = useResourceList<AuditLogEntry>({
    endpoint: "/governance/config/audit-log",
  });

  const auditCols: ColumnDef<AuditLogEntry>[] = [
    { key: "timestamp", label: "时间", sortable: true },
    { key: "action", label: "操作" },
    { key: "configKey", label: "配置键" },
    { key: "actor", label: "操作人" },
  ];

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        配置治理
      </h1>

      <Tabs defaultValue="registry">
        <TabsList>
          <TabsTrigger value="registry">配置注册表</TabsTrigger>
          <TabsTrigger value="overrides">覆盖管理</TabsTrigger>
          <TabsTrigger value="audit">审计日志</TabsTrigger>
        </TabsList>

        <TabsContent value="registry">
          <DataTable<ConfigEntry>
            columns={registryCols}
            data={registry.data}
            loading={registry.isLoading}
            pagination={registry.pagination}
            onPageChange={registry.setPage}
            onPageSizeChange={registry.setPageSize}
            sort={registry.sort}
            onSortChange={registry.setSort}
          />
        </TabsContent>

        <TabsContent value="overrides">
          <DataTable<ConfigOverride>
            columns={overrideCols}
            data={overrides.data}
            loading={overrides.isLoading}
            pagination={overrides.pagination}
            onPageChange={overrides.setPage}
            onPageSizeChange={overrides.setPageSize}
            sort={overrides.sort}
            onSortChange={overrides.setSort}
          />
        </TabsContent>

        <TabsContent value="audit">
          <DataTable<AuditLogEntry>
            columns={auditCols}
            data={auditLog.data}
            loading={auditLog.isLoading}
            pagination={auditLog.pagination}
            onPageChange={auditLog.setPage}
            onPageSizeChange={auditLog.setPageSize}
            sort={auditLog.sort}
            onSortChange={auditLog.setSort}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
