'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface WorkbenchItem {
  id: string;
  key: string;
  displayName: string;
  version: string;
  status: string;
  updatedAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function WorkbenchesPage() {
  const mutations = useResourceMutation({
    endpoint: '/workbenches',
    listQueryKey: ['/workbenches'],
  });

  const config: ResourcePageConfig<WorkbenchItem> = {
    title: '工作台管理',
    apiEndpoint: '/workbenches',
    searchable: true,
    searchPlaceholder: '搜索工作台…',
    columns: [
      { key: 'key', label: 'Key', sortable: true },
      { key: 'displayName', label: '显示名称', sortable: true },
      { key: 'version', label: '版本', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'updatedAt',
        label: '更新时间',
        hiddenOnMobile: true,
        render: (value) => (value ? new Date(value as string).toLocaleString() : '-'),
      },
    ],
    actions: [
      {
        label: '编辑',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'edit'),
      },
      {
        label: '发布',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'publish'),
      },
    ],
    createForm: {
      title: '添加工作台',
      fields: [
        { name: 'key', label: 'Key', type: 'text', required: true },
        { name: 'displayName', label: '显示名称', type: 'text', required: true },
        { name: 'description', label: '描述', type: 'textarea' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
