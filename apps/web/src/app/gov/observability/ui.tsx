"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t, statusLabel } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Badge, Card, PageHeader, StatusBadge, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { numberField, stringField, toDisplayText, toRecord } from "@/lib/viewData";


type RouteSummary = { key: string; total: number; success: number; p50Ms: number | null; p95Ms: number | null };
type SyncSummary = { spaceId: string; pushes: number; ops: number; conflicts: number; conflictRate: string };
type TopErrorSummary = { errorCategory: string; key: string; count: number; sampleTraceId: string };
type KnowledgeSummary = { searches: string; ok: string; denied: string; error: string; emptyResults: string };
type Summary = ApiError & {
  routes: RouteSummary[];
  sync: SyncSummary[];
  topErrors: TopErrorSummary[];
  knowledge: KnowledgeSummary | null;
};

function normalizeSummary(value: unknown): Summary | null {
  const record = toRecord(value);
  if (!record) return null;
  const routes = Array.isArray(record.routes)
    ? record.routes.map((item) => {
        const row = toRecord(item);
        if (!row) return null;
        return {
          key: toDisplayText(row.key),
          total: Number(row.total ?? 0),
          success: Number(row.success ?? 0),
          p50Ms: row.p50Ms == null ? null : Number(row.p50Ms),
          p95Ms: row.p95Ms == null ? null : Number(row.p95Ms),
        };
      }).filter((item): item is RouteSummary => Boolean(item))
    : [];
  const sync = Array.isArray(record.sync)
    ? record.sync.map((item) => {
        const row = toRecord(item);
        if (!row) return null;
        return {
          spaceId: toDisplayText(row.spaceId),
          pushes: Number(row.pushes ?? 0),
          ops: Number(row.ops ?? 0),
          conflicts: Number(row.conflicts ?? 0),
          conflictRate: row.conflictRate == null ? "-" : toDisplayText(row.conflictRate),
        };
      }).filter((item): item is SyncSummary => Boolean(item))
    : [];
  const topErrors = Array.isArray(record.topErrors)
    ? record.topErrors.map((item) => {
        const row = toRecord(item);
        if (!row) return null;
        return {
          errorCategory: toDisplayText(row.errorCategory),
          key: toDisplayText(row.key),
          count: Number(row.count ?? 0),
          sampleTraceId: toDisplayText(row.sampleTraceId),
        };
      }).filter((item): item is TopErrorSummary => Boolean(item))
    : [];
  const knowledgeRecord = toRecord(record.knowledge);
  const knowledge = knowledgeRecord
    ? {
        searches: toDisplayText(knowledgeRecord.searches ?? 0),
        ok: toDisplayText(knowledgeRecord.ok ?? 0),
        denied: toDisplayText(knowledgeRecord.denied ?? 0),
        error: toDisplayText(knowledgeRecord.error ?? 0),
        emptyResults: toDisplayText(knowledgeRecord.emptyResults ?? 0),
      }
    : null;
  return {
    errorCode: stringField(record, "errorCode"),
    message: record.message,
    traceId: stringField(record, "traceId"),
    dimension: stringField(record, "dimension"),
    retryAfterSec: numberField(record, "retryAfterSec"),
    routes,
    sync,
    topErrors,
    knowledge,
  };
}

export default function GovObservabilityClient(props: { locale: string; initial: unknown; initialStatus: number; initialWindow: string }) {
  const [window, setWindow] = useState<string>(props.initialWindow || "1h");
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [data, setData] = useState<Summary | null>(normalizeSummary(props.initial));
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0);
  const [alertErrorRate, setAlertErrorRate] = useState<number>(10);
  const [alertP95, setAlertP95] = useState<number>(5000);
  const [showAlertConfig, setShowAlertConfig] = useState(false);

  const pageSize = 20;
  const [routesPage, setRoutesPage] = useState(0);
  const [syncPage, setSyncPage] = useState(0);
  const [errorsPage, setErrorsPage] = useState(0);

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data as any);
    return "";
  }, [data, props.locale, status]);

  const refresh = useCallback(async (nextWindow?: string) => {
    setError("");
    setBusy(true);
    setRoutesPage(0);
    setSyncPage(0);
    setErrorsPage(0);
    try {
      const w = nextWindow ?? window;
      const q = new URLSearchParams();
      q.set("window", w);
      const res = await apiFetch(`/governance/observability/summary?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setData(normalizeSummary(json));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }, [props.locale, window]);

  /* Auto-refresh timer */
  useEffect(() => {
    if (!autoRefreshInterval) return;
    const timer = setInterval(() => refresh(), autoRefreshInterval * 1000);
    return () => clearInterval(timer);
  }, [autoRefreshInterval, refresh]);

  /* Compute alerts from routes data */
  const alerts = useMemo(() => {
    const result: Array<{ type: string; route: string; value: string }> = [];
    const routes = data?.routes ?? [];
    for (const r of routes) {
      if (r.total > 0) {
        const errRate = ((r.total - r.success) / r.total) * 100;
        if (errRate > alertErrorRate) {
          result.push({ type: "errorRate", route: r.key, value: `${errRate.toFixed(1)}%` });
        }
      }
      if (r.p95Ms != null && r.p95Ms > alertP95) {
        result.push({ type: "p95", route: r.key, value: `${r.p95Ms}ms` });
      }
    }
    return result;
  }, [data, alertErrorRate, alertP95]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from data, used as useMemo dep
  const routes = data?.routes ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from data, used as useMemo dep
  const sync = data?.sync ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps -- derived from data, used as useMemo dep
  const topErrors = data?.topErrors ?? [];
  const knowledge = data?.knowledge ?? null;

  const routesTotalPages = Math.max(1, Math.ceil(routes.length / pageSize));
  const routesPaged = useMemo(() => routes.slice(routesPage * pageSize, (routesPage + 1) * pageSize), [routes, routesPage]);

  const syncTotalPages = Math.max(1, Math.ceil(sync.length / pageSize));
  const syncPaged = useMemo(() => sync.slice(syncPage * pageSize, (syncPage + 1) * pageSize), [sync, syncPage]);

  const errorsTotalPages = Math.max(1, Math.ceil(topErrors.length / pageSize));
  const errorsPaged = useMemo(() => topErrors.slice(errorsPage * pageSize, (errorsPage + 1) * pageSize), [topErrors, errorsPage]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.observability.title")}
        helpHref={getHelpHref("/gov/observability", props.locale) ?? undefined}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.observability.window")}</span>
              <select
                value={window}
                onChange={(e) => {
                  setWindow(e.target.value);
                  refresh(e.target.value);
                }}
                disabled={busy}
              >
                <option value="1h">1h</option>
                <option value="6h">6h</option>
                <option value="24h">24h</option>
                <option value="7d">7d</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.observability.autoRefresh")}</span>
              <select value={autoRefreshInterval} onChange={(e) => setAutoRefreshInterval(Number(e.target.value))} disabled={busy}>
                <option value={0}>{t(props.locale, "gov.observability.autoRefresh.off")}</option>
                <option value={30}>{t(props.locale, "gov.observability.autoRefresh.30s")}</option>
                <option value={60}>{t(props.locale, "gov.observability.autoRefresh.60s")}</option>
                <option value={300}>{t(props.locale, "gov.observability.autoRefresh.5m")}</option>
              </select>
            </label>
            <button onClick={() => setShowAlertConfig(!showAlertConfig)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid var(--sl-border)", background: showAlertConfig ? "var(--sl-accent)" : "var(--sl-surface)", color: showAlertConfig ? "#fff" : "inherit", cursor: "pointer", fontSize: 12 }}>
              {t(props.locale, "gov.observability.alerts.title")}
            </button>
            <button onClick={() => refresh()} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      {/* Alert threshold config */}
      {showAlertConfig && (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.observability.alerts.title")}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <span>{t(props.locale, "gov.observability.alerts.errorRate")}</span>
                <input type="number" value={alertErrorRate} onChange={(e) => setAlertErrorRate(Number(e.target.value))} style={{ width: 80, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--sl-border)" }} min={0} max={100} />
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <span>{t(props.locale, "gov.observability.alerts.p95")}</span>
                <input type="number" value={alertP95} onChange={(e) => setAlertP95(Number(e.target.value))} style={{ width: 100, padding: "4px 8px", borderRadius: 4, border: "1px solid var(--sl-border)" }} min={0} />
              </label>
            </div>
          </Card>
        </div>
      )}

      {/* Active alerts */}
      {alerts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Card title={t(props.locale, "gov.observability.alerts.warning")}>
            <div style={{ display: "grid", gap: 6 }}>
              {alerts.map((a, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", borderRadius: 6, background: "rgba(239,68,68,0.06)", border: "1px solid #fecaca", fontSize: 12 }}>
                  <Badge tone="warning">{a.type === "errorRate" ? t(props.locale, "gov.observability.alerts.errorRateExceeded") : t(props.locale, "gov.observability.alerts.p95Exceeded")}</Badge>
                  <span style={{ fontFamily: "monospace" }}>{a.route}</span>
                  <span style={{ marginLeft: "auto", fontWeight: 600, color: "#dc2626" }}>{a.value}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.routesTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.key")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.total")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.successRate")}</th>
                  <th style={{ textAlign: "right" }}>p50</th>
                  <th style={{ textAlign: "right" }}>p95</th>
                </tr>
              </thead>
              <tbody>
                {routesPaged.map((r, idx) => {
                  const total = r.total;
                  const success = r.success;
                  const rate = total > 0 ? Math.round((success / total) * 10000) / 100 : 0;
                  return (
                    <tr key={`${r.key || idx}`}>
                      <td style={{ padding: "6px 4px" }}>{r.key}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{total}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{rate.toFixed(2)}%</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.p50Ms == null || Number.isNaN(r.p50Ms) ? "-" : `${r.p50Ms}ms`}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.p95Ms == null || Number.isNaN(r.p95Ms) ? "-" : `${r.p95Ms}ms`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {routesTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(routesPage * pageSize + 1)).replace("{to}", String(Math.min((routesPage + 1) * pageSize, routes.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(routes.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={routesPage === 0} onClick={() => setRoutesPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(routesPage + 1))}</span>
                <button disabled={routesPage >= routesTotalPages - 1} onClick={() => setRoutesPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.syncTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.spaceId")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.pushes")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.ops")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.conflicts")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.conflictRate")}</th>
                </tr>
              </thead>
              <tbody>
                {syncPaged.map((r, idx) => (
                  <tr key={`${r.spaceId || idx}`}>
                    <td style={{ padding: "6px 4px" }}>{r.spaceId}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.pushes}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.ops}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.conflicts}</td>
                    <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.conflictRate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {syncTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(syncPage * pageSize + 1)).replace("{to}", String(Math.min((syncPage + 1) * pageSize, sync.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(sync.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={syncPage === 0} onClick={() => setSyncPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(syncPage + 1))}</span>
                <button disabled={syncPage >= syncTotalPages - 1} onClick={() => setSyncPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.knowledgeTitle")}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Badge>
              {t(props.locale, "gov.observability.searches")}: {knowledge?.searches ?? "0"}
            </Badge>
            <Badge>
              ok: {knowledge?.ok ?? "0"}
            </Badge>
            <Badge>
              denied: {knowledge?.denied ?? "0"}
            </Badge>
            <Badge>
              error: {knowledge?.error ?? "0"}
            </Badge>
            <Badge>
              empty: {knowledge?.emptyResults ?? "0"}
            </Badge>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.observability.topErrorsTitle")}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.errorCategory")}</th>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.key")}</th>
                  <th style={{ textAlign: "right" }}>{t(props.locale, "gov.observability.total")}</th>
                  <th style={{ textAlign: "left" }}>{t(props.locale, "gov.observability.sampleTraceId")}</th>
                </tr>
              </thead>
              <tbody>
                {errorsPaged.map((r, idx) => {
                  const traceId = r.sampleTraceId;
                  const href = traceId ? `/gov/audit?lang=${encodeURIComponent(props.locale)}&traceId=${encodeURIComponent(traceId)}&limit=50` : "";
                  return (
                    <tr key={`${r.key || idx}-${idx}`}>
                      <td style={{ padding: "6px 4px" }}>{r.errorCategory}</td>
                      <td style={{ padding: "6px 4px" }}>{r.key}</td>
                      <td style={{ padding: "6px 4px", textAlign: "right" }}>{r.count}</td>
                      <td style={{ padding: "6px 4px" }}>{href ? <a href={href}>{traceId}</a> : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {errorsTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(errorsPage * pageSize + 1)).replace("{to}", String(Math.min((errorsPage + 1) * pageSize, topErrors.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(topErrors.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={errorsPage === 0} onClick={() => setErrorsPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(errorsPage + 1))}</span>
                <button disabled={errorsPage >= errorsTotalPages - 1} onClick={() => setErrorsPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <RunMetricsDashboard locale={props.locale} window={window} />
    </div>
  );
}

type RunMetrics = {
  totalRuns: number;
  activeRuns: number;
  blockedRuns: number;
  succeededRuns: number;
  failedRuns: number;
  canceledRuns: number;
  phaseDistribution: Record<string, number>;
  avgStepDurationMs: number | null;
  approvalConversionRate: number | null;
  recentBlockedRuns: Array<{ runId: string; status: string; blockReason: string | null; updatedAt: string }>;
};

type OpsMetrics = {
  planSuccessRate: number;
  suggestionHitRate: number;
  approvalInterventionRate: number;
  retryRate: number;
  replanRate: number;
  defaultDenyRate: number;
  byEntryPoint: Record<string, { totalRuns: number; succeeded: number; failed: number; approvalRequested: number }>;
};

function RunMetricsDashboard({ locale, window }: { locale: string; window: string }) {
  const [runMetrics, setRunMetrics] = useState<RunMetrics | null>(null);
  const [opsMetrics, setOpsMetrics] = useState<OpsMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const w = window === "24h" ? "24h" : window === "7d" ? "7d" : "1h";
    const [r1, r2] = await Promise.all([
      apiFetch(`/governance/run-metrics?window=${w}`, { locale, cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null),
      apiFetch(`/governance/observability/operations?window=${w}`, { locale, cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null),
    ]);
    setRunMetrics(r1 as RunMetrics | null);
    setOpsMetrics(r2 as OpsMetrics | null);
    setLoading(false);
  }, [locale, window]);

  useEffect(() => {
    void Promise.resolve().then(fetchAll);
  }, [fetchAll]);

  const pct = (v: number | null | undefined) => v != null ? `${(v * 100).toFixed(1)}%` : "-";

  if (loading) {
    return (
      <div style={{ marginTop: 24 }}>
        <Card title={t(locale, "gov.observability.dashboard.coreTitle")}>
          <div style={{ padding: 16, color: "#888" }}>{t(locale, "gov.observability.dashboard.loading")}</div>
        </Card>
      </div>
    );
  }

  return (
    <>
      {runMetrics && (
        <div style={{ marginTop: 24 }}>
          <Card title={t(locale, "gov.observability.dashboard.coreTitle")}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 16 }}>
              <KpiCard label={t(locale, "gov.observability.dashboard.total")} value={runMetrics.totalRuns} />
              <KpiCard label={t(locale, "gov.observability.dashboard.active")} value={runMetrics.activeRuns} color="#3b82f6" />
              <KpiCard label={t(locale, "gov.observability.dashboard.blocked")} value={runMetrics.blockedRuns} color="#f59e0b" />
              <KpiCard label={t(locale, "gov.observability.dashboard.ok")} value={runMetrics.succeededRuns} color="#22c55e" />
              <KpiCard label={t(locale, "gov.observability.dashboard.fail")} value={runMetrics.failedRuns} color="#ef4444" />
              <KpiCard label={t(locale, "gov.observability.dashboard.avgStep")} value={runMetrics.avgStepDurationMs != null ? `${runMetrics.avgStepDurationMs}ms` : "-"} />
              <KpiCard label={t(locale, "gov.observability.dashboard.approvalRate")} value={pct(runMetrics.approvalConversionRate)} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t(locale, "gov.observability.dashboard.phaseDistribution")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {Object.entries(runMetrics.phaseDistribution).sort((a, b) => b[1] - a[1]).map(([phase, count]) => (
                  <Badge key={phase}>{phase}: {count}</Badge>
                ))}
              </div>
            </div>

            {runMetrics.recentBlockedRuns.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t(locale, "gov.observability.dashboard.recentBlocked")}</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>Run ID</th>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.status")}</th>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.blockReason")}</th>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.updated")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runMetrics.recentBlockedRuns.map((r) => (
                        <tr key={r.runId}>
                          <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>{r.runId.slice(0, 12)}…</td>
                          <td style={{ padding: "4px 6px" }}><Badge>{statusLabel(r.status, locale)}</Badge></td>
                          <td style={{ padding: "4px 6px" }}>{r.blockReason ?? "-"}</td>
                          <td style={{ padding: "4px 6px" }}>{fmtDateTime(r.updatedAt, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {opsMetrics && (
        <div style={{ marginTop: 16 }}>
          <Card title={t(locale, "gov.observability.dashboard.opsTitle")}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 16 }}>
              <KpiCard label={t(locale, "gov.observability.dashboard.planSuccess")} value={pct(opsMetrics.planSuccessRate)} color="#22c55e" />
              <KpiCard label={t(locale, "gov.observability.dashboard.suggestionHit")} value={pct(opsMetrics.suggestionHitRate)} color="#3b82f6" />
              <KpiCard label={t(locale, "gov.observability.dashboard.approvalInterv")} value={pct(opsMetrics.approvalInterventionRate)} color="#f59e0b" />
              <KpiCard label={t(locale, "gov.observability.dashboard.retryRate")} value={pct(opsMetrics.retryRate)} />
              <KpiCard label={t(locale, "gov.observability.dashboard.replanRate")} value={pct(opsMetrics.replanRate)} />
              <KpiCard label={t(locale, "gov.observability.dashboard.defaultDeny")} value={pct(opsMetrics.defaultDenyRate)} color="#ef4444" />
            </div>

            {Object.keys(opsMetrics.byEntryPoint).length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{t(locale, "gov.observability.dashboard.byEntry")}</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.entry")}</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.entryTotal")}</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.entryOk")}</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.entryFail")}</th>
                        <th style={{ textAlign: "right", padding: "4px 6px" }}>{t(locale, "gov.observability.dashboard.entryApproval")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(opsMetrics.byEntryPoint).map(([ep, m]) => (
                        <tr key={ep}>
                          <td style={{ padding: "4px 6px" }}>{ep}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>{m.totalRuns}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>{m.succeeded}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>{m.failed}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>{m.approvalRequested}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function KpiCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{
      padding: "10px 12px",
      borderRadius: 8,
      border: "1px solid #e5e7eb",
      background: "#fafafa",
      textAlign: "center",
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: color ?? "#111", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{label}</div>
    </div>
  );
}

