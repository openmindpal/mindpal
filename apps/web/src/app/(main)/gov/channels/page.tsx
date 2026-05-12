'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/shared/lib/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/shared/components/primitives/Tabs';
import { Button } from '@/shared/components/primitives/Button';
import { Input } from '@/shared/components/primitives/Input';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/shared/components/primitives/Select';
import {
  Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/shared/components/primitives/Sheet';
import { DataTable } from '@/features/governance/components/DataTable';
import { StatusBadge } from '@/features/governance/components/StatusBadge';
import type { ColumnDef } from '@/features/governance/types';

/* ─── Types ─── */
interface ChannelConfig {
  id: string;
  provider: string;
  workspaceId: string;
  webhookUrl: string;
  enabled: boolean;
  secretId?: string;
  updatedAt: string;
  [key: string]: unknown;
}

interface IngressEvent {
  id: string;
  eventId: string;
  provider: string;
  workspaceId: string;
  status: string;
  receivedAt: string;
  [key: string]: unknown;
}

interface OutboxMessage {
  id: string;
  provider: string;
  channelChatId: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

/* ─── Constants ─── */
const PROVIDERS = [
  { label: '飞书', value: 'feishu' },
  { label: '企业微信', value: 'wecom' },
  { label: '钉钉', value: 'dingtalk' },
  { label: 'Slack', value: 'slack' },
  { label: 'Discord', value: 'discord' },
  { label: 'QQ OneBot', value: 'qq.onebot' },
  { label: 'iMessage Bridge', value: 'imessage.bridge' },
  { label: 'Webhook', value: 'webhook' },
];

const INGRESS_STATUSES = [
  { label: '失败', value: 'failed' },
  { label: '死信', value: 'deadletter' },
  { label: '排队中', value: 'queued' },
];

const OUTBOX_STATUSES = [
  { label: '待处理', value: 'pending' },
  { label: '已发送', value: 'sent' },
  { label: '失败', value: 'failed' },
  { label: '死信', value: 'deadletter' },
];

function fmtDate(v: unknown): string {
  if (!v) return '-';
  try { return new Date(v as string).toLocaleString('zh-CN'); } catch { return '-'; }
}

function truncate(v: unknown, len: number): string {
  const s = String(v ?? '');
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 1: 渠道配置
   ═══════════════════════════════════════════════════════════════════ */
function ConfigTab() {
  const qc = useQueryClient();
  const [providerFilter, setProviderFilter] = useState<string>('__all__');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState({ provider: 'webhook', workspaceId: '', webhookUrl: '', secretId: '' });

  const endpoint = '/governance/channels/webhook/configs';
  const queryKey = [endpoint, providerFilter];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (providerFilter && providerFilter !== '__all__') params.set('provider', providerFilter);
      const res = await apiFetch(`${endpoint}?${params.toString()}`);
      const json = await res.json();
      return (json.configs ?? []) as ChannelConfig[];
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [endpoint] }); setSheetOpen(false); setForm({ provider: 'webhook', workspaceId: '', webhookUrl: '', secretId: '' }); },
  });

  const testMut = useMutation({
    mutationFn: async (row: ChannelConfig) => {
      await apiFetch('/governance/channels/providers/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: row.provider, workspaceId: row.workspaceId }),
      });
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (row: ChannelConfig) => {
      await apiFetch(`${endpoint}/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: [endpoint] }); },
  });

  const columns: ColumnDef<ChannelConfig>[] = [
    { key: 'provider', label: '提供方', sortable: true },
    { key: 'workspaceId', label: '工作区ID', render: (v) => truncate(v, 12) },
    { key: 'webhookUrl', label: 'Webhook地址', hiddenOnMobile: true, render: (v) => truncate(v, 40) },
    { key: 'enabled', label: '状态', width: '100px', render: (v) => <StatusBadge status={v ? 'enabled' : 'disabled'} /> },
    { key: 'updatedAt', label: '更新时间', hiddenOnMobile: true, render: (v) => fmtDate(v) },
  ];

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="全部提供方" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部提供方</SelectItem>
            {PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button size="sm">新建配置</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>新建渠道配置</SheetTitle>
              <SheetDescription>添加一个新的 Webhook 渠道配置</SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">提供方</label>
                <Select value={form.provider} onValueChange={v => setForm(f => ({ ...f, provider: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">工作区 ID *</label>
                <Input value={form.workspaceId} onChange={e => setForm(f => ({ ...f, workspaceId: e.target.value }))} placeholder="workspace-id" />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">Webhook URL</label>
                <Input value={form.webhookUrl} onChange={e => setForm(f => ({ ...f, webhookUrl: e.target.value }))} placeholder="https://..." />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">Secret ID</label>
                <Input value={form.secretId} onChange={e => setForm(f => ({ ...f, secretId: e.target.value }))} placeholder="可选" />
              </div>
              <Button onClick={() => createMut.mutate()} loading={createMut.isPending} disabled={!form.workspaceId}>
                创建
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* Table */}
      <DataTable<ChannelConfig>
        columns={[
          ...columns,
          {
            key: 'id' as keyof ChannelConfig & string,
            label: '操作',
            width: '160px',
            render: (_v, row) => (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" loading={testMut.isPending} onClick={() => testMut.mutate(row)}>
                  测试
                </Button>
                <Button variant="danger" size="sm" loading={deleteMut.isPending} onClick={() => deleteMut.mutate(row)}>
                  删除
                </Button>
              </div>
            ),
          },
        ]}
        data={data ?? []}
        loading={isLoading}
        emptyMessage="暂无渠道配置"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 2: 入站事件
   ═══════════════════════════════════════════════════════════════════ */
function IngressTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('__all__');
  const [providerFilter, setProviderFilter] = useState<string>('__all__');

  const queryKey = ['/governance/channels/ingress-events', statusFilter, providerFilter];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: '50' });
      if (statusFilter && statusFilter !== '__all__') params.set('status', statusFilter);
      if (providerFilter && providerFilter !== '__all__') params.set('provider', providerFilter);
      const res = await apiFetch(`/governance/channels/ingress-events?${params.toString()}`);
      const json = await res.json();
      return (json.events ?? []) as IngressEvent[];
    },
  });

  const retryMut = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/governance/channels/ingress-events/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/governance/channels/ingress-events'] }); },
  });

  const columns: ColumnDef<IngressEvent>[] = [
    { key: 'eventId', label: '事件ID', render: (v) => truncate(v, 12) },
    { key: 'provider', label: '提供方' },
    { key: 'workspaceId', label: '工作区', render: (v) => truncate(v, 12) },
    { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={v as string} /> },
    { key: 'receivedAt', label: '接收时间', hiddenOnMobile: true, render: (v) => fmtDate(v) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部状态</SelectItem>
            {INGRESS_STATUSES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={providerFilter} onValueChange={setProviderFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="全部提供方" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部提供方</SelectItem>
            {PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <DataTable<IngressEvent>
        columns={[
          ...columns,
          {
            key: 'id' as keyof IngressEvent & string,
            label: '操作',
            width: '100px',
            render: (_v, row) =>
              row.status !== 'queued' ? (
                <Button variant="ghost" size="sm" loading={retryMut.isPending} onClick={() => retryMut.mutate(row.id)}>
                  重试
                </Button>
              ) : null,
          },
        ]}
        data={data ?? []}
        loading={isLoading}
        emptyMessage="暂无入站事件"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 3: 出站队列
   ═══════════════════════════════════════════════════════════════════ */
function OutboxTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('__all__');
  const [showDlq, setShowDlq] = useState(false);

  const queryKey = ['/governance/channels/outbox', statusFilter, showDlq];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      if (showDlq) {
        const res = await apiFetch('/governance/channels/outbox/dlq');
        const json = await res.json();
        return (json.messages ?? json.items ?? []) as OutboxMessage[];
      }
      const params = new URLSearchParams({ limit: '50' });
      if (statusFilter && statusFilter !== '__all__') params.set('status', statusFilter);
      const res = await apiFetch(`/governance/channels/outbox?${params.toString()}`);
      const json = await res.json();
      return (json.messages ?? json.items ?? []) as OutboxMessage[];
    },
  });

  const retryMut = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/retry`, { method: 'POST' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/governance/channels/outbox'] }); },
  });

  const cancelMut = useMutation({
    mutationFn: async (id: string) => {
      await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['/governance/channels/outbox'] }); },
  });

  const columns: ColumnDef<OutboxMessage>[] = [
    { key: 'id', label: '消息ID', render: (v) => truncate(v, 12) },
    { key: 'provider', label: '提供方' },
    { key: 'channelChatId', label: '会话ID', render: (v) => truncate(v, 12) },
    { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={v as string} /> },
    { key: 'createdAt', label: '创建时间', hiddenOnMobile: true, render: (v) => fmtDate(v) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setShowDlq(false); }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="全部状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部状态</SelectItem>
            {OUTBOX_STATUSES.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button
          variant={showDlq ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => setShowDlq(!showDlq)}
        >
          {showDlq ? '返回队列' : '显示死信'}
        </Button>
      </div>

      <DataTable<OutboxMessage>
        columns={[
          ...columns,
          {
            key: 'id' as keyof OutboxMessage & string,
            label: '操作',
            width: '160px',
            render: (_v, row) => (
              <div className="flex gap-2">
                {(row.status === 'failed' || row.status === 'deadletter') && (
                  <Button variant="ghost" size="sm" loading={retryMut.isPending} onClick={() => retryMut.mutate(row.id)}>
                    重试
                  </Button>
                )}
                {row.status === 'pending' && (
                  <Button variant="danger" size="sm" loading={cancelMut.isPending} onClick={() => cancelMut.mutate(row.id)}>
                    取消
                  </Button>
                )}
              </div>
            ),
          },
        ]}
        data={data ?? []}
        loading={isLoading}
        emptyMessage={showDlq ? '暂无死信消息' : '暂无出站消息'}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Page
   ═══════════════════════════════════════════════════════════════════ */
export default function ChannelsPage() {
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold text-[var(--color-text)]">渠道管理</h1>

      <Tabs defaultValue="configs">
        <TabsList>
          <TabsTrigger value="configs">渠道配置</TabsTrigger>
          <TabsTrigger value="ingress">入站事件</TabsTrigger>
          <TabsTrigger value="outbox">出站队列</TabsTrigger>
        </TabsList>

        <TabsContent value="configs">
          <ConfigTab />
        </TabsContent>
        <TabsContent value="ingress">
          <IngressTab />
        </TabsContent>
        <TabsContent value="outbox">
          <OutboxTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
