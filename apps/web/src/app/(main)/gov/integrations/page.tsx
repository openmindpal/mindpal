"use client";

import * as React from "react";
import {
  GovResourcePage,
  StatusBadge,
} from "@/features/governance";
import type { ResourcePageConfig, ColumnDef } from "@/features/governance/types";

/* ─── Row Type ─── */
interface Integration {
  id: string;
  name: string;
  type: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page ─── */
export default function IntegrationsPage() {
  const columns: ColumnDef<Integration>[] = [
    { key: "name", label: "名称", sortable: true },
    { key: "id", label: "ID", hiddenOnMobile: true },
    { key: "type", label: "类型", sortable: true },
    {
      key: "status",
      label: "状态",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    { key: "createdAt", label: "创建时间", sortable: true, hiddenOnMobile: true },
  ];

  const config: ResourcePageConfig<Integration> = {
    title: "集成管理",
    apiEndpoint: "/governance/integrations",
    columns,
    searchable: true,
    searchPlaceholder: "搜索集成…",
    filters: [
      {
        key: "type",
        label: "类型",
        type: "select",
        options: [
          { label: "OAuth", value: "OAuth" },
          { label: "订阅", value: "subscription" },
          { label: "SIEM", value: "SIEM" },
        ],
      },
    ],
    detailFields: [
      { label: "名称", key: "name" },
      { label: "ID", key: "id" },
      { label: "类型", key: "type" },
      { label: "状态", key: "status" },
      { label: "创建时间", key: "createdAt" },
    ],
  };

  return <GovResourcePage<Integration> config={config} />;
}
