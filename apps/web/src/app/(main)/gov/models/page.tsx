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
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/shared/components/primitives/Sheet';
import { DataTable } from '@/features/governance/components/DataTable';
import { StatusBadge } from '@/features/governance/components/StatusBadge';
import type { ColumnDef } from '@/features/governance/types';
import { Trash2, ToggleLeft, Zap, ChevronDown, CheckCircle2, XCircle } from 'lucide-react';

/* ─── Types ─── */
interface ModelEntry {
  id: string;
  modelRef: string;
  displayName: string;
  provider: string;
  status: string;
  capabilities?: { contextWindow?: number; maxOutputTokens?: number; supportedModalities?: string[] };
  updatedAt: string;
  [key: string]: unknown;
}

interface ProviderBinding {
  id: string;
  modelRef: string;
  provider: string;
  baseUrl: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

interface ConnectorInstance {
  id: string;
  name: string;
  type?: string;
  [key: string]: unknown;
}

/* ─── Provider Defaults ─── */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; path: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', path: '/chat/completions' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', path: '/messages' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', path: '/chat/completions' },
  azure: { baseUrl: '', path: '/chat/completions' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', path: '/chat/completions' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', path: '/chat/completions' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', path: '/chat/completions' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', path: '/chat/completions' },
  minimax: { baseUrl: 'https://api.minimax.chat/v1', path: '/chat/completions' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', path: '/chat/completions' },
  local: { baseUrl: 'http://localhost:11434/v1', path: '/chat/completions' },
};

/* ─── Provider Display Label (frontend fallback, backend provides labels too) ─── */
interface ProviderOption {
  id: string;
  label: string;
}

const STATUS_COLOR_MAP: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
  active: 'success',
  degraded: 'warning',
  unavailable: 'danger',
  probing: 'default',
};

/* ─── Catalog Columns ─── */
const catalogColumns: ColumnDef<ModelEntry>[] = [
  { key: 'modelRef', label: '模型引用', sortable: true },
  { key: 'displayName', label: '显示名称' },
  { key: 'provider', label: '提供方' },
  { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={String(v ?? '')} colorMap={STATUS_COLOR_MAP} /> },
  {
    key: 'capabilities', label: '能力摘要', hiddenOnMobile: true,
    render: (v) => {
      const cap = v as ModelEntry['capabilities'];
      if (!cap) return '-';
      const parts: string[] = [];
      if (cap.contextWindow) parts.push(`ctx:${(cap.contextWindow / 1000).toFixed(0)}k`);
      if (cap.supportedModalities?.length) parts.push(`${cap.supportedModalities.length} modalities`);
      return parts.join(' · ') || '-';
    },
  },
  {
    key: 'updatedAt', label: '更新时间', hiddenOnMobile: true,
    render: (v) => v ? new Date(v as string).toLocaleString('zh-CN') : '-',
  },
];

/* ─── Binding Columns ─── */
const bindingColumns: ColumnDef<ProviderBinding>[] = [
  { key: 'modelRef', label: '模型引用' },
  { key: 'provider', label: '提供方' },
  {
    key: 'baseUrl', label: 'API 地址',
    render: (v) => {
      const s = String(v ?? '');
      return s.length > 40 ? s.slice(0, 40) + '…' : s;
    },
  },
  { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={String(v ?? '')} colorMap={STATUS_COLOR_MAP} /> },
  {
    key: 'createdAt', label: '创建时间', hiddenOnMobile: true,
    render: (v) => v ? new Date(v as string).toLocaleString('zh-CN') : '-',
  },
];

/* ─── Page Component ─── */
export default function ModelsPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [catalogSheetOpen, setCatalogSheetOpen] = useState(false);
  const [bindingSheetOpen, setBindingSheetOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  /* ── Batch selection state ── */
  const [selectedCatalogRows, setSelectedCatalogRows] = useState<ModelEntry[]>([]);

  /* ── Test connection state ── */
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg?: string }>>({});

  /* ── Catalog form state ── */
  const [catForm, setCatForm] = useState({
    modelRef: '', provider: '', modelName: '', displayName: '', endpointHost: '',
    contextWindow: '', maxOutputTokens: '', streamingSupport: false, visionSupport: false,
  });

  /* ── Binding form state ── */
  const [bindForm, setBindForm] = useState({
    provider: 'deepseek', modelRef: '', baseUrl: PROVIDER_DEFAULTS.deepseek.baseUrl,
    chatCompletionsPath: PROVIDER_DEFAULTS.deepseek.path,
    connectorInstanceId: '', secretId: '', testBeforeSave: true,
  });

  /* ── Provider list query ── */
  const providersQuery = useQuery({
    queryKey: ['/models/providers'],
    queryFn: async () => {
      const res = await apiFetch('/models/providers');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ providers: ProviderOption[] }>;
    },
    staleTime: 10 * 60 * 1000, // 10 minutes — provider list rarely changes
  });

  /* ── Queries ── */
  const catalogQuery = useQuery({
    queryKey: ['/models/catalog/db', statusFilter],
    queryFn: async () => {
      const params = statusFilter && statusFilter !== '__all__' ? `?status=${statusFilter}` : '';
      const res = await apiFetch(`/models/catalog/db${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ entries: ModelEntry[]; count: number }>;
    },
  });

  const bindingsQuery = useQuery({
    queryKey: ['/models/bindings'],
    queryFn: async () => {
      const res = await apiFetch('/models/bindings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ scope: Record<string, unknown>; bindings: ProviderBinding[] }>;
    },
  });

  /* ── Connector list query ── */
  const connectorsQuery = useQuery({
    queryKey: ['/governance/connectors'],
    queryFn: async () => {
      const res = await apiFetch('/governance/connectors');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { items?: ConnectorInstance[]; connectors?: ConnectorInstance[] };
      return (data.items ?? data.connectors ?? []) as ConnectorInstance[];
    },
  });

  /* ── Mutations ── */
  const createCatalogEntry = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        modelRef: catForm.modelRef,
        provider: catForm.provider,
        modelName: catForm.modelName,
        displayName: catForm.displayName || undefined,
        endpointHost: catForm.endpointHost || undefined,
        capabilities: {
          contextWindow: catForm.contextWindow ? Number(catForm.contextWindow) : undefined,
          maxOutputTokens: catForm.maxOutputTokens ? Number(catForm.maxOutputTokens) : undefined,
          streamingSupport: catForm.streamingSupport,
          visionSupport: catForm.visionSupport,
        },
      };
      const res = await apiFetch('/models/catalog/db', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/models/catalog/db'] });
      setCatalogSheetOpen(false);
      setCatForm({ modelRef: '', provider: '', modelName: '', displayName: '', endpointHost: '', contextWindow: '', maxOutputTokens: '', streamingSupport: false, visionSupport: false });
    },
  });

  const toggleCatalogStatus = useMutation({
    mutationFn: async ({ id, currentStatus }: { id: string; currentStatus: string }) => {
      const newStatus = currentStatus === 'active' ? 'unavailable' : 'active';
      const res = await apiFetch(`/models/catalog/db/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/models/catalog/db'] }),
  });

  const deleteCatalogEntry = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/models/catalog/db/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/models/catalog/db'] }),
  });

  const createBinding = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        provider: bindForm.provider,
        modelRef: bindForm.modelRef,
        baseUrl: bindForm.baseUrl,
        chatCompletionsPath: bindForm.chatCompletionsPath,
        connectorInstanceId: bindForm.connectorInstanceId || undefined,
        secretId: bindForm.secretId || undefined,
        testBeforeSave: bindForm.testBeforeSave,
      };
      const res = await apiFetch('/models/bindings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/models/bindings'] });
      setBindingSheetOpen(false);
      setBindForm({ provider: 'deepseek', modelRef: '', baseUrl: PROVIDER_DEFAULTS.deepseek.baseUrl, chatCompletionsPath: PROVIDER_DEFAULTS.deepseek.path, connectorInstanceId: '', secretId: '', testBeforeSave: true });
    },
  });

  const deleteBinding = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/models/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/models/bindings'] }),
  });

  /* ── Test binding connection ── */
  const testBindingConnection = useMutation({
    mutationFn: async (binding: ProviderBinding) => {
      const res = await apiFetch(`/models/bindings/${encodeURIComponent(binding.id)}/test`, {
        method: 'POST',
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(errBody || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (_data, binding) => {
      setTestResults(prev => ({ ...prev, [binding.id]: { ok: true } }));
    },
    onError: (err, binding) => {
      setTestResults(prev => ({ ...prev, [binding.id]: { ok: false, msg: (err as Error).message } }));
    },
  });

  /* ── Batch operations ── */
  const batchToggleStatus = useMutation({
    mutationFn: async (rows: ModelEntry[]) => {
      await Promise.all(
        rows.map(row => {
          const newStatus = row.status === 'active' ? 'unavailable' : 'active';
          return apiFetch(`/models/catalog/db/${encodeURIComponent(row.id)}/status`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ status: newStatus }),
          });
        }),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/models/catalog/db'] });
      setSelectedCatalogRows([]);
    },
  });

  const batchDelete = useMutation({
    mutationFn: async (rows: ModelEntry[]) => {
      await Promise.all(
        rows.map(row =>
          apiFetch(`/models/catalog/db/${encodeURIComponent(row.id)}`, { method: 'DELETE' }),
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/models/catalog/db'] });
      setSelectedCatalogRows([]);
    },
  });

  /* ── Catalog columns with actions ── */
  const catalogColumnsWithActions: ColumnDef<ModelEntry>[] = [
    ...catalogColumns,
    {
      key: 'id' as keyof ModelEntry & string, label: '操作', width: '120px',
      render: (_v, row) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); toggleCatalogStatus.mutate({ id: row.id, currentStatus: row.status }); }}>
            <ToggleLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); deleteCatalogEntry.mutate(row.id); }}>
            <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />
          </Button>
        </div>
      ),
    },
  ];

  /* ── Binding columns with actions (includes test button) ── */
  const bindingColumnsWithActions: ColumnDef<ProviderBinding>[] = [
    ...bindingColumns,
    {
      key: 'id' as keyof ProviderBinding & string, label: '操作', width: '140px',
      render: (_v, row) => {
        const result = testResults[row.id];
        return (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              title="测试连接"
              onClick={(e) => { e.stopPropagation(); testBindingConnection.mutate(row); }}
            >
              <Zap className="h-4 w-4" />
            </Button>
            {result && (
              result.ok
                ? <span title="连接成功"><CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" /></span>
                : <span title={result.msg ?? '连接失败'}><XCircle className="h-4 w-4 text-[var(--color-danger)]" /></span>
            )}
            <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); deleteBinding.mutate(row.id); }}>
              <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />
            </Button>
          </div>
        );
      },
    },
  ];

  /* ── Connector options ── */
  const connectors = connectorsQuery.data ?? [];

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-[var(--color-text)]">模型管理</h1>

      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">模型目录</TabsTrigger>
          <TabsTrigger value="bindings">模型绑定</TabsTrigger>
        </TabsList>

        {/* ─── Tab 1: 模型目录 ─── */}
        <TabsContent value="catalog">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue placeholder="按状态筛选" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">全部</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="degraded">Degraded</SelectItem>
                    <SelectItem value="unavailable">Unavailable</SelectItem>
                    <SelectItem value="probing">Probing</SelectItem>
                  </SelectContent>
                </Select>
                {/* Batch toolbar */}
                {selectedCatalogRows.length > 0 && (
                  <div className="flex items-center gap-2 rounded-md bg-[var(--color-surface-raised)] px-3 py-1.5 text-[var(--text-sm)]">
                    <span className="text-[var(--color-text-secondary)]">已选 {selectedCatalogRows.length} 项</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => batchToggleStatus.mutate(selectedCatalogRows)}
                      loading={batchToggleStatus.isPending}
                    >
                      <ToggleLeft className="mr-1 h-3.5 w-3.5" />
                      切换状态
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[var(--color-danger)]"
                      onClick={() => {
                        if (confirm(`确认删除选中的 ${selectedCatalogRows.length} 个模型？`)) {
                          batchDelete.mutate(selectedCatalogRows);
                        }
                      }}
                      loading={batchDelete.isPending}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      批量删除
                    </Button>
                  </div>
                )}
              </div>
              <Button size="sm" onClick={() => setCatalogSheetOpen(true)}>新建模型</Button>
            </div>
            <DataTable<ModelEntry>
              columns={catalogColumnsWithActions}
              data={catalogQuery.data?.entries ?? []}
              loading={catalogQuery.isLoading}
              emptyMessage="暂无模型目录数据"
              selectable
              selectedRows={selectedCatalogRows}
              onSelectionChange={setSelectedCatalogRows}
            />
          </div>
        </TabsContent>

        {/* ─── Tab 2: 模型绑定 ─── */}
        <TabsContent value="bindings">
          <div className="space-y-4">
            <div className="flex items-center justify-end">
              <Button size="sm" onClick={() => setBindingSheetOpen(true)}>新建绑定</Button>
            </div>
            <DataTable<ProviderBinding>
              columns={bindingColumnsWithActions}
              data={bindingsQuery.data?.bindings ?? []}
              loading={bindingsQuery.isLoading}
              emptyMessage="暂无模型绑定数据"
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* ─── Sheet: 新建模型目录 ─── */}
      <Sheet open={catalogSheetOpen} onOpenChange={setCatalogSheetOpen}>
        <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>新建模型</SheetTitle>
            <SheetDescription>向目录中添加一个新模型条目</SheetDescription>
          </SheetHeader>
          <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); createCatalogEntry.mutate(); }}>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">模型引用 *</span>
              <Input value={catForm.modelRef} onChange={(e) => setCatForm(p => ({ ...p, modelRef: e.target.value }))} placeholder="如 gpt-4o" required />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">提供方 *</span>
              <Input value={catForm.provider} onChange={(e) => setCatForm(p => ({ ...p, provider: e.target.value }))} placeholder="如 openai" required />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">模型名称 *</span>
              <Input value={catForm.modelName} onChange={(e) => setCatForm(p => ({ ...p, modelName: e.target.value }))} placeholder="如 gpt-4o-2024-05-13" required />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">显示名称</span>
              <Input value={catForm.displayName} onChange={(e) => setCatForm(p => ({ ...p, displayName: e.target.value }))} placeholder="可选" />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">Endpoint Host</span>
              <Input value={catForm.endpointHost} onChange={(e) => setCatForm(p => ({ ...p, endpointHost: e.target.value }))} placeholder="可选" />
            </label>

            <div className="border-t border-[var(--color-border)] pt-4">
              <span className="text-[var(--text-sm)] font-semibold text-[var(--color-text)]">能力配置</span>
              <div className="mt-3 space-y-3">
                <label className="block space-y-1">
                  <span className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">Context Window</span>
                  <Input type="number" value={catForm.contextWindow} onChange={(e) => setCatForm(p => ({ ...p, contextWindow: e.target.value }))} placeholder="128000" />
                </label>
                <label className="block space-y-1">
                  <span className="text-[var(--text-sm)] text-[var(--color-text-secondary)]">Max Output Tokens</span>
                  <Input type="number" value={catForm.maxOutputTokens} onChange={(e) => setCatForm(p => ({ ...p, maxOutputTokens: e.target.value }))} placeholder="4096" />
                </label>
                <label className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={catForm.streamingSupport} onChange={(e) => setCatForm(p => ({ ...p, streamingSupport: e.target.checked }))} className="rounded" />
                  Streaming 支持
                </label>
                <label className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={catForm.visionSupport} onChange={(e) => setCatForm(p => ({ ...p, visionSupport: e.target.checked }))} className="rounded" />
                  Vision 支持
                </label>
              </div>
            </div>

            <div className="flex justify-end pt-4">
              <Button type="submit" loading={createCatalogEntry.isPending}>保存</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      {/* ─── Sheet: 新建绑定 ─── */}
      <Sheet open={bindingSheetOpen} onOpenChange={setBindingSheetOpen}>
        <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle>新建模型绑定</SheetTitle>
            <SheetDescription>将模型连接到提供方 API</SheetDescription>
          </SheetHeader>
          <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); createBinding.mutate(); }}>
            {/* ── 基础字段 ── */}
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">提供方 *</span>
              <Select
                value={bindForm.provider}
                onValueChange={(v) => {
                  const defaults = PROVIDER_DEFAULTS[v] ?? { baseUrl: '', path: '/chat/completions' };
                  setBindForm(p => ({ ...p, provider: v, baseUrl: defaults.baseUrl, chatCompletionsPath: defaults.path }));
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[300px] overflow-y-auto">
                  {(providersQuery.data?.providers ?? []).map(p => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">模型引用 *</span>
              <Input value={bindForm.modelRef} onChange={(e) => setBindForm(p => ({ ...p, modelRef: e.target.value }))} placeholder="如 deepseek-v3" required />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">Base URL *</span>
              <Input value={bindForm.baseUrl} onChange={(e) => setBindForm(p => ({ ...p, baseUrl: e.target.value }))} placeholder="https://..." required />
            </label>
            <label className="block space-y-1">
              <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">Secret ID</span>
              <Input value={bindForm.secretId} onChange={(e) => setBindForm(p => ({ ...p, secretId: e.target.value }))} placeholder="密钥标识" />
            </label>

            {/* ── 高级字段（折叠） ── */}
            <div>
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                className="flex w-full items-center gap-1 border-t border-[var(--color-border)] pt-3 text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors"
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
                高级设置
              </button>
              {advancedOpen && (
              <div className="space-y-4 pt-3">
                <label className="block space-y-1">
                  <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">Chat Completions Path</span>
                  <Input value={bindForm.chatCompletionsPath} onChange={(e) => setBindForm(p => ({ ...p, chatCompletionsPath: e.target.value }))} placeholder="/chat/completions" />
                </label>
                <label className="block space-y-1">
                  <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">Connector Instance</span>
                  {connectors.length === 0 ? (
                    <p className="text-[var(--text-sm)] text-[var(--color-text-muted)] italic">暂无连接器，请先创建</p>
                  ) : (
                    <Select
                      value={bindForm.connectorInstanceId}
                      onValueChange={(v) => setBindForm(p => ({ ...p, connectorInstanceId: v }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="选择连接器" />
                      </SelectTrigger>
                      <SelectContent>
                        {connectors.map(c => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}{c.type ? ` (${c.type})` : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </label>
                <label className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={bindForm.testBeforeSave} onChange={(e) => setBindForm(p => ({ ...p, testBeforeSave: e.target.checked }))} className="rounded" />
                  保存前测试连接
                </label>
              </div>
              )}
            </div>

            <div className="flex justify-end pt-4">
              <Button type="submit" loading={createBinding.isPending}>保存</Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </div>
  );
}
