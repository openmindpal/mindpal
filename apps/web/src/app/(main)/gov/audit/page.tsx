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
import { DataTable, StatusBadge } from '@/features/governance';
import { useResourceList } from '@/features/governance/hooks/useResourceList';
import { useResourceMutation } from '@/features/governance/hooks/useResourceMutation';
import type { ColumnDef } from '@/features/governance/types';
import { Plus, Download, Play, Shield, FileText } from 'lucide-react';

/* ─── Types ─── */
interface AuditLogItem {
  id: string;
  actor: string;
  action: string;
  resource: string;
  timestamp: string;
  [key: string]: unknown;
}

interface LegalHold {
  id: string;
  reason: string;
  targetType: string;
  targetValue: string;
  createdAt: string;
  status: string;
  [key: string]: unknown;
}

interface ExportTask {
  id: string;
  status: string;
  format: string;
  createdAt: string;
  dateFrom?: string;
  dateTo?: string;
  [key: string]: unknown;
}

interface SiemDestination {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  status: string;
  lastSyncAt?: string;
  [key: string]: unknown;
}

/* ─── Helpers ─── */
function fmtDate(v: unknown): string {
  if (!v) return '-';
  try { return new Date(v as string).toLocaleString('zh-CN'); } catch { return '-'; }
}

function truncate(v: unknown, len: number): string {
  const s = String(v ?? '');
  return s.length > len ? s.slice(0, len) + '…' : s;
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 1: 审计日志
   ═══════════════════════════════════════════════════════════════════ */
function AuditLogTab() {
  const [actionFilter, setActionFilter] = useState<string>('__all__');

  const logList = useResourceList<AuditLogItem>({
    endpoint: actionFilter && actionFilter !== '__all__'
      ? `/governance/audit?action=${actionFilter}`
      : '/governance/audit',
  });

  const columns: ColumnDef<AuditLogItem>[] = [
    { key: 'id', label: 'ID', sortable: true },
    { key: 'actor', label: '操作者', sortable: true },
    { key: 'action', label: '操作', sortable: true, render: (v) => <StatusBadge status={v as string} /> },
    { key: 'resource', label: '资源', sortable: true },
    { key: 'timestamp', label: '时间', sortable: true, hiddenOnMobile: true, render: (v) => fmtDate(v) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="全部操作" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">全部操作</SelectItem>
            <SelectItem value="create">创建</SelectItem>
            <SelectItem value="update">更新</SelectItem>
            <SelectItem value="delete">删除</SelectItem>
            <SelectItem value="read">读取</SelectItem>
            <SelectItem value="execute">执行</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <DataTable<AuditLogItem>
        columns={columns}
        data={logList.data}
        loading={logList.isLoading}
        pagination={logList.pagination}
        onPageChange={logList.setPage}
        onPageSizeChange={logList.setPageSize}
        sort={logList.sort}
        onSortChange={logList.setSort}
        emptyMessage="暂无审计日志"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 2: 法律保留
   ═══════════════════════════════════════════════════════════════════ */
function LegalHoldsTab() {
  const qc = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState({ targetType: 'traceId', targetValue: '', reason: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['/governance/audit/legal-holds'],
    queryFn: async () => {
      const res = await apiFetch('/governance/audit/legal-holds');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      return (json.holds ?? json.items ?? json.data ?? []) as LegalHold[];
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/governance/audit/legal-holds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(`创建失败: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/governance/audit/legal-holds'] });
      setSheetOpen(false);
      setForm({ targetType: 'traceId', targetValue: '', reason: '' });
    },
  });

  const releaseMut = useMutation({
    mutationFn: async (holdId: string) => {
      const res = await apiFetch(`/governance/audit/legal-holds/${encodeURIComponent(holdId)}/release`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`释放失败: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/governance/audit/legal-holds'] });
    },
  });

  const columns: ColumnDef<LegalHold>[] = [
    { key: 'id', label: '保留ID', render: (v) => truncate(v, 12) },
    { key: 'reason', label: '原因' },
    { key: 'targetType', label: '目标类型' },
    { key: 'targetValue', label: '目标值', hiddenOnMobile: true, render: (v) => truncate(v, 20) },
    { key: 'createdAt', label: '创建时间', hiddenOnMobile: true, render: (v) => fmtDate(v) },
    { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={v as string} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />创建保留</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>创建法律保留</SheetTitle>
              <SheetDescription>对指定目标设置法律保留，防止数据被自动清理</SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">目标类型</label>
                <Select value={form.targetType} onValueChange={v => setForm(f => ({ ...f, targetType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="traceId">Trace ID</SelectItem>
                    <SelectItem value="runId">Run ID</SelectItem>
                    <SelectItem value="timeRange">时间范围</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">目标值 *</label>
                <Input
                  value={form.targetValue}
                  onChange={e => setForm(f => ({ ...f, targetValue: e.target.value }))}
                  placeholder={form.targetType === 'timeRange' ? '2024-01-01/2024-12-31' : '输入对应ID'}
                />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">保留原因 *</label>
                <textarea
                  className="flex w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-border-focus)] min-h-[80px] resize-y"
                  value={form.reason}
                  onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                  placeholder="输入保留原因"
                />
              </div>
              <Button
                onClick={() => createMut.mutate()}
                loading={createMut.isPending}
                disabled={!form.targetValue || !form.reason}
              >
                创建
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <DataTable<LegalHold>
        columns={[
          ...columns,
          {
            key: 'id' as keyof LegalHold & string,
            label: '操作',
            width: '100px',
            render: (_v, row) =>
              row.status !== 'released' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={releaseMut.isPending}
                  onClick={() => releaseMut.mutate(row.id)}
                >
                  释放
                </Button>
              ) : null,
          },
        ]}
        data={data ?? []}
        loading={isLoading}
        emptyMessage="暂无法律保留记录"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 3: 导出管理
   ═══════════════════════════════════════════════════════════════════ */
function ExportsTab() {
  const qc = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState({ format: 'json', dateFrom: '', dateTo: '', action: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['/governance/audit/exports'],
    queryFn: async () => {
      const res = await apiFetch('/governance/audit/exports');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      return (json.exports ?? json.items ?? json.data ?? []) as ExportTask[];
    },
  });

  const createMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, string> = { format: form.format };
      if (form.dateFrom) body.dateFrom = form.dateFrom;
      if (form.dateTo) body.dateTo = form.dateTo;
      if (form.action) body.action = form.action;
      const res = await apiFetch('/governance/audit/exports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`创建失败: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/governance/audit/exports'] });
      setSheetOpen(false);
      setForm({ format: 'json', dateFrom: '', dateTo: '', action: '' });
    },
  });

  const downloadExport = async (exportId: string) => {
    const res = await apiFetch(`/governance/audit/exports/${encodeURIComponent(exportId)}`);
    if (!res.ok) return;
    const json = await res.json();
    if (json.downloadUrl) {
      window.open(json.downloadUrl, '_blank');
    }
  };

  const columns: ColumnDef<ExportTask>[] = [
    { key: 'id', label: '导出ID', render: (v) => truncate(v, 12) },
    { key: 'status', label: '状态', width: '120px', render: (v) => <StatusBadge status={v as string} /> },
    { key: 'format', label: '格式' },
    { key: 'createdAt', label: '创建时间', hiddenOnMobile: true, render: (v) => fmtDate(v) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4 mr-1" />创建导出</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>创建审计导出</SheetTitle>
              <SheetDescription>导出审计日志为 JSON 或 CSV 格式</SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">导出格式</label>
                <Select value={form.format} onValueChange={v => setForm(f => ({ ...f, format: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="csv">CSV</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">开始日期</label>
                <Input
                  type="date"
                  value={form.dateFrom}
                  onChange={e => setForm(f => ({ ...f, dateFrom: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">结束日期</label>
                <Input
                  type="date"
                  value={form.dateTo}
                  onChange={e => setForm(f => ({ ...f, dateTo: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">过滤操作类型</label>
                <Select value={form.action || '__none__'} onValueChange={v => setForm(f => ({ ...f, action: v === '__none__' ? '' : v }))}>
                  <SelectTrigger><SelectValue placeholder="不限" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不限</SelectItem>
                    <SelectItem value="create">创建</SelectItem>
                    <SelectItem value="update">更新</SelectItem>
                    <SelectItem value="delete">删除</SelectItem>
                    <SelectItem value="read">读取</SelectItem>
                    <SelectItem value="execute">执行</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={() => createMut.mutate()} loading={createMut.isPending}>
                创建导出
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <DataTable<ExportTask>
        columns={[
          ...columns,
          {
            key: 'id' as keyof ExportTask & string,
            label: '操作',
            width: '100px',
            render: (_v, row) =>
              row.status === 'done' ? (
                <Button variant="ghost" size="sm" onClick={() => downloadExport(row.id)}>
                  <Download className="h-3.5 w-3.5 mr-1" />下载
                </Button>
              ) : null,
          },
        ]}
        data={data ?? []}
        loading={isLoading}
        emptyMessage="暂无导出任务"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Tab 4: SIEM 对接
   ═══════════════════════════════════════════════════════════════════ */
function SiemTab() {
  const qc = useQueryClient();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', type: 'splunk', endpoint: '', credentials: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['/governance/audit/siem-destinations'],
    queryFn: async () => {
      const res = await apiFetch('/governance/audit/siem-destinations');
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const json = await res.json();
      return (json.destinations ?? json.items ?? json.data ?? []) as SiemDestination[];
    },
  });

  const saveMut = useMutation({
    mutationFn: async () => {
      const url = editingId
        ? `/governance/audit/siem-destinations`
        : '/governance/audit/siem-destinations';
      const method = editingId ? 'PUT' : 'POST';
      const body = editingId ? { ...form, id: editingId } : form;
      const res = await apiFetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`保存失败: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/governance/audit/siem-destinations'] });
      setSheetOpen(false);
      setEditingId(null);
      setForm({ name: '', type: 'splunk', endpoint: '', credentials: '' });
    },
  });

  const testMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/governance/audit/siem-destinations/${encodeURIComponent(id)}/test`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`测试失败: ${res.status}`);
    },
  });

  const backfillMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/governance/audit/siem-destinations/${encodeURIComponent(id)}/backfill`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`回填失败: ${res.status}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/governance/audit/siem-destinations'] });
    },
  });

  const openEdit = (row: SiemDestination) => {
    setEditingId(row.id);
    setForm({
      name: row.name ?? '',
      type: row.type ?? 'splunk',
      endpoint: row.endpoint ?? '',
      credentials: '',
    });
    setSheetOpen(true);
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ name: '', type: 'splunk', endpoint: '', credentials: '' });
    setSheetOpen(true);
  };

  const columns: ColumnDef<SiemDestination>[] = [
    { key: 'name', label: '名称', sortable: true },
    { key: 'type', label: '类型' },
    { key: 'endpoint', label: '端点URL', hiddenOnMobile: true, render: (v) => truncate(v, 30) },
    { key: 'status', label: '状态', width: '100px', render: (v) => <StatusBadge status={v as string} /> },
    { key: 'lastSyncAt', label: '最后同步', hiddenOnMobile: true, render: (v) => fmtDate(v) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button size="sm" onClick={openCreate}><Plus className="h-4 w-4 mr-1" />新增目的地</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{editingId ? '编辑 SIEM 目的地' : '新增 SIEM 目的地'}</SheetTitle>
              <SheetDescription>配置将审计日志转发到外部 SIEM 系统</SheetDescription>
            </SheetHeader>
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">名称 *</label>
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="生产环境 Splunk"
                />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">类型</label>
                <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="splunk">Splunk</SelectItem>
                    <SelectItem value="elasticsearch">Elasticsearch</SelectItem>
                    <SelectItem value="webhook">Webhook</SelectItem>
                    <SelectItem value="datadog">Datadog</SelectItem>
                    <SelectItem value="sentinel">Azure Sentinel</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">端点 URL *</label>
                <Input
                  value={form.endpoint}
                  onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))}
                  placeholder="https://splunk.example.com:8088/services/collector"
                />
              </div>
              <div>
                <label className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)] mb-1 block">认证信息</label>
                <Input
                  type="password"
                  value={form.credentials}
                  onChange={e => setForm(f => ({ ...f, credentials: e.target.value }))}
                  placeholder="Token / API Key"
                />
              </div>
              <Button
                onClick={() => saveMut.mutate()}
                loading={saveMut.isPending}
                disabled={!form.name || !form.endpoint}
              >
                {editingId ? '保存' : '创建'}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>

      <DataTable<SiemDestination>
        columns={[
          ...columns,
          {
            key: 'id' as keyof SiemDestination & string,
            label: '操作',
            width: '200px',
            render: (_v, row) => (
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
                  编辑
                </Button>
                <Button variant="ghost" size="sm" loading={testMut.isPending} onClick={() => testMut.mutate(row.id)}>
                  测试
                </Button>
                <Button variant="ghost" size="sm" loading={backfillMut.isPending} onClick={() => backfillMut.mutate(row.id)}>
                  回填
                </Button>
              </div>
            ),
          },
        ]}
        data={data ?? []}
        loading={isLoading}
        emptyMessage="暂无 SIEM 目的地"
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   Page
   ═══════════════════════════════════════════════════════════════════ */
export default function AuditPage() {
  return (
    <div className="bg-[var(--color-surface)] min-h-full">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        <h1 className="text-2xl font-semibold text-[var(--color-text)]">审计管理</h1>

        <Tabs defaultValue="logs">
          <TabsList>
            <TabsTrigger value="logs"><FileText className="h-4 w-4 mr-1.5" />审计日志</TabsTrigger>
            <TabsTrigger value="holds"><Shield className="h-4 w-4 mr-1.5" />法律保留</TabsTrigger>
            <TabsTrigger value="exports"><Download className="h-4 w-4 mr-1.5" />导出管理</TabsTrigger>
            <TabsTrigger value="siem"><Play className="h-4 w-4 mr-1.5" />SIEM 对接</TabsTrigger>
          </TabsList>

          <TabsContent value="logs">
            <AuditLogTab />
          </TabsContent>
          <TabsContent value="holds">
            <LegalHoldsTab />
          </TabsContent>
          <TabsContent value="exports">
            <ExportsTab />
          </TabsContent>
          <TabsContent value="siem">
            <SiemTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
