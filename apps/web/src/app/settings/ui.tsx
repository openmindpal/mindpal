"use client";

import { useEffect, useState } from "react";
import { API_BASE, apiHeaders, getClientAuthToken, setClientAuthToken, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };
type ModelCatalogRes = { catalog: unknown[] };
type ModelBindingsRes = { bindings: unknown[] };
type ConnectorInstance = { id: string };
type ConnectorInstancesRes = { instances: ConnectorInstance[] };
type Secret = { id: string };
type SecretsRes = { secrets: Secret[] };
type Subscription = { subscriptionId: string; provider?: string; status?: string };
type SubscriptionsRes = { subscriptions: Subscription[] };
type ToolItem = { name: string; scope?: string; resourceType?: string; action?: string; effectiveActiveToolRef?: string | null };
type ToolsRes = { tools: ToolItem[] };

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

function parseErr(json: unknown, locale: string) {
  const o = json && typeof json === "object" ? (json as ApiError) : {};
  const errorCode = String(o.errorCode ?? "ERROR");
  const msgVal = o.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const traceId = o.traceId ? ` traceId=${String(o.traceId)}` : "";
  return `${errorCode}: ${msg}${traceId}`.trim();
}

export default function SettingsClient(props: { locale: string }) {
  const [authToken, setAuthToken] = useState<string>(() => getClientAuthToken());
  const [authTokenStatus, setAuthTokenStatus] = useState<"unset" | "set">(() => (getClientAuthToken() ? "set" : "unset"));

  const [catalog, setCatalog] = useState<ModelCatalogRes | null>(null);
  const [bindings, setBindings] = useState<ModelBindingsRes | null>(null);
  const [instances, setInstances] = useState<ConnectorInstancesRes | null>(null);
  const [secrets, setSecrets] = useState<SecretsRes | null>(null);
  const [subs, setSubs] = useState<SubscriptionsRes | null>(null);
  const [tools, setTools] = useState<ToolsRes | null>(null);

  const [modelRef, setModelRef] = useState<string>("mock:default");
  const [bindConnectorInstanceId, setBindConnectorInstanceId] = useState<string>("");
  const [bindSecretId, setBindSecretId] = useState<string>("");

  const [newConnectorName, setNewConnectorName] = useState<string>("mock-connector");
  const [newConnectorTypeName, setNewConnectorTypeName] = useState<string>("model.mock");
  const [newConnectorAllowedDomains, setNewConnectorAllowedDomains] = useState<string>("api.mock.local");

  const [newSecretConnectorInstanceId, setNewSecretConnectorInstanceId] = useState<string>("");
  const [newSecretPayloadText, setNewSecretPayloadText] = useState<string>('{"apiKey":"replace-me"}');

  const [newSubProvider, setNewSubProvider] = useState<string>("mock");
  const [newSubConnectorInstanceId, setNewSubConnectorInstanceId] = useState<string>("");
  const [newSubPollIntervalSec, setNewSubPollIntervalSec] = useState<string>("60");

  const [consoleErr, setConsoleErr] = useState<string>("");
  const [modelStatus, setModelStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [channelsStatus, setChannelsStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [schedulesStatus, setSchedulesStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [toolsStatus, setToolsStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [hubCaps, setHubCaps] = useState<{ model: boolean; channels: boolean; schedules: boolean; tools: boolean } | null>(null);

  function statusText(v: string) {
    const key = `status.${v}`;
    const out = t(props.locale, key);
    return out === key ? v : out;
  }

  async function fetchJson(url: string, init?: RequestInit) {
    const res = await fetch(url, { ...init, headers: { ...apiHeaders(props.locale), ...(init?.headers ?? {}) }, cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(parseErr(json, props.locale) || res.statusText);
    return json;
  }

  async function probeAllowed(url: string) {
    const res = await fetch(url, { headers: apiHeaders(props.locale), cache: "no-store" });
    if (res.status === 401 || res.status === 403) return false;
    return true;
  }

  function jumpTo(id: string) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [model, channels, schedules, tools] = await Promise.all([
          probeAllowed(`${API_BASE}/models/bindings`),
          probeAllowed(`${API_BASE}/connectors/instances`),
          probeAllowed(`${API_BASE}/subscriptions`),
          probeAllowed(`${API_BASE}/tools`),
        ]);
        if (!cancelled) setHubCaps({ model, channels, schedules, tools });
      } catch {
        if (!cancelled) setHubCaps({ model: true, channels: true, schedules: true, tools: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.locale]);

  function saveToken() {
    const v = authToken.trim();
    setClientAuthToken(v);
    setAuthToken(v);
    setAuthTokenStatus(v ? "set" : "unset");
    setConsoleErr("");
  }

  function clearToken() {
    setClientAuthToken("");
    setAuthToken("");
    setAuthTokenStatus("unset");
    setConsoleErr("");
  }

  async function refreshModels() {
    setConsoleErr("");
    setModelStatus("loading");
    try {
      const [c, b] = await Promise.all([fetchJson(`${API_BASE}/models/catalog`), fetchJson(`${API_BASE}/models/bindings`)]);
      setCatalog(c as ModelCatalogRes);
      setBindings(b as ModelBindingsRes);
      setModelStatus("ready");
    } catch (e: unknown) {
      setModelStatus("idle");
      setConsoleErr(errMsg(e));
    }
  }

  async function refreshChannels() {
    setConsoleErr("");
    setChannelsStatus("loading");
    try {
      const [i, s] = await Promise.all([fetchJson(`${API_BASE}/connectors/instances`), fetchJson(`${API_BASE}/secrets`)]);
      setInstances(i as ConnectorInstancesRes);
      setSecrets(s as SecretsRes);
      setChannelsStatus("ready");
    } catch (e: unknown) {
      setChannelsStatus("idle");
      setConsoleErr(errMsg(e));
    }
  }

  async function refreshSchedules() {
    setConsoleErr("");
    setSchedulesStatus("loading");
    try {
      const sub = await fetchJson(`${API_BASE}/subscriptions`);
      setSubs(sub as SubscriptionsRes);
      setSchedulesStatus("ready");
    } catch (e: unknown) {
      setSchedulesStatus("idle");
      setConsoleErr(errMsg(e));
    }
  }

  async function refreshTools() {
    setConsoleErr("");
    setToolsStatus("loading");
    try {
      const tt = await fetchJson(`${API_BASE}/tools`);
      setTools(tt as ToolsRes);
      setToolsStatus("ready");
    } catch (e: unknown) {
      setToolsStatus("idle");
      setConsoleErr(errMsg(e));
    }
  }

  async function refreshConsoleAll() {
    await Promise.all([refreshModels(), refreshChannels(), refreshSchedules(), refreshTools()]);
  }

  async function createBinding() {
    setConsoleErr("");
    try {
      const body = { modelRef, connectorInstanceId: bindConnectorInstanceId, secretId: bindSecretId };
      await fetchJson(`${API_BASE}/models/bindings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refreshConsoleAll();
    } catch (e: unknown) {
      setConsoleErr(errMsg(e));
    }
  }

  async function createConnectorInstance() {
    setConsoleErr("");
    try {
      const allowedDomains = newConnectorAllowedDomains
        .split(/[,\s]+/g)
        .map((s) => s.trim())
        .filter(Boolean);
      const body = { name: newConnectorName, typeName: newConnectorTypeName, egressPolicy: { allowedDomains } };
      const out = await fetchJson(`${API_BASE}/connectors/instances`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const createdId = String(out?.instance?.id ?? "");
      if (createdId) {
        setBindConnectorInstanceId(createdId);
        setNewSecretConnectorInstanceId(createdId);
        setNewSubConnectorInstanceId(createdId);
      }
      await refreshConsoleAll();
    } catch (e: unknown) {
      setConsoleErr(errMsg(e));
    }
  }

  async function createSecret() {
    setConsoleErr("");
    try {
      const payload = newSecretPayloadText.trim() ? JSON.parse(newSecretPayloadText) : {};
      const body = { connectorInstanceId: newSecretConnectorInstanceId, payload };
      const out = await fetchJson(`${API_BASE}/secrets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const createdId = String(out?.secret?.id ?? "");
      if (createdId) setBindSecretId(createdId);
      await refreshConsoleAll();
    } catch (e: unknown) {
      setConsoleErr(errMsg(e));
    }
  }

  async function createSubscription() {
    setConsoleErr("");
    try {
      const pollIntervalSec = Number(newSubPollIntervalSec);
      const body: { provider: string; connectorInstanceId?: string; pollIntervalSec?: number } = { provider: newSubProvider };
      if (newSubConnectorInstanceId.trim()) body.connectorInstanceId = newSubConnectorInstanceId.trim();
      if (Number.isFinite(pollIntervalSec) && pollIntervalSec > 0) body.pollIntervalSec = pollIntervalSec;
      await fetchJson(`${API_BASE}/subscriptions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refreshConsoleAll();
    } catch (e: unknown) {
      setConsoleErr(errMsg(e));
    }
  }

  async function setSubscriptionEnabled(subscriptionId: string, enabled: boolean) {
    setConsoleErr("");
    try {
      const url = `${API_BASE}/subscriptions/${encodeURIComponent(subscriptionId)}/${enabled ? "enable" : "disable"}`;
      await fetchJson(url, { method: "POST" });
      await refreshConsoleAll();
    } catch (e: unknown) {
      setConsoleErr(errMsg(e));
    }
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "settings.title")}
        actions={
          <button onClick={refreshConsoleAll}>{t(props.locale, "settings.mode.refreshConsole")}</button>
        }
      />
      {consoleErr ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{consoleErr}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card
          title={t(props.locale, "settings.section.auth")}
          footer={
            <span>
              {t(props.locale, "settings.auth.hint")}
              {" · "}
              <Badge tone={authTokenStatus === "set" ? "success" : "warning"}>{statusText(authTokenStatus)}</Badge>
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span>{t(props.locale, "settings.auth.tokenLabel")}</span>
            <input
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              placeholder={t(props.locale, "settings.auth.tokenPlaceholder")}
              style={{ width: 520 }}
            />
            <button onClick={saveToken}>{t(props.locale, "action.save")}</button>
            <button onClick={clearToken}>{t(props.locale, "action.clear")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "settings.hub.title")} footer={<span>{t(props.locale, "settings.hub.hint")}</span>}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <strong>{t(props.locale, "settings.section.modelBindings")}</strong>
                {hubCaps && !hubCaps.model ? <Badge tone="danger">{t(props.locale, "settings.hub.denied")}</Badge> : null}
              </div>
              <div style={{ marginTop: 6, opacity: 0.85 }}>{t(props.locale, "settings.hub.modelDesc")}</div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => jumpTo("model-bindings")} disabled={Boolean(hubCaps && !hubCaps.model)}>
                  {t(props.locale, "settings.hub.open")}
                </button>
              </div>
            </div>

            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <strong>{t(props.locale, "settings.section.channels")}</strong>
                {hubCaps && !hubCaps.channels ? <Badge tone="danger">{t(props.locale, "settings.hub.denied")}</Badge> : null}
              </div>
              <div style={{ marginTop: 6, opacity: 0.85 }}>{t(props.locale, "settings.hub.channelsDesc")}</div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => jumpTo("channels")} disabled={Boolean(hubCaps && !hubCaps.channels)}>
                  {t(props.locale, "settings.hub.open")}
                </button>
              </div>
            </div>

            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <strong>{t(props.locale, "settings.section.schedules")}</strong>
                {hubCaps && !hubCaps.schedules ? <Badge tone="danger">{t(props.locale, "settings.hub.denied")}</Badge> : null}
              </div>
              <div style={{ marginTop: 6, opacity: 0.85 }}>{t(props.locale, "settings.hub.schedulesDesc")}</div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => jumpTo("schedules")} disabled={Boolean(hubCaps && !hubCaps.schedules)}>
                  {t(props.locale, "settings.hub.open")}
                </button>
              </div>
            </div>

            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                <strong>{t(props.locale, "settings.section.tools")}</strong>
                {hubCaps && !hubCaps.tools ? <Badge tone="danger">{t(props.locale, "settings.hub.denied")}</Badge> : null}
              </div>
              <div style={{ marginTop: 6, opacity: 0.85 }}>{t(props.locale, "settings.hub.toolsDesc")}</div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => jumpTo("tools")} disabled={Boolean(hubCaps && !hubCaps.tools)}>
                  {t(props.locale, "settings.hub.open")}
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <div id="model-bindings" />
        <Card
          title={t(props.locale, "settings.section.modelBindings")}
          footer={
            <span>
              {t(props.locale, "settings.model.catalogLabel")}
              {Array.isArray(catalog?.catalog) ? `${catalog.catalog.length}` : "-"}
              {" · "}
              {t(props.locale, "settings.model.bindingsLabel")}
              {Array.isArray(bindings?.bindings) ? `${bindings.bindings.length}` : "-"}
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button onClick={refreshModels} disabled={modelStatus === "loading"}>
              {modelStatus === "loading" ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
            <Badge tone={modelStatus === "ready" ? "success" : "neutral"}>{statusText(modelStatus)}</Badge>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span>{t(props.locale, "settings.modelBindings.form.modelRef")}</span>
            <input value={modelRef} onChange={(e) => setModelRef(e.target.value)} style={{ width: 220 }} />
            <span>{t(props.locale, "settings.modelBindings.form.connectorInstanceId")}</span>
            <input value={bindConnectorInstanceId} onChange={(e) => setBindConnectorInstanceId(e.target.value)} style={{ width: 260 }} />
            <span>{t(props.locale, "settings.modelBindings.form.secretId")}</span>
            <input value={bindSecretId} onChange={(e) => setBindSecretId(e.target.value)} style={{ width: 260 }} />
            <button onClick={createBinding}>{t(props.locale, "settings.action.createBinding")}</button>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <div id="channels" />
        <Card
          title={t(props.locale, "settings.section.channels")}
          footer={
            <span>
              {t(props.locale, "settings.channels.instancesLabel")}
              {Array.isArray(instances?.instances) ? `${instances.instances.length}` : "-"}
              {" · "}
              {t(props.locale, "settings.channels.secretsLabel")}
              {Array.isArray(secrets?.secrets) ? `${secrets.secrets.length}` : "-"}
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button onClick={refreshChannels} disabled={channelsStatus === "loading"}>
              {channelsStatus === "loading" ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
            <Badge tone={channelsStatus === "ready" ? "success" : "neutral"}>{statusText(channelsStatus)}</Badge>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "settings.channels.createConnectorInstance")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>{t(props.locale, "settings.channels.form.name")}</span>
              <input value={newConnectorName} onChange={(e) => setNewConnectorName(e.target.value)} style={{ width: 200 }} />
              <span>{t(props.locale, "settings.channels.form.typeName")}</span>
              <input value={newConnectorTypeName} onChange={(e) => setNewConnectorTypeName(e.target.value)} style={{ width: 200 }} />
              <span>{t(props.locale, "settings.channels.form.allowedDomains")}</span>
              <input value={newConnectorAllowedDomains} onChange={(e) => setNewConnectorAllowedDomains(e.target.value)} style={{ width: 260 }} />
              <button onClick={createConnectorInstance}>{t(props.locale, "settings.action.create")}</button>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "settings.channels.createSecret")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
              <span>{t(props.locale, "settings.channels.form.connectorInstanceId")}</span>
              <input value={newSecretConnectorInstanceId} onChange={(e) => setNewSecretConnectorInstanceId(e.target.value)} style={{ width: 260 }} />
              <button onClick={createSecret}>{t(props.locale, "settings.action.create")}</button>
            </div>
            <textarea
              rows={4}
              value={newSecretPayloadText}
              onChange={(e) => setNewSecretPayloadText(e.target.value)}
              style={{ width: "100%", maxWidth: 980, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
            />
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <div id="schedules" />
        <Card
          title={t(props.locale, "settings.section.schedules")}
          footer={
            <span>
              {t(props.locale, "settings.schedules.subscriptionsLabel")}
              {Array.isArray(subs?.subscriptions) ? `${subs.subscriptions.length}` : "-"}
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button onClick={refreshSchedules} disabled={schedulesStatus === "loading"}>
              {schedulesStatus === "loading" ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
            <Badge tone={schedulesStatus === "ready" ? "success" : "neutral"}>{statusText(schedulesStatus)}</Badge>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "settings.subscriptions.createTitle")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span>{t(props.locale, "settings.schedules.form.provider")}</span>
              <input value={newSubProvider} onChange={(e) => setNewSubProvider(e.target.value)} style={{ width: 140 }} />
              <span>{t(props.locale, "settings.schedules.form.connectorInstanceId")}</span>
              <input value={newSubConnectorInstanceId} onChange={(e) => setNewSubConnectorInstanceId(e.target.value)} style={{ width: 260 }} />
              <span>{t(props.locale, "settings.schedules.form.pollIntervalSec")}</span>
              <input value={newSubPollIntervalSec} onChange={(e) => setNewSubPollIntervalSec(e.target.value)} style={{ width: 100 }} />
              <button onClick={createSubscription}>{t(props.locale, "settings.action.create")}</button>
            </div>
          </div>

          {Array.isArray(subs?.subscriptions) && subs.subscriptions.length ? (
            <Table>
              <thead>
                <tr>
                  <th align="left">{t(props.locale, "settings.schedules.table.subscriptionId")}</th>
                  <th align="left">{t(props.locale, "settings.schedules.table.provider")}</th>
                  <th align="left">{t(props.locale, "settings.schedules.table.status")}</th>
                  <th align="left">{t(props.locale, "settings.schedules.table.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {subs.subscriptions.map((s: Subscription) => (
                  <tr key={s.subscriptionId}>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{s.subscriptionId}</td>
                    <td>{s.provider}</td>
                    <td>{s.status ? statusText(s.status) : "-"}</td>
                    <td>
                      <button onClick={() => setSubscriptionEnabled(s.subscriptionId, true)} disabled={s.status === "enabled"}>
                        {t(props.locale, "settings.action.enable")}
                      </button>
                      <button onClick={() => setSubscriptionEnabled(s.subscriptionId, false)} disabled={s.status === "disabled"} style={{ marginLeft: 8 }}>
                        {t(props.locale, "settings.action.disable")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <div id="tools" />
        <Card
          title={t(props.locale, "settings.section.tools")}
          footer={
            <span>
              {t(props.locale, "settings.tools.countLabel")}
              {Array.isArray(tools?.tools) ? `${tools.tools.length}` : "-"}
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button onClick={refreshTools} disabled={toolsStatus === "loading"}>
              {toolsStatus === "loading" ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
            <Badge tone={toolsStatus === "ready" ? "success" : "neutral"}>{statusText(toolsStatus)}</Badge>
          </div>
          {Array.isArray(tools?.tools) && tools.tools.length ? (
            <Table>
              <thead>
                <tr>
                  <th align="left">{t(props.locale, "settings.tools.table.name")}</th>
                  <th align="left">{t(props.locale, "settings.tools.table.scope")}</th>
                  <th align="left">{t(props.locale, "settings.tools.table.resourceType")}</th>
                  <th align="left">{t(props.locale, "settings.tools.table.action")}</th>
                  <th align="left">{t(props.locale, "settings.tools.table.effectiveActiveToolRef")}</th>
                </tr>
              </thead>
              <tbody>
                {tools.tools.map((tt: ToolItem) => (
                  <tr key={tt.name}>
                    <td>{tt.name}</td>
                    <td>{tt.scope}</td>
                    <td>{tt.resourceType}</td>
                    <td>{tt.action}</td>
                    <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>{tt.effectiveActiveToolRef ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
