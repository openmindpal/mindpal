'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface DeadLetterItem {
  id: string;
  stepId: string;
  workflowRef: string;
  error: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function DeadLettersPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/workflow/deadletters',
    listQueryKey: ['/governance/workflow/deadletters'],
  });

  const config: ResourcePageConfig<DeadLetterItem> = {
    title: '死信队列',
    apiEndpoint: '/governance/workflow/deadletters',
    searchable: true,
    searchPlaceholder: '搜索死信…',
    columns: [
      { key: 'stepId', label: '步骤ID', sortable: true },
      { key: 'workflowRef', label: '工作流引用', sortable: true },
      {
        key: 'error',
        label: '错误信息',
        render: (value) => {
          const str = value as string;
          return str && str.length > 50 ? `${str.slice(0, 50)}…` : str;
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
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '待处理', value: 'pending' },
          { label: '已重试', value: 'retried' },
          { label: '已取消', value: 'cancelled' },
        ],
      },
    ],
    actions: [
      {
        label: '重试',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'retry'),
      },
      {
        label: '取消',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'cancel'),
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
