'use client';

import * as React from 'react';
import { GovResourcePage, StatusBadge, FormBuilder, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig, FormFieldDef } from '@/features/governance';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/shared/components/primitives/Sheet';
import { Button } from '@/shared/components/primitives/Button';
import { Input } from '@/shared/components/primitives/Input';

/* ─── Row Type ─── */
interface SecretItem {
  id: string;
  name?: string;
  description?: string;
  tags?: string;
  connectorInstanceId: string;
  scopeType: string;
  scopeId: string;
  status: string;
  credentialVersion: number;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Edit Form Fields ─── */
const editFields: FormFieldDef[] = [
  { name: 'name', label: '名称', type: 'text', placeholder: '凭证名称' },
  { name: 'description', label: '描述', type: 'textarea', placeholder: '凭证描述' },
  { name: 'tags', label: '标签', type: 'text', placeholder: '多个标签用逗号分隔' },
];

/* ─── Page Component ─── */
export default function SecretsPage() {
  const mutations = useResourceMutation({
    endpoint: '/secrets',
    listQueryKey: ['/secrets'],
  });

  /* ── Edit state ── */
  const [editOpen, setEditOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<SecretItem | null>(null);
  const [editValues, setEditValues] = React.useState<Record<string, unknown>>({});
  const [editErrors, setEditErrors] = React.useState<Record<string, string>>({});

  /* ── Rotate state ── */
  const [rotateOpen, setRotateOpen] = React.useState(false);
  const [rotateRow, setRotateRow] = React.useState<SecretItem | null>(null);
  const [gracePeriodMs, setGracePeriodMs] = React.useState<string>('');

  /* ── Open edit sheet ── */
  const openEdit = React.useCallback((row: SecretItem) => {
    setEditRow(row);
    setEditValues({
      name: row.name ?? '',
      description: row.description ?? '',
      tags: row.tags ?? '',
    });
    setEditErrors({});
    setEditOpen(true);
  }, []);

  /* ── Submit edit ── */
  const handleEditSubmit = React.useCallback(async () => {
    if (!editRow) return;
    setEditErrors({});
    await mutations.update(editRow.id, editValues);
    setEditOpen(false);
  }, [editRow, editValues, mutations]);

  /* ── Open rotate sheet ── */
  const openRotate = React.useCallback((row: SecretItem) => {
    setRotateRow(row);
    setGracePeriodMs('');
    setRotateOpen(true);
  }, []);

  /* ── Submit rotate ── */
  const handleRotateSubmit = React.useCallback(async () => {
    if (!rotateRow) return;
    const data: Record<string, unknown> = {};
    if (gracePeriodMs !== '') {
      data.gracePeriodMs = Number(gracePeriodMs);
    }
    await mutations.customAction(rotateRow.id, 'rotate', data);
    setRotateOpen(false);
  }, [rotateRow, gracePeriodMs, mutations]);

  const config: ResourcePageConfig<SecretItem> = {
    title: '凭证管理',
    apiEndpoint: '/secrets',
    responseKey: 'secrets',
    searchable: true,
    searchPlaceholder: '搜索凭证…',
    selectable: true,
    columns: [
      { key: 'id', label: 'ID', sortable: true, width: '220px' },
      { key: 'connectorInstanceId', label: '关联连接器', sortable: true },
      { key: 'scopeType', label: '作用域', width: '100px' },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => (
          <StatusBadge
            status={value as string}
            colorMap={{ active: 'success', retired: 'warning', revoked: 'danger' }}
          />
        ),
      },
      { key: 'credentialVersion', label: '版本', width: '80px' },
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
          { label: '活跃', value: 'active' },
          { label: '已停用', value: 'retired' },
          { label: '已吊销', value: 'revoked' },
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
        label: '轮换',
        variant: 'default',
        onClick: (row) => openRotate(row),
        visible: (row) => row.status === 'active',
      },
      {
        label: '吊销',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'revoke'),
        visible: (row) => row.status === 'active',
      },
    ],
    createForm: {
      title: '创建凭证',
      fields: [
        { name: 'connectorInstanceId', label: '连接器实例 ID', type: 'text', required: true, placeholder: '关联的 ConnectorInstance ID' },
        { name: 'payload', label: '密钥内容', type: 'json', required: true, placeholder: '{"key": "value"}' },
      ],
    },
  };

  return (
    <>
      <GovResourcePage config={config} />

      {/* ── Edit Sheet ── */}
      <Sheet open={editOpen} onOpenChange={setEditOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>编辑凭证</SheetTitle>
            <SheetDescription className="sr-only">编辑凭证信息</SheetDescription>
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

      {/* ── Rotate Sheet ── */}
      <Sheet open={rotateOpen} onOpenChange={setRotateOpen}>
        <SheetContent side="right" className="flex w-full max-w-lg flex-col overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>轮换凭证</SheetTitle>
            <SheetDescription className="sr-only">轮换凭证密钥</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-4 py-4">
            <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">
              确认轮换凭证 <span className="font-medium text-[var(--color-text)]">{rotateRow?.id}</span> 的密钥？轮换后旧密钥将在优雅期结束后失效。
            </p>
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="gracePeriodMs"
                className="text-[var(--text-sm)] font-medium text-[var(--color-text)]"
              >
                优雅期（毫秒，可选）
              </label>
              <Input
                id="gracePeriodMs"
                type="number"
                value={gracePeriodMs}
                placeholder="例如 3600000（1小时）"
                onChange={(e) => setGracePeriodMs(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="secondary"
                onClick={() => setRotateOpen(false)}
              >
                取消
              </Button>
              <Button
                onClick={handleRotateSubmit}
                loading={mutations.isLoading}
              >
                确认轮换
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
