'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface NotificationItem {
  id: string;
  type: string;
  channel: string;
  message: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function NotificationsPage() {
  const mutations = useResourceMutation({
    endpoint: '/notifications/inbox',
    listQueryKey: ['/notifications/inbox'],
  });

  const config: ResourcePageConfig<NotificationItem> = {
    title: '通知管理',
    apiEndpoint: '/notifications/inbox',
    searchable: true,
    searchPlaceholder: '搜索通知…',
    columns: [
      { key: 'id', label: 'ID', sortable: true },
      { key: 'type', label: '类型', sortable: true },
      { key: 'channel', label: '渠道', sortable: true },
      {
        key: 'message',
        label: '消息',
        render: (value) => {
          const str = value as string;
          return str && str.length > 40 ? `${str.slice(0, 40)}…` : str;
        },
      },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'createdAt',
        label: '创建时间',
        render: (value) => new Date(value as string).toLocaleString(),
      },
    ],
    filters: [
      {
        key: 'channel',
        label: '渠道',
        type: 'select',
        options: [
          { label: 'Email', value: 'email' },
          { label: 'SMS', value: 'sms' },
          { label: 'Push', value: 'push' },
          { label: 'Webhook', value: 'webhook' },
        ],
      },
      {
        key: 'type',
        label: '类型',
        type: 'select',
        options: [
          { label: '告警', value: 'alert' },
          { label: '信息', value: 'info' },
          { label: '警告', value: 'warning' },
        ],
      },
    ],
    actions: [
      {
        label: '标为已读',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'mark-read'),
        visible: (row) => row.status !== 'read',
      },
      {
        label: '删除',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'delete'),
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
