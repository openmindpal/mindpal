"use client";

export const dynamic = 'force-dynamic';

import * as React from "react";
import { Database } from "lucide-react";
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

interface BackupRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  size: string;
  createdAt: string;
}

/* ═══════════════════════════════════════
   Static data (mock — no backup API yet)
   ═══════════════════════════════════════ */

const MOCK_BACKUPS: BackupRow[] = [
  { id: "1", name: "daily-20260512-0200", status: "succeeded", size: "1.2 GB", createdAt: "2026-05-12T02:00:00Z" },
  { id: "2", name: "daily-20260511-0200", status: "succeeded", size: "1.1 GB", createdAt: "2026-05-11T02:00:00Z" },
  { id: "3", name: "daily-20260510-0200", status: "failed", size: "—", createdAt: "2026-05-10T02:00:00Z" },
];

/* ═══════════════════════════════════════
   Columns
   ═══════════════════════════════════════ */

const backupColumns: ColumnDef<BackupRow>[] = [
  { key: "name", label: "备份名称", sortable: true },
  {
    key: "status",
    label: "状态",
    width: "100px",
    render: (v) => <StatusBadge status={String(v)} />,
  },
  { key: "size", label: "大小", width: "100px" },
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
   Policy form fields
   ═══════════════════════════════════════ */

const policyFields: FormFieldDef[] = [
  {
    name: "frequency",
    label: "备份频率",
    type: "select",
    required: true,
    options: [
      { label: "每天", value: "daily" },
      { label: "每周", value: "weekly" },
      { label: "每月", value: "monthly" },
    ],
    defaultValue: "daily",
  },
  {
    name: "retentionDays",
    label: "保留天数",
    type: "number",
    required: true,
    placeholder: "输入保留天数",
    defaultValue: 30,
  },
  {
    name: "enabled",
    label: "启用自动备份",
    type: "checkbox",
    defaultValue: true,
  },
];

/* ═══════════════════════════════════════
   Page
   ═══════════════════════════════════════ */

export default function BackupsPage() {
  const [policyValues, setPolicyValues] = React.useState<Record<string, unknown>>(() => {
    const defaults: Record<string, unknown> = {};
    policyFields.forEach((f) => {
      if (f.defaultValue !== undefined) defaults[f.name] = f.defaultValue;
    });
    return defaults;
  });
  const [saved, setSaved] = React.useState(false);

  const handleSavePolicy = React.useCallback(() => {
    // TODO: POST /backups/policy
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <h1 className="text-[var(--text-xl)] font-semibold text-[var(--color-text)]">
        备份管理
      </h1>

      {/* ── Policy config ── */}
      <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-6">
        <div className="mb-4 flex items-center gap-2">
          <Database className="h-5 w-5 text-[var(--color-text-secondary)]" />
          <h2 className="text-[var(--text-base)] font-medium text-[var(--color-text)]">
            备份策略
          </h2>
          {saved && (
            <span className="ml-auto text-[var(--text-sm)] text-[var(--color-success)]">
              已保存
            </span>
          )}
        </div>
        <FormBuilder
          fields={policyFields}
          values={policyValues}
          onChange={(name, value) => setPolicyValues((prev) => ({ ...prev, [name]: value }))}
          onSubmit={handleSavePolicy}
          submitLabel="保存策略"
          className="max-w-md"
        />
      </section>

      {/* ── Recent backups ── */}
      <section>
        <h2 className="mb-3 text-[var(--text-base)] font-medium text-[var(--color-text)]">
          最近备份
        </h2>
        <DataTable<BackupRow>
          columns={backupColumns}
          data={MOCK_BACKUPS}
          loading={false}
          emptyMessage="暂无备份记录"
        />
      </section>
    </div>
  );
}
