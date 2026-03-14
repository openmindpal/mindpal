"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ToolRollout = { scope_type?: string; scope_id?: string; tool_ref?: string; enabled?: boolean; created_at?: string; updated_at?: string };
type ActiveToolRef = { name?: string; active_tool_ref?: string; updated_at?: string };
type GovernanceToolsResponse = ApiError & { rollouts?: ToolRollout[]; actives?: ActiveToolRef[] };
type NetworkPolicy = ApiError & {
  tenantId?: string;
  scopeType?: "tenant" | "space";
  scopeId?: string;
  toolRef?: string;
  allowedDomains?: string[];
  updatedAt?: string;
};
type NetworkPoliciesResponse = ApiError & { items?: NetworkPolicy[] };

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

export default function GovToolsClient(props: { locale: string; initial: unknown; initialStatus: number }) {
  const [data, setData] = useState<GovernanceToolsResponse | null>((props.initial as GovernanceToolsResponse) ?? null);
  const [status, setStatus] = useState<number>(props.initialStatus);
  const [scope, setScope] = useState<"" | "space" | "tenant">("");
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const [toolRef, setToolRef] = useState<string>("");
  const [rolloutScope, setRolloutScope] = useState<"space" | "tenant">("space");
  const [toolName, setToolName] = useState<string>("");
  const [activeToolRef, setActiveToolRef] = useState<string>("");

  const [npStatus, setNpStatus] = useState<number>(0);
  const [npScopeType, setNpScopeType] = useState<"space" | "tenant">("space");
  const [npLimit, setNpLimit] = useState<string>("50");
  const [npData, setNpData] = useState<NetworkPoliciesResponse | null>(null);
  const [npToolRef, setNpToolRef] = useState<string>("");
  const [npEditScopeType, setNpEditScopeType] = useState<"space" | "tenant">("space");
  const [npAllowedDomainsText, setNpAllowedDomainsText] = useState<string>("");

  const rollouts = useMemo(() => (Array.isArray(data?.rollouts) ? data!.rollouts! : []), [data]);
  const actives = useMemo(() => (Array.isArray(data?.actives) ? data!.actives! : []), [data]);
  const npItems = useMemo(() => (Array.isArray(npData?.items) ? npData!.items! : []), [npData]);

  async function refresh() {
    setError("");
    const q = new URLSearchParams();
    if (scope) q.set("scope", scope);
    const res = await fetch(`${API_BASE}/governance/tools${q.toString() ? `?${q.toString()}` : ""}`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setData((json as GovernanceToolsResponse) ?? null);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }

  async function runAction(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const refreshNetworkPolicies = useCallback(
    async (nextScopeType?: "space" | "tenant") => {
      setError("");
      const q = new URLSearchParams();
      q.set("scopeType", nextScopeType ?? npScopeType);
      const n = Number(npLimit);
      q.set("limit", String(Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50));
      const res = await fetch(`${API_BASE}/governance/tools/network-policies?${q.toString()}`, { headers: apiHeaders(props.locale), cache: "no-store" });
      setNpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      setNpData((json as NetworkPoliciesResponse) ?? null);
      if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
    },
    [npLimit, npScopeType, props.locale],
  );

  async function runNpAction(fn: () => Promise<unknown>) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refreshNetworkPolicies();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  async function loadNetworkPolicy() {
    await runNpAction(async () => {
      const ref = npToolRef.trim();
      const res = await fetch(
        `${API_BASE}/governance/tools/${encodeURIComponent(ref)}/network-policy?scopeType=${encodeURIComponent(npEditScopeType)}`,
        { headers: apiHeaders(props.locale), cache: "no-store" },
      );
      setNpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const p = (json as NetworkPolicy) ?? {};
      const allowed = Array.isArray(p.allowedDomains) ? p.allowedDomains : [];
      setNpAllowedDomainsText(allowed.join("\n"));
      return json;
    });
  }

  async function saveNetworkPolicy() {
    await runNpAction(async () => {
      const ref = npToolRef.trim();
      const allowedDomains = npAllowedDomainsText
        .split(/\r?\n/g)
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await fetch(`${API_BASE}/governance/tools/${encodeURIComponent(ref)}/network-policy`, {
        method: "PUT",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ scopeType: npEditScopeType, allowedDomains }),
      });
      setNpStatus(res.status);
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function enableDisable(enabled: boolean) {
    await runAction(async () => {
      const path = enabled ? "enable" : "disable";
      const res = await fetch(`${API_BASE}/governance/tools/${encodeURIComponent(toolRef.trim())}/${path}`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ scope: rolloutScope }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  async function setActive() {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/governance/tools/${encodeURIComponent(toolName.trim())}/active`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ toolRef: activeToolRef.trim() }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      return json;
    });
  }

  const initialError = useMemo(() => {
    if (status >= 400) return errText(props.locale, data);
    return "";
  }, [data, props.locale, status]);

  useEffect(() => {
    refreshNetworkPolicies("space");
  }, [refreshNetworkPolicies]);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.tools.title")}
        actions={
          <>
            <Badge>{status}</Badge>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.tools.filterTitle")}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span>{t(props.locale, "gov.tools.scope")}</span>
              <select value={scope} onChange={(e) => setScope(e.target.value === "tenant" ? "tenant" : e.target.value === "space" ? "space" : "")} disabled={busy}>
                <option value="">{t(props.locale, "gov.tools.scopeAll")}</option>
                <option value="space">space</option>
                <option value="tenant">tenant</option>
              </select>
            </label>
            <button onClick={refresh} disabled={busy}>
              {t(props.locale, "action.apply")}
            </button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.tools.rolloutActionsTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.toolRef")}</div>
              <input value={toolRef} onChange={(e) => setToolRef(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.scope")}</div>
              <select value={rolloutScope} onChange={(e) => setRolloutScope(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                <option value="space">space</option>
                <option value="tenant">tenant</option>
              </select>
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => enableDisable(true)} disabled={busy || !toolRef.trim()}>
                {t(props.locale, "gov.tools.enable")}
              </button>
              <button onClick={() => enableDisable(false)} disabled={busy || !toolRef.trim()}>
                {t(props.locale, "gov.tools.disable")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.tools.activeActionsTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.toolName")}</div>
              <input value={toolName} onChange={(e) => setToolName(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.activeToolRef")}</div>
              <input value={activeToolRef} onChange={(e) => setActiveToolRef(e.target.value)} disabled={busy} />
            </label>
            <div>
              <button onClick={setActive} disabled={busy || !toolName.trim() || !activeToolRef.trim()}>
                {t(props.locale, "gov.tools.setActive")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.tools.networkPolicyTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.networkPolicyScopeType")}</div>
              <select value={npEditScopeType} onChange={(e) => setNpEditScopeType(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                <option value="space">space</option>
                <option value="tenant">tenant</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.networkPolicyToolRef")}</div>
              <input value={npToolRef} onChange={(e) => setNpToolRef(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.tools.networkPolicyAllowedDomains")}</div>
              <textarea rows={6} value={npAllowedDomainsText} onChange={(e) => setNpAllowedDomainsText(e.target.value)} disabled={busy} />
            </label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={loadNetworkPolicy} disabled={busy || !npToolRef.trim()}>
                {t(props.locale, "gov.tools.networkPolicyLoad")}
              </button>
              <button onClick={saveNetworkPolicy} disabled={busy || !npToolRef.trim()}>
                {t(props.locale, "gov.tools.networkPolicySave")}
              </button>
              {npStatus ? <Badge>{npStatus}</Badge> : null}
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table
          header={
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>{t(props.locale, "gov.tools.networkPoliciesTitle")}</span>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span>{t(props.locale, "gov.tools.networkPolicyScopeType")}</span>
                  <select value={npScopeType} onChange={(e) => setNpScopeType(e.target.value === "tenant" ? "tenant" : "space")} disabled={busy}>
                    <option value="space">space</option>
                    <option value="tenant">tenant</option>
                  </select>
                </label>
                <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span>limit</span>
                  <input value={npLimit} onChange={(e) => setNpLimit(e.target.value)} disabled={busy} style={{ width: 80 }} />
                </label>
                <button onClick={() => refreshNetworkPolicies()} disabled={busy}>
                  {t(props.locale, "action.refresh")}
                </button>
              </div>
            </div>
          }
        >
          <thead>
            <tr>
              <th align="left">toolRef</th>
              <th align="left">{t(props.locale, "gov.tools.allowedDomainsCount")}</th>
              <th align="left">{t(props.locale, "gov.tools.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {npItems.map((p, idx) => (
              <tr key={`${p.toolRef ?? "x"}:${idx}`}>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{p.toolRef ?? "-"}</td>
                <td>{Array.isArray(p.allowedDomains) ? p.allowedDomains.length : "-"}</td>
                <td>{p.updatedAt ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "gov.tools.rolloutsTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">scope</th>
              <th align="left">toolRef</th>
              <th align="left">{t(props.locale, "gov.tools.enabled")}</th>
              <th align="left">{t(props.locale, "gov.tools.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {rollouts.map((r, idx) => (
              <tr key={`${r.tool_ref ?? "x"}:${idx}`}>
                <td>
                  {r.scope_type ?? "-"}:{r.scope_id ?? "-"}
                </td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{r.tool_ref ?? "-"}</td>
                <td>{String(r.enabled ?? false)}</td>
                <td>{r.updated_at ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <div style={{ marginTop: 16 }}>
        <Table header={<span>{t(props.locale, "gov.tools.activesTitle")}</span>}>
          <thead>
            <tr>
              <th align="left">{t(props.locale, "gov.tools.toolName")}</th>
              <th align="left">{t(props.locale, "gov.tools.activeToolRef")}</th>
              <th align="left">{t(props.locale, "gov.tools.updatedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {actives.map((a, idx) => (
              <tr key={`${a.name ?? "x"}:${idx}`}>
                <td>{a.name ?? "-"}</td>
                <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{a.active_tool_ref ?? "-"}</td>
                <td>{a.updated_at ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
