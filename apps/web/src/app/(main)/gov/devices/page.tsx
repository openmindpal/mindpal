'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface DeviceItem {
  id: string;
  deviceId: string;
  name: string;
  status: string;
  lastSeen: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function DevicesPage() {
  const mutations = useResourceMutation({
    endpoint: '/devices',
    listQueryKey: ['/devices'],
  });

  const config: ResourcePageConfig<DeviceItem> = {
    title: '设备管理',
    apiEndpoint: '/devices',
    searchable: true,
    searchPlaceholder: '搜索设备…',
    columns: [
      { key: 'deviceId', label: '设备ID', sortable: true },
      { key: 'name', label: '名称', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'lastSeen',
        label: '最后在线',
        render: (value) => (value ? new Date(value as string).toLocaleString() : '-'),
      },
      {
        key: 'createdAt',
        label: '创建时间',
        hiddenOnMobile: true,
        render: (value) => (value ? new Date(value as string).toLocaleString() : '-'),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '在线', value: 'online' },
          { label: '离线', value: 'offline' },
          { label: '已配对', value: 'paired' },
          { label: '未配对', value: 'unpaired' },
        ],
      },
    ],
    actions: [
      {
        label: '配对',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'pair'),
        visible: (row) => row.status !== 'paired',
      },
      {
        label: '撤销',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'revoke'),
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
