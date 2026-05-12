'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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
  admissionPolicy?: string;
  updatedAt: string;
  [key: string]: unknown;
}

type SetupMode = 'manual' | 'qr';
type PairingStatus = 'idle' | 'generating' | 'waiting' | 'success' | 'timeout' | 'error';

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

/* ─── QR Code SVG Generator (lightweight, no external deps) ─── */
function QrCodeDisplay({ url }: { url: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4">
      <div
        className="rounded-lg border border-[var(--color-border)] bg-white p-3"
        style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {/* Use a QR code image service URL to render the authorize URL as QR */}
        <img
          src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url)}`}
          alt="配对二维码"
          width={180}
          height={180}
          style={{ imageRendering: 'pixelated' }}
        />
      </div>
      <p className="text-[var(--text-xs)] text-[var(--color-text-tertiary)] text-center max-w-[240px] break-all">
        {url.length > 80 ? url.slice(0, 80) + '…' : url}
      </p>
    </div>
  );
}

/* ─── Pairing Status Indicator ─── */
function PairingStatusIndicator({ status, errorMsg }: { status: PairingStatus; errorMsg?: string }) {
  const map: Record<PairingStatus, { text: string; color: string }> = {
    idle: { text: '', color: '' },
    generating: { text: '正在生成配对码...', color: 'var(--color-text-secondary)' },
    waiting: { text: '等待扫码...', color: 'var(--color-warning)' },
    success: { text: '配对成功！', color: 'var(--color-success)' },
    timeout: { text: '已超时，请重新生成', color: 'var(--color-danger)' },
    error: { text: errorMsg ?? '发生错误', color: 'var(--color-danger)' },
  };
  const info = map[status];
  if (!info.text) return null;
  return (
    <div className="flex items-center gap-2 justify-center py-2">
      {status === 'waiting' && (
        <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: info.color }} />
      )}
      {status === 'success' && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.5 12L13 4" stroke="var(--color-success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      )}
      <span className="text-[var(--text-sm)] font-medium" style={{ color: info.color }}>{info.text}</span>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 1: 渠道配置
   ═══════════════════════════════════════════════════════════════════ */
function ConfigTab() {
  const qc = useQueryClient();
  const [providerFilter, setProviderFilter] = useState<string>('__all__');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<SetupMode>('manual');
  const [form, setForm] = useState({ provider: 'webhook', workspaceId: '', webhookUrl: '', secretId: '', admissionPolicy: 'open' });

  // QR pairing state
  const [qrProvider, setQrProvider] = useState('feishu');
  const [qrAdmissionPolicy, setQrAdmissionPolicy] = useState<'open' | 'pairing'>('open');
  const [pairingStatus, setPairingStatus] = useState<PairingStatus>('idle');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string>('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);

  const POLL_INTERVAL = 3000;
  const POLL_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopPolling(); };
  }, [stopPolling]);

  const startPairing = async () => {
    setPairingStatus('generating');
    setAuthorizeUrl(null);
    setPairingError('');
    stopPolling();

    try {
      const res = await apiFetch(`/governance/channels/setup/${encodeURIComponent(qrProvider)}/init`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        throw new Error(errJson?.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setAuthorizeUrl(json.authorizeUrl);
      setPairingStatus('waiting');
      pollStartRef.current = Date.now();

      // Start polling
      pollTimerRef.current = setInterval(async () => {
        if (Date.now() - pollStartRef.current > POLL_TIMEOUT) {
          stopPolling();
          setPairingStatus('timeout');
          return;
        }
        try {
          const statusRes = await apiFetch(`/governance/channels/setup/${encodeURIComponent(qrProvider)}/status`);
          if (!statusRes.ok) return;
          const statusJson = await statusRes.json();
          if (statusJson.configured) {
            stopPolling();
            setPairingStatus('success');
            qc.invalidateQueries({ queryKey: ['/governance/channels/webhook/configs'] });
          }
        } catch {
          // Ignore poll errors, keep retrying
        }
      }, POLL_INTERVAL);
    } catch (e: any) {
      setPairingError(e?.message ?? '未知错误');
      setPairingStatus('error');
    }
  };

  const resetPairing = () => {
    stopPolling();
    setPairingStatus('idle');
    setAuthorizeUrl(null);
    setPairingError('');
  };

  const handleSheetClose = (open: boolean) => {
    setSheetOpen(open);
    if (!open) {
      resetPairing();
      setSetupMode('manual');
    }
  };

  const endpoint = '/governance/channels/webhook/configs';
  const queryKey = [endpoint, providerFilter];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (providerFilter && providerFilter !== '__all__') params.set('provider', providerFilter);
      const res = await apiFetch(`${endpoint}?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: [endpoint] }); handleSheetClose(false); setForm({ provider: 'webhook', workspaceId: '', webhookUrl: '', secretId: '', admissionPolicy: 'open' }); },
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

  // Providers that support QR setup
  const QR_PROVIDERS = PROVIDERS.filter(p => ['feishu', 'wecom', 'dingtalk', 'slack', 'discord'].includes(p.value));

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

        <Sheet open={sheetOpen} onOpenChange={handleSheetClose}>
          <SheetTrigger asChild>
            <Button size="sm">新建配置</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>新建渠道配置</SheetTitle>
              <SheetDescription>选择手动配置或扫码配对来添加渠道</SheetDescription>
            </SheetHeader>

            {/* Mode Switcher */}
            <div className="mt-4 flex rounded-lg border border-[var(--color-border)] overflow-hidden">
              <button
                type="button"
                className={`flex-1 py-2 px-4 text-[var(--text-sm)] font-medium transition-colors ${
                  setupMode === 'manual'
                    ? 'bg-[var(--color-bg-accent)] text-[var(--color-text)]'
                    : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                }`}
                onClick={() => { setSetupMode('manual'); resetPairing(); }}
              >
                手动配置
              </button>
              <button
                type="button"
                className={`flex-1 py-2 px-4 text-[var(--text-sm)] font-medium transition-colors ${
                  setupMode === 'qr'
                    ? 'bg-[var(--color-bg-accent)] text-[var(--color-text)]'
                    : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                }`}
                onClick={() => setSetupMode('qr')}
              >
                扫码配对
              </button>
            </div>

            {/* Manual Mode */}
            {setupMode === 'manual' && (
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
                <div>
                  <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">准入策略</label>
                  <Select value={form.admissionPolicy} onValueChange={v => setForm(f => ({ ...f, admissionPolicy: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">开放接入</SelectItem>
                      <SelectItem value="pairing">配对接入</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[var(--text-xs)] text-[var(--color-text-tertiary)] mt-1">
                    {form.admissionPolicy === 'open' ? '任何人可通过此渠道发消息' : '需要扫码或邀请才能接入'}
                  </p>
                </div>
                <Button onClick={() => createMut.mutate()} loading={createMut.isPending} disabled={!form.workspaceId}>
                  创建
                </Button>
              </div>
            )}

            {/* QR Pairing Mode */}
            {setupMode === 'qr' && (
              <div className="mt-6 space-y-4">
                <div>
                  <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">选择提供方</label>
                  <Select value={qrProvider} onValueChange={v => { setQrProvider(v); resetPairing(); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {QR_PROVIDERS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">准入策略</label>
                  <Select value={qrAdmissionPolicy} onValueChange={v => setQrAdmissionPolicy(v as 'open' | 'pairing')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">开放接入</SelectItem>
                      <SelectItem value="pairing">配对接入</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[var(--text-xs)] text-[var(--color-text-tertiary)] mt-1">
                    {qrAdmissionPolicy === 'open' ? '任何人可通过此渠道发消息' : '需要扫码或邀请才能接入'}
                  </p>
                </div>

                {/* QR Code area */}
                <div className="flex flex-col items-center border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-bg-secondary)]">
                  {pairingStatus === 'idle' && (
                    <div className="flex flex-col items-center gap-3 py-6">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <rect x="4" y="4" width="16" height="16" rx="2" stroke="var(--color-text-tertiary)" strokeWidth="2"/>
                        <rect x="8" y="8" width="8" height="8" fill="var(--color-text-tertiary)"/>
                        <rect x="28" y="4" width="16" height="16" rx="2" stroke="var(--color-text-tertiary)" strokeWidth="2"/>
                        <rect x="32" y="8" width="8" height="8" fill="var(--color-text-tertiary)"/>
                        <rect x="4" y="28" width="16" height="16" rx="2" stroke="var(--color-text-tertiary)" strokeWidth="2"/>
                        <rect x="8" y="32" width="8" height="8" fill="var(--color-text-tertiary)"/>
                        <rect x="28" y="28" width="4" height="4" fill="var(--color-text-tertiary)"/>
                        <rect x="36" y="28" width="4" height="4" fill="var(--color-text-tertiary)"/>
                        <rect x="28" y="36" width="4" height="4" fill="var(--color-text-tertiary)"/>
                        <rect x="36" y="36" width="8" height="8" fill="var(--color-text-tertiary)"/>
                      </svg>
                      <p className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">点击下方按钮生成配对二维码</p>
                      <Button onClick={startPairing} size="sm">
                        生成配对码
                      </Button>
                    </div>
                  )}

                  {pairingStatus === 'generating' && (
                    <div className="py-8">
                      <PairingStatusIndicator status="generating" />
                    </div>
                  )}

                  {pairingStatus === 'waiting' && authorizeUrl && (
                    <>
                      <QrCodeDisplay url={authorizeUrl} />
                      <PairingStatusIndicator status="waiting" />
                      <p className="text-[var(--text-xs)] text-[var(--color-text-tertiary)] mt-2">请使用对应 IM 应用扫描二维码完成授权</p>
                    </>
                  )}

                  {pairingStatus === 'success' && (
                    <div className="py-6 flex flex-col items-center gap-2">
                      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
                        <circle cx="24" cy="24" r="20" stroke="var(--color-success)" strokeWidth="2"/>
                        <path d="M14 24L21 31L34 17" stroke="var(--color-success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <PairingStatusIndicator status="success" />
                      <p className="text-[var(--text-xs)] text-[var(--color-text-secondary)]">渠道已自动配置完成</p>
                      <Button variant="secondary" size="sm" onClick={() => handleSheetClose(false)}>
                        关闭
                      </Button>
                    </div>
                  )}

                  {(pairingStatus === 'timeout' || pairingStatus === 'error') && (
                    <div className="py-6 flex flex-col items-center gap-2">
                      <PairingStatusIndicator status={pairingStatus} errorMsg={pairingError} />
                      <Button variant="secondary" size="sm" onClick={resetPairing}>
                        重试
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
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
                <Button variant="ghost" size="sm" className="text-[var(--color-danger)]" loading={deleteMut.isPending} onClick={() => deleteMut.mutate(row)}>
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
      if (!res.ok) throw new Error(`API error: ${res.status}`);
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
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const json = await res.json();
        return (json.messages ?? json.items ?? []) as OutboxMessage[];
      }
      const params = new URLSearchParams({ limit: '50' });
      if (statusFilter && statusFilter !== '__all__') params.set('status', statusFilter);
      const res = await apiFetch(`/governance/channels/outbox?${params.toString()}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
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
          variant="secondary"
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
                  <Button variant="ghost" size="sm" className="text-[var(--color-danger)]" loading={cancelMut.isPending} onClick={() => cancelMut.mutate(row.id)}>
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
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">渠道管理</h1>

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
