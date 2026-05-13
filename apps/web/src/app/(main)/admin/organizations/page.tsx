"use client";

import * as React from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  GovResourcePage,
  FormBuilder,
  useResourceMutation,
  type ResourcePageConfig,
  type ColumnDef,
  type ResourceAction,
  type FormFieldDef,
} from "@/features/governance";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";

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

/* ─── Edit Form Fields ─── */
const editFields: FormFieldDef[] = [
  { name: "name", label: "组织名称", type: "text", required: true, placeholder: "输入组织名称" },
  { name: "parentId", label: "上级组织 ID", type: "text", placeholder: "输入上级组织 ID（可选）" },
];

/* ─── Page Component ─── */
export default function OrganizationsPage() {
  const mutations = useResourceMutation({
    endpoint: "/org/units",
    listQueryKey: ["/org/units"],
  });

  /* ── Edit state ── */
  const [editOpen, setEditOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<OrgUnitRow | null>(null);
  const [editValues, setEditValues] = React.useState<Record<string, unknown>>({});
  const [editErrors, setEditErrors] = React.useState<Record<string, string>>({});

  /* ── Open edit sheet ── */
  const openEdit = React.useCallback((row: OrgUnitRow) => {
    setEditRow(row);
    setEditValues({
      name: row.name ?? "",
      parentId: row.parentId ?? "",
    });
    setEditErrors({});
    setEditOpen(true);
  }, []);

  /* ── Submit edit ── */
  const handleEditSubmit = React.useCallback(async () => {
    if (!editRow) return;
    const errors: Record<string, string> = {};
    if (!editValues.name || String(editValues.name).trim() === "") {
      errors.name = "组织名称不能为空";
    }
    if (Object.keys(errors).length > 0) {
      setEditErrors(errors);
      return;
    }
    setEditErrors({});
    await mutations.update(editRow.id, editValues);
    setEditOpen(false);
  }, [editRow, editValues, mutations]);

  /* ── Handle delete ── */
  const handleDelete = React.useCallback(
    async (row: OrgUnitRow) => {
      const confirmed = window.confirm(
        `确定要删除组织「${row.name}」吗？此操作不可恢复。`
      );
      if (!confirmed) return;
      await mutations.remove(row.id);
    },
    [mutations]
  );

  /* ─── Config ─── */
  const actions: ResourceAction<OrgUnitRow>[] = React.useMemo(
    () => [
      {
        label: "编辑",
        icon: Pencil,
        variant: "outline",
        onClick: (row) => openEdit(row),
      },
      {
        label: "删除",
        icon: Trash2,
        variant: "destructive",
        onClick: (row) => handleDelete(row),
      },
    ],
    [openEdit, handleDelete]
  );

  const config: ResourcePageConfig<OrgUnitRow> = React.useMemo(
    () => ({
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
          render: (v) =>
            v ? new Date(v as string).toLocaleString("zh-CN") : "-",
        },
      ],
      actions,
    }),
    [actions]
  );

  return (
    <>
      <GovResourcePage<OrgUnitRow> config={config} />

      {/* ── Edit Sheet ── */}
      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>编辑组织单元</SheetTitle>
            <SheetDescription className="sr-only">编辑组织单元信息</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-4 py-4">
            <FormBuilder
              fields={editFields}
              values={editValues}
              onChange={(name, value) =>
                setEditValues((prev) => ({ ...prev, [name]: value }))
              }
              onSubmit={handleEditSubmit}
              submitLabel="保存"
              loading={mutations.isLoading}
              errors={editErrors}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
