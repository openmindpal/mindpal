'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface RetrievalStrategyItem {
  id: string;
  strategyId: string;
  name: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function RetrievalEnginePage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/knowledge/retrieval-strategies',
    listQueryKey: ['/governance/knowledge/retrieval-strategies'],
  });

  const config: ResourcePageConfig<RetrievalStrategyItem> = {
    title: '检索引擎',
    apiEndpoint: '/governance/knowledge/retrieval-strategies',
    searchable: true,
    searchPlaceholder: '搜索策略…',
    columns: [
      { key: 'strategyId', label: '策略ID', sortable: true },
      { key: 'name', label: '策略名称', sortable: true },
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
    actions: [
      {
        label: '激活',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.strategyId, 'activate'),
        visible: (row) => row.status !== 'active',
      },
      {
        label: '评估',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.strategyId, 'evaluate'),
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
