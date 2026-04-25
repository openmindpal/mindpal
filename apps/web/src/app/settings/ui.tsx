"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch, getClientAuthToken, setClientAuthToken } from "@/lib/api";
import { t } from "@/lib/i18n";
import { type ApiError, errText as errTextShared } from "@/lib/apiError";
import { Badge, Card, PageHeader } from "@/components/ui";

function errMsg(e: unknown) {
  if (e instanceof Error) return e.message;
  return String(e);
}

function parseErr(json: unknown, locale: string) {
  const o = json && typeof json === "object" ? (json as ApiError) : {};
  return errTextShared(locale, o) || "ERROR";
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

const PROVIDER_ICONS: Record<string, string> = {
  wechat: "🟢", alipay: "🔵", dingtalk: "📌", feishu: "🐦", wecom: "🏢",
  oidc: "🔐", saml: "🛡️",
};
function providerIcon(type: string) { return PROVIDER_ICONS[type] ?? "🔗"; }

type PatToken = { id: string; name: string | null; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null; spaceId: string | null };
type MfaStatus = { enrolled: boolean; verified: boolean; method: string | null; recoveryCodesRemaining: number };

export default function SettingsClient(props: { locale: string }) {
  // SSR-safe: use static initial values, then hydrate from localStorage in useEffect
  const [authToken, setAuthToken] = useState<string>("");
  const [authTokenStatus, setAuthTokenStatus] = useState<"unset" | "set">("unset");
  const [authEditing, setAuthEditing] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [hydrated, setHydrated] = useState(false);

  /* ─── PAT state ─── */
  const [patTokens, setPatTokens] = useState<PatToken[]>([]);
  const patPageSize = 20;
  const [patPage, setPatPage] = useState(0);
  const patTotalPages = Math.max(1, Math.ceil(patTokens.length / patPageSize));
  const pagedPatTokens = useMemo(() => patTokens.slice(patPage * patPageSize, (patPage + 1) * patPageSize), [patTokens, patPage]);
  const [patLoading, setPatLoading] = useState(false);
  const [patErr, setPatErr] = useState("");
  const [patCreateName, setPatCreateName] = useState("");
  const [patCreateExpiry, setPatCreateExpiry] = useState("never");
  const [patCreating, setPatCreating] = useState(false);
  const [patCreatedToken, setPatCreatedToken] = useState<string | null>(null);

  /* ─── MFA state ─── */
  const [mfaStatus, setMfaStatus] = useState<MfaStatus | null>(null);
  const [mfaLoading, setMfaLoading] = useState(false);
  const [mfaErr, setMfaErr] = useState("");
  const [mfaEnrollData, setMfaEnrollData] = useState<{ totpUri: string; secret: string; recoveryCodes: string[] } | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaBusy, setMfaBusy] = useState(false);

  /* ─── SSO state ─── */
  const [ssoProviders, setSsoProviders] = useState<{ providerId: string; providerType: string; status: string }[]>([]);
  const ssoPageSize = 20;
  const [ssoPage, setSsoPage] = useState(0);
  const ssoTotalPages = Math.max(1, Math.ceil(ssoProviders.length / ssoPageSize));
  const pagedSsoProviders = useMemo(() => ssoProviders.slice(ssoPage * ssoPageSize, (ssoPage + 1) * ssoPageSize), [ssoProviders, ssoPage]);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [ssoBusy, setSsoBusy] = useState<string | null>(null); // providerId being initiated
  const [ssoErr, setSsoErr] = useState("");
  const [ssoTenantId, setSsoTenantId] = useState(""); // dynamically fetched from /me API
  const [nl2uiFontSize, setNl2uiFontSize] = useState<string>("medium");
  const [nl2uiCardStyle, setNl2uiCardStyle] = useState<string>("modern");
  const [nl2uiColorTheme, setNl2uiColorTheme] = useState<string>("blue");
  const [nl2uiDensity, setNl2uiDensity] = useState<string>("comfortable");
  const [nl2uiDefaultLayout, setNl2uiDefaultLayout] = useState<string>("list");
  const [nl2uiPrefsStatus, setNl2uiPrefsStatus] = useState<string>("idle");
  const [nl2uiPrefsErr, setNl2uiPrefsErr] = useState<string>("");

  const [consoleErr, setConsoleErr] = useState<string>("");


  function statusText(v: string) {
    const key = `status.${v}`;
    const out = t(props.locale, key);
    return out === key ? v : out;
  }

  function saveToken() {
    const v = authToken.trim();
    setClientAuthToken(v);
    setAuthToken(v);
    setAuthTokenStatus(v ? "set" : "unset");
    setAuthEditing(false);
    setConsoleErr("");
  }

  function clearToken() {
    setClientAuthToken("");
    setAuthToken("");
    setAuthTokenStatus("unset");
    setAuthEditing(true);
    setConsoleErr("");
  }

  function generateCredential() {
    // Generate a secure credential with UUID-like random ID
    // Format: dev:user_<timestamp>_<random> to ensure uniqueness
    const timestamp = Date.now().toString(36);
    const randomPart = crypto.randomUUID().replace(/-/g, "").substring(0, 12);
    const generated = `dev:user_${timestamp}_${randomPart}`;
    setAuthToken(generated);
    setClientAuthToken(generated);
    setAuthTokenStatus("set");
    setAuthEditing(false);
    setConsoleErr("");
  }

  /* ─── PAT functions ─── */

  const loadPatTokens = useCallback(async () => {
    setPatErr("");
    setPatLoading(true);
    try {
      const res = await apiFetch("/auth/tokens?limit=100", { method: "GET", locale: props.locale });
      if (res.ok) {
        const data = await res.json() as { items: PatToken[] };
        setPatTokens(data.items ?? []);
        setPatPage(0);
      } else {
        setPatErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setPatErr(errMsg(e)); }
    setPatLoading(false);
  }, [props.locale]);

  async function createPat() {
    setPatErr("");
    setPatCreating(true);
    setPatCreatedToken(null);
    try {
      let expiresAt: string | undefined;
      if (patCreateExpiry !== "never") {
        const days = parseInt(patCreateExpiry, 10);
        expiresAt = new Date(Date.now() + days * 86400000).toISOString();
      }
      const res = await apiFetch("/auth/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ name: patCreateName.trim() || undefined, expiresAt }),
      });
      if (res.ok) {
        const data = await res.json() as { token: string };
        setPatCreatedToken(data.token);
        setPatCreateName("");
        setPatCreateExpiry("never");
        await loadPatTokens();
      } else {
        setPatErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setPatErr(errMsg(e)); }
    setPatCreating(false);
  }

  async function revokePat(tokenId: string) {
    setPatErr("");
    try {
      const res = await apiFetch(`/auth/tokens/${tokenId}/revoke`, { method: "POST", locale: props.locale });
      if (res.ok) {
        await loadPatTokens();
      } else {
        setPatErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setPatErr(errMsg(e)); }
  }

  function patStatus(tok: PatToken): "active" | "expired" | "revoked" {
    if (tok.revokedAt) return "revoked";
    // eslint-disable-next-line react-hooks/purity -- Date.now() needed for token expiry check
    if (tok.expiresAt && Date.parse(tok.expiresAt) <= Date.now()) return "expired";
    return "active";
  }

  /* ─── MFA functions ─── */

  const loadMfaStatus = useCallback(async () => {
    setMfaErr("");
    setMfaLoading(true);
    try {
      const res = await apiFetch("/auth/mfa/status", { method: "GET", locale: props.locale });
      if (res.ok) {
        setMfaStatus(await res.json() as MfaStatus);
      } else {
        setMfaErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setMfaErr(errMsg(e)); }
    setMfaLoading(false);
  }, [props.locale]);

  async function enrollMfa() {
    setMfaErr("");
    setMfaBusy(true);
    try {
      const res = await apiFetch("/auth/mfa/enroll", { method: "POST", locale: props.locale });
      if (res.ok) {
        const data = await res.json() as { totpUri: string; secret: string; recoveryCodes: string[] };
        setMfaEnrollData(data);
        await loadMfaStatus();
      } else {
        setMfaErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setMfaErr(errMsg(e)); }
    setMfaBusy(false);
  }

  async function confirmMfa() {
    setMfaErr("");
    setMfaBusy(true);
    try {
      const res = await apiFetch("/auth/mfa/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      if (res.ok) {
        setMfaCode("");
        setMfaEnrollData(null);
        await loadMfaStatus();
      } else {
        setMfaErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setMfaErr(errMsg(e)); }
    setMfaBusy(false);
  }

  async function disableMfa() {
    setMfaErr("");
    setMfaBusy(true);
    try {
      const res = await apiFetch("/auth/mfa/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ code: mfaCode.trim() }),
      });
      if (res.ok) {
        setMfaCode("");
        setMfaEnrollData(null);
        await loadMfaStatus();
      } else {
        setMfaErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setMfaErr(errMsg(e)); }
    setMfaBusy(false);
  }

  /* ─── SSO functions ─── */

  const loadSsoProviders = useCallback(async () => {
    setSsoLoading(true);
    try {
      const res = await apiFetch("/sso/providers", { locale: props.locale });
      if (res.ok) {
        const json = await res.json() as { providers?: { providerId: string; providerType: string; status: string }[] };
        setSsoProviders((json.providers ?? []).filter(p => p.status === "active"));
        setSsoPage(0);
      }
    } catch { /* ignore */ }
    setSsoLoading(false);
  }, [props.locale]);

  async function initiateSsoProvider(providerId: string) {
    setSsoErr("");
    if (!ssoTenantId) {
      setSsoErr(t(props.locale, "settings.sso.noTenant"));
      return;
    }
    setSsoBusy(providerId);
    try {
      const res = await apiFetch("/auth/sso/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ tenantId: ssoTenantId, providerId }),
      });
      if (res.ok) {
        const data = await res.json() as { authorizeUrl: string };
        // eslint-disable-next-line react-hooks/immutability -- navigating away from page
        window.location.href = data.authorizeUrl;
        return;
      } else {
        setSsoErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) { setSsoErr(errMsg(e)); }
    setSsoBusy(null);
  }

  /* ─── NL2UI Style Preferences ─── */

  async function loadNl2uiPrefs() {
    setNl2uiPrefsErr("");
    setNl2uiPrefsStatus("loading");
    try {
      const res = await apiFetch("/nl2ui/style-preferences", { method: "GET", locale: props.locale });
      if (res.ok) {
        const data = await res.json() as { preferences: any };
        if (data.preferences) {
          setNl2uiFontSize(data.preferences.fontSize || "medium");
          setNl2uiCardStyle(data.preferences.cardStyle || "modern");
          setNl2uiColorTheme(data.preferences.colorTheme || "blue");
          setNl2uiDensity(data.preferences.density || "comfortable");
          setNl2uiDefaultLayout(data.preferences.defaultLayout || "list");
        }
        setNl2uiPrefsStatus("ready");
      } else {
        setNl2uiPrefsStatus("idle");
        setNl2uiPrefsErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) {
      setNl2uiPrefsStatus("idle");
      setNl2uiPrefsErr(errMsg(e));
    }
  }

  async function saveNl2uiPrefs() {
    setNl2uiPrefsErr("");
    setNl2uiPrefsStatus("saving");
    try {
      const res = await apiFetch("/nl2ui/style-preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          fontSize: nl2uiFontSize,
          cardStyle: nl2uiCardStyle,
          colorTheme: nl2uiColorTheme,
          density: nl2uiDensity,
          defaultLayout: nl2uiDefaultLayout,
        }),
      });
      if (res.ok) {
        setNl2uiPrefsStatus("saved");
        setTimeout(() => setNl2uiPrefsStatus("ready"), 1500);
      } else {
        setNl2uiPrefsStatus("ready");
        setNl2uiPrefsErr(parseErr(await res.json().catch(() => null), props.locale));
      }
    } catch (e: unknown) {
      setNl2uiPrefsStatus("ready");
      setNl2uiPrefsErr(errMsg(e));
    }
  }

  async function clearNl2uiPrefs() {
    setNl2uiPrefsErr("");
    try {
      await apiFetch("/nl2ui/style-preferences", { method: "DELETE", locale: props.locale });
      setNl2uiFontSize("medium");
      setNl2uiCardStyle("modern");
      setNl2uiColorTheme("blue");
      setNl2uiDensity("comfortable");
      setNl2uiDefaultLayout("list");
      setNl2uiPrefsStatus("idle");
    } catch (e: unknown) {
      setNl2uiPrefsErr(errMsg(e));
    }
  }

  /* SSR hydration: read localStorage after mount */
  useEffect(() => {
    const token = getClientAuthToken();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR hydration: read localStorage once on mount
    setAuthToken(token);
    setAuthTokenStatus(token ? "set" : "unset");
    setAuthEditing(!token);
    setHydrated(true);
    if (token) {
      loadNl2uiPrefs();
      loadPatTokens();
      loadMfaStatus();
      loadSsoProviders();
      // Fetch current tenantId from /me API (same pattern as HomeChat.tsx)
      void (async () => {
        try {
          const res = await apiFetch("/me", { locale: props.locale });
          if (res.ok) {
            const json = await res.json();
            const tid = typeof json?.subject?.tenantId === "string" ? json.subject.tenantId.trim() : "";
            if (tid) setSsoTenantId(tid);
          }
        } catch { /* ignore - SSO initiate will show error if tenantId is empty */ }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <PageHeader
        title={t(props.locale, "settings.title")}
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
              readOnly={!authEditing}
              disabled={!authEditing}
            />
            {authEditing ? (
              <>
                <button onClick={generateCredential}>{t(props.locale, "settings.auth.generate")}</button>
                <button onClick={saveToken}>{t(props.locale, "action.save")}</button>
                {authTokenStatus === "set" && (
                  <button onClick={() => { setAuthToken(getClientAuthToken()); setAuthEditing(false); }}>{t(props.locale, "action.cancel")}</button>
                )}
              </>
            ) : (
              <>
                <button onClick={() => setAuthEditing(true)}>{t(props.locale, "action.edit")}</button>
                <button onClick={clearToken}>{t(props.locale, "action.clear")}</button>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* ─── PAT Token Management ─── */}
      <div style={{ marginTop: 16 }}>
        <Card
          title={t(props.locale, "settings.section.pat")}
          footer={<span style={{ fontSize: 12, color: "var(--sl-muted)" }}>{t(props.locale, "settings.pat.hint")}</span>}
        >
          {patErr && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginBottom: 8 }}>{patErr}</pre>}

          {/* Created token banner */}
          {patCreatedToken && (
            <div style={{ background: "var(--sl-success-bg, #e6f9e6)", border: "1px solid var(--sl-success, #2d8)", borderRadius: 6, padding: "10px 14px", marginBottom: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(props.locale, "settings.pat.tokenCreated")}</div>
              <div style={{ fontSize: 12, color: "var(--sl-muted)", marginBottom: 6 }}>{t(props.locale, "settings.pat.tokenWarning")}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <code style={{ fontSize: 13, wordBreak: "break-all", flex: 1 }}>{patCreatedToken}</code>
                <button onClick={() => { navigator.clipboard.writeText(patCreatedToken); }}>{t(props.locale, "action.copy")}</button>
                <button onClick={() => setPatCreatedToken(null)}>✕</button>
              </div>
            </div>
          )}

          {/* Create form */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <input
              value={patCreateName}
              onChange={(e) => setPatCreateName(e.target.value)}
              placeholder={t(props.locale, "settings.pat.namePlaceholder")}
              style={{ width: 200 }}
            />
            <select value={patCreateExpiry} onChange={(e) => setPatCreateExpiry(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
              <option value="never">{t(props.locale, "settings.pat.expiresAt.never")}</option>
              <option value="7">{t(props.locale, "settings.pat.expiresAt.7d")}</option>
              <option value="30">{t(props.locale, "settings.pat.expiresAt.30d")}</option>
              <option value="90">{t(props.locale, "settings.pat.expiresAt.90d")}</option>
            </select>
            <button onClick={createPat} disabled={patCreating}>
              {patCreating ? t(props.locale, "action.saving") : t(props.locale, "settings.pat.create")}
            </button>
            <button onClick={loadPatTokens} disabled={patLoading}>
              {patLoading ? t(props.locale, "status.loading") : t(props.locale, "action.load")}
            </button>
          </div>

          {/* Token list */}
          {patTokens.length === 0 ? (
            <p style={{ color: "var(--sl-muted)", fontSize: 13 }}>{t(props.locale, "settings.pat.empty")}</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--sl-border, #ddd)" }}>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>{t(props.locale, "settings.pat.col.name")}</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>{t(props.locale, "settings.pat.col.created")}</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>{t(props.locale, "settings.pat.col.lastUsed")}</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>{t(props.locale, "settings.pat.col.expires")}</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>{t(props.locale, "settings.pat.col.status")}</th>
                    <th style={{ textAlign: "left", padding: "6px 8px" }}>{t(props.locale, "settings.pat.col.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPatTokens.map((tok) => {
                    const st = patStatus(tok);
                    return (
                      <tr key={tok.id} style={{ borderBottom: "1px solid var(--sl-border, #eee)" }}>
                        <td style={{ padding: "6px 8px" }}>{tok.name || <span style={{ color: "var(--sl-muted)" }}>—</span>}</td>
                        <td style={{ padding: "6px 8px" }}>{fmtTime(tok.createdAt)}</td>
                        <td style={{ padding: "6px 8px" }}>{fmtTime(tok.lastUsedAt)}</td>
                        <td style={{ padding: "6px 8px" }}>{fmtTime(tok.expiresAt)}</td>
                        <td style={{ padding: "6px 8px" }}>
                          <Badge tone={st === "active" ? "success" : st === "expired" ? "warning" : "neutral"}>
                            {t(props.locale, `settings.pat.status.${st}`)}
                          </Badge>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          {st === "active" && (
                            <button onClick={() => revokePat(tok.id)} style={{ fontSize: 12 }}>
                              {t(props.locale, "settings.pat.revoke")}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {patTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(patPage * patPageSize + 1)).replace("{to}", String(Math.min((patPage + 1) * patPageSize, patTokens.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(patTokens.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={patPage === 0} onClick={() => setPatPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(patPage + 1))}</span>
                <button disabled={patPage >= patTotalPages - 1} onClick={() => setPatPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ─── MFA Management ─── */}
      <div style={{ marginTop: 16 }}>
        <Card
          title={t(props.locale, "settings.section.mfa")}
          footer={
            <span style={{ fontSize: 12, color: "var(--sl-muted)" }}>
              {t(props.locale, "settings.mfa.hint")}
              {mfaStatus && (
                <>
                  {" \xB7 "}
                  <Badge tone={mfaStatus.verified ? "success" : mfaStatus.enrolled ? "warning" : "neutral"}>
                    {mfaStatus.verified
                      ? t(props.locale, "settings.mfa.verified")
                      : mfaStatus.enrolled
                        ? t(props.locale, "settings.mfa.enrolled")
                        : t(props.locale, "settings.mfa.notEnrolled")}
                  </Badge>
                </>
              )}
            </span>
          }
        >
          {mfaErr && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginBottom: 8 }}>{mfaErr}</pre>}

          {mfaLoading && <p style={{ color: "var(--sl-muted)" }}>{t(props.locale, "status.loading")}</p>}

          {mfaStatus && !mfaStatus.verified && !mfaEnrollData && (
            <button onClick={enrollMfa} disabled={mfaBusy}>
              {mfaBusy ? t(props.locale, "action.saving") : t(props.locale, "settings.mfa.enable")}
            </button>
          )}

          {/* Enrollment flow: show secret + recovery codes + confirm */}
          {mfaEnrollData && !mfaStatus?.verified && (
            <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
              <p style={{ fontSize: 13, margin: 0 }}>{t(props.locale, "settings.mfa.scanQr")}</p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "settings.mfa.secretKey")}:</span>
                <code style={{ fontSize: 13, wordBreak: "break-all" }}>{mfaEnrollData.secret}</code>
                <button onClick={() => navigator.clipboard.writeText(mfaEnrollData.secret)} style={{ fontSize: 12 }}>{t(props.locale, "action.copy")}</button>
              </div>

              {mfaEnrollData.recoveryCodes.length > 0 && (
                <div style={{ background: "var(--sl-warning-bg, #fff8e6)", border: "1px solid var(--sl-warning, #e90)", borderRadius: 6, padding: "10px 14px" }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{t(props.locale, "settings.mfa.recoveryCodes")}</div>
                  <p style={{ fontSize: 12, color: "var(--sl-muted)", margin: "0 0 6px" }}>{t(props.locale, "settings.mfa.recoveryWarning")}</p>
                  <pre style={{ fontSize: 12, margin: 0, whiteSpace: "pre-wrap" }}>{mfaEnrollData.recoveryCodes.join("\n")}</pre>
                </div>
              )}

              <p style={{ fontSize: 13, margin: 0 }}>{t(props.locale, "settings.mfa.confirmCode")}</p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder={t(props.locale, "settings.mfa.codePlaceholder")}
                  maxLength={10}
                  style={{ width: 160 }}
                />
                <button onClick={confirmMfa} disabled={mfaBusy || !mfaCode.trim()}>
                  {mfaBusy ? t(props.locale, "action.saving") : t(props.locale, "settings.mfa.confirm")}
                </button>
              </div>
            </div>
          )}

          {/* Verified: show status + disable option */}
          {mfaStatus?.verified && (
            <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Badge tone="success">{t(props.locale, "settings.mfa.verified")}</Badge>
                <span style={{ fontSize: 13, color: "var(--sl-muted)" }}>
                  {t(props.locale, "settings.mfa.remainingCodes")}: {mfaStatus.recoveryCodesRemaining}
                </span>
              </div>
              <p style={{ fontSize: 13, color: "var(--sl-muted)", margin: 0 }}>{t(props.locale, "settings.mfa.disableHint")}</p>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder={t(props.locale, "settings.mfa.codePlaceholder")}
                  maxLength={20}
                  style={{ width: 160 }}
                />
                <button onClick={disableMfa} disabled={mfaBusy || !mfaCode.trim()}>
                  {mfaBusy ? t(props.locale, "action.saving") : t(props.locale, "settings.mfa.disable")}
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ─── Third-party Login ─── */}
      <div style={{ marginTop: 16 }}>
        <Card
          title={t(props.locale, "settings.section.sso")}
          footer={<span style={{ fontSize: 12, color: "var(--sl-muted)" }}>{t(props.locale, "settings.sso.hint")}</span>}
        >
          {ssoErr && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginBottom: 8 }}>{ssoErr}</pre>}
          {ssoLoading ? (
            <div style={{ color: "var(--sl-muted)", padding: 12, textAlign: "center" }}>{t(props.locale, "action.loading")}</div>
          ) : ssoProviders.length === 0 ? (
            <div style={{ color: "var(--sl-muted)", padding: 16, textAlign: "center", fontSize: 13 }}>
              <div>{t(props.locale, "settings.sso.noProviders")}</div>
              <Link
                href={`/admin/sso-providers?lang=${encodeURIComponent(props.locale)}`}
                style={{ display: "inline-block", marginTop: 8, color: "var(--sl-accent)", fontWeight: 500, fontSize: 13 }}
              >
                {t(props.locale, "settings.sso.goAdmin")} &rarr;
              </Link>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {pagedSsoProviders.map((p) => {
                const label = t(props.locale, `settings.sso.provider.${p.providerType}`);
                const displayLabel = label.startsWith("settings.sso.provider.") ? p.providerType.toUpperCase() : label;
                return (
                  <button
                    key={p.providerId}
                    onClick={() => initiateSsoProvider(p.providerId)}
                    disabled={ssoBusy !== null}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "10px 20px", borderRadius: 8,
                      border: "1px solid var(--sl-border)",
                      background: ssoBusy === p.providerId ? "var(--sl-surface)" : "var(--sl-bg, #fff)",
                      cursor: ssoBusy ? "wait" : "pointer",
                      fontSize: 14, fontWeight: 500,
                      transition: "box-shadow 0.15s",
                    }}
                    onMouseEnter={(e) => { if (!ssoBusy) (e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.08)"); }}
                    onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "none"; }}
                  >
                    <span style={{ fontSize: 18 }}>{providerIcon(p.providerType)}</span>
                    <span>{ssoBusy === p.providerId ? t(props.locale, "settings.sso.initiating") : displayLabel}</span>
                  </button>
                );
              })}
            </div>
          )}
          {ssoTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(ssoPage * ssoPageSize + 1)).replace("{to}", String(Math.min((ssoPage + 1) * ssoPageSize, ssoProviders.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(ssoProviders.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={ssoPage === 0} onClick={() => setSsoPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(ssoPage + 1))}</span>
                <button disabled={ssoPage >= ssoTotalPages - 1} onClick={() => setSsoPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* NL2UI style preferences */}
      <div style={{ marginTop: 16 }} id="nl2ui-prefs">
        <Card
          title={t(props.locale, "settings.section.nl2uiPrefs")}
          footer={
            <span>
              <Badge tone={nl2uiPrefsStatus === "saved" ? "success" : nl2uiPrefsStatus === "ready" ? "neutral" : "warning"}>
                {nl2uiPrefsStatus === "saved" ? t(props.locale, "action.saved") : statusText(nl2uiPrefsStatus)}
              </Badge>
            </span>
          }
        >
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
            <button onClick={loadNl2uiPrefs} disabled={nl2uiPrefsStatus === "loading"}>
              {nl2uiPrefsStatus === "loading" ? t(props.locale, "action.loading") : t(props.locale, "action.load")}
            </button>
          </div>
          {nl2uiPrefsErr && <pre style={{ color: "crimson", whiteSpace: "pre-wrap", marginBottom: 12 }}>{nl2uiPrefsErr}</pre>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16, marginBottom: 16 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.fontSize")}</span>
              <select value={nl2uiFontSize} onChange={(e) => setNl2uiFontSize(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="small">{t(props.locale, "nl2ui.prefs.fontSize.small")}</option>
                <option value="medium">{t(props.locale, "nl2ui.prefs.fontSize.medium")}</option>
                <option value="large">{t(props.locale, "nl2ui.prefs.fontSize.large")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.cardStyle")}</span>
              <select value={nl2uiCardStyle} onChange={(e) => setNl2uiCardStyle(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="minimal">{t(props.locale, "nl2ui.prefs.cardStyle.minimal")}</option>
                <option value="modern">{t(props.locale, "nl2ui.prefs.cardStyle.modern")}</option>
                <option value="classic">{t(props.locale, "nl2ui.prefs.cardStyle.classic")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.colorTheme")}</span>
              <select value={nl2uiColorTheme} onChange={(e) => setNl2uiColorTheme(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="blue">{t(props.locale, "nl2ui.prefs.colorTheme.blue")}</option>
                <option value="green">{t(props.locale, "nl2ui.prefs.colorTheme.green")}</option>
                <option value="warm">{t(props.locale, "nl2ui.prefs.colorTheme.warm")}</option>
                <option value="dark">{t(props.locale, "nl2ui.prefs.colorTheme.dark")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.density")}</span>
              <select value={nl2uiDensity} onChange={(e) => setNl2uiDensity(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="compact">{t(props.locale, "nl2ui.prefs.density.compact")}</option>
                <option value="comfortable">{t(props.locale, "nl2ui.prefs.density.comfortable")}</option>
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(props.locale, "nl2ui.prefs.defaultLayout")}</span>
              <select value={nl2uiDefaultLayout} onChange={(e) => setNl2uiDefaultLayout(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6 }}>
                <option value="list">{t(props.locale, "nl2ui.prefs.defaultLayout.list")}</option>
                <option value="cards">{t(props.locale, "nl2ui.prefs.defaultLayout.cards")}</option>
                <option value="kanban">{t(props.locale, "nl2ui.prefs.defaultLayout.kanban")}</option>
                <option value="table">{t(props.locale, "nl2ui.prefs.defaultLayout.table")}</option>
              </select>
            </label>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveNl2uiPrefs} disabled={nl2uiPrefsStatus === "saving"}>
              {nl2uiPrefsStatus === "saving" ? t(props.locale, "action.saving") : t(props.locale, "action.save")}
            </button>
            <button onClick={clearNl2uiPrefs}>
              {t(props.locale, "action.clear")}
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}
