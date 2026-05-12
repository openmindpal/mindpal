"use client";

import * as React from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  GovResourcePage,
  type ResourcePageConfig,
  type ColumnDef,
  type ResourceAction,
} from "@/features/governance";

/* ─── Row type ─── */
interface OrgUnitRow extends Record<string, unknown> {
  id: string;
  name: string;
  parentId: string;
  createdAt: string;
}

/* ─── Columns ─── */
const columns: ColumnDef<OrgUnitRow>[] = [
  { key: "name", label: "组织名称", sortable: true },
  {
    key: "parentId",
    label: "上级组织",
    hiddenOnMobile: true,
    render: (v) => (v ? String(v) : "—"),
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
function useOrgConfig(): ResourcePageConfig<OrgUnitRow> {
  return React.useMemo(() => {
    const actions: ResourceAction<OrgUnitRow>[] = [
      {
        label: "编辑",
        icon: Pencil,
        variant: "outline",
        onClick: (row) => {
          // TODO: open edit sheet
          void row;
        },
      },
      {
        label: "删除",
        icon: Trash2,
        variant: "destructive",
        onClick: (row) => {
          void row;
        },
      },
    ];

    return {
      title: "组织单元管理",
      apiEndpoint: "/org/units",
      columns,
      searchable: true,
      searchPlaceholder: "搜索组织…",
      createForm: {
        title: "新建组织单元",
        fields: [
          {
            name: "name",
            label: "组织名称",
            type: "text",
            required: true,
            placeholder: "输入组织名称",
          },
          {
            name: "parentId",
            label: "上级组织 ID",
            type: "text",
            placeholder: "输入上级组织 ID（可选）",
          },
        ],
      },
      detailFields: [
        { label: "ID", key: "id" },
        { label: "组织名称", key: "name" },
        { label: "上级组织", key: "parentId" },
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
export default function OrganizationsPage() {
  const config = useOrgConfig();
  return <GovResourcePage<OrgUnitRow> config={config} />;
}
