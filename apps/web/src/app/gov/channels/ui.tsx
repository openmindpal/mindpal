"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { Badge, Card, PageHeader, Table } from "@/components/ui";

type ApiError = { errorCode?: string; message?: unknown; traceId?: string };

function toApiError(e: unknown): ApiError {
  if (e && typeof e === "object") return e as ApiError;
  return { errorCode: "ERROR", message: String(e) };
}

function errText(locale: string, e: ApiError | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg = msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`.trim();
}

export default function GovChannelsClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [configs, setConfigs] = useState<{ status: number; json: any }>(props.initial?.configs ?? { status: 0, json: null });
  const [events, setEvents] = useState<{ status: number; json: any }>(props.initial?.events ?? { status: 0, json: null });

  const cfgItems = useMemo(() => (Array.isArray(configs?.json?.configs) ? configs.json.configs : []), [configs]);
  const evItems = useMemo(() => (Array.isArray(events?.json?.events) ? events.json.events : []), [events]);

  const [provider, setProvider] = useState("feishu");
  const [workspaceId, setWorkspaceId] = useState("");
  const [secretEnvKey, setSecretEnvKey] = useState("");
  const [secretId, setSecretId] = useState("");
  const [appIdEnvKey, setAppIdEnvKey] = useState("");
  const [appSecretEnvKey, setAppSecretEnvKey] = useState("");
  const [spaceId, setSpaceId] = useState("");

  const [channelChatId, setChannelChatId] = useState("");
  const [defaultSubjectId, setDefaultSubjectId] = useState("");

  const [channelUserId, setChannelUserId] = useState("");
  const [subjectId, setSubjectId] = useState("");

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(errText(props.locale, toApiError(e)));
    } finally {
      setBusy(false);
    }
  }

  const refreshConfigs = useCallback(async () => {
    const res = await fetch(`${API_BASE}/governance/channels/webhook/configs?limit=50`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json = await res.json().catch(() => null);
    setConfigs({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  const refreshEvents = useCallback(async () => {
    const res = await fetch(`${API_BASE}/governance/channels/ingress-events?status=deadletter&limit=20`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json = await res.json().catch(() => null);
    setEvents({ status: res.status, json });
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }));
  }, [props.locale]);

  useEffect(() => {
    refreshConfigs();
    refreshEvents();
  }, [refreshConfigs, refreshEvents]);

  async function saveConfig() {
    await runAction(async () => {
      const providerConfig: any = {};
      if (provider === "feishu") {
        if (appIdEnvKey.trim()) providerConfig.appIdEnvKey = appIdEnvKey.trim();
        if (appSecretEnvKey.trim()) providerConfig.appSecretEnvKey = appSecretEnvKey.trim();
      }
      const res = await fetch(`${API_BASE}/governance/channels/webhook/configs`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          spaceId: spaceId.trim() || undefined,
          secretEnvKey: secretEnvKey.trim() || undefined,
          secretId: secretId.trim() || undefined,
          providerConfig: Object.keys(providerConfig).length ? providerConfig : undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshConfigs();
    });
  }

  async function testConfig() {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/governance/channels/providers/test`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.trim(), workspaceId: workspaceId.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(JSON.stringify(json ?? {}, null, 2));
    });
  }

  async function saveChatBinding() {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/governance/channels/chats`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          channelChatId: channelChatId.trim(),
          spaceId: spaceId.trim(),
          defaultSubjectId: defaultSubjectId.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEvents();
    });
  }

  async function saveAccountBinding() {
    await runAction(async () => {
      const res = await fetch(`${API_BASE}/governance/channels/accounts`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          channelUserId: channelUserId.trim(),
          subjectId: subjectId.trim(),
          spaceId: spaceId.trim(),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEvents();
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.channels.title")}
        actions={
          <>
            <Badge>{configs.status || 0}</Badge>
            <button onClick={refreshConfigs} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />
      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {info ? <pre style={{ color: "inherit", whiteSpace: "pre-wrap" }}>{info}</pre> : null}

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.channels.configTitle")}>
          <div style={{ display: "grid", gap: 10, maxWidth: 920 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.provider")}</div>
              <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy}>
                <option value="feishu">feishu</option>
                <option value="dingtalk">dingtalk</option>
                <option value="wecom">wecom</option>
                <option value="slack">slack</option>
                <option value="discord">discord</option>
                <option value="qq.onebot">qq.onebot</option>
                <option value="imessage.bridge">imessage.bridge</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.workspaceId")}</div>
              <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.spaceId")}</div>
              <input value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.secretEnvKey")}</div>
              <input value={secretEnvKey} onChange={(e) => setSecretEnvKey(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.secretId")}</div>
              <input value={secretId} onChange={(e) => setSecretId(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.feishu.appIdEnvKey")}</div>
              <input value={appIdEnvKey} onChange={(e) => setAppIdEnvKey(e.target.value)} disabled={busy} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <div>{t(props.locale, "gov.channels.feishu.appSecretEnvKey")}</div>
              <input value={appSecretEnvKey} onChange={(e) => setAppSecretEnvKey(e.target.value)} disabled={busy} />
            </label>
            <div>
              <button onClick={saveConfig} disabled={busy || !provider.trim() || !workspaceId.trim() || (!secretEnvKey.trim() && !secretId.trim())}>
                {t(props.locale, "action.save")}
              </button>
              <button onClick={testConfig} disabled={busy || !provider.trim() || !workspaceId.trim()} style={{ marginLeft: 8 }}>
                {t(props.locale, "action.test")}
              </button>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.channels.mappingTitle")}>
          <div style={{ display: "grid", gap: 16, maxWidth: 920 }}>
            <div style={{ display: "grid", gap: 10 }}>
              <div>{t(props.locale, "gov.channels.chatBinding")}</div>
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.channels.channelChatId")}</div>
                <input value={channelChatId} onChange={(e) => setChannelChatId(e.target.value)} disabled={busy} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.channels.defaultSubjectId")}</div>
                <input value={defaultSubjectId} onChange={(e) => setDefaultSubjectId(e.target.value)} disabled={busy} />
              </label>
              <div>
                <button onClick={saveChatBinding} disabled={busy || !workspaceId.trim() || !spaceId.trim() || !channelChatId.trim()}>
                  {t(props.locale, "action.save")}
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: 10 }}>
              <div>{t(props.locale, "gov.channels.accountBinding")}</div>
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.channels.channelUserId")}</div>
                <input value={channelUserId} onChange={(e) => setChannelUserId(e.target.value)} disabled={busy} />
              </label>
              <label style={{ display: "grid", gap: 6 }}>
                <div>{t(props.locale, "gov.channels.subjectId")}</div>
                <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} />
              </label>
              <div>
                <button onClick={saveAccountBinding} disabled={busy || !workspaceId.trim() || !spaceId.trim() || !channelUserId.trim() || !subjectId.trim()}>
                  {t(props.locale, "action.save")}
                </button>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <Card title={t(props.locale, "gov.channels.configsListTitle")}>
          <Table>
            <thead>
              <tr>
                <th>provider</th>
                <th>workspaceId</th>
                <th>secretEnvKey</th>
                <th>secretId</th>
                <th>deliveryMode</th>
              </tr>
            </thead>
            <tbody>
              {cfgItems.map((c: any, idx: number) => (
                <tr key={String(c.workspaceId ?? idx)}>
                  <td>{String(c.provider ?? "")}</td>
                  <td>{String(c.workspaceId ?? "")}</td>
                  <td>{String(c.secretEnvKey ?? "")}</td>
                  <td>{String(c.secretId ?? "")}</td>
                  <td>{String(c.deliveryMode ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <div style={{ marginTop: 16 }}>
        <PageHeader
          title={t(props.locale, "gov.channels.ingressTitle")}
          actions={
            <>
              <Badge>{events.status || 0}</Badge>
              <button onClick={refreshEvents} disabled={busy}>
                {t(props.locale, "action.refresh")}
              </button>
            </>
          }
        />
        <Card title={t(props.locale, "gov.channels.ingressDeadletterTitle")}>
          <Table>
            <thead>
              <tr>
                <th>provider</th>
                <th>workspaceId</th>
                <th>eventId</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {evItems.map((e: any, idx: number) => (
                <tr key={String(e.id ?? e.eventId ?? idx)}>
                  <td>{String(e.provider ?? "")}</td>
                  <td>{String(e.workspaceId ?? "")}</td>
                  <td>{String(e.eventId ?? "")}</td>
                  <td>{String(e.status ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
