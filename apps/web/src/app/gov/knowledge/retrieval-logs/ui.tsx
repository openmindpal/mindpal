"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type RetrievalLogRow = {
  id: string;
  createdAt: unknown;
  candidateCount: number;
  returnedCount: number | null;
  degraded: boolean;
  rankPolicy: string | null;
};
type RetrievalLogsResp = ApiError & { logs?: RetrievalLogRow[] };

type InitialData = { status: number; json: unknown };

export default function RetrievalLogsClient(props: { locale: string; initial?: InitialData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number>(props.initial?.status ?? 0);
  const [data, setData] = useState<RetrievalLogsResp | null>((props.initial?.json as RetrievalLogsResp) ?? null);

  const [rankPolicy, setRankPolicy] = useState("");
  const [degraded, setDegraded] = useState<"" | "true" | "false">("");
  const [limit, setLimit] = useState("50");
  const [offset, setOffset] = useState("0");

  const rows = useMemo(() => (Array.isArray(data?.logs) ? data!.logs! : []), [data]);

  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const paged = useMemo(() => rows.slice(page * pageSize, (page + 1) * pageSize), [rows, page]);

  async function refresh() {
    setError("");
    setBusy(true);
    setPage(0);
    try {
      const q = new URLSearchParams();
      const nLimit = Number(limit);
      const nOffset = Number(offset);
      if (Number.isFinite(nLimit) && nLimit > 0) q.set("limit", String(nLimit));
      if (Number.isFinite(nOffset) && nOffset >= 0) q.set("offset", String(nOffset));
      if (rankPolicy.trim()) q.set("rankPolicy", rankPolicy.trim());
      if (degraded) q.set("degraded", degraded);
      const res = await apiFetch(`/governance/knowledge/retrieval-logs?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData((json as RetrievalLogsResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={String(t(props.locale, "gov.nav.knowledgeLogs"))}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={status || 0} />
            <button disabled={busy} onClick={refresh}>
              {busy ? String(t(props.locale, "action.loading")) : String(t(props.locale, "action.refresh"))}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={String(t(props.locale, "gov.changesets.filterTitle"))}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{String(t(props.locale, "gov.retrievalLogs.rankPolicy"))}</span>
            <input value={rankPolicy} onChange={(e) => setRankPolicy(e.target.value)} style={{ width: 260 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{String(t(props.locale, "gov.retrievalLogs.degraded"))}</span>
            <select value={degraded} onChange={(e) => setDegraded(e.target.value === "true" ? "true" : e.target.value === "false" ? "false" : "")}>
              <option value="">all</option>
              <option value="false">false</option>
              <option value="true">true</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{String(t(props.locale, "gov.retrievalLogs.limit"))}</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{String(t(props.locale, "gov.retrievalLogs.offset"))}</span>
            <input value={offset} onChange={(e) => setOffset(e.target.value)} style={{ width: 90 }} />
          </label>
          <button disabled={busy} onClick={refresh}>
            {String(t(props.locale, "action.apply"))}
          </button>
        </div>
      </Card>

      <Table header={<span>{rows.length ? `${rows.length}` : "-"}</span>}>
        <thead>
          <tr>
            <th align="left">{String(t(props.locale, "gov.retrievalLogs.col.id"))}</th>
            <th align="left">{String(t(props.locale, "gov.retrievalLogs.col.createdAt"))}</th>
            <th align="left">{String(t(props.locale, "gov.retrievalLogs.col.candidateCount"))}</th>
            <th align="left">{String(t(props.locale, "gov.retrievalLogs.col.returnedCount"))}</th>
            <th align="left">{String(t(props.locale, "gov.retrievalLogs.col.degraded"))}</th>
            <th align="left">{String(t(props.locale, "gov.retrievalLogs.col.rankPolicy"))}</th>
            <th align="left">{String(t(props.locale, "gov.changesets.actions"))}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{String(t(props.locale, "widget.noData"))}</td></tr>
                ) : paged.map((r) => (
            <tr key={r.id}>
              <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{typeof r.id === 'object' ? JSON.stringify(r.id) : r.id}</td>
              <td>{fmtDateTime(r.createdAt, props.locale)}</td>
              <td>{String(r.candidateCount)}</td>
              <td>{r.returnedCount == null ? "-" : String(r.returnedCount)}</td>
              <td>{r.degraded ? <Badge>true</Badge> : <Badge>false</Badge>}</td>
              <td>{typeof r.rankPolicy === 'object' ? JSON.stringify(r.rankPolicy) : (r.rankPolicy ?? "-")}</td>
              <td>
                <Link href={`/gov/knowledge/retrieval-logs/${encodeURIComponent(String(r.id))}?lang=${encodeURIComponent(props.locale)}`}>{String(t(props.locale, "action.open"))}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
          <span style={{ opacity: 0.7, fontSize: 13 }}>
            {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(Math.min((page + 1) * pageSize, rows.length)))}
            {t(props.locale, "pagination.total").replace("{count}", String(rows.length))}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
            <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(page + 1))}</span>
            <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
          </div>
        </div>
      )}
    </div>
  );
}
