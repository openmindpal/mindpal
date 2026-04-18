"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader, Card, Table, Badge, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

function CallbackUrl() {
  const [url, setUrl] = useState("/auth/sso/callback");
  useEffect(() => { setUrl(`${window.location.origin}/auth/sso/callback`); }, []);
  return <>{url}</>;
}

type SsoProvider = {
  providerId: string;
  providerType: string;
  issuerUrl: string;
  clientId?: string;
  status: string;
  autoProvision?: boolean;
  createdAt?: string;
};
type ProvidersList = ApiError & { providers?: SsoProvider[] };

export default function SsoProvidersClient(props: {
  locale: string;
  initial: { providers: unknown; status: number };
}) {
  const [providers, setProviders] = useState<ProvidersList | null>((props.initial.providers as ProvidersList) ?? null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [status, setStatus] = useState<number>(props.initial.status);
  const [error, setError] = useState<string>("");
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formType, setFormType] = useState<string>("oidc");
  const [formIssuerUrl, setFormIssuerUrl] = useState("");
  const [formClientId, setFormClientId] = useState("");
  const [formClientSecret, setFormClientSecret] = useState("");
  const [formScopes, setFormScopes] = useState("openid profile email");
  const [formAutoProvision, setFormAutoProvision] = useState(true);

  const providerItems = Array.isArray(providers?.providers) ? providers.providers : [];

  async function refreshProviders() {
    const res = await apiFetch(`/sso/providers`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setProviders((json as ProvidersList) ?? null);
    if (!res.ok) throw toApiError(json);
  }

  async function createProvider() {
    setError("");
    try {
      const res = await apiFetch(`/sso/providers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          providerType: formType,
          issuerUrl: formIssuerUrl,
          clientId: formClientId,
          clientSecretRef: formClientSecret || null,
          scopes: formScopes,
          autoProvision: formAutoProvision,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setShowForm(false);
      setFormIssuerUrl("");
      setFormClientId("");
      setFormClientSecret("");
      await refreshProviders();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function toggleStatus(providerId: string, currentStatus: string) {
    setError("");
    try {
      const newStatus = currentStatus === "active" ? "disabled" : "active";
      const res = await apiFetch(`/sso/providers/${encodeURIComponent(providerId)}/status`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ status: newStatus }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshProviders();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  return (
    <div style={{ padding: "1.5rem" }}>
      <PageHeader
        title={t(props.locale, "admin.sso.title")}
        description={t(props.locale, "admin.sso.desc")}
        helpHref={getHelpHref("/admin/sso", props.locale) ?? undefined}
      />

      {error && (
        <div style={{ color: "var(--color-danger)", marginBottom: "1rem", padding: "0.75rem", background: "var(--color-danger-bg)", borderRadius: "0.5rem" }}>
          {error}
        </div>
      )}

      <Card title={t(props.locale, "admin.sso.providers")}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
          <button
            onClick={() => setShowForm(!showForm)}
            style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
          >
            {showForm ? t(props.locale, "common.cancel") : t(props.locale, "admin.sso.addProvider")}
          </button>
        </div>

        {showForm && (
          <div style={{ padding: "1rem", background: "rgba(15,23,42,0.03)", borderRadius: "0.5rem", marginBottom: "1rem" }}>
            {/* Type-specific hint */}
            {(formType === "wechat" || formType === "alipay") && (
              <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--sl-warning-bg, #fff8e1)", borderRadius: 6, borderLeft: "3px solid var(--sl-warning, #f59e0b)", fontSize: 12, color: "var(--sl-muted)" }}>
                {t(props.locale, `admin.sso.form.hint.${formType}`)}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.sso.form.type")}</label>
                <select
                  value={formType}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
                    const v = e.target.value;
                    setFormType(v);
                    // Auto-fill issuerUrl for known providers
                    if (v === "wechat") { setFormIssuerUrl("https://open.weixin.qq.com"); setFormScopes("snsapi_login"); }
                    else if (v === "alipay") { setFormIssuerUrl("https://openauth.alipay.com"); setFormScopes("auth_user"); }
                    else if (v === "dingtalk") { setFormIssuerUrl("https://oapi.dingtalk.com"); setFormScopes("openid corpid"); }
                    else if (v === "feishu") { setFormIssuerUrl("https://open.feishu.cn"); setFormScopes("openid"); }
                    else if (v === "wecom") { setFormIssuerUrl("https://open.work.weixin.qq.com"); setFormScopes("snsapi_base"); }
                    else { setFormIssuerUrl(""); setFormScopes("openid profile email"); }
                  }}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                >
                  <option value="oidc">{t(props.locale, "admin.sso.type.oidc")}</option>
                  <option value="wechat">{t(props.locale, "admin.sso.type.wechat")}</option>
                  <option value="alipay">{t(props.locale, "admin.sso.type.alipay")}</option>
                  <option value="dingtalk">{t(props.locale, "admin.sso.type.dingtalk")}</option>
                  <option value="feishu">{t(props.locale, "admin.sso.type.feishu")}</option>
                  <option value="wecom">{t(props.locale, "admin.sso.type.wecom")}</option>
                  <option value="saml">{t(props.locale, "admin.sso.type.saml")}</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
                  {["wechat", "alipay", "dingtalk", "feishu", "wecom"].includes(formType)
                    ? t(props.locale, "admin.sso.form.platformUrl")
                    : t(props.locale, "admin.sso.form.issuerUrl")}
                </label>
                <input
                  value={formIssuerUrl}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormIssuerUrl(e.target.value)}
                  placeholder={t(props.locale, "admin.sso.form.issuerUrlPlaceholder")}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                  readOnly={["wechat", "alipay"].includes(formType)}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
                  {["wechat", "alipay", "dingtalk", "feishu", "wecom"].includes(formType)
                    ? t(props.locale, "admin.sso.form.appId")
                    : t(props.locale, "admin.sso.form.clientId")}
                </label>
                <input
                  value={formClientId}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormClientId(e.target.value)}
                  placeholder={["wechat", "alipay", "dingtalk", "feishu", "wecom"].includes(formType) ? "App ID / AppKey" : "client_id"}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
                  {["wechat", "alipay", "dingtalk", "feishu", "wecom"].includes(formType)
                    ? t(props.locale, "admin.sso.form.appSecret")
                    : t(props.locale, "admin.sso.form.clientSecret")}
                </label>
                <input
                  type="password"
                  value={formClientSecret}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormClientSecret(e.target.value)}
                  placeholder={["wechat", "alipay", "dingtalk", "feishu", "wecom"].includes(formType) ? "App Secret" : "client_secret"}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                />
              </div>
              {/* Only show scopes for OIDC/SAML; hide for Chinese social providers */}
              {!["wechat", "alipay"].includes(formType) && (
                <div>
                  <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.sso.form.scopes")}</label>
                  <input
                    value={formScopes}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormScopes(e.target.value)}
                    style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                  />
                </div>
              )}
              <div style={{ display: "flex", alignItems: "center", paddingTop: "1.5rem" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={formAutoProvision}
                    onChange={(e) => setFormAutoProvision(e.target.checked)}
                  />
                  {t(props.locale, "admin.sso.form.autoProvisionDesc")}
                </label>
              </div>
            </div>
            <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
              <button onClick={createProvider} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {t(props.locale, "common.create")}
              </button>
              <button onClick={() => setShowForm(false)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
                {t(props.locale, "common.cancel")}
              </button>
            </div>
          </div>
        )}

        {providerItems.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "var(--sl-muted)" }}>
            {t(props.locale, "admin.sso.noProviders")}
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "admin.sso.table.type")}</th>
                <th>{t(props.locale, "admin.sso.table.issuer")}</th>
                <th>{t(props.locale, "admin.sso.table.clientId")}</th>
                <th>{t(props.locale, "admin.sso.table.status")}</th>
                <th>{t(props.locale, "admin.sso.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {providerItems.map((p) => (
                <tr key={p.providerId}>
                  <td>
                    <Badge tone={p.providerType === "oidc" ? "success" : "warning"}>
                      {t(props.locale, `admin.sso.type.${p.providerType}`) || p.providerType.toUpperCase()}
                    </Badge>
                  </td>
                  <td style={{ maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {p.issuerUrl}
                  </td>
                  <td>{p.clientId || "-"}</td>
                  <td>
                    <Badge tone={p.status === "active" ? "success" : "neutral"}>
                      {p.status}
                    </Badge>
                  </td>
                  <td>
                    <button
                      onClick={() => toggleStatus(p.providerId, p.status)}
                      style={{
                        padding: "4px 12px",
                        borderRadius: 6,
                        background: p.status === "active" ? "var(--sl-danger)" : "var(--sl-accent)",
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {p.status === "active" ? t(props.locale, "common.disable") : t(props.locale, "common.enable")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <h3 style={{ marginTop: 0 }}>{t(props.locale, "admin.sso.instructions.title")}</h3>
        <div style={{ fontSize: "0.875rem", color: "var(--color-text-muted)" }}>
          <p style={{ marginTop: 0, padding: "8px 12px", background: "var(--sl-bg-alt, #f8fafc)", borderRadius: 6, borderLeft: "3px solid var(--sl-accent)" }}>
            <strong>{t(props.locale, "admin.sso.instructions.title")}:</strong>{" "}
            {t(props.locale, "admin.sso.instructions.oidc")}
          </p>
          <p><strong>SAML:</strong> {t(props.locale, "admin.sso.instructions.saml")}</p>
          <p><strong>{t(props.locale, "admin.sso.instructions.callback")}:</strong></p>
          <code style={{ display: "block", padding: "0.5rem", background: "var(--color-surface-2)", borderRadius: "0.25rem" }}>
            <CallbackUrl />
          </code>
        </div>
      </Card>
    </div>
  );
}
