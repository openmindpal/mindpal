"use client";

import * as React from "react";
import { Shield, Plus, Trash2 } from "lucide-react";
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
  type ColumnDef,
  type FormFieldDef,
} from "@/features/governance";

/* ═══════════════════════════════════════
   Types
   ═══════════════════════════════════════ */

interface SSOProviderRow extends Record<string, unknown> {
  id: string;
  name: string;
  protocol: string;
  issuer: string;
  status: string;
}

/* ═══════════════════════════════════════
   Mock data
   ═══════════════════════════════════════ */

const MOCK_PROVIDERS: SSOProviderRow[] = [
  { id: "1", name: "企业 OIDC", protocol: "OIDC", issuer: "https://idp.example.com", status: "active" },
  { id: "2", name: "SAML IdP", protocol: "SAML", issuer: "https://saml.example.com/metadata", status: "inactive" },
];

/* ═══════════════════════════════════════
   Columns
   ═══════════════════════════════════════ */

const providerColumns: ColumnDef<SSOProviderRow>[] = [
  { key: "name", label: "提供者名称", sortable: true },
  { key: "protocol", label: "协议", width: "100px" },
  { key: "issuer", label: "Issuer / Metadata URL", hiddenOnMobile: true },
  {
    key: "status",
    label: "状态",
    width: "100px",
    render: (v) => <StatusBadge status={String(v)} />,
  },
];

/* ═══════════════════════════════════════
   Form fields for new SSO provider
   ═══════════════════════════════════════ */

const ssoFormFields: FormFieldDef[] = [
  { name: "name", label: "提供者名称", type: "text", required: true, placeholder: "如: 企业 OIDC" },
  {
    name: "protocol",
    label: "协议",
    type: "select",
    required: true,
    options: [
      { label: "OIDC (OpenID Connect)", value: "OIDC" },
      { label: "SAML 2.0", value: "SAML" },
    ],
  },
  { name: "issuer", label: "Issuer URL", type: "text", required: true, placeholder: "https://idp.example.com" },
  { name: "clientId", label: "Client ID", type: "text", placeholder: "OAuth Client ID" },
  { name: "clientSecret", label: "Client Secret", type: "text", placeholder: "OAuth Client Secret" },
  { name: "callbackUrl", label: "回调 URL", type: "text", placeholder: "https://your-app.com/callback" },
  { name: "enabled", label: "立即启用", type: "checkbox", defaultValue: false },
];

/* ═══════════════════════════════════════
   Page
   ═══════════════════════════════════════ */

export default function SSOPage() {
  const [providers, setProviders] = React.useState<SSOProviderRow[]>(MOCK_PROVIDERS);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
  const [formErrors, setFormErrors] = React.useState<Record<string, string>>({});

  const openCreate = () => {
    const defaults: Record<string, unknown> = {};
    ssoFormFields.forEach((f) => {
      if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
    });
    setFormValues(defaults);
    setFormErrors({});
    setCreateOpen(true);
  };

  const handleCreate = React.useCallback(() => {
    const errs: Record<string, string> = {};
    ssoFormFields.forEach((f) => {
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

    /* Add locally (mock) */
    const newProvider: SSOProviderRow = {
      id: crypto.randomUUID(),
      name: String(formValues.name ?? ""),
      protocol: String(formValues.protocol ?? ""),
      issuer: String(formValues.issuer ?? ""),
      status: formValues.enabled ? "active" : "inactive",
    };
    setProviders((prev) => [...prev, newProvider]);
    setCreateOpen(false);
  }, [formValues]);

  const handleDelete = React.useCallback((row: SSOProviderRow) => {
    setProviders((prev) => prev.filter((p) => p.id !== row.id));
  }, []);

  /* Columns with actions */
  const columns = React.useMemo(() => {
    const actionCol: ColumnDef<SSOProviderRow> = {
      key: "__actions" as keyof SSOProviderRow & string,
      label: "操作",
      width: "80px",
      render: (_v: unknown, row: SSOProviderRow) => (
        <div onClick={(e) => e.stopPropagation()}>
          <Button variant="danger" size="sm" onClick={() => handleDelete(row)}>
            <Trash2 className="h-3.5 w-3.5" />
            删除
          </Button>
        </div>
      ),
    };
    return [...providerColumns, actionCol];
  }, [handleDelete]);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-[var(--color-text-secondary)]" />
          <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
            SSO 单点登录配置
          </h1>
        </div>
        <Button onClick={openCreate} size="sm">
          <Plus className="h-4 w-4" />
          添加提供者
        </Button>
      </div>

      <DataTable<SSOProviderRow>
        columns={columns}
        data={providers}
        loading={false}
        emptyMessage="暂无 SSO 提供者配置"
      />

      <Sheet open={createOpen} onOpenChange={setCreateOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>添加 SSO 提供者</SheetTitle>
            <SheetDescription className="sr-only">SSO 配置表单</SheetDescription>
          </SheetHeader>
          <div className="flex-1 py-4">
            <FormBuilder
              fields={ssoFormFields}
              values={formValues}
              onChange={(name, value) => setFormValues((prev) => ({ ...prev, [name]: value }))}
              onSubmit={handleCreate}
              submitLabel="添加"
              errors={formErrors}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
