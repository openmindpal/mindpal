"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";

type ExplainView = ApiError & {
  snapshotId?: string;
  tenantId?: string;
  spaceId?: string | null;
  resourceType?: string;
  action?: string;
  decision?: string;
  reason?: string | null;
  matchedRules?: unknown;
  rowFilters?: unknown;
  fieldRules?: unknown;
  createdAt?: string;
};

function normalizeExplainView(value: unknown): ExplainView | null {
  const record = toRecord(value);
  if (!record) return null;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    snapshotId: toDisplayText(record.snapshotId),
    tenantId: toDisplayText(record.tenantId),
    spaceId: record.spaceId == null ? null : toDisplayText(record.spaceId),
    resourceType: toDisplayText(record.resourceType),
    action: toDisplayText(record.action),
    decision: toDisplayText(record.decision),
    reason: record.reason == null ? null : toDisplayText(record.reason),
    matchedRules: record.matchedRules ?? null,
    rowFilters: record.rowFilters ?? null,
    fieldRules: record.fieldRules ?? null,
    createdAt: toDisplayText(record.createdAt),
  };
}

function jsonBlock(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default function GovPolicySnapshotDetailClient(props: { locale: string; snapshotId: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<ExplainView | null>(normalizeExplainView(props.initial));
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  async function refresh() {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/policy/snapshots/${encodeURIComponent(props.snapshotId)}/explain`, {
        locale: props.locale,
        cache: "no-store",
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      const normalized = normalizeExplainView(json);
      setData(normalized);
      if (!res.ok) setError(errText(props.locale, normalized ?? { errorCode: String(res.status) }));
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

  async function copy(textVal: string) {
    try {
      await navigator.clipboard.writeText(textVal);
    } catch {}
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.policySnapshotDetail.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
            <a href={`/gov/policy-snapshots?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.back")}</a>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshotDetail.metaTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.snapshotId")}</b>: {toDisplayText(data?.snapshotId ?? props.snapshotId)}{" "}
              <button onClick={() => copy(toDisplayText(data?.snapshotId ?? props.snapshotId))} disabled={busy}>
                {t(props.locale, "action.copy")}
              </button>
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.createdAt")}</b>: {fmtDateTime(data?.createdAt, props.locale)}
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.resourceType")}</b>: {toDisplayText(data?.resourceType)}
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.action")}</b>: {toDisplayText(data?.action)}
            </div>
            <div>
              <b>tenantId</b>: {toDisplayText(data?.tenantId)}
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.spaceId")}</b>: {toDisplayText(data?.spaceId)}
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshotDetail.decisionTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div>
              <b>{t(props.locale, "gov.policySnapshots.decision")}</b>: <Badge>{toDisplayText(data?.decision)}</Badge>
            </div>
            <div>
              <b>{t(props.locale, "gov.policySnapshotDetail.reason")}</b>: {data?.reason ? toDisplayText(data.reason) : ""}
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.policySnapshotDetail.rulesTitle")}>
          <details open>
            <summary>{t(props.locale, "gov.policySnapshotDetail.matchedRules")}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{jsonBlock(data?.matchedRules ?? null)}</pre>
          </details>
          <details>
            <summary>{t(props.locale, "gov.policySnapshotDetail.fieldRules")}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{jsonBlock(data?.fieldRules ?? null)}</pre>
          </details>
          <details>
            <summary>{t(props.locale, "gov.policySnapshotDetail.rowFilters")}</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{jsonBlock(data?.rowFilters ?? null)}</pre>
          </details>
        </Card>
      </div>
    </div>
  );
}

