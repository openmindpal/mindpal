"use client";

import { GovResourcePage, StatusBadge } from "@/features/governance";
import { useResourceMutation } from "@/features/governance";
import type { ResourcePageConfig } from "@/features/governance";
import { toast } from "@/shared/components/feedback/Toast";

interface RetrievalStrategy {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

const config: ResourcePageConfig<RetrievalStrategy> = {
  title: "检索策略",
  apiEndpoint: "/governance/knowledge/retrieval-strategies",
  searchable: true,
  searchPlaceholder: "搜索策略…",
  columns: [
    { key: "name", label: "策略名称", sortable: true },
    {
      key: "status",
      label: "状态",
      sortable: true,
      width: "120px",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    {
      key: "createdAt",
      label: "创建时间",
      sortable: true,
      width: "180px",
      hiddenOnMobile: true,
    },
  ],
  createForm: {
    title: "新建检索策略",
    fields: [
      { name: "name", label: "策略名称", type: "text", required: true, placeholder: "输入策略名称" },
      { name: "description", label: "描述", type: "textarea", placeholder: "策略描述（可选）" },
      { name: "config", label: "配置 (JSON)", type: "json", required: true, placeholder: '{"topK": 10, "threshold": 0.7}' },
    ],
  },
};

export default function KnowledgeRetrievalPage() {
  const mutations = useResourceMutation({
    endpoint: "/governance/knowledge/retrieval-strategies",
    listQueryKey: ["/governance/knowledge/retrieval-strategies"],
  });

  const configWithActions: ResourcePageConfig<RetrievalStrategy> = {
    ...config,
    actions: [
      {
        label: "激活",
        variant: "default",
        visible: (row) => row.status !== "active",
        onClick: async (row) => {
          await mutations.customAction(row.id, "activate");
          toast.success("策略已激活");
        },
      },
    ],
  };

  return <GovResourcePage<RetrievalStrategy> config={configWithActions} />;
}
