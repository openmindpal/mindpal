"use client";

import { useMemo, useState } from "react";
import { API_BASE, apiHeaders, text } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader } from "@/components/ui";

type ApiErr = { errorCode?: string; message?: unknown; traceId?: string };
type RoleItem = { id: string; name?: string };
type PermissionItem = { id?: string; resource_type?: string; action?: string };
type RolesList = ApiErr & { items?: RoleItem[] };
type PermissionsList = ApiErr & { items?: PermissionItem[] };

function errText(locale: string, e: ApiErr | null) {
  if (!e) return "";
  const code = e.errorCode ?? "ERROR";
  const msgVal = e.message;
  const msg =
    msgVal && typeof msgVal === "object" ? text(msgVal as Record<string, string>, locale) : msgVal != null ? String(msgVal) : "";
  const trace = e.traceId ? ` traceId=${e.traceId}` : "";
  return `${code}${msg ? `: ${msg}` : ""}${trace}`;
}

function toApiErr(e: unknown): ApiErr {
  if (e && typeof e === "object") return e as ApiErr;
  return { errorCode: "ERROR", message: String(e) };
}

export default function AdminRbacClient(props: {
  locale: string;
  initial: { roles: unknown; permissions: unknown; rolesStatus: number; permissionsStatus: number };
}) {
  const [roles, setRoles] = useState<RolesList | null>((props.initial.roles as RolesList) ?? null);
  const [permissions, setPermissions] = useState<PermissionsList | null>((props.initial.permissions as PermissionsList) ?? null);
  const [rolesStatus, setRolesStatus] = useState<number>(props.initial.rolesStatus);
  const [permissionsStatus, setPermissionsStatus] = useState<number>(props.initial.permissionsStatus);

  const [roleName, setRoleName] = useState("");
  const [selectedRoleId, setSelectedRoleId] = useState<string>("");
  const [roleDetail, setRoleDetail] = useState<unknown>(null);

  const [permFilterResource, setPermFilterResource] = useState("");
  const [permFilterAction, setPermFilterAction] = useState("");
  const [grantResourceType, setGrantResourceType] = useState("entity");
  const [grantAction, setGrantAction] = useState("read");
  const [grantRowFiltersReadJson, setGrantRowFiltersReadJson] = useState<string>("");
  const [grantRowFiltersWriteJson, setGrantRowFiltersWriteJson] = useState<string>("");
  const [policyPreflight, setPolicyPreflight] = useState<unknown>(null);

  const [bindSubjectId, setBindSubjectId] = useState("");
  const [bindScopeType, setBindScopeType] = useState<"tenant" | "space">("space");
  const [bindScopeId, setBindScopeId] = useState("space_dev");
  const [createdBindings, setCreatedBindings] = useState<string[]>([]);

  const [error, setError] = useState<string>("");

  const initialError = useMemo(() => {
    if (rolesStatus >= 400) return errText(props.locale, roles);
    if (permissionsStatus >= 400) return errText(props.locale, permissions);
    return "";
  }, [permissions, permissionsStatus, props.locale, roles, rolesStatus]);

  const roleItems = useMemo(() => (Array.isArray(roles?.items) ? roles.items : []), [roles]);
  const permissionItems = useMemo(() => (Array.isArray(permissions?.items) ? permissions.items : []), [permissions]);

  const filteredPermissions = useMemo(() => {
    const r = permFilterResource.trim();
    const a = permFilterAction.trim();
    return permissionItems.filter((p: PermissionItem) => {
      if (r && !String(p.resource_type ?? "").includes(r)) return false;
      if (a && !String(p.action ?? "").includes(a)) return false;
      return true;
    });
  }, [permissionItems, permFilterResource, permFilterAction]);

  async function refreshRoles() {
    const res = await fetch(`${API_BASE}/rbac/roles?limit=200`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setRolesStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setRoles((json as RolesList) ?? null);
    if (!res.ok) throw toApiErr(json);
  }

  async function refreshPermissions() {
    const res = await fetch(`${API_BASE}/rbac/permissions?limit=500`, { headers: apiHeaders(props.locale), cache: "no-store" });
    setPermissionsStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setPermissions((json as PermissionsList) ?? null);
    if (!res.ok) throw toApiErr(json);
  }

  async function loadRoleDetail(roleId: string) {
    const res = await fetch(`${API_BASE}/rbac/roles/${encodeURIComponent(roleId)}`, { headers: apiHeaders(props.locale), cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw toApiErr(json);
    const obj = json && typeof json === "object" ? (json as { role?: unknown }) : {};
    setRoleDetail(obj.role ?? null);
  }

  async function createRole() {
    setError("");
    try {
      const res = await fetch(`${API_BASE}/rbac/roles`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ name: roleName }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      setRoleName("");
      await refreshRoles();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function grantPermission() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      let rowFiltersRead: unknown = undefined;
      let rowFiltersWrite: unknown = undefined;
      if (grantRowFiltersReadJson.trim()) rowFiltersRead = JSON.parse(grantRowFiltersReadJson);
      if (grantRowFiltersWriteJson.trim()) rowFiltersWrite = JSON.parse(grantRowFiltersWriteJson);
      const res = await fetch(`${API_BASE}/rbac/roles/${encodeURIComponent(selectedRoleId)}/permissions`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ resourceType: grantResourceType, action: grantAction, rowFiltersRead, rowFiltersWrite }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      await refreshPermissions();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function preflightPolicy() {
    setError("");
    setPolicyPreflight(null);
    try {
      let rowFilters: unknown = undefined;
      if (grantRowFiltersReadJson.trim()) rowFilters = JSON.parse(grantRowFiltersReadJson);
      const res = await fetch(`${API_BASE}/rbac/policy/preflight`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ rowFilters }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      setPolicyPreflight(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function revokePermission() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      const res = await fetch(`${API_BASE}/rbac/roles/${encodeURIComponent(selectedRoleId)}/permissions`, {
        method: "DELETE",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ resourceType: grantResourceType, action: grantAction }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      await refreshPermissions();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function createBinding() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      const res = await fetch(`${API_BASE}/rbac/bindings`, {
        method: "POST",
        headers: { ...apiHeaders(props.locale), "content-type": "application/json" },
        body: JSON.stringify({ subjectId: bindSubjectId, roleId: selectedRoleId, scopeType: bindScopeType, scopeId: bindScopeId }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      const obj = json && typeof json === "object" ? (json as { bindingId?: unknown }) : {};
      const id = String(obj.bindingId ?? "");
      if (id) setCreatedBindings((s) => [id, ...s]);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  async function deleteBinding(bindingId: string) {
    setError("");
    try {
      const res = await fetch(`${API_BASE}/rbac/bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE", headers: apiHeaders(props.locale) });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiErr(json);
      setCreatedBindings((s) => s.filter((x) => x !== bindingId));
    } catch (e: unknown) {
      setError(errText(props.locale, toApiErr(e)));
    }
  }

  return (
    <div>
      <PageHeader title={t(props.locale, "admin.rbac.title")} />

      {error ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</pre> : null}
      {!error && initialError ? <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{initialError}</pre> : null}

      <section style={{ marginTop: 16 }}>
        <h2>{t(props.locale, "admin.rbac.rolesTitle")}</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder={t(props.locale, "admin.rbac.roleNamePlaceholder")}
            style={{ width: 240 }}
          />
          <button onClick={createRole} disabled={!roleName.trim()}>
            {t(props.locale, "admin.rbac.create")}
          </button>
          <button onClick={refreshRoles} style={{ marginLeft: 8 }}>
            {t(props.locale, "admin.rbac.refresh")}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: 16 }}>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "admin.rbac.list")}</div>
            <ul style={{ paddingLeft: 18 }}>
              {roleItems.map((r: RoleItem) => (
                <li key={String(r.id)}>
                  <button
                    onClick={async () => {
                      setSelectedRoleId(String(r.id));
                      setRoleDetail(null);
                      try {
                        await loadRoleDetail(String(r.id));
                      } catch (e: unknown) {
                        setError(errText(props.locale, toApiErr(e)));
                      }
                    }}
                  >
                    {String(r.name ?? r.id)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "admin.rbac.detail")}</div>
            <pre style={{ background: "rgba(15, 23, 42, 0.03)", padding: 12, overflowX: "auto" }}>
              {JSON.stringify({ selectedRoleId, roleDetail }, null, 2)}
            </pre>
          </div>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t(props.locale, "admin.rbac.permissionsTitle")}</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <span>{t(props.locale, "admin.rbac.resourceTypeLabel")}:</span>
          <input value={permFilterResource} onChange={(e) => setPermFilterResource(e.target.value)} style={{ width: 180 }} />
          <span>{t(props.locale, "admin.rbac.actionLabel")}:</span>
          <input value={permFilterAction} onChange={(e) => setPermFilterAction(e.target.value)} style={{ width: 180 }} />
          <button onClick={refreshPermissions} style={{ marginLeft: 8 }}>
            {t(props.locale, "admin.rbac.refresh")}
          </button>
        </div>
        <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid #ddd", padding: 8 }}>
          <table cellPadding={6} style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th align="left">{t(props.locale, "admin.rbac.table.id")}</th>
                <th align="left">{t(props.locale, "admin.rbac.table.resourceType")}</th>
                <th align="left">{t(props.locale, "admin.rbac.table.action")}</th>
              </tr>
            </thead>
            <tbody>
              {filteredPermissions.map((p: PermissionItem) => (
                <tr key={String(p.id)} style={{ borderTop: "1px solid #eee" }}>
                  <td>{String(p.id)}</td>
                  <td>{String(p.resource_type)}</td>
                  <td>{String(p.action)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t(props.locale, "admin.rbac.grantRevokeTitle")}</h2>
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.roleId")}</div>
            <input value={selectedRoleId} onChange={(e) => setSelectedRoleId(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.resourceType")}</div>
            <input value={grantResourceType} onChange={(e) => setGrantResourceType(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.action")}</div>
            <input value={grantAction} onChange={(e) => setGrantAction(e.target.value)} />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => {
                setGrantRowFiltersReadJson(JSON.stringify({ kind: "owner_only" }, null, 2));
                setGrantRowFiltersWriteJson("");
              }}
            >
              {t(props.locale, "admin.rbac.template.ownerOnly")}
            </button>
            <button
              onClick={() => {
                setGrantRowFiltersReadJson(
                  JSON.stringify(
                    { kind: "expr", expr: { op: "eq", left: { kind: "record", key: "ownerSubjectId" }, right: { kind: "subject", key: "subjectId" } } },
                    null,
                    2,
                  ),
                );
              }}
            >
              {t(props.locale, "admin.rbac.template.exprOwner")}
            </button>
          </div>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.rowFiltersReadJson")}</div>
            <textarea
              value={grantRowFiltersReadJson}
              onChange={(e) => setGrantRowFiltersReadJson(e.target.value)}
              rows={7}
              placeholder='{"kind":"expr","expr":{...}}'
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
            />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.rowFiltersWriteJson")}</div>
            <textarea
              value={grantRowFiltersWriteJson}
              onChange={(e) => setGrantRowFiltersWriteJson(e.target.value)}
              rows={5}
              placeholder='{"kind":"owner_only"}'
              style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
            />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={grantPermission}>{t(props.locale, "admin.rbac.action.grant")}</button>
            <button onClick={revokePermission}>{t(props.locale, "admin.rbac.action.revoke")}</button>
            <button onClick={preflightPolicy}>{t(props.locale, "admin.rbac.action.preflight")}</button>
          </div>
        </div>
        {policyPreflight ? (
          <pre style={{ marginTop: 12, background: "rgba(15, 23, 42, 0.03)", padding: 12, overflowX: "auto" }}>
            {JSON.stringify(policyPreflight, null, 2)}
          </pre>
        ) : null}
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>{t(props.locale, "admin.rbac.bindingsTitle")}</h2>
        <div style={{ display: "grid", gap: 8, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.subjectId")}</div>
            <input value={bindSubjectId} onChange={(e) => setBindSubjectId(e.target.value)} placeholder={t(props.locale, "admin.rbac.subjectIdPlaceholder")} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.roleId")}</div>
            <input value={selectedRoleId} onChange={(e) => setSelectedRoleId(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.scopeType")}</div>
            <select
              value={bindScopeType}
              onChange={(e) => {
                const v = e.target.value;
                setBindScopeType(v === "tenant" ? "tenant" : "space");
              }}
            >
              <option value="tenant">{t(props.locale, "admin.rbac.scopeType.tenant")}</option>
              <option value="space">{t(props.locale, "admin.rbac.scopeType.space")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 6 }}>
            <div>{t(props.locale, "admin.rbac.form.scopeId")}</div>
            <input value={bindScopeId} onChange={(e) => setBindScopeId(e.target.value)} />
          </label>
          <button onClick={createBinding} disabled={!bindSubjectId.trim() || !selectedRoleId.trim()}>
            {t(props.locale, "admin.rbac.action.createBinding")}
          </button>
        </div>

        {createdBindings.length ? (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>{t(props.locale, "admin.rbac.createdBindingIds")}</div>
            <ul style={{ paddingLeft: 18 }}>
              {createdBindings.map((id) => (
                <li key={id}>
                  {id}
                  <button style={{ marginLeft: 8 }} onClick={() => deleteBinding(id)}>
                    {t(props.locale, "admin.rbac.action.delete")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
}
