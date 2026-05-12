'use client';

import { GovResourcePage, StatusBadge } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface SyncRunItem {
  id: string;
  entityType: string;
  direction: string;
  status: string;
  watermark: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function SyncPage() {
  const config: ResourcePageConfig<SyncRunItem> = {
    title: '数据同步',
    apiEndpoint: '/sync/merge-runs',
    searchable: true,
    searchPlaceholder: '搜索同步记录…',
    columns: [
      { key: 'id', label: 'ID', sortable: true },
      { key: 'entityType', label: '实体类型', sortable: true },
      { key: 'direction', label: '方向', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      { key: 'watermark', label: '水位线' },
      {
        key: 'createdAt',
        label: '创建时间',
        render: (value) => new Date(value as string).toLocaleString(),
      },
    ],
    filters: [
      {
        key: 'entityType',
        label: '实体类型',
        type: 'select',
        options: [
          { label: 'Task', value: 'task' },
          { label: 'Entity', value: 'entity' },
          { label: 'Schema', value: 'schema' },
          { label: 'Config', value: 'config' },
        ],
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '已完成', value: 'completed' },
          { label: '失败', value: 'failed' },
          { label: '运行中', value: 'running' },
        ],
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
