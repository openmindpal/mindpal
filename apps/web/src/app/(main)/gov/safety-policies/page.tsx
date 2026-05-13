'use client';

import * as React from 'react';
import { GovResourcePage, StatusBadge, useResourceMutation, FormBuilder } from '@/features/governance';
import type { ResourcePageConfig, FormFieldDef } from '@/features/governance';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/shared/components/primitives/Sheet';
import { cn } from '@/shared/lib/cn';

/* ─── Row Type ─── */
interface SafetyPolicyItem {
  id: string;
  name: string;
  policyType: string;
  version: number;
  status: string;
  description: string;
  [key: string]: unknown;
}

/* ─── Policy type labels ─── */
const policyTypeLabels: Record<string, string> = {
  content: '内容审核',
  injection: '注入防护',
  risk: '风险控制',
};

/* ─── Edit form fields ─── */
const editFields: FormFieldDef[] = [
  { name: 'name', label: '策略名', type: 'text', required: true, placeholder: '如 content-filter-v1' },
  {
    name: 'policyType',
    label: '策略类型',
    type: 'select',
    required: true,
    options: [
      { label: '内容审核', value: 'content' },
      { label: '注入防护', value: 'injection' },
      { label: '风险控制', value: 'risk' },
    ],
  },
];

/* ─── Page Component ─── */
export default function SafetyPoliciesPage() {
  /* ── Edit sheet state ── */
  const [editOpen, setEditOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<SafetyPolicyItem | null>(null);
  const [editValues, setEditValues] = React.useState<Record<string, unknown>>({});
  const [editErrors, setEditErrors] = React.useState<Record<string, string>>({});

  const mutations = useResourceMutation({
    endpoint: '/governance/safety-policies',
    listQueryKey: ['/governance/safety-policies'],
    onSuccess: () => setEditOpen(false),
  });

  /* ── Open edit sheet ── */
  const openEdit = React.useCallback((row: SafetyPolicyItem) => {
    setEditRow(row);
    setEditValues({ name: row.name, policyType: row.policyType });
    setEditErrors({});
    setEditOpen(true);
  }, []);

  /* ── Submit edit ── */
  const handleEditSubmit = React.useCallback(async () => {
    const errs: Record<string, string> = {};
    editFields.forEach((f) => {
      if (f.required) {
        const v = editValues[f.name];
        if (v == null || v === '') errs[f.name] = `${f.label}不能为空`;
      }
    });
    if (Object.keys(errs).length) {
      setEditErrors(errs);
      return;
    }
    setEditErrors({});
    if (editRow) {
      await mutations.update(editRow.id, editValues);
    }
  }, [editRow, editValues, mutations]);

  /* ── Delete handler ── */
  const handleDelete = React.useCallback(
    (row: SafetyPolicyItem) => {
      if (confirm(`确认删除安全策略「${row.name}」？此操作不可撤销。`)) {
        mutations.remove(row.id);
      }
    },
    [mutations],
  );

  const config: ResourcePageConfig<SafetyPolicyItem> = {
    title: '安全策略管理',
    apiEndpoint: '/governance/safety-policies',
    searchable: true,
    searchPlaceholder: '搜索安全策略…',
    columns: [
      { key: 'name', label: '策略名', sortable: true },
      {
        key: 'policyType',
        label: '类型',
        width: '120px',
        render: (value) => policyTypeLabels[value as string] ?? (value as string),
      },
      { key: 'version', label: '版本', sortable: true, width: '80px' },
      {
        key: 'status',
        label: '状态',
        width: '120px',
        render: (value) => <StatusBadge status={value as string} />,
      },
    ],
    filters: [
      {
        key: 'policyType',
        label: '策略类型',
        type: 'select',
        options: [
          { label: '内容审核', value: 'content' },
          { label: '注入防护', value: 'injection' },
          { label: '风险控制', value: 'risk' },
        ],
      },
    ],
    actions: [
      {
        label: '编辑',
        variant: 'outline',
        onClick: (row) => openEdit(row),
      },
      {
        label: '查看版本',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'versions'),
      },
      {
        label: '编辑草稿',
        onClick: (row) => mutations.customAction(row.id, 'edit-draft'),
        visible: (row) => row.status === 'draft',
      },
      {
        label: '删除',
        variant: 'destructive',
        onClick: (row) => handleDelete(row),
      },
    ],
    createForm: {
      title: '新建安全策略',
      fields: [
        { name: 'name', label: '策略名', type: 'text', required: true, placeholder: '如 content-filter-v1' },
        {
          name: 'policyType',
          label: '策略类型',
          type: 'select',
          required: true,
          options: [
            { label: '内容审核', value: 'content' },
            { label: '注入防护', value: 'injection' },
            { label: '风险控制', value: 'risk' },
          ],
        },
        { name: 'description', label: '描述', type: 'textarea', placeholder: '策略描述' },
      ],
    },
  };

  return (
    <>
      <GovResourcePage config={config} />

      {/* ── Edit Sheet ── */}
      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent
          side="right"
          className={cn('flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg')}
        >
          <SheetHeader>
            <SheetTitle>编辑安全策略</SheetTitle>
            <SheetDescription className="sr-only">
              编辑安全策略表单
            </SheetDescription>
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
