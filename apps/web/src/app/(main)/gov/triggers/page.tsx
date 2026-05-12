'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface TriggerItem {
  id: string;
  type: string;
  target: string;
  status: string;
  nextFire: string;
  updatedAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function TriggersPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/triggers',
    listQueryKey: ['/governance/triggers'],
  });

  const config: ResourcePageConfig<TriggerItem> = {
    title: '触发器管理',
    apiEndpoint: '/governance/triggers',
    columns: [
      { key: 'id', label: 'ID', sortable: true },
      { key: 'type', label: '类型', sortable: true },
      { key: 'target', label: '目标', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'nextFire',
        label: '下次触发',
        render: (value) => (value ? new Date(value as string).toLocaleString() : '-'),
      },
      {
        key: 'updatedAt',
        label: '更新时间',
        hiddenOnMobile: true,
        render: (value) => (value ? new Date(value as string).toLocaleString() : '-'),
      },
    ],
    filters: [
      {
        key: 'type',
        label: '类型',
        type: 'select',
        options: [
          { label: 'Cron', value: 'cron' },
          { label: 'Event', value: 'event' },
          { label: 'Webhook', value: 'webhook' },
        ],
      },
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
        label: '删除',
        variant: 'destructive',
        onClick: (row) => mutations.remove(row.id),
      },
    ],
    createForm: {
      title: '添加触发器',
      fields: [
        { name: 'type', label: '类型', type: 'text', required: true },
        { name: 'target', label: '目标', type: 'text', required: true },
        { name: 'schedule', label: '调度', type: 'text', placeholder: 'cron表达式' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
