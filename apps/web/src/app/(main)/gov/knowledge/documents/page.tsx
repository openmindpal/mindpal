"use client";

import { GovResourcePage, StatusBadge } from "@/features/governance";
import type { ResourcePageConfig } from "@/features/governance";

interface KnowledgeDocument {
  id: string;
  title: string;
  status: string;
  sourceType: string;
  updatedAt: string;
  [key: string]: unknown;
}

const config: ResourcePageConfig<KnowledgeDocument> = {
  title: "文档管理",
  apiEndpoint: "/governance/knowledge/documents",
  searchable: true,
  searchPlaceholder: "搜索文档…",
  columns: [
    { key: "title", label: "标题", sortable: true },
    {
      key: "status",
      label: "状态",
      sortable: true,
      width: "120px",
      render: (value) => <StatusBadge status={String(value)} />,
    },
    { key: "sourceType", label: "来源类型", width: "140px" },
    {
      key: "updatedAt",
      label: "更新时间",
      sortable: true,
      width: "180px",
      hiddenOnMobile: true,
    },
  ],
  filters: [
    {
      key: "status",
      label: "状态",
      type: "select",
      options: [
        { label: "已就绪", value: "ready" },
        { label: "处理中", value: "processing" },
        { label: "失败", value: "failed" },
      ],
    },
    {
      key: "sourceType",
      label: "来源类型",
      type: "select",
      options: [
        { label: "上传", value: "upload" },
        { label: "爬取", value: "crawl" },
        { label: "API", value: "api" },
        { label: "连接器", value: "connector" },
      ],
    },
  ],
};

export default function KnowledgeDocumentsPage() {
  return <GovResourcePage<KnowledgeDocument> config={config} />;
}
