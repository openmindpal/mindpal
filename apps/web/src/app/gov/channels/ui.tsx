"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { fmtDateTime } from "@/lib/fmtDateTime";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge, Card, PageHeader, Table, StatusBadge, TabNav, EmptyState } from "@/components/ui";

/* ── types ── */
interface ProviderMeta {
  provider: string;
  displayName: Record<string, string>;
  icon: string;
  setupModes: string[];
  features: { admissionPolicy?: boolean; groupChat?: boolean; directMessage?: boolean; richMessage?: boolean };
  manualConfigFields?: Array<{ key: string; label: Record<string, string>; type: "text" | "secret"; required: boolean }>;
  status: "connected" | "disabled" | "unconfigured";
  workspaceId: string | null;
  admissionPolicy: "open" | "pairing" | null;
}

interface QrModalState {
  provider: string;
  loading: boolean;
  authorizeUrl?: string;
  setupId?: string;
  expiresAt?: string;
}

interface ManualModalState {
  provider: string;
  fields: Array<{ key: string; label: Record<string, string>; type: "text" | "secret"; required: boolean }>;
  values: Record<string, string>;
}

/* ── constants ── */
const PROVIDER_ICONS: Record<string, string> = {
  feishu: "📱", dingtalk: "💬", wechat: "💚", wecom: "🏢",
  slack: "💼", discord: "🎮", "qq.onebot": "🐧", qq: "🐧",
  "imessage.bridge": "🍎", imessage: "🍎",
};

function pName(p: ProviderMeta, locale: string): string {
  if (p.displayName) {
    if (locale.includes("zh") && p.displayName.zh) return p.displayName.zh;
    if (p.displayName.en) return p.displayName.en;
    const first = Object.values(p.displayName)[0];
    if (first) return first;
  }
  return p.provider;
}

function pIcon(p: ProviderMeta): string {
  return PROVIDER_ICONS[p.provider] ?? PROVIDER_ICONS[p.icon] ?? "📡";
}

const PROVIDER_ORDER: Record<string, number> = {
  feishu: 1, dingtalk: 2, wechat: 3, wecom: 4, "qq.onebot": 5,
  slack: 10, discord: 11,
  bridge: 20, "imessage.bridge": 21,
};

export default function GovChannelsClient(props: { locale: string; initial: any }) {
  const locale = props.locale;
  const isZh = locale.includes("zh");

  /* ── shared state ── */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /* ── provider cards ── */
  const [providers, setProviders] = useState<ProviderMeta[]>([]);

  /* ── QR modal ── */
  const [qrModal, setQrModal] = useState<QrModalState | null>(null);
  /* ── Manual config modal ── */
  const [manualModal, setManualModal] = useState<ManualModalState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── ops section ── */
  const [opsOpen, setOpsOpen] = useState(false);
  const [events, setEvents] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const [outbox, setOutbox] = useState<{ status: number; json: any }>({ status: 0, json: null });
  const [ingressStatus, setIngressStatus] = useState<string>("deadletter");
  const [outboxStatus, setOutboxStatus] = useState<string>("deadletter");

  const evItems = useMemo(() => (Array.isArray(events?.json?.events) ? events.json.events : []), [events]);
  const outboxItems = useMemo(() => (Array.isArray(outbox?.json?.messages) ? outbox.json.messages : []), [outbox]);

  const pageSize = 20;
  const [evPage, setEvPage] = useState(0);
  const evTotalPages = Math.max(1, Math.ceil(evItems.length / pageSize));
  const evPaged = useMemo(() => evItems.slice(evPage * pageSize, (evPage + 1) * pageSize), [evItems, evPage]);

  const [outPage, setOutPage] = useState(0);
  const outTotalPages = Math.max(1, Math.ceil(outboxItems.length / pageSize));
  const outPaged = useMemo(() => outboxItems.slice(outPage * pageSize, (outPage + 1) * pageSize), [outboxItems, outPage]);

  /* ── helpers ── */
  async function runAction(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try { await fn(); } catch (e: any) {
      const apiErr = toApiError(e);
      setError(errText(locale, apiErr) || e?.message || "操作失败");
    } finally { setBusy(false); }
  }

  /* ── data fetchers ── */
  const refreshProviders = useCallback(async () => {
    try {
      const res = await apiFetch(`/channels/providers`, { locale, cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && Array.isArray(json?.providers)) {
        const sorted = [...json.providers].sort((a: ProviderMeta, b: ProviderMeta) => (PROVIDER_ORDER[a.provider] ?? 99) - (PROVIDER_ORDER[b.provider] ?? 99));
        setProviders(sorted);
      }
      else if (!res.ok) setError(errText(locale, json as ApiError) || `HTTP ${res.status}`);
    } catch (e: any) { setError(e?.message || "加载失败"); }
  }, [locale]);

  const refreshEvents = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "20");
    if (ingressStatus.trim() && ingressStatus !== "all") q.set("status", ingressStatus.trim());
    const res = await apiFetch(`/governance/channels/ingress-events?${q.toString()}`, { locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setEvents({ status: res.status, json });
    setEvPage(0);
  }, [locale, ingressStatus]);

  const refreshOutbox = useCallback(async () => {
    const q = new URLSearchParams();
    q.set("limit", "50");
    if (outboxStatus.trim()) q.set("status", outboxStatus.trim());
    const res = await apiFetch(`/governance/channels/outbox?${q.toString()}`, { locale, cache: "no-store" });
    const json = await res.json().catch(() => null);
    setOutbox({ status: res.status, json });
    setOutPage(0);
  }, [locale, outboxStatus]);

  useEffect(() => { refreshProviders(); }, [refreshProviders]);

  /* ── cleanup poll on unmount / modal close ── */
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  /* ── provider actions ── */
  async function toggleProvider(p: ProviderMeta, enabled: boolean) {
    await runAction(async () => {
      const res = await apiFetch(`/channels/setup/${encodeURIComponent(p.provider)}/toggle`, {
        method: "POST", headers: { "content-type": "application/json" }, locale,
        body: JSON.stringify({ workspaceId: p.workspaceId, enabled }),
      });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      await refreshProviders();
    });
  }

  async function removeProvider(p: ProviderMeta) {
    if (!window.confirm(isZh ? `确定移除「${pName(p, locale)}」的配置？将清除所有绑定和配置。` : `Remove ${pName(p, locale)} configuration? All bindings and config will be cleared.`)) return;
    await runAction(async () => {
      const res = await apiFetch(`/channels/setup/${encodeURIComponent(p.provider)}/remove`, {
        method: "POST", headers: { "content-type": "application/json" }, locale,
        body: JSON.stringify({ workspaceId: p.workspaceId }),
      });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      await refreshProviders();
    });
  }

  async function setAdmission(p: ProviderMeta, policy: "open" | "pairing") {
    await runAction(async () => {
      const res = await apiFetch(`/channels/setup/${encodeURIComponent(p.provider)}/admission`, {
        method: "POST", headers: { "content-type": "application/json" }, locale,
        body: JSON.stringify({ workspaceId: p.workspaceId, policy }),
      });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      await refreshProviders();
    });
  }

  /* ── QR flow ── */
  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  function closeQr() { stopPoll(); setQrModal(null); }

  async function startQr(provider: string) {
    stopPoll();
    setQrModal({ provider, loading: true });
    try {
      const res = await apiFetch(`/channels/setup/${encodeURIComponent(provider)}/init`, {
        method: "POST", headers: { "content-type": "application/json" }, locale,
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) { setQrModal(null); const apiErr = toApiError(json); setError(errText(locale, apiErr) || `HTTP ${res.status}`); return; }
      setQrModal({ provider, loading: false, authorizeUrl: json.authorizeUrl, setupId: json.setupId, expiresAt: json.expiresAt });
      // start polling
      pollRef.current = setInterval(async () => {
        try {
          const sr = await apiFetch(`/channels/setup/${encodeURIComponent(provider)}/status`, { locale, cache: "no-store" });
          const sj = await sr.json().catch(() => null);
          if (sj?.configured) { stopPoll(); setQrModal(null); refreshProviders(); }
        } catch { /* ignore poll errors */ }
      }, 3000);
    } catch (e: any) {
      setQrModal(null);
      setError(e?.message || "初始化失败");
    }
  }

  async function refreshQr() {
    if (!qrModal) return;
    stopPoll();
    await startQr(qrModal.provider);
  }

  /* ── ops actions ── */
  async function retryIngress(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/ingress-events/${encodeURIComponent(id)}/retry`, { method: "POST", locale });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      await refreshEvents();
    });
  }

  async function retryOutbox(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/retry`, { method: "POST", locale });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      await refreshOutbox();
    });
  }

  async function cancelOutbox(id: string) {
    await runAction(async () => {
      const res = await apiFetch(`/governance/channels/outbox/${encodeURIComponent(id)}/cancel`, { method: "POST", locale });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      await refreshOutbox();
    });
  }

  /* ── Manual config submit ── */
  async function submitManual() {
    if (!manualModal) return;
    await runAction(async () => {
      const res = await apiFetch(`/channels/setup/${encodeURIComponent(manualModal.provider)}/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify(manualModal.values),
      });
      if (!res.ok) { const j = await res.json().catch(() => null); throw toApiError(j); }
      setManualModal(null);
      await refreshProviders();
    });
  }

  /* ── provider card display name for QR modal ── */
  const qrProviderName = qrModal ? pName(providers.find(p => p.provider === qrModal.provider) ?? { provider: qrModal.provider, displayName: {}, icon: "", setupModes: [], features: {}, status: "unconfigured", workspaceId: null, admissionPolicy: null }, locale) : "";

  /* ── render ── */
  return (
    <div>
      <PageHeader
        title={isZh ? "IM 频道" : "IM Channels"}
        actions={
          <button onClick={() => refreshProviders()} disabled={busy}>
            {isZh ? "刷新" : "Refresh"}
          </button>
        }
      />

      {error && <pre style={{ color: "var(--sl-danger, crimson)", whiteSpace: "pre-wrap", fontSize: 13, margin: "8px 0" }}>{error}</pre>}

      {/* ── Provider Card Grid ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16, marginTop: 16 }}>
        {providers.map(p => {
          const name = pName(p, locale);
          const icon = pIcon(p);
          const connected = p.status === "connected";
          const disabled = p.status === "disabled";
          const unconfigured = p.status === "unconfigured";

          return (
            <div key={p.provider} style={{
              border: "1px solid var(--sl-border, #e2e8f0)", borderRadius: 8,
              padding: "14px 12px", background: "var(--sl-bg, #fff)",
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              {/* icon + name + badge */}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                  {connected && <Badge tone="success">{isZh ? "已连接" : "Connected"}</Badge>}
                  {disabled && <Badge tone="neutral">{isZh ? "已禁用" : "Disabled"}</Badge>}
                </div>
              </div>

              {/* connected state */}
              {(connected || disabled) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {/* toggle */}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={connected}
                      onChange={(e) => toggleProvider(p, e.target.checked)}
                      disabled={busy}
                      style={{ width: 16, height: 16 }}
                    />
                    <span>{isZh ? "启用" : "Enabled"}</span>
                  </label>

                  {/* admission policy */}
                  {p.features.admissionPolicy && connected && (
                    <div style={{ fontSize: 12 }}>
                      <div style={{ color: "var(--sl-muted)", marginBottom: 4 }}>{isZh ? "准入策略" : "Admission"}</div>
                      <select
                        value={p.admissionPolicy ?? "open"}
                        onChange={(e) => setAdmission(p, e.target.value as "open" | "pairing")}
                        disabled={busy}
                        style={{ fontSize: 12, width: "100%", padding: "3px 6px", borderRadius: 4, border: "1px solid var(--sl-border)" }}
                      >
                        <option value="open">{isZh ? "开放 — 所有人可用" : "Open — everyone"}</option>
                        <option value="pairing">{isZh ? "配对 — 需管理员允许" : "Pairing — admin approval"}</option>
                      </select>
                    </div>
                  )}

                  {/* remove */}
                  <button
                    onClick={() => removeProvider(p)}
                    disabled={busy}
                    title={isZh ? "将清除所有绑定和配置" : "All bindings and config will be removed"}
                    style={{
                      fontSize: 12, color: "var(--sl-muted, #94a3b8)", background: "transparent",
                      border: "none", borderRadius: 0,
                      padding: "4px 0", cursor: "pointer", marginTop: 2,
                      opacity: busy ? 0.5 : 1,
                    }}
                  >
                    {isZh ? "移除配置" : "Remove"}
                  </button>
                </div>
              )}

              {/* unconfigured state */}
              {unconfigured && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {p.setupModes.includes("qr") && (
                    <button
                      onClick={() => startQr(p.provider)}
                      disabled={busy}
                      style={{
                        fontSize: 12, fontWeight: 500, cursor: "pointer",
                        padding: "5px 10px", borderRadius: 6,
                        background: "var(--sl-accent, #3b82f6)", color: "#fff",
                        border: "none",
                      }}
                    >
                      {isZh ? "扫码配置" : "QR Setup"}
                    </button>
                  )}
                  {p.setupModes.includes("manual") && !p.setupModes.includes("qr") && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        const fields = p.manualConfigFields ?? [];
                        const values: Record<string, string> = {};
                        fields.forEach(f => { values[f.key] = ""; });
                        setManualModal({ provider: p.provider, fields, values });
                      }}
                      style={{
                        fontSize: 12, cursor: "pointer",
                        padding: "5px 10px", borderRadius: 6,
                        background: "var(--sl-bg-alt, #f1f5f9)", color: "var(--sl-fg)",
                        border: "1px solid var(--sl-border)",
                      }}
                    >
                      {isZh ? "手动配置" : "Manual Setup"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {providers.length === 0 && (
        <EmptyState text={isZh ? "暂无可用 IM 频道" : "No IM channels available"} />
      )}

      {/* ── QR Modal ── */}
      {qrModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999 }}
          onClick={closeQr}
        >
          <div
            style={{ background: "#fff", borderRadius: 16, padding: "32px 40px", minWidth: 360, maxWidth: 420, textAlign: "center", boxShadow: "0 8px 32px rgba(0,0,0,0.12)" }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 18 }}>{isZh ? `配置${qrProviderName}` : `Setup ${qrProviderName}`}</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "#64748b" }}>
              {isZh ? `打开${qrProviderName}，扫描二维码完成授权` : `Open ${qrProviderName} and scan the QR code to authorize`}
            </p>
            {qrModal.authorizeUrl ? (
              <>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrModal.authorizeUrl)}`}
                  alt={isZh ? "扫码授权" : "Scan to authorize"}
                  style={{ width: 256, height: 256, borderRadius: 8, border: "1px solid #e2e8f0" }}
                />
                <div style={{ marginTop: 10 }}>
                  <a
                    href={qrModal.authorizeUrl}
                    onClick={(e) => { e.preventDefault(); window.open(qrModal.authorizeUrl, "_blank"); }}
                    style={{ fontSize: 12, color: "#64748b", textDecoration: "underline", cursor: "pointer" }}
                  >
                    {isZh ? "在浏览器中打开授权" : "Open authorization in browser"}
                  </a>
                </div>
              </>
            ) : (
              <div style={{ width: 256, height: 256, display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f5f9", borderRadius: 8, margin: "0 auto" }}>
                {isZh ? "加载中..." : "Loading..."}
              </div>
            )}
            <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "center" }}>
              <button onClick={refreshQr} disabled={busy} style={{ fontSize: 13 }}>{isZh ? "刷新二维码" : "Refresh QR"}</button>
              <button onClick={closeQr} style={{ fontSize: 13, opacity: 0.6 }}>{isZh ? "取消" : "Cancel"}</button>
            </div>
            {qrModal.expiresAt && (
              <p style={{ marginTop: 8, fontSize: 12, color: "#94a3b8" }}>
                {isZh ? "有效期至" : "Expires at"} {new Date(qrModal.expiresAt).toLocaleTimeString()}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Manual Config Modal ── */}
      {manualModal && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999 }}
          onClick={() => setManualModal(null)}
        >
          <div
            style={{ background: "#fff", borderRadius: 8, padding: "24px 28px", minWidth: 340, maxWidth: 400 }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 600 }}>
              {isZh ? `配置 ${pName(providers.find(pp => pp.provider === manualModal.provider) ?? { provider: manualModal.provider, displayName: {}, icon: "", setupModes: [], features: {}, status: "unconfigured" as const, workspaceId: null, admissionPolicy: null }, locale)}` : `Configure ${manualModal.provider}`}
            </h3>
            {manualModal.fields.map(f => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--sl-muted)", marginBottom: 4 }}>
                  {(isZh ? f.label.zh : f.label.en) || f.key}
                  {f.required && <span style={{ color: "var(--sl-danger, #dc2626)" }}> *</span>}
                </label>
                <input
                  type={f.type === "secret" ? "password" : "text"}
                  value={manualModal.values[f.key] ?? ""}
                  onChange={e => setManualModal(prev => prev ? { ...prev, values: { ...prev.values, [f.key]: e.target.value } } : null)}
                  style={{ width: "100%", padding: "6px 8px", fontSize: 13, borderRadius: 4, border: "1px solid var(--sl-border, #e2e8f0)", boxSizing: "border-box" as const }}
                  placeholder={(isZh ? f.label.zh : f.label.en) || f.key}
                />
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button
                onClick={() => setManualModal(null)}
                style={{ fontSize: 12, padding: "5px 12px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "transparent", cursor: "pointer" }}
              >
                {isZh ? "取消" : "Cancel"}
              </button>
              <button
                onClick={submitManual}
                disabled={busy}
                style={{ fontSize: 12, padding: "5px 12px", borderRadius: 4, border: "none", background: "var(--sl-accent, #3b82f6)", color: "#fff", cursor: "pointer", opacity: busy ? 0.5 : 1 }}
              >
                {isZh ? "保存" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Collapsible Ops Section ── */}
      <div style={{ marginTop: 32 }}>
        <button
          onClick={() => { setOpsOpen(!opsOpen); if (!opsOpen) { refreshEvents(); refreshOutbox(); } }}
          style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, color: "var(--sl-muted)", padding: "6px 0" }}
        >
          <span style={{ fontSize: 10, transition: "transform .15s", transform: opsOpen ? "rotate(90deg)" : "none" }}>▶</span>
          {isZh ? "运维管理（入站事件 / 出站消息）" : "Ops Management (Ingress / Outbox)"}
        </button>
        {opsOpen && (
          <TabNav tabs={[
            { key: "ingress", label: isZh ? "入站事件" : "Ingress Events", content: (
              <Card title={isZh ? "入站事件" : "Ingress Events"}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <StatusBadge locale={locale} status={events.status} />
                  <select value={ingressStatus} onChange={(e) => setIngressStatus(e.target.value)} disabled={busy} style={{ fontSize: 13 }}>
                    <option value="all">{isZh ? "全部" : "All"}</option>
                    <option value="received">{isZh ? "已接收" : "Received"}</option>
                    <option value="processed">{isZh ? "已处理" : "Processed"}</option>
                    <option value="deadletter">{isZh ? "死信" : "Dead Letter"}</option>
                  </select>
                  <button onClick={refreshEvents} disabled={busy} style={{ fontSize: 13 }}>{isZh ? "刷新" : "Refresh"}</button>
                </div>
                {evItems.length === 0 ? (
                  <EmptyState text={isZh ? "暂无入站事件" : "No ingress events"} />
                ) : (
                  <>
                    <Table>
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Workspace</th>
                          <th>Event ID</th>
                          <th>{isZh ? "状态" : "Status"}</th>
                          <th>{isZh ? "操作" : "Actions"}</th>
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
                              <button disabled={busy || !e.id} onClick={() => retryIngress(String(e.id))} style={{ fontSize: 12 }}>
                                {isZh ? "重试" : "Retry"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    {evTotalPages > 1 && (
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
                        <span style={{ opacity: 0.7, fontSize: 13 }}>
                          {evPage * pageSize + 1}-{Math.min((evPage + 1) * pageSize, evItems.length)} / {evItems.length}
                        </span>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button disabled={evPage === 0} onClick={() => setEvPage(p => Math.max(0, p - 1))}>{isZh ? "上一页" : "Prev"}</button>
                          <button disabled={evPage >= evTotalPages - 1} onClick={() => setEvPage(p => p + 1)}>{isZh ? "下一页" : "Next"}</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Card>
            )},
            { key: "outbox", label: isZh ? "出站消息" : "Outbox Messages", content: (
              <Card title={isZh ? "出站消息" : "Outbox Messages"}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <StatusBadge locale={locale} status={outbox.status} />
                  <select value={outboxStatus} onChange={(e) => setOutboxStatus(e.target.value)} disabled={busy} style={{ fontSize: 13 }}>
                    <option value="deadletter">{isZh ? "死信" : "Dead Letter"}</option>
                    <option value="failed">{isZh ? "失败" : "Failed"}</option>
                    <option value="queued">{isZh ? "排队中" : "Queued"}</option>
                    <option value="processing">{isZh ? "处理中" : "Processing"}</option>
                    <option value="delivered">{isZh ? "已投递" : "Delivered"}</option>
                    <option value="acked">{isZh ? "已确认" : "Acked"}</option>
                    <option value="canceled">{isZh ? "已取消" : "Canceled"}</option>
                  </select>
                  <button onClick={refreshOutbox} disabled={busy} style={{ fontSize: 13 }}>{isZh ? "刷新" : "Refresh"}</button>
                </div>
                {outboxItems.length === 0 ? (
                  <EmptyState text={isZh ? "暂无出站消息" : "No outbox messages"} />
                ) : (
                  <>
                    <Table>
                      <thead>
                        <tr>
                          <th>Provider</th>
                          <th>Workspace</th>
                          <th>Chat ID</th>
                          <th>Request ID</th>
                          <th>{isZh ? "状态" : "Status"}</th>
                          <th>{isZh ? "重试次数" : "Attempts"}</th>
                          <th>{isZh ? "下次重试" : "Next Attempt"}</th>
                          <th>{isZh ? "错误" : "Error"}</th>
                          <th>{isZh ? "操作" : "Actions"}</th>
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
                            <td>{fmtDateTime(m.nextAttemptAt, locale)}</td>
                            <td>{String(m.lastErrorCategory ?? "")}{m.lastErrorDigest ? `:${String(m.lastErrorDigest)}` : ""}</td>
                            <td>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button disabled={busy || !m.id} onClick={() => retryOutbox(String(m.id))} style={{ fontSize: 12 }}>
                                  {isZh ? "重试" : "Retry"}
                                </button>
                                <button disabled={busy || !m.id} onClick={() => cancelOutbox(String(m.id))} style={{ fontSize: 12 }}>
                                  {isZh ? "取消" : "Cancel"}
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
                          {outPage * pageSize + 1}-{Math.min((outPage + 1) * pageSize, outboxItems.length)} / {outboxItems.length}
                        </span>
                        <div style={{ display: "flex", gap: 8 }}>
                          <button disabled={outPage === 0} onClick={() => setOutPage(p => Math.max(0, p - 1))}>{isZh ? "上一页" : "Prev"}</button>
                          <button disabled={outPage >= outTotalPages - 1} onClick={() => setOutPage(p => p + 1)}>{isZh ? "下一页" : "Next"}</button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </Card>
            )},
          ]} />
        )}
      </div>
    </div>
  );
}
