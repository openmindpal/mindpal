"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { Card, PageHeader, Table, StructuredData, StatusBadge } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { toDisplayText, toRecord } from "@/lib/viewData";

type EvalSet = Record<string, unknown>;
type EvalRun = Record<string, unknown>;
type EvalSetsResp = ApiError & { sets?: EvalSet[] };
type EvalRunsResp = ApiError & { runs?: EvalRun[] };
type CreateSetResp = ApiError & { set?: EvalSet };
type RunResp = ApiError & { run?: EvalRun };

/** P1-3g: 指标卡片组件 */
function MetricCard({ label, value, delta, unit = "%" }: { label: string; value: number | null; delta?: number | null; unit?: string }) {
  if (value == null) return null;
  const display = unit === "%" ? `${(value * 100).toFixed(1)}%` : String(value);
  const deltaColor = delta != null ? (delta >= 0 ? "#22c55e" : "#ef4444") : undefined;
  const deltaText = delta != null
    ? `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(2)}%`
    : null;
  return (
    <div style={{ padding: "12px 16px", border: "1px solid var(--sl-border, #e5e7eb)", borderRadius: 8, minWidth: 120, textAlign: "center" }}>
      <div style={{ fontSize: 12, color: "var(--sl-muted, #6b7280)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{display}</div>
      {deltaText && <div style={{ fontSize: 11, color: deltaColor, marginTop: 2 }}>{deltaText}</div>}
    </div>
  );
}

/** P1-3g: 回归告警横幅 */
function RegressionAlert({ status, reasons }: { status: string; reasons: string[] }) {
  if (status === "passed") {
    return <div style={{ padding: "8px 12px", background: "#f0fdf4", borderRadius: 6, border: "1px solid #86efac", color: "#166534" }}>✅ Regression gate: PASSED</div>;
  }
  return (
    <div style={{ padding: "8px 12px", background: "#fef2f2", borderRadius: 6, border: "1px solid #fca5a5", color: "#991b1b" }}>
      <div>⛔ Regression gate: BLOCKED</div>
      {reasons.map((r, i) => <div key={i} style={{ fontSize: 12, marginTop: 4 }}>• {r}</div>)}
    </div>
  );
}

/** P1-3g: 趋势迷你横条图 */
function MiniBar({ value, max = 1, color = "#3b82f6" }: { value: number; max?: number; color?: string }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div style={{ width: 80, height: 8, background: "var(--sl-border, #e5e7eb)", borderRadius: 4, overflow: "hidden", display: "inline-block", verticalAlign: "middle", marginLeft: 8 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} />
    </div>
  );
}

/** P1-3g: 从评测运行结果中提取高级指标 */
function extractAdvancedMetrics(metrics: any): {
  hitAtK: number | null; mrrAtK: number | null; ndcgAtK: number | null;
  mapAtK: number | null; precisionAtK: number | null; recallAtK: number | null;
  f1AtK: number | null; hallucinationRate: number | null;
} | null {
  if (!metrics || typeof metrics !== "object") return null;
  return {
    hitAtK: metrics.hitAtK ?? metrics.hitAtk ?? metrics.hit_at_k ?? null,
    mrrAtK: metrics.mrrAtK ?? metrics.mrrAtk ?? metrics.mrr_at_k ?? null,
    ndcgAtK: metrics.ndcgAtK ?? metrics.ndcg_at_k ?? null,
    mapAtK: metrics.mapAtK ?? metrics.map_at_k ?? null,
    precisionAtK: metrics.precisionAtK ?? metrics.precision_at_k ?? null,
    recallAtK: metrics.recallAtK ?? metrics.recall_at_k ?? null,
    f1AtK: metrics.f1AtK ?? metrics.f1_at_k ?? null,
    hallucinationRate: metrics.hallucinationRate ?? metrics.hallucination_rate ?? null,
  };
}

type InitialData = { status: number; json: unknown };

export default function KnowledgeQualityClient(props: { locale: string; initial?: InitialData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<number>(props.initial?.status ?? 0);

  const [sets, setSets] = useState<EvalSetsResp | null>((props.initial?.json as EvalSetsResp) ?? null);
  const [runs, setRuns] = useState<EvalRunsResp | null>(null);

  const [createName, setCreateName] = useState("baseline");
  const [createDescription, setCreateDescription] = useState("");
  const [createQueriesText, setCreateQueriesText] = useState(
    JSON.stringify(
      [
        { query: "hello knowledge", expectedDocumentIds: ["00000000-0000-0000-0000-000000000000"], k: 5 },
      ],
      null,
      2,
    ),
  );

  const setRows = useMemo(() => (Array.isArray(sets?.sets) ? sets!.sets! : []), [sets]);
  const runRows = useMemo(() => (Array.isArray(runs?.runs) ? runs!.runs! : []), [runs]);

  const pageSize = 20;
  const [setPage, setSetPage] = useState(0);
  const setTotalPages = Math.max(1, Math.ceil(setRows.length / pageSize));
  const setRowsPaged = useMemo(() => setRows.slice(setPage * pageSize, (setPage + 1) * pageSize), [setRows, setPage]);

  const [runPage, setRunPage] = useState(0);
  const runTotalPages = Math.max(1, Math.ceil(runRows.length / pageSize));
  const runRowsPaged = useMemo(() => runRows.slice(runPage * pageSize, (runPage + 1) * pageSize), [runRows, runPage]);

  async function refresh(selectedEvalSetId?: string) {
    setError("");
    setBusy(true);
    setSetPage(0);
    setRunPage(0);
    try {
      const sRes = await apiFetch(`/governance/knowledge/quality/eval-sets?limit=50`, { locale: props.locale, cache: "no-store" });
      setStatus(sRes.status);
      const sJson: unknown = await sRes.json().catch(() => null);
      if (!sRes.ok) throw toApiError(sJson);
      setSets((sJson as EvalSetsResp) ?? null);

      const id = selectedEvalSetId ?? (() => {
        const arr = toRecord(sJson)?.sets;
        const first = Array.isArray(arr) && arr.length ? arr[0] : null;
        return toDisplayText(toRecord(first)?.id);
      })();
      const q = new URLSearchParams();
      q.set("limit", "50");
      if (id) q.set("evalSetId", id);
      const rRes = await apiFetch(`/governance/knowledge/quality/runs?${q.toString()}`, { locale: props.locale, cache: "no-store" });
      const rJson: unknown = await rRes.json().catch(() => null);
      if (!rRes.ok) throw toApiError(rJson);
      setRuns((rJson as EvalRunsResp) ?? null);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function createSet() {
    setError("");
    setBusy(true);
    try {
      const parsed = JSON.parse(createQueriesText);
      const res = await apiFetch(`/governance/knowledge/quality/eval-sets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ name: createName, description: createDescription || undefined, queries: parsed }),
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as CreateSetResp) ?? {};
      const id = toDisplayText(toRecord(out.set)?.id);
      await refresh(id || undefined);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function runEval(evalSetId: string) {
    setError("");
    setBusy(true);
    try {
      const res = await apiFetch(`/governance/knowledge/quality/eval-sets/${encodeURIComponent(evalSetId)}/runs`, {
        method: "POST",
        locale: props.locale,
      });
      setStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const out = (json as RunResp) ?? {};
      const run = toRecord(out.run);
      const setId = run ? toDisplayText(run.evalSetId ?? evalSetId) : evalSetId;
      await refresh(setId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader
        title={t(props.locale, "gov.nav.knowledgeQuality")}
        actions={
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <StatusBadge locale={props.locale} status={status || 0} />
            <button disabled={busy} onClick={() => refresh()}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.refresh")}
            </button>
          </div>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap", margin: 0 }}>{error}</pre> : null}

      <Card title={t(props.locale, "gov.knowledgeQuality.createEvalSetTitle")}>
        <div style={{ display: "grid", gap: 10, maxWidth: 920 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.knowledgeQuality.form.name")}</div>
            <input value={createName} onChange={(e) => setCreateName(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.knowledgeQuality.form.description")}</div>
            <input value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "gov.knowledgeQuality.form.queriesJson")}</div>
            <textarea value={createQueriesText} onChange={(e) => setCreateQueriesText(e.target.value)} rows={10} style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }} />
          </label>
          <div>
            <button disabled={busy || !createName.trim()} onClick={createSet}>
              {busy ? t(props.locale, "action.loading") : t(props.locale, "action.create")}
            </button>
          </div>
        </div>
      </Card>

      <Card title={t(props.locale, "gov.knowledgeQuality.evalSetsTitle")}>
        <Table header={<span>{setRows.length ? `${setRows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.id")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.name")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.table.queries")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {setRows.length === 0 ? (
                  <tr><td colSpan={4} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : setRowsPaged.map((s) => {
              const rec = toRecord(s);
              const id = rec ? toDisplayText(rec.id) : "";
              const name = rec ? toDisplayText(rec.name) : "";
              const queries = rec ? (rec.queries as unknown) : null;
              const qCount = Array.isArray(queries) ? queries.length : 0;
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{name || "-"}</td>
                  <td>{fmtDateTime(rec?.createdAt, props.locale)}</td>
                  <td>{qCount}</td>
                  <td>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button disabled={!id || busy} onClick={() => refresh(id)}>
                        {t(props.locale, "gov.knowledgeQuality.action.runs")}
                      </button>
                      <button disabled={!id || busy} onClick={() => runEval(id)}>
                        {t(props.locale, "gov.knowledgeQuality.action.run")}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {setTotalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(props.locale, "pagination.showing").replace("{from}", String(setPage * pageSize + 1)).replace("{to}", String(Math.min((setPage + 1) * pageSize, setRows.length)))}
              {t(props.locale, "pagination.total").replace("{count}", String(setRows.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={setPage === 0} onClick={() => setSetPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(setPage + 1))}</span>
              <button disabled={setPage >= setTotalPages - 1} onClick={() => setSetPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
            </div>
          </div>
        )}
      </Card>

      {/* P1-3g: 最新评测运行的高级指标卡片组 */}
      {(() => {
        const latestRun = runRows[0];
        const latestRec = latestRun ? toRecord(latestRun) : null;
        const adv = latestRec ? extractAdvancedMetrics(latestRec.metrics) : null;
        const prevRun = runRows.length >= 2 ? toRecord(runRows[1]!) : null;
        const prevAdv = prevRun ? extractAdvancedMetrics(prevRun.metrics) : null;
        const regression = latestRec?.regression as any;

        if (!adv) return null;
        const delta = (cur: number | null, prev: number | null) => (cur != null && prev != null) ? cur - prev : null;

        return (
          <Card title="Retrieval Quality Overview">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <MetricCard label="Hit@K" value={adv.hitAtK} delta={delta(adv.hitAtK, prevAdv?.hitAtK ?? null)} />
              <MetricCard label="MRR@K" value={adv.mrrAtK} delta={delta(adv.mrrAtK, prevAdv?.mrrAtK ?? null)} />
              <MetricCard label="NDCG@K" value={adv.ndcgAtK} delta={delta(adv.ndcgAtK, prevAdv?.ndcgAtK ?? null)} />
              <MetricCard label="MAP@K" value={adv.mapAtK} delta={delta(adv.mapAtK, prevAdv?.mapAtK ?? null)} />
              <MetricCard label="Precision@K" value={adv.precisionAtK} delta={delta(adv.precisionAtK, prevAdv?.precisionAtK ?? null)} />
              <MetricCard label="Recall@K" value={adv.recallAtK} delta={delta(adv.recallAtK, prevAdv?.recallAtK ?? null)} />
              <MetricCard label="F1@K" value={adv.f1AtK} delta={delta(adv.f1AtK, prevAdv?.f1AtK ?? null)} />
              <MetricCard label="Hallucination" value={adv.hallucinationRate} delta={delta(adv.hallucinationRate, prevAdv?.hallucinationRate ?? null)} />
            </div>
            {regression && typeof regression === "object" && regression.gateResult && (
              <RegressionAlert status={regression.gateResult} reasons={Array.isArray(regression.blockedReasons) ? regression.blockedReasons : []} />
            )}
          </Card>
        );
      })()}

      <Card title={t(props.locale, "gov.knowledgeQuality.runsTitle")}>
        <Table header={<span>{runRows.length ? `${runRows.length}` : "-"}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.id")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.status")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.metrics")}</th>
              <th align="left">{t(props.locale, "gov.knowledgeQuality.runsTable.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {runRows.length === 0 ? (
                  <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--sl-muted)", padding: 24, fontStyle: "italic" }}>{t(props.locale, "widget.noData")}</td></tr>
                ) : runRowsPaged.map((r, idx) => {
              const rec = toRecord(r);
              const id = rec ? toDisplayText(rec.id ?? idx) : String(idx);
              const adv = extractAdvancedMetrics(rec?.metrics);
              return (
                <tr key={id}>
                  <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{id}</td>
                  <td>{rec ? toDisplayText(rec.status ?? "-") : "-"}</td>
                  <td>{fmtDateTime(rec?.createdAt, props.locale)}</td>
                  <td>
                    {adv ? (
                      <div style={{ display: "grid", gap: 2, fontSize: 12 }}>
                        {adv.hitAtK != null && <div>Hit@K: {(adv.hitAtK * 100).toFixed(1)}%<MiniBar value={adv.hitAtK} /></div>}
                        {adv.mrrAtK != null && <div>MRR@K: {(adv.mrrAtK * 100).toFixed(1)}%<MiniBar value={adv.mrrAtK} color="#8b5cf6" /></div>}
                        {adv.ndcgAtK != null && <div>NDCG@K: {(adv.ndcgAtK * 100).toFixed(1)}%<MiniBar value={adv.ndcgAtK} color="#f59e0b" /></div>}
                        {adv.hallucinationRate != null && <div>Halluc.: {(adv.hallucinationRate * 100).toFixed(1)}%<MiniBar value={adv.hallucinationRate} color="#ef4444" /></div>}
                      </div>
                    ) : (
                      <StructuredData data={rec?.metrics ?? null} />
                    )}
                  </td>
                  <td>
                    <details>
                      <summary>{t(props.locale, "gov.knowledgeQuality.json")}</summary>
                      <StructuredData data={r} />
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        {runTotalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
            <span style={{ opacity: 0.7, fontSize: 13 }}>
              {t(props.locale, "pagination.showing").replace("{from}", String(runPage * pageSize + 1)).replace("{to}", String(Math.min((runPage + 1) * pageSize, runRows.length)))}
              {t(props.locale, "pagination.total").replace("{count}", String(runRows.length))}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={runPage === 0} onClick={() => setRunPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
              <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(runPage + 1))}</span>
              <button disabled={runPage >= runTotalPages - 1} onClick={() => setRunPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
