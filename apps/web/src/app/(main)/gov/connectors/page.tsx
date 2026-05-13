'use client';

import * as React from 'react';
import { GovResourcePage, StatusBadge, FormBuilder, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/shared/components/primitives/Sheet';
import { cn } from '@/shared/lib/cn';

/* ─── Row Type ─── */
interface ConnectorInstance {
  id: string;
  name: string;
  typeName: string;
  scopeType: string;
  scopeId: string;
  status: string;
  description?: string;
  egressPolicy: Record<string, unknown> | null;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Edit Form Fields ─── */
const EDIT_FIELDS = [
  { name: 'name', label: '名称', type: 'text' as const, required: true, placeholder: '连接器名称' },
  { name: 'description', label: '描述', type: 'textarea' as const, placeholder: '连接器描述（可选）' },
  { name: 'egressPolicy', label: '出站策略 (JSON)', type: 'json' as const, placeholder: '{"allowedDomains": ["example.com"]}' },
];

/* ─── Page Component ─── */
export default function ConnectorsPage() {
  const mutations = useResourceMutation({
    endpoint: '/connectors/instances',
    listQueryKey: ['/connectors/instances'],
  });

  /* ── Edit state ── */
  const [editOpen, setEditOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<ConnectorInstance | null>(null);
  const [editValues, setEditValues] = React.useState<Record<string, unknown>>({});
  const [editErrors, setEditErrors] = React.useState<Record<string, string>>({});

  const openEdit = React.useCallback((row: ConnectorInstance) => {
    setEditRow(row);
    setEditValues({
      name: row.name ?? '',
      description: (row.description as string) ?? '',
      egressPolicy: row.egressPolicy ?? '',
    });
    setEditErrors({});
    setEditOpen(true);
  }, []);

  const handleEditSubmit = React.useCallback(async () => {
    if (!editRow) return;
    const errs: Record<string, string> = {};
    EDIT_FIELDS.forEach((f) => {
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
    await mutations.update(editRow.id, editValues);
    setEditOpen(false);
  }, [editRow, editValues, mutations]);

  /* ── Delete handler ── */
  const handleDelete = React.useCallback(
    async (row: ConnectorInstance) => {
      const confirmed = window.confirm(`确定删除连接器「${row.name}」？此操作不可撤销。`);
      if (!confirmed) return;
      await mutations.remove(row.id);
    },
    [mutations],
  );

  const config: ResourcePageConfig<ConnectorInstance> = {
    title: '连接器管理',
    apiEndpoint: '/connectors/instances',
    responseKey: 'instances',
    searchable: true,
    searchPlaceholder: '搜索连接器…',
    selectable: true,
    columns: [
      { key: 'name', label: '名称', sortable: true },
      { key: 'typeName', label: '类型', sortable: true, width: '140px' },
      { key: 'scopeType', label: '作用域', width: '100px' },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'egressPolicy',
        label: '出站策略',
        width: '120px',
        render: (value) => (value ? '已配置' : '无'),
      },
      {
        key: 'createdAt',
        label: '创建时间',
        sortable: true,
        width: '180px',
        render: (value) => (value ? new Date(value as string).toLocaleString('zh-CN') : '-'),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '已启用', value: 'enabled' },
          { label: '已禁用', value: 'disabled' },
        ],
      },
      {
        key: 'typeName',
        label: '类型',
        type: 'select',
        options: [
          { label: 'IMAP', value: 'mail.imap' },
          { label: 'SMTP', value: 'mail.smtp' },
          { label: 'Exchange', value: 'mail.exchange' },
          { label: 'OAuth', value: 'oauth' },
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
        label: '启用',
        onClick: (row) => mutations.customAction(row.id, 'enable'),
        visible: (row) => row.status === 'disabled',
      },
      {
        label: '禁用',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'disable'),
        visible: (row) => row.status === 'enabled',
      },
      {
        label: '删除',
        variant: 'destructive',
        onClick: (row) => handleDelete(row),
      },
    ],
    createForm: {
      title: '创建连接器实例',
      fields: [
        { name: 'name', label: '名称', type: 'text', required: true, placeholder: '连接器名称' },
        {
          name: 'typeName',
          label: '类型',
          type: 'select',
          required: true,
          options: [
            { label: 'IMAP 邮件收取', value: 'mail.imap' },
            { label: 'SMTP 邮件发送', value: 'mail.smtp' },
            { label: 'Exchange 邮件', value: 'mail.exchange' },
            { label: 'OAuth 授权', value: 'oauth' },
          ],
        },
        { name: 'egressPolicy', label: '出站策略 (JSON)', type: 'json', placeholder: '{"allowedDomains": ["example.com"]}' },
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
            <SheetTitle>编辑连接器</SheetTitle>
            <SheetDescription className="sr-only">
              编辑连接器实例表单
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 py-4">
            <FormBuilder
              fields={EDIT_FIELDS}
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
