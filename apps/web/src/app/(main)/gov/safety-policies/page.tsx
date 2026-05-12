'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface SafetyPolicyItem {
  id: string;
  name: string;
  policyType: string;
  version: number;
  status: string;
  description: string;
  [key: string]: unknown;
}

/* ─── Policy type labels ─── */
const policyTypeLabels: Record<string, string> = {
  content: '内容审核',
  injection: '注入防护',
  risk: '风险控制',
};

/* ─── Page Component ─── */
export default function SafetyPoliciesPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/safety-policies',
    listQueryKey: ['/governance/safety-policies'],
  });

  const config: ResourcePageConfig<SafetyPolicyItem> = {
    title: '安全策略管理',
    apiEndpoint: '/governance/safety-policies',
    searchable: true,
    searchPlaceholder: '搜索安全策略…',
    columns: [
      { key: 'name', label: '策略名', sortable: true },
      {
        key: 'policyType',
        label: '类型',
        width: '120px',
        render: (value) => policyTypeLabels[value as string] ?? (value as string),
      },
      { key: 'version', label: '版本', sortable: true, width: '80px' },
      {
        key: 'status',
        label: '状态',
        width: '120px',
        render: (value) => <StatusBadge status={value as string} />,
      },
    ],
    filters: [
      {
        key: 'policyType',
        label: '策略类型',
        type: 'select',
        options: [
          { label: '内容审核', value: 'content' },
          { label: '注入防护', value: 'injection' },
          { label: '风险控制', value: 'risk' },
        ],
      },
    ],
    actions: [
      {
        label: '查看版本',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'versions'),
      },
      {
        label: '编辑草稿',
        onClick: (row) => mutations.customAction(row.id, 'edit-draft'),
        visible: (row) => row.status === 'draft',
      },
    ],
    createForm: {
      title: '新建安全策略',
      fields: [
        { name: 'name', label: '策略名', type: 'text', required: true, placeholder: '如 content-filter-v1' },
        {
          name: 'policyType',
          label: '策略类型',
          type: 'select',
          required: true,
          options: [
            { label: '内容审核', value: 'content' },
            { label: '注入防护', value: 'injection' },
            { label: '风险控制', value: 'risk' },
          ],
        },
        { name: 'description', label: '描述', type: 'textarea', placeholder: '策略描述' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
