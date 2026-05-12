"use client";

import { GovResourcePage, StatusBadge } from "@/features/governance";
import { useResourceMutation } from "@/features/governance";
import type { ResourcePageConfig } from "@/features/governance";
import { toast } from "@/shared/components/feedback/Toast";

interface PolicyVersion {
  id: string;
  name: string;
  version: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

const config: ResourcePageConfig<PolicyVersion> = {
  title: "策略版本",
  apiEndpoint: "/governance/policy/versions",
  searchable: true,
  searchPlaceholder: "搜索策略…",
  columns: [
    { key: "name", label: "策略名称", sortable: true },
    { key: "version", label: "版本", width: "100px" },
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
  filters: [
    {
      key: "name",
      label: "策略名称",
      type: "text",
    },
    {
      key: "status",
      label: "状态",
      type: "select",
      options: [
        { label: "草稿", value: "draft" },
        { label: "已发布", value: "released" },
        { label: "已弃用", value: "deprecated" },
      ],
    },
  ],
  createForm: {
    title: "新建策略版本",
    fields: [
      { name: "name", label: "策略名称", type: "text", required: true, placeholder: "输入策略名称" },
      { name: "content", label: "策略内容 (JSON)", type: "json", required: true, placeholder: '{"rules": []}' },
    ],
  },
};

export default function PolicyVersionsPage() {
  const mutations = useResourceMutation({
    endpoint: "/governance/policy/versions",
    listQueryKey: ["/governance/policy/versions"],
  });

  const configWithActions: ResourcePageConfig<PolicyVersion> = {
    ...config,
    actions: [
      {
        label: "发布",
        variant: "default",
        visible: (row) => row.status === "draft",
        onClick: async (row) => {
          await mutations.customAction(row.name, `${row.version}/release`);
          toast.success("策略已发布");
        },
      },
      {
        label: "弃用",
        variant: "destructive",
        visible: (row) => row.status === "released",
        onClick: async (row) => {
          await mutations.customAction(row.name, `${row.version}/deprecate`);
          toast.success("策略已弃用");
        },
      },
    ],
  };

  return <GovResourcePage<PolicyVersion> config={configWithActions} />;
}
