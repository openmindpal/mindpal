"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table, StatusBadge, TabNav, EmptyState } from "@/components/ui";

const PROVIDER_KEYS = ["feishu", "dingtalk", "wecom", "slack", "discord", "qq.onebot", "imessage.bridge"] as const;

function formatApiError(err: any, locale?: string): string {
  if (err?.response?.data) {
    const d = err.response.data;
    if (typeof d.message === "string") return d.message;
    if (typeof d.errorCode === "string") return d.errorCode;
    if (typeof d === "string") return d;
  }
  if (err?.message) return String(err.message);
  return t(locale, "gov.channels.operationFailed");
}

export default function GovChannelsClient(props: { locale: string; initial: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [configs, setConfigs] = useState<{ status: number; json: any }>(props.initial?.configs ?? { status: 0, json: null });
  const [events, setEvents] = useState<{ status: number; json: any }>(props.initial?.events ?? { status: 0, json: null });
  const [outbox, setOutbox] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const [outboxStatus, setOutboxStatus] = useState<string>("deadletter");

  const cfgItems = useMemo(() => (Array.isArray(configs?.json?.configs) ? configs.json.configs : []), [configs]);
  const evItems = useMemo(() => (Array.isArray(events?.json?.events) ? events.json.events : []), [events]);
  const outboxItems = useMemo(() => (Array.isArray(outbox?.json?.messages) ? outbox.json.messages : []), [outbox]);

  const pageSize = 20;
  const [cfgPage, setCfgPage] = useState(0);
  const cfgTotalPages = Math.max(1, Math.ceil(cfgItems.length / pageSize));
  const cfgPaged = useMemo(() => cfgItems.slice(cfgPage * pageSize, (cfgPage + 1) * pageSize), [cfgItems, cfgPage]);

  const [evPage, setEvPage] = useState(0);
  const evTotalPages = Math.max(1, Math.ceil(evItems.length / pageSize));
  const evPaged = useMemo(() => evItems.slice(evPage * pageSize, (evPage + 1) * pageSize), [evItems, evPage]);

  const [outPage, setOutPage] = useState(0);
  const outTotalPages = Math.max(1, Math.ceil(outboxItems.length / pageSize));
  const outPaged = useMemo(() => outboxItems.slice(outPage * pageSize, (outPage + 1) * pageSize), [outboxItems, outPage]);

  const spacesList = useMemo<Array<{ id: string; name: string | null }>>(() => {
    const raw = props.initial?.spaces;
    return Array.isArray(raw?.spaces) ? raw.spaces : [];
  }, [props.initial]);

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

  const [bindingResult, setBindingResult] = useState<{ authorizeUrl: string; expiresAt: string; bindingId: string } | null>(null);
  const [bindingStates, setBindingStates] = useState<any[]>([]);
  const [bindingCopied, setBindingCopied] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);

  const hasExistingConfig = cfgItems.length > 0;
  const configExistsForCurrentProvider = cfgItems.some(
    (c: any) => String(c.provider ?? "") === provider && String(c.workspaceId ?? "") === workspaceId.trim(),
  );

  async function runAction(fn: () => Promise<void>) {
    setError("");
    setInfo("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      const apiErr = toApiError(e);
      const msg = errText(props.locale, apiErr) || formatApiError(e);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  const refreshConfigs = useCallback(async () => {
    const res = await apiFetch(`/governance/channels/webhook/configs?limit=50`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setConfigs({ status: res.status, json });
    setCfgPage(0);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }) || formatApiError({ message: `HTTP ${res.status}` }));
  }, [props.locale]);

  const [ingressStatus, setIngressStatus] = useState<string>("deadletter");

  const refreshEvents = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "20");
    if (ingressStatus.trim() && ingressStatus !== "all") q.set("status", ingressStatus.trim());
    const res = await apiFetch(`/governance/channels/ingress-events?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setEvents({ status: res.status, json });
    setEvPage(0);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }) || formatApiError({ message: `HTTP ${res.status}` }));
  }, [props.locale, ingressStatus]);

  const refreshOutbox = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "50");
    if (outboxStatus.trim()) q.set("status", outboxStatus.trim());
    const res = await apiFetch(`/governance/channels/outbox?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setOutbox({ status: res.status, json });
    setOutPage(0);
    if (!res.ok) setError(errText(props.locale, (json as ApiError) ?? { errorCode: String(res.status) }) || formatApiError({ message: `HTTP ${res.status}` }));
  }, [props.locale, outboxStatus]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    refreshConfigs();
    refreshEvents();
  }, [refreshConfigs, refreshEvents]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial outbox fetch
    refreshOutbox();
  }, [refreshOutbox]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync UI state from data
    if (hasExistingConfig) setMappingOpen(true);
  }, [hasExistingConfig]);

  async function saveConfig() {
    await runAction(async () => {
      const providerConfig: any = {};
      if (provider === "feishu") {
        if (appIdEnvKey.trim()) providerConfig.appIdEnvKey = appIdEnvKey.trim();
        if (appSecretEnvKey.trim()) providerConfig.appSecretEnvKey = appSecretEnvKey.trim();
      }
      const res = await apiFetch(`/governance/channels/webhook/configs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
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
      const res = await apiFetch(`/governance/channels/providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ provider: provider.trim(), workspaceId: workspaceId.trim() }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(JSON.stringify(json ?? {}, null, 2));
    });
  }

  async function saveChatBinding() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
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

  async function retryIngress(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/ingress-events/${encodeURIComponent(id)}/retry`, { method: "POST", locale: props.locale });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshEvents();
    });
  }

  async function retryOutbox(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/retry`, { method: "POST", locale: props.locale });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshOutbox();
    });
  }

  async function cancelOutbox(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/cancel`, { method: "POST", locale: props.locale });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshOutbox();
    });
  }

  const refreshBindingStates = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "50");
    if (provider.trim()) q.set("provider", provider.trim());
    if (workspaceId.trim()) q.set("workspaceId", workspaceId.trim());
    const res = await apiFetch(`/governance/channels/binding/states?${q.toString()}`, { locale: props.locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    if (res.ok && Array.isArray(json?.states)) setBindingStates(json.states);
  }, [props.locale, provider, workspaceId]);

  async function initiateBinding() {
    await runAction(async () => {
      setBindingResult(null);
      setBindingCopied(false);
      const res = await apiFetch(`/governance/channels/binding/initiate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          provider: provider.trim(),
          workspaceId: workspaceId.trim(),
          spaceId: spaceId.trim(),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setBindingResult({ authorizeUrl: json.authorizeUrl, expiresAt: json.expiresAt, bindingId: json.bindingId });
      await refreshBindingStates();
    });
  }

  async function saveAccountBinding() {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
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

  async function revokeAccount(p: string, wsId: string, cuId: string) {
    if (!window.confirm(t(props.locale, "gov.channels.confirmRevoke"))) return;
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/accounts/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ provider: p, workspaceId: wsId, channelUserId: cuId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshBindingStates();
    });
  }

  async function revokeChatBinding(p: string, wsId: string, ccId: string) {
    if (!window.confirm(t(props.locale, "gov.channels.confirmRevoke"))) return;
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/chat-bindings/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ provider: p, workspaceId: wsId, channelChatId: ccId }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setInfo(t(props.locale, "gov.channels.groupUnbindSuccess"));
    });
  }

  return (
    <div>
      <PageHeader
        title={t(props.locale, "gov.channels.title")}
        actions={
          <>
            <StatusBadge locale={props.locale} status={configs.status} />
            <button onClick={refreshConfigs} disabled={busy}>
              {t(props.locale, "action.refresh")}
            </button>
          </>
        }
      />
      {error ? <pre style={{ color: "var(--sl-danger, crimson)", whiteSpace: "pre-wrap", fontSize: 13 }}>{error}</pre> : null}
      {info ? <pre style={{ color: "var(--sl-muted)", whiteSpace: "pre-wrap", fontSize: 12, maxHeight: 160, overflow: "auto" }}>{info}</pre> : null}

      {/* Identity vs Channel distinction hint */}
      <div style={{ padding: "10px 14px", marginBottom: 12, background: "var(--sl-bg-alt, #f8fafc)", borderRadius: 6, borderLeft: "3px solid var(--sl-accent, #3b82f6)", fontSize: 13, color: "var(--sl-muted)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>{t(props.locale, "gov.channels.identityHint")}</span>
        <Link href={`/admin/sso-providers?lang=${encodeURIComponent(props.locale)}`} style={{ color: "var(--sl-accent)", fontWeight: 500, whiteSpace: "nowrap" }}>
          {t(props.locale, "gov.channels.identityHint.link")} &rarr;
        </Link>
      </div>

      <TabNav tabs={[
        { key: "config", label: t(props.locale, "gov.channels.tab.config"), content: (
          <>
            {/* ── Step 1: Provider ── */}
            <Card title={t(props.locale, "gov.channels.step.provider")}>
              <p style={{ fontSize: 12, color: "var(--sl-muted)", margin: "0 0 10px" }}>{t(props.locale, "gov.channels.step.provider.desc")}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {PROVIDER_KEYS.map((k) => (
                  <button
                    key={k}
                    onClick={() => setProvider(k)}
                    disabled={busy}
                    style={{
                      padding: "4px 12px", fontSize: 12, borderRadius: 999,
                      border: provider === k ? "1px solid var(--sl-accent)" : "1px solid var(--sl-border)",
                      background: provider === k ? "var(--sl-accent-bg)" : "transparent",
                      color: provider === k ? "var(--sl-accent)" : "var(--sl-fg)",
                      fontWeight: provider === k ? 600 : 400,
                      cursor: "pointer", transition: "all .12s",
                    }}
                  >
                    {t(props.locale, `gov.channels.provider.${k}`)}
                  </button>
                ))}
              </div>
            </Card>

            {/* ── Step 2: Credentials ── */}
            <div style={{ marginTop: 12 }}>
              <Card title={t(props.locale, "gov.channels.step.credentials")}>
                <p style={{ fontSize: 12, color: "var(--sl-muted)", margin: "0 0 10px" }}>{t(props.locale, "gov.channels.step.credentials.desc")}</p>
                <div style={{ display: "grid", gap: 12, maxWidth: 640 }}>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.workspaceId")}</span>
                    <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.workspaceId.hint")} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.spaceId")}</span>
                    {spacesList.length > 0 ? (
                      <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy}>
                        <option value="">{t(props.locale, "gov.channels.spaceId.pick")}</option>
                        {spacesList.map((s) => (
                          <option key={s.id} value={s.id}>{s.name ? `${s.name} (${s.id})` : s.id}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.spaceId.hint")} />
                    )}
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.secretEnvKey")}</span>
                    <input value={secretEnvKey} onChange={(e) => setSecretEnvKey(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.secretEnvKey.hint")} />
                  </label>
                  <label style={{ display: "grid", gap: 4 }}>
                    <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.secretId")}</span>
                    <input value={secretId} onChange={(e) => setSecretId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.secretId.hint")} />
                  </label>
                  {provider === "feishu" && (
                    <>
                      <label style={{ display: "grid", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.feishu.appIdEnvKey")}</span>
                        <input value={appIdEnvKey} onChange={(e) => setAppIdEnvKey(e.target.value)} disabled={busy} />
                      </label>
                      <label style={{ display: "grid", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.feishu.appSecretEnvKey")}</span>
                        <input value={appSecretEnvKey} onChange={(e) => setAppSecretEnvKey(e.target.value)} disabled={busy} />
                      </label>
                    </>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={saveConfig} disabled={busy || !provider.trim() || !workspaceId.trim() || (!secretEnvKey.trim() && !secretId.trim())}>
                      {t(props.locale, "action.save")}
                    </button>
                    <button onClick={testConfig} disabled={busy || !provider.trim() || !workspaceId.trim()} style={{ opacity: 0.75 }}>
                      {t(props.locale, "action.test")}
                    </button>
                  </div>
                </div>
              </Card>
            </div>

            {/* ── Step 3: Identity mapping ── */}
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => setMappingOpen(!mappingOpen)}
                style={{
                  all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                  fontSize: 13, fontWeight: 500, color: "var(--sl-muted)", padding: "6px 0",
                }}
              >
                <span style={{ fontSize: 10, transition: "transform .15s", transform: mappingOpen ? "rotate(90deg)" : "none" }}>▶</span>
                {t(props.locale, "gov.channels.step.mapping")}
              </button>
              <p style={{ fontSize: 12, color: "var(--sl-muted)", margin: "0 0 8px" }}>{t(props.locale, "gov.channels.step.mapping.desc")}</p>
              {mappingOpen && (
                <Card>
                  <div style={{ display: "grid", gap: 20, maxWidth: 640 }}>
                    {/* Chat binding - scenario hint */}
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "gov.channels.chatBinding")}</div>
                      <div style={{ fontSize: 12, color: "var(--sl-muted)", background: "var(--sl-bg-alt, #f8fafc)", padding: "8px 12px", borderRadius: 6 }}>{t(props.locale, "gov.channels.chatBinding.desc")}</div>
                      <label style={{ display: "grid", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.channelChatId")}</span>
                        <input value={channelChatId} onChange={(e) => setChannelChatId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.channelChatId.hint")} />
                      </label>
                      <label style={{ display: "grid", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.defaultSubjectId")}</span>
                        <input value={defaultSubjectId} onChange={(e) => setDefaultSubjectId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.defaultSubjectId.hint")} />
                      </label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={saveChatBinding} disabled={busy || !workspaceId.trim() || !spaceId.trim() || !channelChatId.trim()}>
                          {t(props.locale, "action.save")}
                        </button>
                        <button
                          onClick={() => revokeChatBinding(provider.trim(), workspaceId.trim(), channelChatId.trim())}
                          disabled={busy || !provider.trim() || !workspaceId.trim() || !channelChatId.trim()}
                          style={{ background: "var(--sl-danger, #dc2626)", color: "#fff", border: "1px solid var(--sl-danger, #dc2626)", borderRadius: 4, padding: "4px 12px", fontSize: 13, cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                        >
                          {t(props.locale, "gov.channels.unbind")}
                        </button>
                      </div>
                    </div>
                    {/* Account binding - scenario hint */}
                    <div style={{ borderTop: "1px solid var(--sl-border)", paddingTop: 16, display: "grid", gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "gov.channels.accountBinding")}</div>
                      <div style={{ fontSize: 12, color: "var(--sl-muted)", background: "var(--sl-bg-alt, #f8fafc)", padding: "8px 12px", borderRadius: 6 }}>{t(props.locale, "gov.channels.accountBinding.desc")}</div>
                      <label style={{ display: "grid", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.channelUserId")}</span>
                        <input value={channelUserId} onChange={(e) => setChannelUserId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.channelUserId.hint")} />
                      </label>
                      <label style={{ display: "grid", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.subjectId")}</span>
                        <input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.subjectId.hint")} />
                      </label>
                      <div>
                        <button onClick={saveAccountBinding} disabled={busy || !workspaceId.trim() || !spaceId.trim() || !channelUserId.trim() || !subjectId.trim()}>
                          {t(props.locale, "action.save")}
                        </button>
                      </div>
                    </div>
                  </div>
                </Card>
              )}
            </div>

            {/* ── Configs list ── */}
            <div style={{ marginTop: 12 }}>
              <Card title={t(props.locale, "gov.channels.configsListTitle")}>
                {cfgItems.length === 0 ? (
                  <EmptyState text={t(props.locale, "gov.channels.configEmpty")} />
                ) : (
                  <>
                  <Table>
                    <thead>
                      <tr>
                        <th>{t(props.locale, "gov.channels.table.provider")}</th>
                        <th>{t(props.locale, "gov.channels.table.workspaceId")}</th>
                        <th>{t(props.locale, "gov.channels.table.secretEnvKey")}</th>
                        <th>{t(props.locale, "gov.channels.table.secretId")}</th>
                        <th>{t(props.locale, "gov.channels.table.deliveryMode")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cfgPaged.map((c: any, idx: number) => (
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
                  {cfgTotalPages > 1 && (
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
                      <span style={{ opacity: 0.7, fontSize: 13 }}>
                        {t(props.locale, "pagination.showing").replace("{from}", String(cfgPage * pageSize + 1)).replace("{to}", String(Math.min((cfgPage + 1) * pageSize, cfgItems.length)))}
                        {t(props.locale, "pagination.total").replace("{count}", String(cfgItems.length))}
                      </span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button disabled={cfgPage === 0} onClick={() => setCfgPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                        <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(cfgPage + 1))}</span>
                        <button disabled={cfgPage >= cfgTotalPages - 1} onClick={() => setCfgPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
                      </div>
                    </div>
                  )}
                  </>
                )}
              </Card>
            </div>
          </>
        )},

        { key: "ingress", label: t(props.locale, "gov.channels.tab.ingress"), content: (
          <Card title={t(props.locale, "gov.channels.ingressDeadletterTitle")}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <StatusBadge locale={props.locale} status={events.status} />
              <select value={ingressStatus} onChange={(e) => setIngressStatus(e.target.value)} disabled={busy} style={{ fontSize: 13 }}>
                <option value="all">{t(props.locale, "gov.channels.filter.all")}</option>
                <option value="received">{t(props.locale, "gov.channels.filter.received")}</option>
                <option value="processed">{t(props.locale, "gov.channels.filter.processed")}</option>
                <option value="deadletter">{t(props.locale, "gov.channels.filter.deadletter")}</option>
              </select>
              <button onClick={refreshEvents} disabled={busy} style={{ fontSize: 13 }}>
                {t(props.locale, "action.refresh")}
              </button>
            </div>
            {evItems.length === 0 ? (
              <EmptyState text={t(props.locale, "gov.channels.ingressEmpty")} />
            ) : (
              <>
              <Table>
                <thead>
                  <tr>
                    <th>{t(props.locale, "gov.channels.table.provider")}</th>
                    <th>{t(props.locale, "gov.channels.table.workspaceId")}</th>
                    <th>{t(props.locale, "gov.channels.table.eventId")}</th>
                    <th>{t(props.locale, "gov.channels.table.status")}</th>
                    <th>{t(props.locale, "gov.changesets.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {evPaged.map((e: any, idx: number) => (
                    <tr key={String(e.id ?? e.eventId ?? idx)}>
                      <td>{String(e.provider ?? "")}</td>
                      <td>{String(e.workspaceId ?? "")}</td>
                      <td>{String(e.eventId ?? "")}</td>
                      <td>
                        <Badge tone={e.status === "processed" ? "success" : e.status === "deadletter" ? "danger" : "warning"}>
                          {String(e.status ?? "")}
                        </Badge>
                      </td>
                      <td>
                        <button disabled={busy || !e.id} onClick={() => retryIngress(String(e.id))}>
                          {t(props.locale, "gov.channels.outbox.retry")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {evTotalPages > 1 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
                  <span style={{ opacity: 0.7, fontSize: 13 }}>
                    {t(props.locale, "pagination.showing").replace("{from}", String(evPage * pageSize + 1)).replace("{to}", String(Math.min((evPage + 1) * pageSize, evItems.length)))}
                    {t(props.locale, "pagination.total").replace("{count}", String(evItems.length))}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button disabled={evPage === 0} onClick={() => setEvPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                    <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(evPage + 1))}</span>
                    <button disabled={evPage >= evTotalPages - 1} onClick={() => setEvPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
                  </div>
                </div>
              )}
              </>
            )}
          </Card>
        )},

        { key: "binding", label: t(props.locale, "gov.channels.tab.binding"), content: (
          <>
            <Card title={t(props.locale, "gov.channels.binding.title")}>
              <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: "0 0 16px" }}>{t(props.locale, "gov.channels.binding.desc")}</p>

              <div style={{ display: "grid", gap: 10, maxWidth: 480, marginBottom: 16, padding: "12px 16px", background: "var(--sl-bg-alt, #f8fafc)", borderRadius: 8, border: "1px solid var(--sl-border)" }}>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.provider")}</span>
                  <select value={provider} onChange={(e) => setProvider(e.target.value)} disabled={busy} style={{ fontSize: 13 }}>
                    {PROVIDER_KEYS.map((k) => (
                      <option key={k} value={k}>{t(props.locale, `gov.channels.provider.${k}`)}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.workspaceId")}</span>
                  <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.workspaceId.hint")} style={{ fontSize: 13 }} />
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  <span style={{ fontSize: 12, color: "var(--sl-muted)" }}>{t(props.locale, "gov.channels.spaceId")}</span>
                  {spacesList.length > 0 ? (
                    <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy} style={{ fontSize: 13 }}>
                      <option value="">{t(props.locale, "gov.channels.spaceId.pick")}</option>
                      {spacesList.map((s) => (
                        <option key={s.id} value={s.id}>{s.name ? `${s.name} (${s.id})` : s.id}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={busy} placeholder={t(props.locale, "gov.channels.spaceId.hint")} style={{ fontSize: 13 }} />
                  )}
                </label>
              </div>

              {provider.trim() && workspaceId.trim() && !configExistsForCurrentProvider && (
                <div style={{ padding: "10px 14px", marginBottom: 16, borderRadius: 6, background: "var(--sl-warning-bg, #fffbeb)", border: "1px solid var(--sl-warning, #f59e0b)", fontSize: 12, color: "var(--sl-warning-fg, #92400e)" }}>
                  {t(props.locale, "gov.channels.binding.noConfigWarning")}
                </div>
              )}

              {!bindingResult ? (
                <div style={{ textAlign: "center", padding: "20px 0" }}>
                  <button
                    onClick={initiateBinding}
                    disabled={busy || !provider.trim() || !workspaceId.trim() || !spaceId.trim()}
                  >
                    {busy ? t(props.locale, "gov.channels.binding.generating") : t(props.locale, "gov.channels.binding.generate")}
                  </button>
                  {(!provider.trim() || !workspaceId.trim() || !spaceId.trim()) && (
                    <p style={{ color: "var(--sl-muted)", fontSize: 12, marginTop: 8 }}>
                      {t(props.locale, "gov.channels.binding.prerequisite")}
                    </p>
                  )}
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "8px 0" }}>
                  <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: "0 0 12px" }}>{t(props.locale, "gov.channels.binding.qrHint")}</p>
                  <Image
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(bindingResult.authorizeUrl)}`}
                    alt={t(props.locale, "gov.channels.binding.qrAlt")}
                    width={200}
                    height={200}
                    unoptimized
                    style={{ width: 200, height: 200, borderRadius: 10, border: "1px solid var(--sl-border)" }}
                  />
                  <div style={{ marginTop: 10, display: "flex", gap: 8, justifyContent: "center" }}>
                    <button onClick={() => { navigator.clipboard.writeText(bindingResult.authorizeUrl); setBindingCopied(true); setTimeout(() => setBindingCopied(false), 2000); }}>
                      {bindingCopied ? t(props.locale, "gov.channels.binding.copied") : t(props.locale, "gov.channels.binding.copyLink")}
                    </button>
                    <button onClick={() => { setBindingResult(null); setBindingCopied(false); }}>
                      {t(props.locale, "gov.channels.binding.regenerate")}
                    </button>
                  </div>
                  <p style={{ color: "var(--sl-muted)", fontSize: 12, marginTop: 8 }}>
                    {t(props.locale, "gov.channels.binding.expiresAt")}: {fmtDateTime(bindingResult.expiresAt, props.locale)}
                  </p>
                </div>
              )}
            </Card>
            <div style={{ marginTop: 12 }}>
              <Card title={t(props.locale, "gov.channels.binding.historyTitle")}>
                <div style={{ marginBottom: 8 }}>
                  <button onClick={() => refreshBindingStates()} disabled={busy} style={{ fontSize: 13 }}>
                    {t(props.locale, "action.refresh")}
                  </button>
                </div>
                {bindingStates.length === 0 ? (
                  <EmptyState text={t(props.locale, "gov.channels.binding.noHistory")} />
                ) : (
                  <Table>
                    <thead>
                      <tr>
                        <th>{t(props.locale, "gov.channels.binding.col.provider")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.status")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.channelUserId")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.createdAt")}</th>
                        <th>{t(props.locale, "gov.channels.binding.col.expiresAt")}</th>
                        <th>{t(props.locale, "gov.changesets.actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bindingStates.map((s: any, idx: number) => (
                        <tr key={String(s.id ?? idx)} title={`${t(props.locale, "gov.channels.binding.col.workspaceId")}: ${String(s.workspaceId ?? "")}  |  ${t(props.locale, "gov.channels.binding.col.spaceId")}: ${String(s.spaceId ?? "")}${s.label ? `  |  ${s.label}` : ""}`}>
                          <td>{String(s.provider ?? "")}</td>
                          <td>
                            <Badge tone={s.status === "consumed" ? "success" : s.status === "expired" ? "danger" : "warning"}>
                              {t(props.locale, `gov.channels.binding.status.${s.status}`) || String(s.status ?? "")}
                            </Badge>
                          </td>
                          <td>{String(s.boundChannelUserId ?? "")}</td>
                          <td>{fmtDateTime(s.createdAt, props.locale)}</td>
                          <td>{fmtDateTime(s.expiresAt, props.locale)}</td>
                          <td>
                            {s.status === "consumed" && s.boundChannelUserId ? (
                              <button
                                disabled={busy}
                                onClick={() => revokeAccount(String(s.provider ?? ""), String(s.workspaceId ?? ""), String(s.boundChannelUserId ?? ""))}
                                style={{ background: "var(--sl-danger, #dc2626)", color: "#fff", border: "1px solid var(--sl-danger, #dc2626)", borderRadius: 4, padding: "2px 10px", fontSize: 12, cursor: "pointer", opacity: busy ? 0.5 : 1 }}
                              >
                                {t(props.locale, "gov.channels.unbind")}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Card>
            </div>
          </>
        )},

        { key: "outbox", label: t(props.locale, "gov.channels.tab.outbox"), content: (
          <Card title={t(props.locale, "gov.channels.outboxListTitle")}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
              <StatusBadge locale={props.locale} status={outbox.status} />
              <select value={outboxStatus} onChange={(e) => setOutboxStatus(e.target.value)} disabled={busy}>
                <option value="deadletter">{t(props.locale, "gov.channels.outbox.status.deadletter")}</option>
                <option value="failed">{t(props.locale, "gov.channels.outbox.status.failed")}</option>
                <option value="queued">{t(props.locale, "gov.channels.outbox.status.queued")}</option>
                <option value="processing">{t(props.locale, "gov.channels.outbox.status.processing")}</option>
                <option value="delivered">{t(props.locale, "gov.channels.outbox.status.delivered")}</option>
                <option value="acked">{t(props.locale, "gov.channels.outbox.status.acked")}</option>
                <option value="canceled">{t(props.locale, "gov.channels.outbox.status.canceled")}</option>
              </select>
              <button onClick={refreshOutbox} disabled={busy}>
                {t(props.locale, "action.refresh")}
              </button>
            </div>
            {outboxItems.length === 0 ? (
              <EmptyState text={t(props.locale, "gov.channels.outboxEmpty")} />
            ) : (
              <>
              <Table header={<span>{outboxItems.length}</span>}>
                <thead>
                  <tr>
                    <th>{t(props.locale, "gov.channels.table.provider")}</th>
                    <th>{t(props.locale, "gov.channels.table.workspaceId")}</th>
                    <th>{t(props.locale, "gov.channels.table.channelChatId")}</th>
                    <th>{t(props.locale, "gov.channels.table.requestId")}</th>
                    <th>{t(props.locale, "gov.channels.table.status")}</th>
                    <th>{t(props.locale, "gov.channels.table.attempt")}</th>
                    <th>{t(props.locale, "gov.channels.table.nextAttemptAt")}</th>
                    <th>{t(props.locale, "gov.channels.table.lastError")}</th>
                    <th>{t(props.locale, "gov.changesets.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {outPaged.map((m: any, idx: number) => (
                    <tr key={String(m.id ?? idx)}>
                      <td>{String(m.provider ?? "")}</td>
                      <td>{String(m.workspaceId ?? "")}</td>
                      <td>{String(m.channelChatId ?? "")}</td>
                      <td style={{ fontFamily: "var(--sl-font-mono, monospace)", fontSize: 12 }}>{String(m.requestId ?? "")}</td>
                      <td>
                        <Badge tone={m.status === "delivered" || m.status === "acked" ? "success" : m.status === "deadletter" || m.status === "failed" ? "danger" : "warning"}>
                          {String(m.status ?? "")}
                        </Badge>
                      </td>
                      <td>{String(m.attemptCount ?? "")}</td>
                      <td>{fmtDateTime(m.nextAttemptAt, props.locale)}</td>
                      <td>{String(m.lastErrorCategory ?? "")}{m.lastErrorDigest ? `:${String(m.lastErrorDigest)}` : ""}</td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button disabled={busy || !m.id} onClick={() => retryOutbox(String(m.id))}>
                            {t(props.locale, "gov.channels.outbox.retry")}
                          </button>
                          <button disabled={busy || !m.id} onClick={() => cancelOutbox(String(m.id))}>
                            {t(props.locale, "action.cancel")}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {outTotalPages > 1 && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
                  <span style={{ opacity: 0.7, fontSize: 13 }}>
                    {t(props.locale, "pagination.showing").replace("{from}", String(outPage * pageSize + 1)).replace("{to}", String(Math.min((outPage + 1) * pageSize, outboxItems.length)))}
                    {t(props.locale, "pagination.total").replace("{count}", String(outboxItems.length))}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button disabled={outPage === 0} onClick={() => setOutPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                    <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(outPage + 1))}</span>
                    <button disabled={outPage >= outTotalPages - 1} onClick={() => setOutPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
                  </div>
                </div>
              )}
              </>
            )}
          </Card>
        )},
      ]} />
    </div>
  );
}
