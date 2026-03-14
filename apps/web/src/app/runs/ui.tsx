"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RunRow = Record<string, unknown>;
type RunsListResponse = ApiError & { runs?: RunRow[] };

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function pickStr(v: unknown) {
  return v != null ? String(v) : "";
}

function shortId(v: unknown) {
  const s = pickStr(v);
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
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
  const [runsStatus, setRunsStatus] = useState<number>(props.initialStatus);

  const [status, setStatus] = useState<string>(props.initialQuery.status ?? "");
  const [updatedFrom, setUpdatedFrom] = useState<string>(props.initialQuery.updatedFrom ?? "");
  const [updatedTo, setUpdatedTo] = useState<string>(props.initialQuery.updatedTo ?? "");
  const [limit, setLimit] = useState<string>(props.initialQuery.limit ?? "20");

  const runRows = useMemo(() => runs, [runs]);

  async function load() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      if (status.trim()) q.set("status", status.trim());
      if (updatedFrom.trim()) q.set("updatedFrom", updatedFrom.trim());
      if (updatedTo.trim()) q.set("updatedTo", updatedTo.trim());
      const n = Number(limit);
      if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
      const res = await fetch(`${API_BASE}/runs?${q.toString()}`, { headers: apiHeaders(props.locale), cache: "no-store" });
      setRunsStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as RunsListResponse) ?? {};
      setRuns(Array.isArray(out.runs) ? out.runs : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

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
            <input value={status} onChange={(e) => setStatus(e.target.value)} placeholder={t(props.locale, "runs.filters.statusPlaceholder")} />
          </label>
          <label>
            {t(props.locale, "runs.filters.updatedFrom")}
            <input value={updatedFrom} onChange={(e) => setUpdatedFrom(e.target.value)} placeholder="2026-01-01T00:00:00Z" />
          </label>
          <label>
            {t(props.locale, "runs.filters.updatedTo")}
            <input value={updatedTo} onChange={(e) => setUpdatedTo(e.target.value)} placeholder="2026-01-31T23:59:59Z" />
          </label>
          <label>
            {t(props.locale, "runs.filters.limit")}
            <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="20" />
          </label>
          <div style={{ display: "flex", gap: 12 }}>
            <button disabled={busy} onClick={load}>
              {t(props.locale, "action.load")}
            </button>
            <span style={{ opacity: 0.75 }}>
              HTTP {runsStatus || "-"}
            </span>
          </div>
        </div>
      </Card>

      <Card title={t(props.locale, "runs.list.title")}>
        <Table>
          <thead>
            <tr>
              <th>{t(props.locale, "runs.table.runId")}</th>
              <th>{t(props.locale, "runs.table.status")}</th>
              <th>{t(props.locale, "runs.table.updatedAt")}</th>
              <th>{t(props.locale, "runs.table.traceId")}</th>
            </tr>
          </thead>
          <tbody>
            {runRows.map((r, idx) => {
              const runId = pickStr(r.runId);
              const href = `/runs/${encodeURIComponent(runId)}?lang=${encodeURIComponent(props.locale)}`;
              return (
                <tr key={`${runId}:${idx}`}>
                  <td>
                    <Link href={href}>{shortId(runId)}</Link>
                  </td>
                  <td>
                    <Badge>{pickStr(r.status) || "-"}</Badge>
                  </td>
                  <td>{pickStr(r.updatedAt) || "-"}</td>
                  <td>{pickStr(r.traceId) || "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
