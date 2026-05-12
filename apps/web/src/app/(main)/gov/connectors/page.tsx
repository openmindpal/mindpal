'use client';

import { GovResourcePage, StatusBadge, useResourceMutation } from '@/features/governance';
import type { ResourcePageConfig } from '@/features/governance';

/* ─── Row Type ─── */
interface ConnectorInstance {
  id: string;
  name: string;
  typeName: string;
  scopeType: string;
  scopeId: string;
  status: string;
  egressPolicy: Record<string, unknown> | null;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function ConnectorsPage() {
  const mutations = useResourceMutation({
    endpoint: '/connectors/instances',
    listQueryKey: ['/connectors/instances'],
  });

  const config: ResourcePageConfig<ConnectorInstance> = {
    title: '连接器管理',
    apiEndpoint: '/connectors/instances',
    responseKey: 'instances',
    searchable: true,
    searchPlaceholder: '搜索连接器…',
    selectable: true,
    columns: [
      { key: 'name', label: '名称', sortable: true },
      { key: 'typeName', label: '类型', sortable: true, width: '140px' },
      { key: 'scopeType', label: '作用域', width: '100px' },
      {
        key: 'status',
        label: '状态',
        width: '100px',
        render: (value) => <StatusBadge status={value as string} />,
      },
      {
        key: 'egressPolicy',
        label: '出站策略',
        width: '120px',
        render: (value) => (value ? '已配置' : '无'),
      },
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
          { label: '已启用', value: 'enabled' },
          { label: '已禁用', value: 'disabled' },
        ],
      },
      {
        key: 'typeName',
        label: '类型',
        type: 'select',
        options: [
          { label: 'IMAP', value: 'mail.imap' },
          { label: 'SMTP', value: 'mail.smtp' },
          { label: 'Exchange', value: 'mail.exchange' },
          { label: 'OAuth', value: 'oauth' },
        ],
      },
    ],
    actions: [
      {
        label: '启用',
        onClick: (row) => mutations.customAction(row.id, 'enable'),
        visible: (row) => row.status === 'disabled',
      },
      {
        label: '禁用',
        variant: 'destructive',
        onClick: (row) => mutations.customAction(row.id, 'disable'),
        visible: (row) => row.status === 'enabled',
      },
    ],
    createForm: {
      title: '创建连接器实例',
      fields: [
        { name: 'name', label: '名称', type: 'text', required: true, placeholder: '连接器名称' },
        {
          name: 'typeName',
          label: '类型',
          type: 'select',
          required: true,
          options: [
            { label: 'IMAP 邮件收取', value: 'mail.imap' },
            { label: 'SMTP 邮件发送', value: 'mail.smtp' },
            { label: 'Exchange 邮件', value: 'mail.exchange' },
            { label: 'OAuth 授权', value: 'oauth' },
          ],
        },
        { name: 'egressPolicy', label: '出站策略 (JSON)', type: 'json', placeholder: '{"allowedDomains": ["example.com"]}' },
      ],
    },
  };

  return <GovResourcePage config={config} />;
}
