'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface ApprovalItem {
  id: string;
  status: string;
  tool: string;
  requester: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function ApprovalsPage() {
  const mutations = useResourceMutation({
    endpoint: '/approvals',
    listQueryKey: ['/approvals'],
  });

  const config: ResourcePageConfig<ApprovalItem> = {
    title: '审批管理',
    apiEndpoint: '/approvals',
    searchable: true,
    searchPlaceholder: '搜索审批…',
    columns: [
      { key: 'id', label: 'ID', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      { key: 'tool', label: '工具名', sortable: true },
      { key: 'requester', label: '请求者', sortable: true },
      {
        key: 'createdAt',
        label: '创建时间',
        render: (value) => new Date(value as string).toLocaleString(),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '待审批', value: 'pending' },
          { label: '已批准', value: 'approved' },
          { label: '已拒绝', value: 'rejected' },
        ],
      },
    ],
    actions: [
      {
        label: '批准',
        onClick: (row) => mutations.customAction(row.id, 'approve'),
        visible: (row) => row.status === 'pending',
      },
      {
        label: '拒绝',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'reject'),
        visible: (row) => row.status === 'pending',
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
