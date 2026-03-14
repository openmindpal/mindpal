"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ApprovalRow = { approvalId?: string; status?: string; runId?: string; createdAt?: string };
type ApprovalsResponse = ApiError & { items?: ApprovalRow[] };

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export default function ApprovalsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ApprovalsResponse | null>((props.initial as ApprovalsResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [qStatus, setQStatus] = useState<string>("");
  const [limit, setLimit] = useState<string>("50");
  const [error, setError] = useState<string>("");

  const items = useMemo(() => (Array.isArray(data?.items) ? data!.items! : []), [data]);

  async function refresh() {
    setError("");
    const q = new URLSearchParams();
    if (qStatus.trim()) q.set("status", qStatus.trim());
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
    const res = await fetch(`${API_BASE}/approvals?${q.toString()}`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ApprovalsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.approvals.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.approvals.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.approvals.status")}</span>
              <input value={qStatus} onChange={(e) => setQStatus(e.target.value)} style={{ width: 160 }} placeholder={t(props.locale, "gov.approvals.statusPlaceholder")} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.approvals.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 100 }} />
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
              <th align="left">approvalId</th>
              <th align="left">{t(props.locale, "gov.approvals.status")}</th>
              <th align="left">runId</th>
              <th align="left">{t(props.locale, "gov.approvals.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.approvals.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a, idx) => {
              const approvalId = a.approvalId ?? "";
              return (
                <tr key={`${approvalId}:${idx}`}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{approvalId || "-"}</td>
                  <td>{a.status ?? "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{a.runId ?? "-"}</td>
                  <td>{a.createdAt ?? "-"}</td>
                  <td>
                    {approvalId ? (
                      <Link href={`/gov/approvals/${encodeURIComponent(approvalId)}?lang=${encodeURIComponent(props.locale)}`}>
                        {t(props.locale, "action.open")}
                      </Link>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

