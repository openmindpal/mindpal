'use client';
import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

interface RoutingItem {
  id: string;
  purpose: string;
  modelRef: string;
  status: string;
  updatedAt: string;
  [key: string]: unknown;
}

export default function RoutingPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/model-gateway/routing',
    listQueryKey: ['/governance/model-gateway/routing'],
  });

  const config: ResourcePageConfig<RoutingItem> = {
    title: '模型路由',
    apiEndpoint: '/governance/model-gateway/routing',
    searchable: true,
    searchPlaceholder: '搜索路由规则…',
    columns: [
      { key: 'purpose', label: '用途', sortable: true },
      { key: 'modelRef', label: '模型引用', sortable: true },
      { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={v as string} /> },
      { key: 'updatedAt', label: '更新时间', sortable: true, hiddenOnMobile: true, render: (v) => v ? new Date(v as string).toLocaleString('zh-CN') : '-' },
    ],
    filters: [
      { key: 'purpose', label: '用途', type: 'select', options: [
        { label: '对话', value: 'chat' },
        { label: '嵌入', value: 'embedding' },
        { label: '推理', value: 'reasoning' },
        { label: '工具调用', value: 'tool-call' },
      ]},
    ],
    actions: [
      { label: '编辑', variant: 'outline', onClick: (row) => mutations.customAction(row.id, 'edit') },
      { label: '删除', variant: 'destructive', onClick: (row) => mutations.remove(row.id) },
    ],
    createForm: {
      title: '添加路由规则',
      fields: [
        { name: 'purpose', label: '用途', type: 'text', required: true, placeholder: '如 chat' },
        { name: 'modelRef', label: '模型引用', type: 'text', required: true, placeholder: '如 gpt-4o' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
