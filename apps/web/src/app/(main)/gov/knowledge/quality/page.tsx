"use client";

import { GovResourcePage, StatusBadge } from "@/features/governance";
import { useResourceMutation } from "@/features/governance";
import type { ResourcePageConfig } from "@/features/governance";
import { toast } from "@/shared/components/feedback/Toast";

interface EvalSet {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  lastRunAt: string;
  [key: string]: unknown;
}

const config: ResourcePageConfig<EvalSet> = {
  title: "质量评估",
  apiEndpoint: "/governance/knowledge/quality/eval-sets",
  searchable: true,
  searchPlaceholder: "搜索评估集…",
  columns: [
    { key: "name", label: "评估集名称", sortable: true },
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
    {
      key: "lastRunAt",
      label: "最近运行",
      width: "180px",
      hiddenOnMobile: true,
      render: (value) => (value ? String(value) : "—"),
    },
  ],
  createForm: {
    title: "新建评估集",
    fields: [
      { name: "name", label: "评估集名称", type: "text", required: true, placeholder: "输入评估集名称" },
      { name: "description", label: "描述", type: "textarea", placeholder: "评估集描述（可选）" },
    ],
  },
};

export default function KnowledgeQualityPage() {
  const mutations = useResourceMutation({
    endpoint: "/governance/knowledge/quality/eval-sets",
    listQueryKey: ["/governance/knowledge/quality/eval-sets"],
  });

  const configWithActions: ResourcePageConfig<EvalSet> = {
    ...config,
    actions: [
      {
        label: "运行评估",
        variant: "default",
        onClick: async (row) => {
          await mutations.customAction(row.id, "run");
          toast.success("评估任务已启动");
        },
      },
    ],
  };

  return <GovResourcePage<EvalSet> config={configWithActions} />;
}
