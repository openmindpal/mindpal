'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface ToolItem {
  id: string;
  toolRef: string;
  displayName: string;
  status: string;
  networkPolicy: Record<string, unknown> | null;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function ToolsPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/tools',
    listQueryKey: ['/governance/tools'],
  });

  const config: ResourcePageConfig<ToolItem> = {
    title: '工具治理',
    apiEndpoint: '/governance/tools',
    searchable: true,
    searchPlaceholder: '搜索工具…',
    selectable: true,
    columns: [
      { key: 'toolRef', label: '工具引用', sortable: true },
      { key: 'displayName', label: '显示名称', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'networkPolicy',
        label: '网络策略',
        width: '100px',
        render: (value) => (value ? '已配置' : '无'),
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
    ],
    actions: [
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
        label: '激活版本',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'activate'),
      },
      {
        label: '回滚',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'rollback'),
      },
    ],
    createForm: {
      title: '注册工具',
      fields: [
        { name: 'toolRef', label: '工具引用', type: 'text', required: true, placeholder: '如 builtin://calculator' },
        { name: 'displayName', label: '显示名称', type: 'text', required: true, placeholder: '工具名称' },
        { name: 'description', label: '描述', type: 'textarea', placeholder: '工具描述' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
