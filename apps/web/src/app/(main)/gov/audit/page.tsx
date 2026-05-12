'use client';

import { GovResourcePage } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface AuditLogItem {
  id: string;
  actor: string;
  action: string;
  resource: string;
  timestamp: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function AuditPage() {
  const config: ResourcePageConfig<AuditLogItem> = {
    title: '审计日志',
    apiEndpoint: '/governance/audit',
    searchable: true,
    searchPlaceholder: '搜索日志…',
    columns: [
      { key: 'id', label: 'ID', sortable: true },
      { key: 'actor', label: '操作者', sortable: true },
      { key: 'action', label: '操作', sortable: true },
      { key: 'resource', label: '资源', sortable: true },
      {
        key: 'timestamp',
        label: '时间',
        render: (value) => new Date(value as string).toLocaleString(),
      },
    ],
    filters: [
      {
        key: 'action',
        label: '操作',
        type: 'select',
        options: [
          { label: '创建', value: 'create' },
          { label: '更新', value: 'update' },
          { label: '删除', value: 'delete' },
          { label: '读取', value: 'read' },
          { label: '执行', value: 'execute' },
        ],
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
