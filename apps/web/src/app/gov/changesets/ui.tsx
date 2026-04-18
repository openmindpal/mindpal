"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table, StatusBadge, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type ChangeSetRow = { id: string; title?: string; scope_type?: string; scope_id?: string; status?: string; created_at?: string };
type ChangeSetsResponse = ApiError & { changesets?: ChangeSetRow[] };
type PipelineRow = { changesetId: string; mode: string; gates: Array<{ gateType: string; status: string; required: boolean }>; warningsCount: number };
type PipelinesResponse = ApiError & { pipelines?: PipelineRow[] };

export default function ChangeSetsClient(props: { locale: string; initial: unknown; initialStatus: number; initialPipelines: unknown; initialPipelinesStatus: number }) {
  const [scope, setScope] = useState<"space" | "tenant" | "">( "");
  const [limit, setLimit] = useState<string>("20");
  const [data, setData] = useState<ChangeSetsResponse | null>((props.initial as ChangeSetsResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [pipes, setPipes] = useState<PipelinesResponse | null>((props.initialPipelines as PipelinesResponse) ?? null);
  const [pipesStatus, setPipesStatus] = useState<number>(props.initialPipelinesStatus);
  const [error, setError] = useState<string>("");

  const [title, setTitle] = useState<string>("");
  const [createScope, setCreateScope] = useState<"space" | "tenant">("space");
  const [canaryTargetsText, setCanaryTargetsText] = useState<string>("");
  const [creating, setCreating] = useState<boolean>(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);

  const items = useMemo(() => (Array.isArray(data?.changesets) ? data!.changesets! : []), [data]);
  const pageSize = 20;
  const [page, setPage] = useState(0);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = useMemo(() => items.slice(page * pageSize, (page + 1) * pageSize), [items, page]);
  const pipelinesById = useMemo(() => {
    const arr = Array.isArray(pipes?.pipelines) ? pipes!.pipelines! : [];
    const m = new Map<string, PipelineRow>();
    for (const p of arr) m.set(p.changesetId, p);
    return m;
  }, [pipes]);

  function translated(key: string, fallback: string) {
    const out = t(props.locale, key);
    return out === key ? fallback : out;
  }

  function scopeTypeText(v: string) {
    if (v === "space") return t(props.locale, "scope.space");
    if (v === "tenant") return t(props.locale, "scope.tenant");
    return v;
  }

  async function refresh() {
    setError("");
    setPage(0);
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    const n = Number(limit);
    if (Number.isFinite(n) && n > 0) q.set("limit", String(n));
    const res = await apiFetch(`/governance/changesets?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as ChangeSetsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    const pRes = await apiFetch(`/governance/changesets/pipelines?${q.toString()}&mode=full`, { locale: props.locale, cache: "no-store" });
    setPipesStatus(pRes.status);
    const pJson: unknown = await pRes.json().catch(() => null);
    setPipes((pJson as PipelinesResponse) ?? null);
  }

  async function create() {
    setError("");
    setCreating(true);
    try {
      const canaryTargets = canaryTargetsText
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 50);
      const res = await apiFetch(`/governance/changesets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ title, scope: createScope, canaryTargets: canaryTargets.length ? canaryTargets : undefined }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setTitle("");
      setCanaryTargetsText("");
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setCreating(false);
    }
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.changesets.title")}
        helpHref={getHelpHref("/gov/changesets", props.locale) ?? undefined}
        actions={
          <>
            <StatusBadge locale={props.locale} status={status} />
            <Badge>{pipesStatus}</Badge>
            <button onClick={refresh}>{t(props.locale, "action.refresh")}</button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesets.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.changesets.scope")}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value === "tenant" ? "tenant" : e.target.value === "space" ? "space" : "")}>
                <option value="">{t(props.locale, "gov.changesets.scopeAll")}</option>
                <option value="space">{t(props.locale, "scope.space")}</option>
                <option value="tenant">{t(props.locale, "scope.tenant")}</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.changesets.limit")}</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 100 }} />
            </label>
            <button onClick={refresh}>{t(props.locale, "action.apply")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.changesets.createTitle")}>
          {/* Wizard step indicator */}
          <div style={{ display: "flex", gap: 0, marginBottom: 20 }}>
            {[1, 2, 3].map((step) => {
              const isActive = wizardStep === step;
              const isDone = wizardStep > step;
              return (
                <div key={step} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", position: "relative" }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, background: isActive ? "var(--sl-accent)" : isDone ? "#22c55e" : "var(--sl-surface)", color: isActive || isDone ? "#fff" : "var(--sl-muted)", border: `2px solid ${isActive ? "var(--sl-accent)" : isDone ? "#22c55e" : "var(--sl-border)"}` }}>
                    {isDone ? "✓" : step}
                  </div>
                  <span style={{ fontSize: 11, marginTop: 4, fontWeight: isActive ? 600 : 400, color: isActive ? "var(--sl-accent)" : "var(--sl-muted)" }}>
                    {t(props.locale, `gov.changesets.wizard.step${step}`)}
                  </span>
                  {step < 3 && <div style={{ position: "absolute", top: 13, left: "60%", right: "-40%", height: 2, background: isDone ? "#22c55e" : "var(--sl-border)" }} />}
                </div>
              );
            })}
          </div>

          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            {/* Step 1: Title */}
            {wizardStep === 1 && (
              <>
                <p style={{ color: "var(--sl-muted)", fontSize: 12, margin: 0 }}>{t(props.locale, "gov.changesets.wizard.step1Desc")}</p>
                <label style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t(props.locale, "gov.changesets.titleLabel")}</div>
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t(props.locale, "gov.changesets.titlePlaceholder")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                  <button disabled={!title.trim()} onClick={() => setWizardStep(2)} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, opacity: !title.trim() ? 0.5 : 1 }}>
                    {t(props.locale, "gov.changesets.wizard.next")} →
                  </button>
                </div>
              </>
            )}

            {/* Step 2: Scope */}
            {wizardStep === 2 && (
              <>
                <p style={{ color: "var(--sl-muted)", fontSize: 12, margin: 0 }}>{t(props.locale, "gov.changesets.wizard.step2Desc")}</p>
                <label style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t(props.locale, "gov.changesets.scope")}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {(["space", "tenant"] as const).map(s => (
                      <button key={s} onClick={() => setCreateScope(s)} style={{ flex: 1, padding: "10px 16px", borderRadius: 8, border: `2px solid ${createScope === s ? "var(--sl-accent)" : "var(--sl-border)"}`, background: createScope === s ? "rgba(var(--sl-accent-rgb,59,130,246),0.08)" : "var(--sl-surface)", cursor: "pointer", fontWeight: createScope === s ? 600 : 400, fontSize: 13 }}>
                        {t(props.locale, `scope.${s}`)}
                      </button>
                    ))}
                  </div>
                </label>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
                  <button onClick={() => setWizardStep(1)} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
                    ← {t(props.locale, "gov.changesets.wizard.prev")}
                  </button>
                  <button onClick={() => setWizardStep(3)} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
                    {t(props.locale, "gov.changesets.wizard.next")} →
                  </button>
                </div>
              </>
            )}

            {/* Step 3: Canary + Create */}
            {wizardStep === 3 && (
              <>
                <p style={{ color: "var(--sl-muted)", fontSize: 12, margin: 0 }}>{t(props.locale, "gov.changesets.wizard.step3Desc")}</p>
                <label style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t(props.locale, "gov.changesets.canaryTargets")}</div>
                  <input
                    value={canaryTargetsText}
                    onChange={(e) => setCanaryTargetsText(e.target.value)}
                    placeholder={t(props.locale, "gov.changesets.canaryTargetsPlaceholder")}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                  />
                  <span style={{ fontSize: 11, color: "var(--sl-muted)" }}>{t(props.locale, "gov.changesets.wizard.canaryHint")}</span>
                </label>
                {/* Review summary */}
                <div style={{ padding: 10, borderRadius: 6, background: "var(--sl-surface)", border: "1px solid var(--sl-border)", fontSize: 12, display: "grid", gap: 4 }}>
                  <div><strong>{t(props.locale, "gov.changesets.titleLabel")}:</strong> {title}</div>
                  <div><strong>{t(props.locale, "gov.changesets.scope")}:</strong> {t(props.locale, `scope.${createScope}`)}</div>
                  {canaryTargetsText.trim() && <div><strong>{t(props.locale, "gov.changesets.canaryTargets")}:</strong> {canaryTargetsText}</div>}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 8 }}>
                  <button onClick={() => setWizardStep(2)} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
                    ← {t(props.locale, "gov.changesets.wizard.prev")}
                  </button>
                  <button onClick={() => { create(); setWizardStep(1); }} disabled={!title.trim() || creating} style={{ padding: "8px 20px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, opacity: (!title.trim() || creating) ? 0.5 : 1 }}>
                    {creating ? t(props.locale, "action.creating") : t(props.locale, "gov.changesets.wizard.review")}
                  </button>
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.changesets.listTitle")}</span>
              <Badge>{items.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.changesets.table.id")}</th>
              <th align="left">{t(props.locale, "gov.changesets.titleCol")}</th>
              <th align="left">{t(props.locale, "gov.changesets.table.scope")}</th>
              <th align="left">{t(props.locale, "gov.changesets.table.status")}</th>
              <th align="left">{t(props.locale, "gov.changesets.table.gates")}</th>
              <th align="left">{t(props.locale, "gov.changesets.createdAt")}</th>
              <th align="left">{t(props.locale, "gov.changesets.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((cs) => (
              <tr key={cs.id}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{cs.id}</td>
                <td>{cs.title ?? "-"}</td>
                <td>
                  {scopeTypeText(cs.scope_type ?? "-")}:{cs.scope_id ?? "-"}
                </td>
                <td>{cs.status ? translated(`gov.changesets.status.${cs.status}`, cs.status) : "-"}</td>
                <td>
                  {(() => {
                    const p = pipelinesById.get(cs.id);
                    if (!p) return "-";
                    const fails = p.gates.filter((g) => g.status === "fail").length;
                    const warns = p.gates.filter((g) => g.status === "warn").length;
                    const unknowns = p.gates.filter((g) => g.status === "unknown").length;
                    return (
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Badge>
                          {t(props.locale, "gov.changesets.gates.fail")}:{fails}
                        </Badge>
                        <Badge>
                          {t(props.locale, "gov.changesets.gates.warn")}:{warns}
                        </Badge>
                        {unknowns ? (
                          <Badge>
                            {t(props.locale, "gov.changesets.gates.unknown")}:{unknowns}
                          </Badge>
                        ) : null}
                        {p.warningsCount ? (
                          <Badge>
                            {t(props.locale, "gov.changesets.gates.warnings")}:{p.warningsCount}
                          </Badge>
                        ) : null}
                      </div>
                    );
                  })()}
                </td>
                <td>{cs.created_at ?? "-"}</td>
                <td>
                  <Link href={`/gov/changesets/${encodeURIComponent(cs.id)}?lang=${encodeURIComponent(props.locale)}`}>
                    {t(props.locale, "action.open")}
                  </Link>
                </td>
              </tr>
            ))}
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
