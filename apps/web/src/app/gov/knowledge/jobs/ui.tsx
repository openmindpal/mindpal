"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StructuredData } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";

type JobRow = { id: string; status: string; attempt: string; updatedAt: unknown; raw: unknown };
type JobsResp = ApiError & { jobs?: JobRow[] };

type InitialData = { status: number; json: unknown };

function normalizeJobsResp(value: unknown): JobsResp | null {
  const record = toRecord(value);
  if (!record) return null;
  const jobs = Array.isArray(record.jobs)
    ? record.jobs.reduce<JobRow[]>((acc, item, index) => {
        const row = toRecord(item);
        acc.push({
          id: row ? toDisplayText(row.id ?? index) : String(index),
          status: row ? toDisplayText(row.status ?? "-") : "-",
          attempt: row ? toDisplayText(row.attempt ?? "-") : "-",
          updatedAt: row?.updatedAt ?? null,
          raw: item,
        });
        return acc;
      }, [])
    : undefined;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    jobs,
  };
}

export default function KnowledgeJobsClient(props: { locale: string; initial?: InitialData }) {
  const [kind, setKind] = useState<"index" | "embedding" | "ingest">("index");
  const [statusFilter, setStatusFilter] = useState("");
  const [limit, setLimit] = useState("50");
  const [offset, setOffset] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [httpStatus, setHttpStatus] = useState<number>(props.initial?.status ?? 0);
  const [data, setData] = useState<JobsResp | null>(normalizeJobsResp(props.initial?.json));

  const rows = useMemo(() => (Array.isArray(data?.jobs) ? data!.jobs! : []), [data]);

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const q = new URLSearchParams();
      const nLimit = Number(limit);
      const nOffset = Number(offset);
      if (Number.isFinite(nLimit) && nLimit > 0) q.set("limit", String(nLimit));
      if (Number.isFinite(nOffset) && nOffset >= 0) q.set("offset", String(nOffset));
      if (statusFilter.trim()) q.set("status", statusFilter.trim());

      const path =
        kind === "index"
          ? `/governance/knowledge/index-jobs?${q.toString()}`
          : kind === "embedding"
            ? `/governance/knowledge/embedding-jobs?${q.toString()}`
            : `/governance/knowledge/ingest-jobs?${q.toString()}`;
      const res = await apiFetch(path, { locale: props.locale, cache: "no-store" });
      setHttpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData(normalizeJobsResp(json));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.knowledgeJobs")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Badge>{httpStatus || "-"}</Badge>
            <button disabled={busy} onClick={refresh}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.changesets.filterTitle")}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.kind")}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value === "embedding" ? "embedding" : e.target.value === "ingest" ? "ingest" : "index")}>
              <option value="index">index</option>
              <option value="embedding">embedding</option>
              <option value="ingest">ingest</option>
            </select>
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.status")}</span>
            <input value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ width: 180 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.limit")}</span>
            <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90 }} />
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span>{t(props.locale, "gov.knowledgeJobs.offset")}</span>
            <input value={offset} onChange={(e) => setOffset(e.target.value)} style={{ width: 90 }} />
          </label>
          <button disabled={busy} onClick={refresh}>
            {t(props.locale, "action.apply")}
          </button>
        </div>
      </Card>

      <Card title={t(props.locale, "gov.knowledgeJobs.jobsTitle")}>
        <Table header={<span>{rows.length ? `${rows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.id")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.status")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.attempt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.updatedAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeJobs.table.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : rows.map((r) => {
              return (
                <tr key={r.id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.id}</td>
                  <td>{r.status}</td>
                  <td>{r.attempt}</td>
                  <td>{fmtDateTime(r.updatedAt, props.locale)}</td>
                  <td>
                    <details>
                      <summary>{t(props.locale, "gov.knowledgeJobs.json")}</summary>
                      <StructuredData data={r.raw} />
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}
