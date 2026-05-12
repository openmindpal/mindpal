'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface IngestJobItem {
  id: string;
  jobId: string;
  type: string;
  status: string;
  progress: number;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function IngestJobsPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/knowledge/ingest-jobs',
    listQueryKey: ['/governance/knowledge/ingest-jobs'],
  });

  const config: ResourcePageConfig<IngestJobItem> = {
    title: '摄入任务',
    apiEndpoint: '/governance/knowledge/ingest-jobs',
    searchable: true,
    searchPlaceholder: '搜索任务…',
    columns: [
      { key: 'jobId', label: '任务ID', sortable: true },
      { key: 'type', label: '任务类型', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'progress',
        label: '进度',
        width: '80px',
        render: (value) => `${value}%`,
      },
      {
        key: 'createdAt',
        label: '创建时间',
        render: (value) => new Date(value as string).toLocaleString(),
      },
    ],
    filters: [
      {
        key: 'type',
        label: '任务类型',
        type: 'select',
        options: [
          { label: '摄入', value: 'ingest' },
          { label: '嵌入', value: 'embedding' },
          { label: '索引', value: 'index' },
        ],
      },
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '运行中', value: 'running' },
          { label: '已完成', value: 'completed' },
          { label: '失败', value: 'failed' },
          { label: '排队中', value: 'queued' },
        ],
      },
    ],
    actions: [
      {
        label: '取消',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.jobId, 'cancel'),
        visible: (row) => row.status === 'running' || row.status === 'queued',
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
