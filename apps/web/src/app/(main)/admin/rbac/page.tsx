"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
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
  useResourceList,
  useResourceMutation,
  type ColumnDef,
  type FormFieldDef,
  type SortState,
} from "@/features/governance";

/* ═══════════════════════════════════════
   Row types
   ═══════════════════════════════════════ */

interface RoleRow extends Record<string, unknown> {
  roleId: string;
  roleName: string;
  description: string;
  createdAt: string;
}

interface PermissionRow extends Record<string, unknown> {
  permissionId: string;
  resourceType: string;
  action: string;
  fieldRules: string;
  createdAt: string;
}

interface BindingRow extends Record<string, unknown> {
  bindingId: string;
  roleId: string;
  subjectId: string;
  scope: string;
  createdAt: string;
}

/* ═══════════════════════════════════════
   Column definitions
   ═══════════════════════════════════════ */

const roleColumns: ColumnDef<RoleRow>[] = [
  { key: "roleName", label: "角色名称", sortable: true },
  { key: "description", label: "描述", hiddenOnMobile: true },
  {
    key: "createdAt",
    label: "创建时间",
    sortable: true,
    hiddenOnMobile: true,
    width: "180px",
    render: (v) => (v ? new Date(v as string).toLocaleString("zh-CN") : "-"),
  },
];

const permissionColumns: ColumnDef<PermissionRow>[] = [
  { key: "resourceType", label: "资源类型", sortable: true },
  { key: "action", label: "操作", sortable: true },
  {
    key: "fieldRules",
    label: "字段规则",
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

const bindingColumns: ColumnDef<BindingRow>[] = [
  { key: "roleId", label: "角色 ID", sortable: true },
  { key: "subjectId", label: "主体 ID", sortable: true },
  { key: "scope", label: "范围", hiddenOnMobile: true },
  {
    key: "createdAt",
    label: "创建时间",
    sortable: true,
    hiddenOnMobile: true,
    width: "180px",
    render: (v) => (v ? new Date(v as string).toLocaleString("zh-CN") : "-"),
  },
];

/* ═══════════════════════════════════════
   Form field definitions
   ═══════════════════════════════════════ */

const roleFormFields: FormFieldDef[] = [
  { name: "roleName", label: "角色名称", type: "text", required: true, placeholder: "输入角色名称" },
  { name: "description", label: "描述", type: "textarea", placeholder: "输入描述（可选）" },
];

const permissionFormFields: FormFieldDef[] = [
  { name: "resourceType", label: "资源类型", type: "text", required: true, placeholder: "如: entity, schema" },
  { name: "action", label: "操作", type: "text", required: true, placeholder: "如: read, write, delete" },
  { name: "fieldRules", label: "字段规则 (JSON)", type: "json", placeholder: "{}" },
];

const bindingFormFields: FormFieldDef[] = [
  { name: "roleId", label: "角色 ID", type: "text", required: true, placeholder: "输入角色 ID" },
  { name: "subjectId", label: "主体 ID", type: "text", required: true, placeholder: "输入用户/组 ID" },
  { name: "scope", label: "范围", type: "text", placeholder: "如: tenant, space:xxx" },
];

/* ═══════════════════════════════════════
   Generic sub-tab panel component
   ═══════════════════════════════════════ */

interface TabPanelProps<T extends Record<string, unknown>> {
  endpoint: string;
  columns: ColumnDef<T>[];
  formFields: FormFieldDef[];
  formTitle: string;
  deletable?: boolean;
  idKey?: string;
}

function TabPanel<T extends Record<string, unknown>>({
  endpoint,
  columns,
  formFields,
  formTitle,
  deletable = false,
  idKey = "id",
}: TabPanelProps<T>) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});

  const resource = useResourceList<T>({ endpoint });
  const mutations = useResourceMutation({
    endpoint,
    listQueryKey: [endpoint],
    onSuccess: () => setCreateOpen(false),
  });

  /* Action columns */
  const finalColumns = React.useMemo(() => {
    if (!deletable) return columns;
    const actionCol: ColumnDef<T> = {
      key: "__actions" as keyof T & string,
      label: "操作",
      width: "80px",
      render: (_v: unknown, row: T) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Button
            variant="danger"
            size="sm"
            onClick={() => mutations.remove(String(row[idKey]))}
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      ),
    };
    return [...columns, actionCol];
  }, [columns, deletable, idKey, mutations]);

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
    setFormValues({});
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

export default function RBACPage() {
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        RBAC 权限管理
      </h1>

      <Tabs defaultValue="roles">
        <TabsList>
          <TabsTrigger value="roles">角色</TabsTrigger>
          <TabsTrigger value="permissions">权限</TabsTrigger>
          <TabsTrigger value="bindings">绑定</TabsTrigger>
        </TabsList>

        <TabsContent value="roles">
          <TabPanel<RoleRow>
            endpoint="/rbac/roles"
            columns={roleColumns}
            formFields={roleFormFields}
            formTitle="新建角色"
            deletable
            idKey="roleId"
          />
        </TabsContent>

        <TabsContent value="permissions">
          <TabPanel<PermissionRow>
            endpoint="/rbac/permissions"
            columns={permissionColumns}
            formFields={permissionFormFields}
            formTitle="新建权限"
          />
        </TabsContent>

        <TabsContent value="bindings">
          <TabPanel<BindingRow>
            endpoint="/rbac/bindings"
            columns={bindingColumns}
            formFields={bindingFormFields}
            formTitle="新建绑定"
            deletable
            idKey="bindingId"
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
