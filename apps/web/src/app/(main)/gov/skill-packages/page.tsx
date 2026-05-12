'use client';

import { GovResourcePage, StatusBadge } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type (matches GET /skill-lifecycle/summary response) ─── */
interface SkillPackageItem {
  skillName: string;
  latestStatus: string;
  scopeType: string;
  scopeId: string;
  updatedAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function SkillPackagesPage() {
  const config: ResourcePageConfig<SkillPackageItem> = {
    title: 'Skill 包管理',
    apiEndpoint: '/skill-lifecycle/summary',
    responseKey: 'summary',
    searchable: true,
    searchPlaceholder: '搜索 Skill 包…',
    columns: [
      { key: 'skillName', label: 'Skill 名称', sortable: true },
      {
        key: 'latestStatus',
        label: '状态',
        width: '120px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      { key: 'scopeType', label: '作用域', sortable: true },
      {
        key: 'updatedAt',
        label: '更新时间',
        sortable: true,
        render: (value) => new Date(value as string).toLocaleDateString(),
      },
    ],
    filters: [
      {
        key: 'latestStatus',
        label: '状态',
        type: 'select',
        options: [
          { label: '草稿', value: 'draft' },
          { label: '用户级启用', value: 'enabled_user_scope' },
          { label: '空间级启用', value: 'enabled_space' },
          { label: '租户级启用', value: 'enabled_tenant' },
          { label: '已禁用', value: 'disabled' },
          { label: '已撤回', value: 'revoked' },
        ],
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
