'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface SecretItem {
  id: string;
  connectorInstanceId: string;
  scopeType: string;
  scopeId: string;
  status: string;
  credentialVersion: number;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function SecretsPage() {
  const mutations = useResourceMutation({
    endpoint: '/secrets',
    listQueryKey: ['/secrets'],
  });

  const config: ResourcePageConfig<SecretItem> = {
    title: '凭证管理',
    apiEndpoint: '/secrets',
    responseKey: 'secrets',
    searchable: true,
    searchPlaceholder: '搜索凭证…',
    selectable: true,
    columns: [
      { key: 'id', label: 'ID', sortable: true, width: '220px' },
      { key: 'connectorInstanceId', label: '关联连接器', sortable: true },
      { key: 'scopeType', label: '作用域', width: '100px' },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => (
          <StatusBadge
            status={value as string}
            colorMap={{ active: 'success', retired: 'warning', revoked: 'danger' }}
          />
        ),
      },
      { key: 'credentialVersion', label: '版本', width: '80px' },
      {
        key: 'createdAt',
        label: '创建时间',
        sortable: true,
        width: '180px',
        render: (value) => (value ? new Date(value as string).toLocaleString('zh-CN') : '-'),
      },
    ],
    filters: [
      {
        key: 'status',
        label: '状态',
        type: 'select',
        options: [
          { label: '活跃', value: 'active' },
          { label: '已停用', value: 'retired' },
          { label: '已吊销', value: 'revoked' },
        ],
      },
    ],
    actions: [
      {
        label: '吊销',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'revoke'),
        visible: (row) => row.status === 'active',
      },
    ],
    createForm: {
      title: '创建凭证',
      fields: [
        { name: 'connectorInstanceId', label: '连接器实例 ID', type: 'text', required: true, placeholder: '关联的 ConnectorInstance ID' },
        { name: 'payload', label: '密钥内容', type: 'json', required: true, placeholder: '{"key": "value"}' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
