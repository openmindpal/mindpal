"use client";

import Link from "next/link";
import { useMemo, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { shortId, statusTone } from "@/lib/taskUIUtils";
import { friendlyToolName } from "@/app/homeHelpers";
import TaskDetailDrawer from "@/components/task/TaskDetailDrawer";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { usePaginatedList } from "@/hooks/usePaginatedList";

type LongTaskItem = {
  task: { taskId: string; title: string | null; status: string; createdAt: string; updatedAt: string };
  run: { runId: string; status: string; jobType: string | null; toolRef: string | null; traceId: string | null; startedAt: string | null; finishedAt: string | null; updatedAt: string | null } | null;
  progress: { phase: string | null };
  controls: { canCancel: boolean; canContinue: boolean; needsApproval: boolean };
};

type LongTasksResp = { longTasks?: LongTaskItem[] } & ApiError;

/* ── Status groups for filtering ── */
const STATUS_OPTIONS = ["executing", "queued", "running", "completed", "succeeded", "failed", "cancelled", "needs_approval"] as const;

function mergedStatus(it: LongTaskItem): string {
  return it.run?.status ?? it.progress.phase ?? it.task.status;
}

export default function TasksClient(props: { locale: string; initial: unknown; initialStatus: number; initialQuery: { scope?: string | null; limit?: string | null; offset?: string | null } }) {
  const locale = props.locale;

  const initialPageSize = useMemo(() => {
    const n = Number(props.initialQuery.limit);
    return Number.isFinite(n) && n > 0 ? n : 20;
  }, [props.initialQuery.limit]);

  const initialItems = useMemo(() => {
    const resp = props.initial as LongTasksResp | null;
    return Array.isArray(resp?.longTasks) ? resp!.longTasks! : [];
  }, [props.initial]);

  const initialError = useMemo(() => {
    if (props.initialStatus >= 400) return errText(locale, props.initial as ApiError);
    return "";
  }, [props.initial, locale, props.initialStatus]);

  const { data: items, page, setPage, pageSize, busy, error, setError, refresh } = usePaginatedList<LongTaskItem>({
    fetchFn: async ({ limit, offset }) => {
      const q = new URLSearchParams();
      if (props.initialQuery.scope) q.set("scope", props.initialQuery.scope);
      q.set("limit", String(limit));
      q.set("offset", String(offset));
      const res = await apiFetch(`/tasks/long-tasks?${q.toString()}`, { locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errText(locale, (json as ApiError) ?? { errorCode: String(res.status) }));
      const resp = (json as LongTasksResp) ?? {};
      return Array.isArray(resp.longTasks) ? resp.longTasks : [];
    },
    pageSize: initialPageSize,
    initialData: initialItems,
  });

  const [actionBusy, setActionBusy] = useState(false);
  const isBusy = busy || actionBusy;

  /* ── Search & filter state ── */
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");

  const filtered = useMemo(() => {
    let list = items;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((it) => (it.task.title ?? "").toLowerCase().includes(q) || it.task.taskId.toLowerCase().includes(q));
    }
    if (statusFilter) {
      list = list.filter((it) => mergedStatus(it) === statusFilter);
    }
    return list;
  }, [items, search, statusFilter]);

  /* ── Stats (aggregated from current page data) ── */
  const stats = useMemo(() => {
    let active = 0, queued = 0, completed = 0, failed = 0;
    for (const it of items) {
      const s = mergedStatus(it);
      if (s === "executing" || s === "running") active++;
      else if (s === "queued" || s === "pending" || s === "created") queued++;
      else if (s === "completed" || s === "succeeded") completed++;
      else if (s === "failed" || s === "cancelled" || s === "canceled" || s === "deadletter") failed++;
    }
    return { active, queued, completed, failed };
  }, [items]);

  /* ── Batch selection ── */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleOne = useCallback((id: string) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }), []);
  const toggleAll = useCallback(() => {
    setSelected((prev) => prev.size === filtered.length ? new Set() : new Set(filtered.map((it) => it.task.taskId)));
  }, [filtered]);

  /* ── Detail drawer ── */
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  /* ── Actions (unchanged logic) ── */
  async function runAction(fn: () => Promise<void>) {
    setError("");
    setActionBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(locale, toApiError(e)));
    } finally {
      setActionBusy(false);
    }
  }

  async function cancelRun(runId: string) {
    if (!confirm(t(locale, "tasks.confirmCancel"))) return;
    await runAction(async () => {
      const res = await apiFetch(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  async function continueAgentRun(taskId: string, runId: string) {
    await runAction(async () => {
      const res = await apiFetch(`/tasks/${encodeURIComponent(taskId)}/agent-runs/${encodeURIComponent(runId)}/continue`, {
        method: "POST",
        locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
    });
  }

  async function batchCancel() {
    if (!selected.size) return;
    const msg = t(locale, "tasks.batch.cancelN").replace("{n}", String(selected.size));
    if (!confirm(msg)) return;
    setActionBusy(true);
    setError("");
    try {
      for (const taskId of selected) {
        const it = items.find((x) => x.task.taskId === taskId);
        if (it?.run?.runId && it.controls.canCancel) {
          const res = await apiFetch(`/runs/${encodeURIComponent(it.run.runId)}/cancel`, { method: "POST", locale });
          if (!res.ok) { const json: unknown = await res.json().catch(() => null); throw toApiError(json); }
        }
      }
      setSelected(new Set());
      await refresh();
    } catch (e: unknown) {
      setError(errText(locale, toApiError(e)));
    } finally {
      setActionBusy(false);
    }
  }

  const statCards: { key: string; value: number; tone: "warning" | "neutral" | "success" | "danger" }[] = [
    { key: "tasks.stats.active", value: stats.active, tone: "warning" },
    { key: "tasks.stats.queued", value: stats.queued, tone: "neutral" },
    { key: "tasks.stats.completed", value: stats.completed, tone: "success" },
    { key: "tasks.stats.failed", value: stats.failed, tone: "danger" },
  ];

  return (
    <div>
      <PageHeader
        title={t(locale, "tasks.title")}
        actions={
          <>
            {selected.size > 0 && (
              <button onClick={batchCancel} disabled={isBusy}>
                {t(locale, "tasks.batch.cancelN").replace("{n}", String(selected.size))}
              </button>
            )}
            <button onClick={refresh} disabled={isBusy}>
              {t(locale, "action.refresh")}
            </button>
          </>
        }
      />

      {/* ── Stats summary ── */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        {statCards.map((c) => (
          <Card key={c.key} title={t(locale, c.key)}>
            <Badge tone={c.tone}>{c.value}</Badge>
          </Card>
        ))}
      </div>

      {/* ── Search + filter ── */}
      <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(locale, "tasks.search.placeholder")}
          style={{ padding: "4px 8px", minWidth: 200 }}
        />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t(locale, "tasks.filter.allStatus")}</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>{statusLabel(s, locale)}</option>
          ))}
        </select>
      </div>

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 8 }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginTop: 8 }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(locale, "tasks.listTitle")}>
          <Table>
            <thead>
              <tr>
                <th style={{ width: 32 }}><input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} onChange={toggleAll} /></th>
                <th align="left">{t(locale, "tasks.col.taskId")}</th>
                <th align="left">{t(locale, "tasks.col.title")}</th>
                <th align="left">{t(locale, "tasks.col.status")}</th>
                <th align="left">{t(locale, "tasks.col.tool")}</th>
                <th align="left">{t(locale, "tasks.col.run")}</th>
                <th align="left">{t(locale, "tasks.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => {
                const status = mergedStatus(it);
                return (
                  <tr key={it.task.taskId} onClick={() => { setSelectedTaskId(it.task.taskId); setSelectedRunId(it.run?.runId ?? null); }} style={{ cursor: "pointer" }}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(it.task.taskId)} onChange={() => toggleOne(it.task.taskId)} />
                    </td>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                      <Link href={`/tasks/${encodeURIComponent(it.task.taskId)}?lang=${encodeURIComponent(locale)}`} title={it.task.taskId} onClick={(e) => e.stopPropagation()}>{shortId(it.task.taskId)}</Link>
                    </td>
                    <td>{it.task.title ?? "-"}</td>
                    <td><Badge tone={statusTone(status)}>{statusLabel(status, locale)}</Badge></td>
                    <td>{it.run?.toolRef ? friendlyToolName(locale, it.run.toolRef) : "-"}</td>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                      {it.run?.runId ? <Link href={`/runs/${encodeURIComponent(it.run.runId)}?lang=${encodeURIComponent(locale)}`} title={it.run.runId} onClick={(e) => e.stopPropagation()}>{shortId(it.run.runId)}</Link> : "-"}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button onClick={() => it.run?.runId && cancelRun(it.run.runId)} disabled={isBusy || !it.controls.canCancel || !it.run?.runId}>
                          {t(locale, "action.cancel")}
                        </button>
                        <button
                          onClick={() => it.run?.runId && continueAgentRun(it.task.taskId, it.run.runId)}
                          disabled={isBusy || !it.controls.canContinue || !it.run?.runId}
                          title={it.run?.status === "needs_approval" ? t(locale, "tasks.tooltip.continueBlocked") : undefined}
                        >
                          {t(locale, "action.continue")}
                        </button>
                        <Link href={`/tasks/${encodeURIComponent(it.task.taskId)}?lang=${encodeURIComponent(locale)}`}>{t(locale, "tasks.col.detail")}</Link>
                        {it.controls.needsApproval ? <Badge>{t(locale, "tasks.badge.needsApproval")}</Badge> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(page * pageSize + items.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={isBusy || page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(locale, "pagination.page").replace("{page}", String(page + 1))}</span>
              <button disabled={isBusy || items.length < pageSize} onClick={() => setPage((p) => p + 1)}>{t(locale, "pagination.next")}</button>
            </div>
          </div>
        </Card>
      </div>

      {/* ── Detail drawer ── */}
      {selectedTaskId && (
        <TaskDetailDrawer
          taskId={selectedTaskId}
          runId={selectedRunId ?? undefined}
          locale={locale}
          onClose={() => { setSelectedTaskId(null); setSelectedRunId(null); }}
        />
      )}
    </div>
  );
}
