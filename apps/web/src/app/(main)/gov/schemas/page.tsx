'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface SchemaItem {
  id: string;
  name: string;
  version: number;
  status: string;
  fields: Record<string, unknown>;
  updatedAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function SchemasPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/schemas',
    listQueryKey: ['/governance/schemas'],
  });

  const config: ResourcePageConfig<SchemaItem> = {
    title: '数据模型管理',
    apiEndpoint: '/governance/schemas',
    searchable: true,
    searchPlaceholder: '搜索 Schema…',
    columns: [
      { key: 'name', label: '名称', sortable: true },
      { key: 'version', label: '版本', sortable: true, width: '80px' },
      {
        key: 'status',
        label: '状态',
        width: '120px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'fields',
        label: '字段数',
        width: '80px',
        render: (value) => {
          const obj = value as Record<string, unknown> | null;
          return obj ? Object.keys(obj).length : 0;
        },
      },
      {
        key: 'updatedAt',
        label: '更新时间',
        sortable: true,
        hiddenOnMobile: true,
        render: (value) => (value ? new Date(value as string).toLocaleString('zh-CN') : '-'),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '草稿', value: 'draft' },
          { label: '已发布', value: 'published' },
          { label: '已激活', value: 'active' },
        ],
      },
    ],
    actions: [
      {
        label: '发布',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'publish'),
        visible: (row) => row.status === 'draft',
      },
      {
        label: '激活',
        onClick: (row) => mutations.customAction(row.id, 'set-active'),
        visible: (row) => row.status === 'published',
      },
      {
        label: '回滚',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'rollback'),
        visible: (row) => row.status === 'active' || row.status === 'published',
      },
    ],
    createForm: {
      title: '新建 Schema',
      fields: [
        { name: 'name', label: '名称', type: 'text', required: true, placeholder: '如 user_profile' },
        { name: 'displayName', label: '显示名称', type: 'text', placeholder: '如 用户档案' },
        { name: 'description', label: '描述', type: 'textarea', placeholder: '简要描述该 Schema 的用途' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
