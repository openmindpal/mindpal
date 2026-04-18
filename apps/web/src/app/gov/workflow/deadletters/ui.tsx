"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type DeadletterRow = {
  jobId?: unknown;
  runId?: unknown;
  stepId?: unknown;
  status?: unknown;
  attempt?: unknown;
  toolRef?: unknown;
  errorCategory?: unknown;
  lastErrorDigest?: unknown;
  deadletteredAt?: unknown;
  updatedAt?: unknown;
};
type DeadlettersResponse = ApiError & { deadletters?: DeadletterRow[] };

function safeStr(v: unknown, fallback = "-"): string {
  if (v == null) return fallback;
  if (typeof v === "string") return v || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

export default function DeadlettersClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<DeadlettersResponse | null>((props.initial as DeadlettersResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [toolRef, setToolRef] = useState<string>("");
  const [limit, setLimit] = useState<string>("50");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [selectedSteps, setSelectedSteps] = useState<Set<string>>(new Set());

  const items = useMemo(() => (Array.isArray(data?.deadletters) ? data!.deadletters! : []), [data]);

  /** Diagnose error category and return i18n key */
  function diagnoseError(errorCat: string): string {
    const cat = (errorCat || "").toLowerCase();
    if (cat.includes("timeout") || cat.includes("deadline")) return "gov.workflowDeadletters.diagnose.timeout";
    if (cat.includes("auth") || cat.includes("permission") || cat.includes("forbidden") || cat.includes("401") || cat.includes("403")) return "gov.workflowDeadletters.diagnose.auth";
    if (cat.includes("rate") || cat.includes("limit") || cat.includes("throttl") || cat.includes("429")) return "gov.workflowDeadletters.diagnose.rateLimit";
    if (cat.includes("valid") || cat.includes("param") || cat.includes("400")) return "gov.workflowDeadletters.diagnose.validation";
    if (cat.includes("not_found") || cat.includes("404") || cat.includes("missing")) return "gov.workflowDeadletters.diagnose.notFound";
    return "gov.workflowDeadletters.diagnose.unknown";
  }

  function toggleSelect(stepId: string) {
    setSelectedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId); else next.add(stepId);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedSteps.size === items.filter(d => safeStr(d.stepId, "")).length) {
      setSelectedSteps(new Set());
    } else {
      setSelectedSteps(new Set(items.map(d => safeStr(d.stepId, "")).filter(Boolean)));
    }
  }

  async function batchRetry() {
    if (!selectedSteps.size) return;
    if (!confirm(t(props.locale, "gov.workflowDeadletters.action.batchRetryConfirm").replace("{count}", String(selectedSteps.size)))) return;
    setError("");
    for (const stepId of selectedSteps) {
      setBusy(stepId);
      try {
        const res = await apiFetch(`/governance/workflow/deadletters/${encodeURIComponent(stepId)}/retry`, { method: "POST", locale: props.locale });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) throw toApiError(json);
      } catch (e: unknown) {
        setError(errText(props.locale, toApiError(e)));
        break;
      }
    }
    setBusy("");
    setSelectedSteps(new Set());
    await refresh();
  }

  async function refresh() {
    setError("");
    const q = new URLSearchParams();
    if (toolRef.trim()) q.set("toolRef", toolRef.trim());
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
    const res = await apiFetch(`/governance/workflow/deadletters?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as DeadlettersResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function retry(stepId: string) {
    setError("");
    setBusy(stepId);
    try {
      const res = await apiFetch(`/governance/workflow/deadletters/${encodeURIComponent(stepId)}/retry`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy("");
    }
  }

  async function cancel(stepId: string) {
    setError("");
    setBusy(stepId);
    try {
      const res = await apiFetch(`/governance/workflow/deadletters/${encodeURIComponent(stepId)}/cancel`, { method: "POST", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy("");
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.workflowDeadletters.title")}
        helpHref={getHelpHref("/gov/workflow/deadletters", props.locale) ?? undefined}
        description={t(props.locale, "gov.workflowDeadletters.subtitle")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <button onClick={refresh}>{t(props.locale, "action.refresh")}</button>
            {selectedSteps.size > 0 && (
              <button onClick={batchRetry} style={{ fontWeight: 600, background: "var(--sl-accent)", color: "#fff", border: "none", padding: "4px 12px", borderRadius: 6, cursor: "pointer" }}>
                {t(props.locale, "gov.workflowDeadletters.action.batchRetry")} ({selectedSteps.size})
              </button>
            )}
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.workflowDeadletters.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.workflowDeadletters.toolRef")}</span>
              <input value={toolRef} onChange={(e) => setToolRef(e.target.value)} style={{ width: 220 }} placeholder={t(props.locale, "gov.workflowDeadletters.toolRefPlaceholder")} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.workflowDeadletters.limit")}</span>
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
              <span>{t(props.locale, "gov.workflowDeadletters.listTitle")}</span>
              <Badge>{items.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left" style={{ width: 30 }}>
                <input type="checkbox" checked={selectedSteps.size > 0 && selectedSteps.size === items.filter(d => safeStr(d.stepId, "")).length} onChange={toggleSelectAll} title={t(props.locale, "gov.workflowDeadletters.action.selectAll")} />
              </th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.col.stepId")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.col.runId")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.toolRef")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.deadletteredAt")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.errorCategory")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.lastErrorDigest")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.diagnose.title")}</th>
              <th align="left">{t(props.locale, "gov.workflowDeadletters.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d, idx) => {
              const stepId = safeStr(d.stepId, "");
              const runId = safeStr(d.runId, "");
              const disabled = busy && busy === stepId;
              return (
                <tr key={`${stepId}:${idx}`} style={selectedSteps.has(stepId) ? { background: "rgba(59,130,246,0.06)" } : undefined}>
                  <td><input type="checkbox" checked={selectedSteps.has(stepId)} onChange={() => stepId && toggleSelect(stepId)} disabled={!stepId} /></td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{stepId || "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{runId || "-"}</td>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{safeStr(d.toolRef)}</td>
                  <td>{safeStr(d.deadletteredAt)}</td>
                  <td>{safeStr(d.errorCategory)}</td>
                  <td>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(d.lastErrorDigest ?? null, null, 2)}</pre>
                  </td>
                  <td>
                    <details style={{ fontSize: 12 }}>
                      <summary style={{ cursor: "pointer", color: "var(--sl-accent)", fontWeight: 500 }}>
                        {t(props.locale, "gov.workflowDeadletters.diagnose.title")}
                      </summary>
                      <pre style={{ margin: "4px 0 0", whiteSpace: "pre-wrap", fontSize: 11, padding: 8, borderRadius: 4, background: "var(--sl-surface)", border: "1px solid var(--sl-border)" }}>
                        {t(props.locale, diagnoseError(safeStr(d.errorCategory, "")))}
                      </pre>
                    </details>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                      {runId ? (
                        <Link href={`/runs/${encodeURIComponent(runId)}?lang=${encodeURIComponent(props.locale)}`}>{t(props.locale, "action.open")}</Link>
                      ) : (
                        <span>-</span>
                      )}
                      {stepId ? (
                        <>
                          <button disabled={Boolean(disabled)} onClick={() => retry(stepId)}>
                            {t(props.locale, "gov.workflowDeadletters.action.retry")}
                          </button>
                          <button disabled={Boolean(disabled)} onClick={() => cancel(stepId)}>
                            {t(props.locale, "gov.workflowDeadletters.action.cancel")}
                          </button>
                        </>
                      ) : (
                        <span>-</span>
                      )}
                    </div>
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

