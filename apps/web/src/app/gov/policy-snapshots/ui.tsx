"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, Table, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";

type Cursor = { createdAt: string; snapshotId: string };
type PolicySnapshotRow = {
  snapshotId: string;
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  resourceType: string;
  action: string;
  decision: "allow" | "deny";
  reason: string | null;
  rowFilters: unknown;
  fieldRules: unknown;
  createdAt: string;
};
type ListResponse = ApiError & { items?: PolicySnapshotRow[]; nextCursor?: Cursor };

function normalizeCursor(value: unknown): Cursor | undefined {
  const record = toRecord(value);
  if (!record) return undefined;
  const createdAt = toDisplayText(record.createdAt);
  const snapshotId = toDisplayText(record.snapshotId);
  if (!createdAt || !snapshotId) return undefined;
  return { createdAt, snapshotId };
}

function normalizeRow(value: unknown): PolicySnapshotRow | null {
  const record = toRecord(value);
  if (!record) return null;
  const snapshotId = toDisplayText(record.snapshotId);
  if (!snapshotId) return null;
  return {
    snapshotId,
    tenantId: toDisplayText(record.tenantId),
    spaceId: record.spaceId == null ? null : toDisplayText(record.spaceId),
    subjectId: toDisplayText(record.subjectId),
    resourceType: toDisplayText(record.resourceType),
    action: toDisplayText(record.action),
    decision: toDisplayText(record.decision) === "deny" ? "deny" : "allow",
    reason: record.reason == null ? null : toDisplayText(record.reason),
    rowFilters: record.rowFilters ?? null,
    fieldRules: record.fieldRules ?? null,
    createdAt: toDisplayText(record.createdAt),
  };
}

function normalizeListResponse(value: unknown): ListResponse | null {
  const record = toRecord(value);
  if (!record) return null;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    items: Array.isArray(record.items) ? record.items.map(normalizeRow).filter((item): item is PolicySnapshotRow => Boolean(item)) : undefined,
    nextCursor: normalizeCursor(record.nextCursor),
  };
}

export default function GovPolicySnapshotsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ListResponse | null>(normalizeListResponse(props.initial));
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [scope, setScope] = useState<"space" | "tenant">("space");
  const [subjectId, setSubjectId] = useState<string>("");
  const [resourceType, setResourceType] = useState<string>("");
  const [action, setAction] = useState<string>("");
  const [decision, setDecision] = useState<"" | "allow" | "deny">("");
  const [limit, setLimit] = useState<string>("50");

  const items = useMemo(() => (Array.isArray(data?.items) ? (data!.items as PolicySnapshotRow[]) : []), [data]);
  const nextCursor = data?.nextCursor;

  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = useMemo(() => items.slice(page * pageSize, (page + 1) * pageSize), [items, page]);

  async function fetchList(params: { append: boolean; cursor?: Cursor }) {
    setError("");
    setBusy(true);
    setPage(0);
    try {
      const q = new URLSearchParams();
      if (scope) q.set("scope", scope);
      if (subjectId.trim()) q.set("subjectId", subjectId.trim());
      if (resourceType.trim()) q.set("resourceType", resourceType.trim());
      if (action.trim()) q.set("action", action.trim());
      if (decision) q.set("decision", decision);
      const n = Number(limit);
      q.set("limit", String(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50));
      if (params.cursor?.createdAt && params.cursor?.snapshotId) {
        q.set("cursorCreatedAt", params.cursor.createdAt);
        q.set("cursorSnapshotId", params.cursor.snapshotId);
      }

      const res = await apiFetch(`/governance/policy/snapshots?${q.toString()}`, {
        locale: props.locale,
        cache: "no-store",
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = normalizeListResponse(json) ?? {};
      if (!params.append) {
        setData(out);
      } else {
        const prev = items;
        const merged = [...prev, ...(Array.isArray(out.items) ? out.items : [])];
        setData({ ...out, items: merged });
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.policySnapshots.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={() => fetchList({ append: false })} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshots.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.scope")}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                <option value="space">{t(props.locale, "gov.policySnapshots.scopeSpace")}</option>
                <option value="tenant">{t(props.locale, "gov.policySnapshots.scopeTenant")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.subjectId")}</span>
              <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.resourceType")}</span>
              <input value={resourceType} onChange={(e) => setResourceType(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.action")}</span>
              <input value={action} onChange={(e) => setAction(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.decision")}</span>
              <select
                value={decision}
                onChange={(e) => setDecision(e.target.value === "allow" ? "allow" : e.target.value === "deny" ? "deny" : "")}
                disabled={busy}
              >
                <option value="">{t(props.locale, "gov.policySnapshots.decisionAll")}</option>
                <option value="allow">{t(props.locale, "gov.policySnapshots.decisionAllow")}</option>
                <option value="deny">{t(props.locale, "gov.policySnapshots.decisionDeny")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.policySnapshots.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} disabled={busy} style={{ width: 80 }} />
            </label>
            <button onClick={() => fetchList({ append: false })} disabled={busy}>
              {t(props.locale, "gov.policySnapshots.search")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshots.listTitle")}>
          <Table
            header={
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div>
                  {t(props.locale, "gov.policySnapshots.count")}: {items.length}
                </div>
                <button onClick={() => fetchList({ append: true, cursor: nextCursor })} disabled={busy || !nextCursor}>
                  {t(props.locale, "gov.policySnapshots.loadMore")}
                </button>
              </div>
            }
          >
            <thead>
              <tr>
                <th>{t(props.locale, "gov.policySnapshots.createdAt")}</th>
                <th>{t(props.locale, "gov.policySnapshots.decision")}</th>
                <th>{t(props.locale, "gov.policySnapshots.resourceType")}</th>
                <th>{t(props.locale, "gov.policySnapshots.action")}</th>
                <th>{t(props.locale, "gov.policySnapshots.subjectId")}</th>
                <th>{t(props.locale, "gov.policySnapshots.spaceId")}</th>
                <th>{t(props.locale, "gov.policySnapshots.snapshotId")}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : paged.map((r) => {
                const snapshotIdText = toDisplayText(r.snapshotId);
                const href = `/gov/policy-snapshots/${encodeURIComponent(snapshotIdText)}?lang=${encodeURIComponent(props.locale)}`;
                return (
                  <tr key={snapshotIdText}>
                    <td>{fmtDateTime(r.createdAt, props.locale)}</td>
                    <td>
                      <Badge>{toDisplayText(r.decision)}</Badge>
                    </td>
                    <td>{toDisplayText(r.resourceType)}</td>
                    <td>{toDisplayText(r.action)}</td>
                    <td>{toDisplayText(r.subjectId)}</td>
                    <td>{toDisplayText(r.spaceId)}</td>
                    <td>
                      <a href={href}>{snapshotIdText}</a>
                    </td>
                  </tr>
                );
              })}
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
        </Card>
      </div>
    </div>
  );
}
