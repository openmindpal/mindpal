"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { pickStr, shortId, statusTone, formatTime } from "@/lib/taskUIUtils";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { usePaginatedList } from "@/hooks/usePaginatedList";

const STATUS_OPTIONS = ["running", "succeeded", "failed", "canceled", "queued", "pending", "created", "compensating", "needs_approval", "paused"] as const;

type RunRow = Record<string, unknown>;
type RunsListResponse = ApiError & { runs?: RunRow[] };

export default function RunsClient(props: {
  locale: string;
  initial: unknown;
  initialStatus: number;
  initialQuery: { status?: string; updatedFrom?: string; updatedTo?: string; limit?: string };
}) {
  const initialRuns = (props.initial as RunsListResponse | null)?.runs;

  const [status, setStatus] = useState<string>(props.initialQuery.status ?? "");
  const [updatedFrom, setUpdatedFrom] = useState<string>(props.initialQuery.updatedFrom ?? "");
  const [updatedTo, setUpdatedTo] = useState<string>(props.initialQuery.updatedTo ?? "");
  const [limit, setLimit] = useState<string>(props.initialQuery.limit ?? "20");

  const initialPageSize = useMemo(() => { const n = Number(limit); return Number.isFinite(n) && n > 0 ? n : 20; }, [limit]);

  const { data: runRows, page, setPage, pageSize, busy, error, refresh } = usePaginatedList<RunRow>({
    fetchFn: async ({ limit: lim, offset }) => {
      const q = new URLSearchParams();
      if (status.trim()) q.set("status", status.trim());
      if (updatedFrom.trim()) q.set("updatedFrom", updatedFrom.trim());
      if (updatedTo.trim()) q.set("updatedTo", updatedTo.trim());
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
      q.set("offset", String(offset));
      const res = await apiFetch(`/runs?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new Error(errText(props.locale, toApiError(json)));
      const out = (json as RunsListResponse) ?? {};
      return Array.isArray(out.runs) ? out.runs : [];
    },
    pageSize: initialPageSize,
    initialData: Array.isArray(initialRuns) ? initialRuns : [],
  });

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "runs.title")}
        description={error || undefined}
        actions={
          <button disabled={busy} onClick={refresh}>
            {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
          </button>
        }
      />

      <Card title={t(props.locale, "runs.filters.title")}>
        <div style={{ display: "grid", gap: 12 }}>
          <label>
            {t(props.locale, "runs.filters.status")}
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t(props.locale, "runs.filters.statusAll")}</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusLabel(s, props.locale)}</option>)}
            </select>
          </label>
          <label>
            {t(props.locale, "runs.filters.updatedFrom")}
            <input type="datetime-local" value={updatedFrom} onChange={(e) => setUpdatedFrom(e.target.value)} />
          </label>
          <label>
            {t(props.locale, "runs.filters.updatedTo")}
            <input type="datetime-local" value={updatedTo} onChange={(e) => setUpdatedTo(e.target.value)} />
          </label>
          <label>
            {t(props.locale, "runs.filters.limit")}
            <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="20" />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <button disabled={busy} onClick={refresh}>
              {t(props.locale, "action.load")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t(props.locale, "runs.list.title")}>
        <Table>
          <thead>
            <tr>
              <th>{t(props.locale, "runs.table.runId")}</th>
              <th>{t(props.locale, "runs.table.toolRef")}</th>
              <th>{t(props.locale, "runs.table.trigger")}</th>
              <th>{t(props.locale, "runs.table.status")}</th>
              <th>{t(props.locale, "runs.table.createdAt")}</th>
              <th>{t(props.locale, "runs.table.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {runRows.map((r, idx) => {
              const runId = pickStr(r.runId);
              const href = `/runs/${encodeURIComponent(runId)}?lang=${encodeURIComponent(props.locale)}`;
              return (
                <tr key={`${runId}:${idx}`}>
                  <td>
                    <Link href={href} title={runId}>{shortId(runId)}</Link>
                  </td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{pickStr(r.toolRef) || "-"}</td>
                  <td>{pickStr(r.trigger) || "-"}</td>
                  <td>
                    <Badge tone={statusTone(pickStr(r.status))}>{statusLabel(pickStr(r.status), props.locale) || "-"}</Badge>
                  </td>
                  <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{formatTime(r.createdAt, props.locale)}</td>
                  <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{formatTime(r.updatedAt, props.locale)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(page * pageSize + runRows.length))}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={busy || page === 0} onClick={() => { setPage((p) => Math.max(0, p - 1)); }}>{t(props.locale, "pagination.prev")}</button>
            <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(page + 1))}</span>
            <button disabled={busy || runRows.length < pageSize} onClick={() => { setPage((p) => p + 1); }}>{t(props.locale, "pagination.next")}</button>
          </div>
        </div>
      </Card>
    </div>
  );
}
