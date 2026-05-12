'use client';

import { GovResourcePage, StatusBadge } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface RetrievalLogItem {
  id: string;
  query: string;
  status: string;
  latency: number;
  resultCount: number;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function RetrievalLogsPage() {
  const config: ResourcePageConfig<RetrievalLogItem> = {
    title: '检索日志',
    apiEndpoint: '/governance/knowledge/retrieval-logs',
    searchable: true,
    searchPlaceholder: '搜索检索日志…',
    columns: [
      { key: 'id', label: 'ID', sortable: true },
      {
        key: 'query',
        label: '查询内容',
        sortable: true,
        render: (value) => {
          const str = String(value ?? '');
          return str.length > 40 ? `${str.slice(0, 40)}…` : str;
        },
      },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'latency',
        label: '延迟',
        width: '100px',
        render: (value) => `${value}ms`,
      },
      { key: 'resultCount', label: '结果数', sortable: true },
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
          { label: '成功', value: 'success' },
          { label: '失败', value: 'failed' },
          { label: '超时', value: 'timeout' },
        ],
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
