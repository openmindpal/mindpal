'use client';

import { GovResourcePage, StatusBadge } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface SkillPackageItem {
  id: string;
  skillId: string;
  version: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function SkillPackagesPage() {
  const config: ResourcePageConfig<SkillPackageItem> = {
    title: 'Skill 包管理',
    apiEndpoint: '/skill-lifecycle/registry',
    searchable: true,
    searchPlaceholder: '搜索 Skill 包…',
    columns: [
      { key: 'skillId', label: 'Skill ID', sortable: true },
      { key: 'version', label: '版本', sortable: true },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'createdAt',
        label: '创建时间',
        sortable: true,
        render: (value) => new Date(value as string).toLocaleDateString(),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '已发布', value: 'published' },
          { label: '草稿', value: 'draft' },
          { label: '已废弃', value: 'deprecated' },
        ],
      },
    ],
  };

  return <GovResourcePage config={config} />;
}
