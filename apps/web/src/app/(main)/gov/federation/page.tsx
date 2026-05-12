"use client";

import * as React from "react";
import { Wifi, Eye, Trash2 } from "lucide-react";
import {
  GovResourcePage,
  StatusBadge,
} from "@/features/governance";
import { useResourceMutation } from "@/features/governance/hooks/useResourceMutation";
import type { ResourcePageConfig, ColumnDef, ResourceAction } from "@/features/governance/types";

/* ─── Row Type ─── */
interface FederationNode {
  nodeId: string;
  endpoint: string;
  status: string;
  lastHeartbeat: string;
  mode: string;
  [key: string]: unknown;
}

/* ─── Page ─── */
export default function FederationPage() {
  const mutations = useResourceMutation({
    endpoint: "/governance/federation/nodes",
    listQueryKey: ["/governance/federation/nodes"],
  });

  const columns: ColumnDef<FederationNode>[] = [
    { key: "nodeId", label: "节点 ID", sortable: true },
    { key: "endpoint", label: "端点", sortable: true },
    {
      key: "status",
      label: "状态",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    { key: "lastHeartbeat", label: "最后心跳", sortable: true, hiddenOnMobile: true },
    { key: "mode", label: "模式", hiddenOnMobile: true },
  ];

  const actions: ResourceAction<FederationNode>[] = [
    {
      label: "测试",
      icon: Wifi,
      variant: "outline",
      onClick: (row) => mutations.customAction(row.nodeId, "test"),
    },
    {
      label: "能力",
      icon: Eye,
      variant: "outline",
      onClick: (row) => mutations.customAction(row.nodeId, "capabilities"),
    },
    {
      label: "删除",
      icon: Trash2,
      variant: "destructive",
      onClick: (row) => mutations.remove(row.nodeId),
    },
  ];

  const config: ResourcePageConfig<FederationNode> = {
    title: "联邦节点管理",
    apiEndpoint: "/governance/federation/nodes",
    columns,
    searchable: true,
    searchPlaceholder: "搜索节点…",
    actions,
    createForm: {
      title: "新建联邦节点",
      fields: [
        { name: "nodeId", label: "节点 ID", type: "text", required: true },
        { name: "endpoint", label: "端点地址", type: "text", required: true, placeholder: "https://" },
        {
          name: "mode",
          label: "模式",
          type: "select",
          required: true,
          options: [
            { label: "主动", value: "active" },
            { label: "被动", value: "passive" },
            { label: "双向", value: "bidirectional" },
          ],
        },
      ],
    },
  };

  return <GovResourcePage<FederationNode> config={config} />;
}
