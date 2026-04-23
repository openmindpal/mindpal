"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api"
import { fmtDateTime } from "@/lib/fmtDateTime";
import { t } from "@/lib/i18n";
import { PageHeader, Card, Table, Badge, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";

type ScimConfig = {
  configId: string;
  tenantId: string;
  enabled: boolean;
  bearerTokenHash?: string;
  defaultRoleId?: string;
  autoProvision?: boolean;
  createdAt?: string;
  lastSyncAt?: string;
  provisionedCount?: number;
};
type ConfigsList = ApiError & { configs?: ScimConfig[] };

export default function ScimConfigClient(props: {
  locale: string;
  initial: { configs: unknown; status: number };
}) {
  const [configs, setConfigs] = useState<ConfigsList | null>((props.initial.configs as ConfigsList) ?? null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [status, setStatus] = useState<number>(props.initial.status);
  const [error, setError] = useState<string>("");
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formTenantId, setFormTenantId] = useState("");
  const [formBearerToken, setFormBearerToken] = useState("");
  const [formDefaultRoleId, setFormDefaultRoleId] = useState("");
  const [formAutoProvision, setFormAutoProvision] = useState(true);
  const [generatedToken, setGeneratedToken] = useState<string>("");

  const configItems = useMemo(() => Array.isArray(configs?.configs) ? configs.configs : [], [configs]);
  const scimPageSize = 20;
  const [scimPage, setScimPage] = useState(0);
  const scimTotalPages = Math.max(1, Math.ceil(configItems.length / scimPageSize));
  const pagedConfigs = useMemo(() => configItems.slice(scimPage * scimPageSize, (scimPage + 1) * scimPageSize), [configItems, scimPage]);

  async function refreshConfigs() {
    const res = await apiFetch(`/scim/v2/admin/configs`, { locale: props.locale, cache: "no-store" });
    setStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setConfigs((json as ConfigsList) ?? null);
    setScimPage(0);
    if (!res.ok) throw toApiError(json);
  }

  async function createConfig() {
    setError("");
    try {
      const res = await apiFetch(`/scim/v2/admin/configs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({
          tenantId: formTenantId || undefined,
          bearerToken: formBearerToken || undefined,
          defaultRoleId: formDefaultRoleId || undefined,
          autoProvision: formAutoProvision,
        }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const result = json as { token?: string };
      if (result.token) {
        setGeneratedToken(result.token);
      }
      setShowForm(false);
      setFormTenantId("");
      setFormBearerToken("");
      setFormDefaultRoleId("");
      await refreshConfigs();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function toggleEnabled(configId: string, currentEnabled: boolean) {
    setError("");
    try {
      const res = await apiFetch(`/scim/v2/admin/configs/${encodeURIComponent(configId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ enabled: !currentEnabled }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshConfigs();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function regenerateToken(configId: string) {
    setError("");
    try {
      const res = await apiFetch(`/scim/v2/admin/configs/${encodeURIComponent(configId)}/regenerate-token`, {
        method: "POST",
        locale: props.locale,
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const result = json as { token?: string };
      if (result.token) {
        setGeneratedToken(result.token);
      }
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  return (
    <div style={{ padding: "1.5rem" }}>
      <PageHeader
        title={t(props.locale, "admin.scim.title")}
        description={t(props.locale, "admin.scim.desc")}
        helpHref={getHelpHref("/admin/scim", props.locale) ?? undefined}
      />

      {error && (
        <div style={{ color: "var(--sl-danger)", marginBottom: "1rem", padding: "0.75rem", background: "rgba(220,38,38,0.1)", borderRadius: "0.5rem" }}>
          {error}
        </div>
      )}

      {generatedToken && (
        <div style={{ marginBottom: "1rem", padding: "1rem", background: "rgba(34,197,94,0.1)", borderRadius: "0.5rem", border: "1px solid rgba(34,197,94,0.3)" }}>
          <strong>{t(props.locale, "admin.scim.tokenGenerated")}:</strong>
          <code style={{ display: "block", marginTop: "0.5rem", padding: "0.5rem", background: "var(--sl-surface)", borderRadius: "0.25rem", wordBreak: "break-all" }}>
            {generatedToken}
          </code>
          <p style={{ fontSize: 12, color: "var(--sl-muted)", marginTop: "0.5rem", marginBottom: 0 }}>
            {t(props.locale, "admin.scim.tokenWarning")}
          </p>
          <button
            onClick={() => setGeneratedToken("")}
            style={{ marginTop: "0.5rem", padding: "4px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}
          >
            {t(props.locale, "common.dismiss")}
          </button>
        </div>
      )}

      <Card title={t(props.locale, "admin.scim.configs")}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "1rem" }}>
          <button
            onClick={() => setShowForm(!showForm)}
            style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
          >
            {showForm ? t(props.locale, "common.cancel") : t(props.locale, "admin.scim.addConfig")}
          </button>
        </div>

        {showForm && (
          <div style={{ padding: "1rem", background: "rgba(15,23,42,0.03)", borderRadius: "0.5rem", marginBottom: "1rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.scim.form.tenantId")}</label>
                <input
                  value={formTenantId}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormTenantId(e.target.value)}
                  placeholder={t(props.locale, "admin.scim.form.tenantIdPlaceholder")}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.scim.form.bearerToken")}</label>
                <input
                  value={formBearerToken}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormBearerToken(e.target.value)}
                  placeholder={t(props.locale, "admin.scim.form.bearerTokenPlaceholder")}
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>{t(props.locale, "admin.scim.form.defaultRoleId")}</label>
                <input
                  value={formDefaultRoleId}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFormDefaultRoleId(e.target.value)}
                  placeholder="role_viewer"
                  style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", paddingTop: "1.5rem" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={formAutoProvision}
                    onChange={(e) => setFormAutoProvision(e.target.checked)}
                  />
                  {t(props.locale, "admin.scim.form.autoProvision")}
                </label>
              </div>
            </div>
            <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
              <button onClick={createConfig} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
                {t(props.locale, "common.create")}
              </button>
              <button onClick={() => setShowForm(false)} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
                {t(props.locale, "common.cancel")}
              </button>
            </div>
          </div>
        )}

        {configItems.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem", color: "var(--sl-muted)" }}>
            {t(props.locale, "admin.scim.noConfigs")}
          </div>
        ) : (
          <>
          <Table>
            <thead>
              <tr>
                <th>{t(props.locale, "admin.scim.table.tenantId")}</th>
                <th>{t(props.locale, "admin.scim.table.status")}</th>
                <th>{t(props.locale, "admin.scim.table.provisionedCount")}</th>
                <th>{t(props.locale, "admin.scim.table.lastSync")}</th>
                <th>{t(props.locale, "admin.scim.table.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {pagedConfigs.map((c) => (
                <tr key={c.configId}>
                  <td>{c.tenantId || "-"}</td>
                  <td>
                    <Badge tone={c.enabled ? "success" : "neutral"}>
                      {c.enabled ? t(props.locale, "common.enabled") : t(props.locale, "common.disabled")}
                    </Badge>
                  </td>
                  <td>{c.provisionedCount ?? 0}</td>
                  <td>{c.lastSyncAt ? fmtDateTime(c.lastSyncAt, props.locale) : "-"}</td>
                  <td style={{ display: "flex", gap: "0.5rem" }}>
                    <button
                      onClick={() => toggleEnabled(c.configId, c.enabled)}
                      style={{
                        padding: "4px 12px",
                        borderRadius: 6,
                        background: c.enabled ? "var(--sl-danger)" : "var(--sl-accent)",
                        color: "#fff",
                        border: "none",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {c.enabled ? t(props.locale, "common.disable") : t(props.locale, "common.enable")}
                    </button>
                    <button
                      onClick={() => regenerateToken(c.configId)}
                      style={{
                        padding: "4px 12px",
                        borderRadius: 6,
                        border: "1px solid var(--sl-border)",
                        background: "var(--sl-surface)",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      {t(props.locale, "admin.scim.regenerateToken")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          {scimTotalPages > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, gap: 8 }}>
              <span style={{ opacity: 0.7, fontSize: 13 }}>
                {t(props.locale, "pagination.showing").replace("{from}", String(scimPage * scimPageSize + 1)).replace("{to}", String(Math.min((scimPage + 1) * scimPageSize, configItems.length)))}
                {t(props.locale, "pagination.total").replace("{count}", String(configItems.length))}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button disabled={scimPage === 0} onClick={() => setScimPage((p) => Math.max(0, p - 1))}>{t(props.locale, "pagination.prev")}</button>
                <span style={{ lineHeight: "32px", fontSize: 13 }}>{t(props.locale, "pagination.page").replace("{page}", String(scimPage + 1))}</span>
                <button disabled={scimPage >= scimTotalPages - 1} onClick={() => setScimPage((p) => p + 1)}>{t(props.locale, "pagination.next")}</button>
              </div>
            </div>
          )}
          </>
        )}
      </Card>

      <div style={{ marginTop: "1.5rem" }}>
        <Card title={t(props.locale, "admin.scim.instructions.title")}>
        <div style={{ fontSize: "0.875rem", color: "var(--sl-muted)" }}>
          <p><strong>{t(props.locale, "admin.scim.instructions.endpoint")}:</strong></p>
          <code style={{ display: "block", padding: "0.5rem", background: "rgba(15,23,42,0.03)", borderRadius: "0.25rem", marginBottom: "1rem" }}>
            {typeof window !== "undefined" ? `${window.location.origin}/scim/v2` : "/scim/v2"}
          </code>
          <p>{t(props.locale, "admin.scim.instructions.auth")}</p>
          <p>{t(props.locale, "admin.scim.instructions.idp")}</p>
        </div>
        </Card>
      </div>
    </div>
  );
}
