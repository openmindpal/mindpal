"use client";

import * as React from "react";
import { Trash2, Users } from "lucide-react";
import {
  GovResourcePage,
  type ResourcePageConfig,
  type ColumnDef,
  type ResourceAction,
} from "@/features/governance";

/* ─── Row type ─── */
interface SpaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  memberCount: number;
  createdAt: string;
}

/* ─── Columns ─── */
const columns: ColumnDef<SpaceRow>[] = [
  { key: "name", label: "空间名称", sortable: true },
  { key: "description", label: "描述", hiddenOnMobile: true },
  {
    key: "memberCount",
    label: "成员数",
    sortable: true,
    width: "100px",
    render: (v) => String(v ?? 0),
  },
  {
    key: "createdAt",
    label: "创建时间",
    sortable: true,
    hiddenOnMobile: true,
    width: "180px",
    render: (v) => (v ? new Date(v as string).toLocaleString("zh-CN") : "-"),
  },
];

/* ─── Config ─── */
function useSpacesConfig(): ResourcePageConfig<SpaceRow> {
  return React.useMemo(() => {
    const actions: ResourceAction<SpaceRow>[] = [
      {
        label: "成员",
        icon: Users,
        variant: "outline",
        onClick: (row) => {
          // TODO: open members panel for row.id
          void row;
        },
      },
      {
        label: "删除",
        icon: Trash2,
        variant: "destructive",
        onClick: (row) => {
          // handled via mutation in GovResourcePage actions
          void row;
        },
      },
    ];

    return {
      title: "空间管理",
      apiEndpoint: "/spaces",
      columns,
      searchable: true,
      searchPlaceholder: "搜索空间…",
      createForm: {
        title: "新建空间",
        fields: [
          {
            name: "name",
            label: "空间名称",
            type: "text",
            required: true,
            placeholder: "输入空间名称",
          },
          {
            name: "description",
            label: "描述",
            type: "textarea",
            placeholder: "输入空间描述（可选）",
          },
        ],
      },
      detailFields: [
        { label: "ID", key: "id" },
        { label: "空间名称", key: "name" },
        { label: "描述", key: "description" },
        { label: "成员数", key: "memberCount" },
        {
          label: "创建时间",
          key: "createdAt",
          render: (v) => (v ? new Date(v as string).toLocaleString("zh-CN") : "-"),
        },
      ],
      actions,
    };
  }, []);
}

/* ─── Page ─── */
export default function SpacesPage() {
  const config = useSpacesConfig();
  return <GovResourcePage<SpaceRow> config={config} />;
}
