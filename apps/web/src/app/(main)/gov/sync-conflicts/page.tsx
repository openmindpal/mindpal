'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface SyncConflictItem {
  ticketId: string;
  entityType: string;
  conflictClass: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function SyncConflictsPage() {
  const mutations = useResourceMutation({
    endpoint: '/sync/conflict-tickets',
    listQueryKey: ['/sync/conflict-tickets'],
  });

  const config: ResourcePageConfig<SyncConflictItem> = {
    title: '同步冲突',
    apiEndpoint: '/sync/conflict-tickets',
    searchable: true,
    searchPlaceholder: '搜索冲突…',
    columns: [
      { key: 'ticketId', label: 'Ticket ID', sortable: true },
      { key: 'entityType', label: '实体类型', sortable: true },
      { key: 'conflictClass', label: '冲突类型', sortable: true },
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
        key: 'conflictClass',
        label: '冲突类型',
        type: 'select',
        options: [
          { label: 'Diverged', value: 'diverged' },
          { label: 'Deleted-Modified', value: 'deleted-modified' },
          { label: 'Schema Mismatch', value: 'schema-mismatch' },
        ],
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '待处理', value: 'open' },
          { label: '已解决', value: 'resolved' },
          { label: '已放弃', value: 'abandoned' },
        ],
      },
    ],
    actions: [
      {
        label: '解决',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.ticketId, 'resolve'),
        visible: (row) => row.status === 'open',
      },
      {
        label: '放弃',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.ticketId, 'abandon'),
        visible: (row) => row.status === 'open',
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
