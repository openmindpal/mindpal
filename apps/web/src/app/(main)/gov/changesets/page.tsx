'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface ChangesetItem {
  id: string;
  title: string;
  status: string;
  riskLevel: string;
  items: unknown[];
  createdBy: string;
  createdAt: string;
  scopeType: string;
  [key: string]: unknown;
}

/* ─── Risk level color map ─── */
const riskColorMap: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

/* ─── Page Component ─── */
export default function ChangesetsPage() {
  const mutations = useResourceMutation({
    endpoint: '/governance/changesets',
    listQueryKey: ['/governance/changesets'],
  });

  const config: ResourcePageConfig<ChangesetItem> = {
    title: '变更集管理',
    apiEndpoint: '/governance/changesets',
    responseKey: 'changesets',
    searchable: true,
    searchPlaceholder: '搜索变更集…',
    columns: [
      { key: 'title', label: '标题', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '130px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'riskLevel',
        label: '风险等级',
        width: '100px',
        render: (value) => (
          <StatusBadge status={value as string} colorMap={riskColorMap} />
        ),
      },
      {
        key: 'items',
        label: '变更项数',
        width: '90px',
        render: (value) => (Array.isArray(value) ? value.length : 0),
      },
      { key: 'createdBy', label: '创建人', hiddenOnMobile: true },
      {
        key: 'createdAt',
        label: '创建时间',
        sortable: true,
        hiddenOnMobile: true,
        render: (value) => (value ? new Date(value as string).toLocaleString('zh-CN') : '-'),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '草稿', value: 'draft' },
          { label: '已提交', value: 'submitted' },
          { label: '已批准', value: 'approved' },
          { label: '灰度发布', value: 'canary_released' },
          { label: '已发布', value: 'released' },
          { label: '已回滚', value: 'rolled_back' },
        ],
      },
      {
        key: 'scopeType',
        label: '范围',
        type: 'select',
        options: [
          { label: '租户', value: 'tenant' },
          { label: '空间', value: 'space' },
        ],
      },
    ],
    actions: [
      {
        label: '提交审批',
        variant: 'outline',
        onClick: (row) => mutations.customAction(row.id, 'submit'),
        visible: (row) => row.status === 'draft',
      },
      {
        label: '批准',
        onClick: (row) => mutations.customAction(row.id, 'approve'),
        visible: (row) => row.status === 'submitted',
      },
      {
        label: '全量发布',
        onClick: (row) => mutations.customAction(row.id, 'promote'),
        visible: (row) => row.status === 'approved' || row.status === 'canary_released',
      },
      {
        label: '回滚',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'rollback'),
        visible: (row) => row.status === 'released' || row.status === 'canary_released',
      },
    ],
    createForm: {
      title: '新建变更集',
      fields: [
        { name: 'title', label: '标题', type: 'text', required: true, placeholder: '变更集标题' },
        {
          name: 'scopeType',
          label: '范围类型',
          type: 'select',
          required: true,
          options: [
            { label: '租户', value: 'tenant' },
            { label: '空间', value: 'space' },
          ],
          defaultValue: 'tenant',
        },
        {
          name: 'riskLevel',
          label: '风险等级',
          type: 'select',
          required: true,
          options: [
            { label: '低', value: 'low' },
            { label: '中', value: 'medium' },
            { label: '高', value: 'high' },
          ],
          defaultValue: 'low',
        },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
