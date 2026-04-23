"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { type ApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table, StatusBadge, EmptyState } from "@/components/ui";
import type { BadgeTone } from "@/components/ui";

type ApprovalRow = {
  approvalId?: unknown;
  status?: unknown;
  runId?: unknown;
  createdAt?: unknown;
  requestedAt?: unknown;
  toolRef?: unknown;
  requestedBySubjectId?: unknown;
};
type ApprovalsResponse = ApiError & { items?: ApprovalRow[] };

function safeStr(v: unknown, fallback = "-"): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function shortId(v: unknown): string {
  const s = safeStr(v, "");
  if (!s) return "-";
  return s.length > 8 ? s.slice(0, 8) + "…" : s;
}

function statusLabel(locale: string, raw: unknown): string {
  const s = safeStr(raw, "").toLowerCase();
  if (s === "pending") return t(locale, "gov.approvals.status.pending");
  if (s === "approved") return t(locale, "gov.approvals.status.approved");
  if (s === "rejected") return t(locale, "gov.approvals.status.rejected");
  return safeStr(raw);
}

function statusTone(raw: unknown): BadgeTone {
  const s = safeStr(raw, "").toLowerCase();
  if (s === "pending") return "warning";
  if (s === "approved") return "success";
  if (s === "rejected") return "danger";
  return "neutral";
}

function fmtToolRef(v: unknown): string {
  const s = safeStr(v, "");
  if (!s) return "-";
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

const STATUS_OPTIONS = [
  { value: "", labelKey: "gov.approvals.status.all" },
  { value: "pending", labelKey: "gov.approvals.status.pending" },
  { value: "approved", labelKey: "gov.approvals.status.approved" },
  { value: "rejected", labelKey: "gov.approvals.status.rejected" },
];

export default function ApprovalsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ApprovalsResponse | null>((props.initial as ApprovalsResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [qStatus, setQStatus] = useState<string>("");
  const [limit, setLimit] = useState<string>("50");
  const [error, setError] = useState<string>("");

  const items = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);
  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = useMemo(() => items.slice(page * pageSize, (page + 1) * pageSize), [items, page]);

  async function refresh() {
    setError("");
    setPage(0);
    const q = new URLSearchParams();
    if (qStatus.trim()) q.set("status", qStatus.trim());
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
    const res = await apiFetch(`/approvals?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ApprovalsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  const mono = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.approvals.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={refresh}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvals.filterTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.approvals.status")}</span>
              <select
                value={qStatus}
                onChange={(e) => setQStatus(e.target.value)}
                style={{ width: 160, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--sl-border, #d1d5db)" }}
              >
                {STATUS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {t(props.locale, opt.labelKey)}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.approvals.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 80, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--sl-border, #d1d5db)" }} />
            </label>
            <button onClick={refresh}>{t(props.locale, "action.apply")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.approvals.listTitle")}</span>
              <Badge>{items.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.approvals.col.approvalId")}</th>
              <th align="left">{t(props.locale, "gov.approvals.status")}</th>
              <th align="left">{t(props.locale, "gov.approvals.col.toolRef")}</th>
              <th align="left">{t(props.locale, "gov.approvals.col.runId")}</th>
              <th align="left">{t(props.locale, "gov.approvals.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.approvals.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState text={t(props.locale, "gov.approvals.emptyTitle")} />
                </td>
              </tr>
            ) : (
              paged.map((a, idx) => {
                const approvalId = safeStr(a.approvalId, "");
                return (
                  <tr key={`${approvalId}:${idx}`}>
                    <td style={{ fontFamily: mono }}>
                      <span title={approvalId}>{shortId(a.approvalId)}</span>
                    </td>
                    <td>
                      <Badge tone={statusTone(a.status)}>{statusLabel(props.locale, a.status)}</Badge>
                    </td>
                    <td>{fmtToolRef(a.toolRef)}</td>
                    <td style={{ fontFamily: mono }}>
                      <span title={safeStr(a.runId, "")}>{shortId(a.runId)}</span>
                    </td>
                    <td>{fmtDateTime(a.requestedAt ?? a.createdAt, props.locale)}</td>
                    <td>
                      {approvalId ? (
                        <Link
                          href={`/gov/approvals/${encodeURIComponent(approvalId)}?lang=${encodeURIComponent(props.locale)}`}
                          style={{ color: "var(--sl-accent, #2563eb)", textDecoration: "none", fontWeight: 500 }}
                        >
                          {t(props.locale, "action.open")}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </Table>
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(props.locale, "pagination.showing").replace("{from}", String(page * pageSize + 1)).replace("{to}", String(Math.min((page + 1) * pageSize, items.length)))}
              {t(props.locale, "pagination.total").replace("{count}", String(items.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(page + 1))}</span>
              <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
