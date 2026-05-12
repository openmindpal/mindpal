"use client";

import * as React from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/shared/components/primitives/Tabs";
import { Button } from "@/shared/components/primitives/Button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/shared/components/primitives/Sheet";
import {
  DataTable,
  FormBuilder,
  StatusBadge,
  useResourceList,
  useResourceMutation,
  type ColumnDef,
  type FormFieldDef,
  type SortState,
} from "@/features/governance";

/* ═══════════════════════════════════════
   Row types
   ═══════════════════════════════════════ */

interface ScimUserRow extends Record<string, unknown> {
  id: string;
  userName: string;
  displayName: string;
  active: boolean;
  emails: string;
}

interface ScimGroupRow extends Record<string, unknown> {
  id: string;
  displayName: string;
  memberCount: number;
}

/* ═══════════════════════════════════════
   Columns
   ═══════════════════════════════════════ */

const userColumns: ColumnDef<ScimUserRow>[] = [
  { key: "userName", label: "用户名", sortable: true },
  { key: "displayName", label: "显示名称", sortable: true },
  {
    key: "active",
    label: "状态",
    width: "100px",
    render: (v) => <StatusBadge status={v ? "active" : "inactive"} />,
  },
  {
    key: "emails",
    label: "邮箱",
    hiddenOnMobile: true,
    render: (v) => {
      if (!v) return "—";
      if (typeof v === "string") return v;
      if (Array.isArray(v)) {
        const primary = (v as { value: string; primary?: boolean }[]).find((e) => e.primary);
        return primary?.value ?? (v as { value: string }[])[0]?.value ?? "—";
      }
      return String(v);
    },
  },
];

const groupColumns: ColumnDef<ScimGroupRow>[] = [
  { key: "displayName", label: "组名称", sortable: true },
  {
    key: "memberCount",
    label: "成员数",
    width: "100px",
    render: (v) => String(v ?? 0),
  },
];

/* ═══════════════════════════════════════
   Form fields
   ═══════════════════════════════════════ */

const userFormFields: FormFieldDef[] = [
  { name: "userName", label: "用户名", type: "text", required: true, placeholder: "输入用户名" },
  { name: "displayName", label: "显示名称", type: "text", required: true, placeholder: "输入显示名称" },
  { name: "email", label: "邮箱", type: "text", placeholder: "输入邮箱地址" },
  { name: "active", label: "启用", type: "checkbox", defaultValue: true },
];

const groupFormFields: FormFieldDef[] = [
  { name: "displayName", label: "组名称", type: "text", required: true, placeholder: "输入组名称" },
];

/* ═══════════════════════════════════════
   Generic SCIM tab panel
   ═══════════════════════════════════════ */

interface ScimTabPanelProps<T extends Record<string, unknown>> {
  endpoint: string;
  columns: ColumnDef<T>[];
  formFields: FormFieldDef[];
  formTitle: string;
}

function ScimTabPanel<T extends Record<string, unknown>>({
  endpoint,
  columns,
  formFields,
  formTitle,
}: ScimTabPanelProps<T>) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});

  /* SCIM uses 'Resources' (capital R) as responseKey */
  const resource = useResourceList<T>({ endpoint, responseKey: "Resources" });
  const mutations = useResourceMutation({
    endpoint,
    listQueryKey: [endpoint],
    onSuccess: () => setCreateOpen(false),
  });

  /* Action columns */
  const finalColumns = React.useMemo(() => {
    const actionCol: ColumnDef<T> = {
      key: "__actions" as keyof T & string,
      label: "操作",
      width: "120px",
      render: (_v: unknown, row: T) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="secondary" size="sm" onClick={() => { void row; }}>
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </Button>
          <Button variant="danger" size="sm" onClick={() => mutations.remove(String(row.id))}>
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      ),
    };
    return [...columns, actionCol];
  }, [columns, mutations]);

  /* Validate + create */
  const handleCreate = React.useCallback(async () => {
    const errs: Record<string, string> = {};
    formFields.forEach((f) => {
      if (f.required) {
        const v = formValues[f.name];
        if (v == null || v === "") errs[f.name] = `${f.label}不能为空`;
      }
    });
    if (Object.keys(errs).length) {
      setFormErrors(errs);
      return;
    }
    setFormErrors({});
    await mutations.create(formValues);
  }, [formFields, formValues, mutations]);

  const openCreate = () => {
    const defaults: Record<string, unknown> = {};
    formFields.forEach((f) => {
      if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
    });
    setFormValues(defaults);
    setFormErrors({});
    setCreateOpen(true);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4" />
          新建
        </Button>
      </div>

      <DataTable<T>
        columns={finalColumns}
        data={resource.data}
        loading={resource.isLoading}
        pagination={resource.pagination}
        onPageChange={resource.setPage}
        onPageSizeChange={resource.setPageSize}
        sort={resource.sort}
        onSortChange={resource.setSort as (s: SortState) => void}
      />

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{formTitle}</SheetTitle>
            <SheetDescription className="sr-only">新建资源表单</SheetDescription>
          </SheetHeader>
          <div className="flex-1 py-4">
            <FormBuilder
              fields={formFields}
              values={formValues}
              onChange={(name, value) => setFormValues((prev) => ({ ...prev, [name]: value }))}
              onSubmit={handleCreate}
              submitLabel="创建"
              loading={mutations.isLoading}
              errors={formErrors}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ═══════════════════════════════════════
   Page
   ═══════════════════════════════════════ */

export default function SCIMPage() {
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        SCIM 身份管理
      </h1>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">用户</TabsTrigger>
          <TabsTrigger value="groups">组</TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          <ScimTabPanel<ScimUserRow>
            endpoint="/scim/v2/Users"
            columns={userColumns}
            formFields={userFormFields}
            formTitle="新建 SCIM 用户"
          />
        </TabsContent>

        <TabsContent value="groups">
          <ScimTabPanel<ScimGroupRow>
            endpoint="/scim/v2/Groups"
            columns={groupColumns}
            formFields={groupFormFields}
            formTitle="新建 SCIM 组"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
