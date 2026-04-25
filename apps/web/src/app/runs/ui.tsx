"use client";

import Link from "next/link";
import { useMemo, useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { t, statusLabel } from "@/lib/i18n";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

const STATUS_OPTIONS = ["running", "succeeded", "failed", "canceled", "queued", "pending", "created", "compensating", "needs_approval", "paused"] as const;

type RunRow = Record<string, unknown>;
type RunsListResponse = ApiError & { runs?: RunRow[] };

function pickStr(v: unknown) {
  return v != null ? String(v) : "";
}

function shortId(v: unknown) {
  const s = pickStr(v);
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function statusTone(s: string): "neutral" | "success" | "warning" | "danger" {
  if (s === "succeeded") return "success";
  if (s === "failed" || s === "canceled") return "danger";
  if (s === "running" || s === "queued" || s === "pending" || s === "created" || s === "compensating" || s === "needs_approval") return "warning";
  return "neutral";
}

function formatTime(v: unknown, locale: string) {
  const formatted = fmtDateTime(v, locale);
  if (formatted !== "—") return formatted;
  const s = pickStr(v);
  return s || "—";
}

export default function RunsClient(props: {
  locale: string;
  initial: unknown;
  initialStatus: number;
  initialQuery: { status?: string; updatedFrom?: string; updatedTo?: string; limit?: string };
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const initialRuns = (props.initial as RunsListResponse | null)?.runs;
  const [runs, setRuns] = useState<RunRow[]>(Array.isArray(initialRuns) ? initialRuns : []);

  const [status, setStatus] = useState<string>(props.initialQuery.status ?? "");
  const [updatedFrom, setUpdatedFrom] = useState<string>(props.initialQuery.updatedFrom ?? "");
  const [updatedTo, setUpdatedTo] = useState<string>(props.initialQuery.updatedTo ?? "");
  const [limit, setLimit] = useState<string>(props.initialQuery.limit ?? "20");
  const [page, setPage] = useState<number>(0);

  const pageSize = useMemo(() => { const n = Number(limit); return Number.isFinite(n) && n > 0 ? n : 20; }, [limit]);

  const runRows = useMemo(() => runs, [runs]);

  const load = useCallback(async function () {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      if (status.trim()) q.set("status", status.trim());
      if (updatedFrom.trim()) q.set("updatedFrom", updatedFrom.trim());
      if (updatedTo.trim()) q.set("updatedTo", updatedTo.trim());
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
      q.set("offset", String(page * pageSize));
      const res = await apiFetch(`/runs?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as RunsListResponse) ?? {};
      setRuns(Array.isArray(out.runs) ? out.runs : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [status, updatedFrom, updatedTo, limit, page, pageSize, props.locale]);

  /* Auto-reload when page changes (but skip initial render) */
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (!initialized) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- skip initial render, mark as initialized
      setInitialized(true); return;
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "runs.title")}
        description={error || undefined}
        actions={
          <button disabled={busy} onClick={load}>
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
            <button disabled={busy} onClick={load}>
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
