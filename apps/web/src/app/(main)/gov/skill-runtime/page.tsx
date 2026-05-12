"use client";

import * as React from "react";
import { Power, PowerOff } from "lucide-react";
import {
  GovResourcePage,
  StatusBadge,
} from "@/features/governance";
import { useResourceMutation } from "@/features/governance/hooks/useResourceMutation";
import type { ResourcePageConfig, ColumnDef, ResourceAction } from "@/features/governance/types";

/* ─── Row Type ─── */
interface Runner {
  runnerId: string;
  status: string;
  host: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page ─── */
export default function SkillRuntimePage() {
  const mutations = useResourceMutation({
    endpoint: "/governance/skill-runtime/runners",
    listQueryKey: ["/governance/skill-runtime/runners"],
  });

  const columns: ColumnDef<Runner>[] = [
    { key: "runnerId", label: "Runner ID", sortable: true },
    {
      key: "status",
      label: "状态",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    { key: "host", label: "主机", sortable: true },
    { key: "createdAt", label: "创建时间", sortable: true, hiddenOnMobile: true },
  ];

  const actions: ResourceAction<Runner>[] = [
    {
      label: "启用",
      icon: Power,
      variant: "default",
      onClick: (row) => mutations.customAction(row.runnerId, "enable"),
      visible: (row) => row.status !== "enabled",
    },
    {
      label: "禁用",
      icon: PowerOff,
      variant: "destructive",
      onClick: (row) => mutations.customAction(row.runnerId, "disable"),
      visible: (row) => row.status === "enabled",
    },
  ];

  const config: ResourcePageConfig<Runner> = {
    title: "Skill 运行时管理",
    apiEndpoint: "/governance/skill-runtime/runners",
    columns,
    searchable: true,
    searchPlaceholder: "搜索 Runner…",
    actions,
    createForm: {
      title: "新建 Runner",
      fields: [
        { name: "host", label: "主机地址", type: "text", required: true, placeholder: "host:port" },
        { name: "capacity", label: "容量", type: "number", required: true, placeholder: "10" },
      ],
    },
  };

  return <GovResourcePage<Runner> config={config} />;
}
