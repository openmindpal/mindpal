"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

const PRESET_PURPOSES = [
  "intent.classify",
  "intent.analyze",
  "orchestrator.turn",
  "nl2ui.generate",
  "agent.loop.think",
  "agent.loop.think.fast",
  "agent.loop.decompose",
] as const;

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type RoutingPolicyRow = { purpose?: string; primaryModelRef?: string; fallbackModelRefs?: string[]; enabled?: boolean; updatedAt?: string };
type RoutingListResponse = ApiError & { policies?: RoutingPolicyRow[] };
type BindingRow = { modelRef?: string; provider?: string; model?: string };

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

function purposeLabel(locale: string, p: string) {
  const key = `gov.routing.purpose.${p}`;
  const v = t(locale, key);
  return v !== key ? v : p;
}

export default function RoutingClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<RoutingListResponse | null>((props.initial as RoutingListResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [purposeSelect, setPurposeSelect] = useState<string>("");
  const [customPurpose, setCustomPurpose] = useState<string>("");
  const [primaryModelRef, setPrimaryModelRef] = useState<string>("");
  const [fallbackText, setFallbackText] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean>(true);

  const [bindings, setBindings] = useState<BindingRow[]>([]);

  const purpose = purposeSelect === "__custom__" ? customPurpose : purposeSelect;

  const policies = useMemo(() => (Array.isArray(data?.policies) ? data!.policies! : []), [data]);

  /* Load model bindings on mount */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/models/bindings?limit=200`, { headers: apiHeaders(props.locale) });
        if (res.ok) {
          const json = await res.json() as { bindings?: BindingRow[] };
          setBindings(json.bindings ?? []);
        }
      } catch { /* ignore */ }
    })();
  }, [props.locale]);

  async function refresh() {
    setError("");
    const res = await fetch(`${API_BASE}/governance/model-gateway/routing?limit=200`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as RoutingListResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function upsert() {
    setError("");
    setBusy(true);
    try {
      const fallbacks = fallbackText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
      const res = await fetch(`${API_BASE}/governance/model-gateway/routing/${encodeURIComponent(purpose.trim())}`, {
        method: "PUT",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ primaryModelRef: primaryModelRef.trim(), fallbackModelRefs: fallbacks, enabled }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPurposeSelect("");
      setCustomPurpose("");
      setPrimaryModelRef("");
      setFallbackText("");
      setEnabled(true);
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function disable(p: string) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/governance/model-gateway/routing/${encodeURIComponent(p)}/disable`, {
        method: "POST",
        headers: apiHeaders(props.locale),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refresh();
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

  /* Description hint for selected purpose */
  const purposeDesc = useMemo(() => {
    if (!purposeSelect || purposeSelect === "__custom__") return "";
    const key = `gov.routing.purpose.${purposeSelect}.desc`;
    const v = t(props.locale, key);
    return v !== key ? v : "";
  }, [purposeSelect, props.locale]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.routing.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      <p style={{ color: "var(--sl-muted)", fontSize: 13, marginTop: 4, marginBottom: 0 }}>
        {t(props.locale, "gov.routing.subtitle")}
      </p>

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.routing.upsertTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 780 }}>
            {/* Purpose dropdown */}
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.routing.purpose")}</div>
              <select
                value={purposeSelect}
                onChange={(e) => { setPurposeSelect(e.target.value); setCustomPurpose(""); }}
                disabled={busy}
                style={{ padding: "6px 8px", borderRadius: 6 }}
              >
                <option value="">{t(props.locale, "gov.routing.purposePlaceholder")}</option>
                {PRESET_PURPOSES.map((p) => (
                  <option key={p} value={p}>{purposeLabel(props.locale, p)}</option>
                ))}
                <option value="__custom__">{t(props.locale, "gov.routing.purposeCustom")}</option>
              </select>
              {purposeSelect === "__custom__" && (
                <input
                  value={customPurpose}
                  onChange={(e) => setCustomPurpose(e.target.value)}
                  disabled={busy}
                  placeholder={t(props.locale, "gov.routing.purposePlaceholder")}
                  style={{ marginTop: 4 }}
                />
              )}
              {purposeDesc && (
                <p style={{ fontSize: 12, color: "var(--sl-muted)", margin: "2px 0 0" }}>{purposeDesc}</p>
              )}
            </label>

            {/* Primary model dropdown */}
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.routing.primaryModelRef")}</div>
              {bindings.length > 0 ? (
                <select
                  value={primaryModelRef}
                  onChange={(e) => setPrimaryModelRef(e.target.value)}
                  disabled={busy}
                  style={{ padding: "6px 8px", borderRadius: 6 }}
                >
                  <option value="">{t(props.locale, "gov.routing.modelRefPlaceholder")}</option>
                  {bindings.map((b) => (
                    <option key={b.modelRef} value={b.modelRef ?? ""}>
                      {b.modelRef}{b.provider ? ` (${b.provider}:${b.model ?? ""})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={primaryModelRef}
                  onChange={(e) => setPrimaryModelRef(e.target.value)}
                  disabled={busy}
                  placeholder={t(props.locale, "gov.routing.modelRefPlaceholder")}
                />
              )}
            </label>

            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.routing.fallbackModelRefs")}</div>
              <input value={fallbackText} onChange={(e) => setFallbackText(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.routing.fallbackPlaceholder")} />
            </label>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={busy} />
              <span>{t(props.locale, "gov.routing.enabled")}</span>
            </label>
            <div>
              <button onClick={upsert} disabled={busy || !purpose.trim() || !primaryModelRef.trim()}>
                {busy ? t(props.locale, "action.loading") : t(props.locale, "action.save")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>{t(props.locale, "gov.routing.listTitle")}</span>
              <Badge>{policies.length}</Badge>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.routing.purpose")}</th>
              <th align="left">{t(props.locale, "gov.routing.primaryModelRef")}</th>
              <th align="left">{t(props.locale, "gov.routing.fallbackModelRefs")}</th>
              <th align="left">{t(props.locale, "gov.routing.enabled")}</th>
              <th align="left">{t(props.locale, "gov.routing.updatedAt")}</th>
              <th align="left">{t(props.locale, "gov.routing.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {policies.map((p, idx) => (
              <tr key={`${p.purpose ?? "x"}:${idx}`}>
                <td>
                  <span>{purposeLabel(props.locale, p.purpose ?? "")}</span>
                  {p.purpose && purposeLabel(props.locale, p.purpose) !== p.purpose && (
                    <span style={{ fontSize: 11, color: "var(--sl-muted)", marginLeft: 6 }}>{p.purpose}</span>
                  )}
                </td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{p.primaryModelRef ?? "-"}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  {Array.isArray(p.fallbackModelRefs) ? p.fallbackModelRefs.join(", ") : ""}
                </td>
                <td>{String(Boolean(p.enabled))}</td>
                <td>{p.updatedAt ?? "-"}</td>
                <td>
                  {p.purpose ? (
                    <button onClick={() => disable(p.purpose!)} disabled={busy}>
                      {t(props.locale, "action.disable")}
                    </button>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}

