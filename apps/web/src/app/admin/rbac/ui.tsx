"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { t } from "@/lib/i18n";
import { PageHeader, Card, TabNav, Table, StructuredData, JsonFormEditor, getHelpHref } from "@/components/ui";
import { type ApiError, toApiError, errText } from "@/lib/apiError";
import { Badge } from "@/components/ui";

type RoleItem = { id: string; name?: string };
type PermissionItem = { id?: string; resource_type?: string; action?: string };
type BindingItem = { id: string; subject_id?: string; role_id?: string; role_name?: string; scope_type?: string; scope_id?: string; created_at?: string };
type RolesList = ApiError & { items?: RoleItem[] };
type PermissionsList = ApiError & { items?: PermissionItem[] };
type BindingsList = ApiError & { items?: BindingItem[] };
type PolicySetItem = { policy_set_id: string; name: string; version?: number; resource_type: string; combining_algorithm: string; status: string; description?: string; created_at?: string; updated_at?: string; rule_count?: number };
type PolicyRuleItem = { rule_id: string; name: string; description?: string; resource_type: string; actions: string[]; priority: number; effect: string; condition_expr: unknown; enabled: boolean; space_id?: string };
type SandboxResult = {
  allowed: boolean;
  decision?: string;
  reason?: string | null;
  policySnapshotId?: string | null;
  matchedRules?: any[];
  matchedRulesSummary?: Record<string, unknown> | null;
  raw?: Record<string, unknown>;
};

const COMBINING_ALGORITHMS = ["deny_overrides", "permit_overrides", "first_applicable", "deny_unless_permit", "permit_unless_deny"] as const;
const POLICY_STATUSES = ["draft", "active", "deprecated"] as const;

/* ─── 资源类型 → 可用操作 映射 (来自 permissionActions.ts) ─── */
const RESOURCE_ACTIONS: Record<string, string[]> = {
  entity: ["read", "create", "update", "delete"],
  skill: ["read", "write"],
  tool: ["read", "publish", "execute"],
  model: ["read", "write", "bind", "invoke"],
  workflow: ["create", "read", "cancel", "retry", "pause", "resume", "replan", "step.insert", "step.remove"],
  space: ["create"],
  memory: ["read", "write", "task_state"],
  schema: ["read"],
  connector: ["create"],
  secret: ["create"],
  backup: ["list", "get", "create", "restore"],
  audit: ["read", "verify", "export", "legalHold.manage", "siem.destination.read", "siem.destination.write", "siem.destination.test"],
  orchestrator: ["turn", "execute", "dispatch", "dispatch.stream"],
  device: ["create", "read", "revoke", "pairing.create", "policy.update"],
  device_execution: ["create", "read", "cancel"],
  device_message: ["send", "read"],
  agent_runtime: ["collab.read", "collab.create", "collab.envelopes.write", "collab.envelopes.read", "collab.arbiter.commit", "collab.events"],
  rbac: ["manage"],
  governance: ["tool.read", "tool.manage", "tool.enable", "tool.disable", "tool.set_active", "tool.network_policy.read", "tool.network_policy.write", "changeset.create", "changeset.update", "changeset.read", "evalrun.execute", "evalrun.read", "evalsuite.write", "evalsuite.read", "federation.read", "diagnostics.read", "diagnostics.dump", "workflow.deadletter.read", "workflow.deadletter.retry", "workflow.deadletter.cancel"],
  "*": ["*"],
};
const RESOURCE_TYPES = Object.keys(RESOURCE_ACTIONS);

/* ─── 常用权限场景预设 ─── */
type PermPreset = { key: string; resourceType: string; action: string; fieldRulesRead?: string; fieldRulesWrite?: string; rowFiltersRead?: string };
const PERM_PRESETS: PermPreset[] = [
  { key: "admin_full", resourceType: "*", action: "*" },
  { key: "entity_crud", resourceType: "entity", action: "*" },
  { key: "entity_readonly", resourceType: "entity", action: "read" },
  { key: "skill_manage", resourceType: "skill", action: "write" },
  { key: "skill_readonly", resourceType: "skill", action: "read" },
  { key: "tool_execute", resourceType: "tool", action: "execute" },
  { key: "model_invoke", resourceType: "model", action: "invoke" },
  { key: "model_manage", resourceType: "model", action: "write" },
  { key: "workflow_manage", resourceType: "workflow", action: "create" },
  { key: "memory_readwrite", resourceType: "memory", action: "write" },
  { key: "entity_own_data", resourceType: "entity", action: "read", rowFiltersRead: JSON.stringify({ kind: "owner_only" }, null, 2) },
  { key: "entity_field_mask", resourceType: "entity", action: "read", fieldRulesRead: JSON.stringify({ allow: ["*"], deny: ["secret_field", "internal_notes"] }, null, 2) },
];

export default function AdminRbacClient(props: {
  locale: string;
  initial: { roles: unknown; permissions: unknown; rolesStatus: number; permissionsStatus: number };
}) {
  const locale = props.locale;
  const [roles, setRoles] = useState<RolesList | null>((props.initial.roles as RolesList) ?? null);
  const [permissions, setPermissions] = useState<PermissionsList | null>((props.initial.permissions as PermissionsList) ?? null);
  const [bindings, setBindings] = useState<BindingsList | null>(null);
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
  const [grantFieldRulesReadJson, setGrantFieldRulesReadJson] = useState<string>("");
  const [grantFieldRulesWriteJson, setGrantFieldRulesWriteJson] = useState<string>("");
  const [policyPreflight, setPolicyPreflight] = useState<unknown>(null);

  const [bindSubjectId, setBindSubjectId] = useState("");
  const [bindScopeType, setBindScopeType] = useState<"tenant" | "space">("space");
  const [bindScopeId, setBindScopeId] = useState("space_dev");
  const [bindingFilterSubject, setBindingFilterSubject] = useState("");

  /* ─── ABAC 策略集 + 规则 state ─── */
  const [policySets, setPolicySets] = useState<PolicySetItem[]>([]);
  const [selectedPolicySetId, setSelectedPolicySetId] = useState<string | null>(null);
  const [policySetRules, setPolicySetRules] = useState<PolicyRuleItem[]>([]);
  const [psName, setPsName] = useState("");
  const [psResource, setPsResource] = useState("*");
  const [psCombining, setPsCombining] = useState<string>("deny_overrides");
  const [psStatus, setPsStatus] = useState<string>("draft");
  const [psDesc, setPsDesc] = useState("");
  const [editingPsId, setEditingPsId] = useState<string | null>(null);
  const [editPsCombining, setEditPsCombining] = useState("");
  const [editPsStatus, setEditPsStatus] = useState("");
  const [editPsDesc, setEditPsDesc] = useState("");
  // 新规则表单
  const [ruleName, setRuleName2] = useState("");
  const [ruleResource, setRuleResource] = useState("*");
  const [ruleActions, setRuleActions] = useState("read");
  const [rulePriority, setRulePriority] = useState("100");
  const [ruleEffect, setRuleEffect] = useState<"deny" | "allow">("deny");
  const [ruleCondExpr, setRuleCondExpr] = useState("{}");
  // 评估
  const [evalPsId, setEvalPsId] = useState("");
  const [evalSubjectId, setEvalSubjectId] = useState("");
  const [evalTenantId, setEvalTenantId] = useState("");
  const [evalResourceType, setEvalResourceType] = useState("entity");
  const [evalAction, setEvalAction] = useState("read");
  const [abacEvalResult, setAbacEvalResult] = useState<unknown>(null);

  const [error, setError] = useState<string>("");

  const initialError = useMemo(() => {
    if (rolesStatus >= 400) return errText(props.locale, roles);
    if (permissionsStatus >= 400) return errText(props.locale, permissions);
    return "";
  }, [permissions, permissionsStatus, props.locale, roles, rolesStatus]);

  const roleItems = useMemo(() => (Array.isArray(roles?.items) ? roles.items : []), [roles]);
  const permissionItems = useMemo(() => (Array.isArray(permissions?.items) ? permissions.items : []), [permissions]);
  const bindingItems = useMemo(() => (Array.isArray(bindings?.items) ? bindings.items : []), [bindings]);

  const filteredPermissions = useMemo(() => {
    const r = permFilterResource.trim();
    const a = permFilterAction.trim();
    return permissionItems.filter((p: PermissionItem) => {
      if (r && !String(p.resource_type ?? "").includes(r)) return false;
      if (a && !String(p.action ?? "").includes(a)) return false;
      return true;
    });
  }, [permissionItems, permFilterResource, permFilterAction]);

  const filteredBindings = useMemo(() => {
    const subjectFilter = bindingFilterSubject.trim().toLowerCase();
    return bindingItems.filter((item) => {
      if (selectedRoleId && String(item.role_id ?? "") !== selectedRoleId) return false;
      if (subjectFilter && !String(item.subject_id ?? "").toLowerCase().includes(subjectFilter)) return false;
      return true;
    });
  }, [bindingFilterSubject, bindingItems, selectedRoleId]);

  async function refreshRoles() {
    const res = await apiFetch(`/rbac/roles?limit=200`, { locale: props.locale, cache: "no-store" });
    setRolesStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setRoles((json as RolesList) ?? null);
    if (!res.ok) throw toApiError(json);
  }

  async function refreshPermissions() {
    const res = await apiFetch(`/rbac/permissions?limit=500`, { locale: props.locale, cache: "no-store" });
    setPermissionsStatus(res.status);
    const json: unknown = await res.json().catch(() => null);
    setPermissions((json as PermissionsList) ?? null);
    if (!res.ok) throw toApiError(json);
  }

  async function loadRoleDetail(roleId: string) {
    const res = await apiFetch(`/rbac/roles/${encodeURIComponent(roleId)}`, { locale: props.locale, cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw toApiError(json);
    setRoleDetail(json);
  }

  async function createRole() {
    setError("");
    try {
      const res = await apiFetch(`/rbac/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ name: roleName }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setRoleName("");
      await refreshRoles();
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function grantPermission() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      let rowFiltersRead: unknown = undefined;
      let rowFiltersWrite: unknown = undefined;
      let fieldRulesRead: unknown = undefined;
      let fieldRulesWrite: unknown = undefined;
      if (grantRowFiltersReadJson.trim()) rowFiltersRead = JSON.parse(grantRowFiltersReadJson);
      if (grantRowFiltersWriteJson.trim()) rowFiltersWrite = JSON.parse(grantRowFiltersWriteJson);
      if (grantFieldRulesReadJson.trim()) fieldRulesRead = JSON.parse(grantFieldRulesReadJson);
      if (grantFieldRulesWriteJson.trim()) fieldRulesWrite = JSON.parse(grantFieldRulesWriteJson);
      const res = await apiFetch(`/rbac/roles/${encodeURIComponent(selectedRoleId)}/permissions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ resourceType: grantResourceType, action: grantAction, rowFiltersRead, rowFiltersWrite, fieldRulesRead, fieldRulesWrite }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshPermissions();
      if (selectedRoleId) await loadRoleDetail(selectedRoleId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function preflightPolicy() {
    setError("");
    setPolicyPreflight(null);
    try {
      let rowFilters: unknown = undefined;
      if (grantRowFiltersReadJson.trim()) rowFilters = JSON.parse(grantRowFiltersReadJson);
      const res = await apiFetch(`/rbac/policy/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ rowFilters }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPolicyPreflight(json);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function revokePermission() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      const res = await apiFetch(`/rbac/roles/${encodeURIComponent(selectedRoleId)}/permissions`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ resourceType: grantResourceType, action: grantAction }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshPermissions();
      if (selectedRoleId) await loadRoleDetail(selectedRoleId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  const refreshBindings = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("limit", "200");
    const res = await apiFetch(`/rbac/bindings?${params.toString()}`, { locale, cache: "no-store" });
    const json: unknown = await res.json().catch(() => null);
    setBindings((json as BindingsList) ?? null);
    if (!res.ok) throw toApiError(json);
  }, [locale]);

  async function createBinding() {
    setError("");
    try {
      if (!selectedRoleId) throw { errorCode: "BAD_REQUEST", message: t(props.locale, "rbac.selectRole") };
      const res = await apiFetch(`/rbac/bindings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale: props.locale,
        body: JSON.stringify({ subjectId: bindSubjectId, roleId: selectedRoleId, scopeType: bindScopeType, scopeId: bindScopeId }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setBindSubjectId("");
      await refreshBindings();
      if (selectedRoleId) await loadRoleDetail(selectedRoleId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  async function deleteBinding(bindingId: string) {
    setError("");
    try {
      const res = await apiFetch(`/rbac/bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      await refreshBindings();
      if (selectedRoleId) await loadRoleDetail(selectedRoleId);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }

  const refreshPolicySets = useCallback(async () => {
    try {
      const res = await apiFetch(`/rbac/abac/policy-sets`, { locale: props.locale, cache: "no-store" });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const items = (json as any)?.items;
      setPolicySets(Array.isArray(items) ? items : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }, [props.locale]);

  const loadPolicySetRules = useCallback(async (policySetId: string) => {
    try {
      const res = await apiFetch(`/rbac/abac/policy-sets/${encodeURIComponent(policySetId)}`, { locale: props.locale, cache: "no-store" });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setPolicySetRules(Array.isArray(json?.rules) ? json.rules.map((r: any) => ({ ...r, actions: Array.isArray(r.actions) ? r.actions : [] })) : []);
    } catch (e: unknown) {
      setError(errText(props.locale, toApiError(e)));
    }
  }, [props.locale]);

  const [showAdvanced, setShowAdvanced] = useState(false);

  const [sbSubjectId, setSbSubjectId] = useState("");
  const [sbScopeType, setSbScopeType] = useState<"tenant" | "space">("space");
  const [sbScopeId, setSbScopeId] = useState("space_dev");
  const [sbResourceType, setSbResourceType] = useState("entity");
  const [sbResourceId, setSbResourceId] = useState("");
  const [sbAction, setSbAction] = useState("read");
  const [sbResult, setSbResult] = useState<SandboxResult | null>(null);
  const [sbLoading, setSbLoading] = useState(false);
  const [sbHistory, setSbHistory] = useState<Array<{ subjectId: string; scopeType: string; scopeId: string; resourceType: string; resourceId: string; action: string; allowed: boolean; reason?: string | null; time: string }>>([]);

  useEffect(() => {
    void refreshBindings().catch((e: unknown) => setError(errText(locale, toApiError(e))));
    void refreshPolicySets();
  }, [locale, refreshPolicySets, refreshBindings]);

  const QUICK_SCENARIOS = [
    { key: "adminRead", subjectId: "admin", resourceType: "entity", resourceId: "*", action: "read" },
    { key: "userWrite", subjectId: "user_001", resourceType: "entity", resourceId: "doc_001", action: "write" },
    { key: "guestAccess", subjectId: "guest", resourceType: "space", resourceId: "space_dev", action: "read" },
    { key: "deleteOp", subjectId: "user_001", resourceType: "entity", resourceId: "doc_001", action: "delete" },
  ];

  async function runSandboxCheck() {
    setError("");
    setSbResult(null);
    setSbLoading(true);
    try {
      const res = await apiFetch(`/rbac/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        locale,
        body: JSON.stringify({ scopeType: sbScopeType, scopeId: sbScopeId, subjectId: sbSubjectId, resourceType: sbResourceType, resourceId: sbResourceId, action: sbAction }),
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      const allowed = Boolean(json?.allowed ?? json?.result === "allow");
      const result: SandboxResult = {
        allowed,
        decision: String(json?.decision ?? ""),
        reason: typeof json?.reason === "string" ? json.reason : null,
        policySnapshotId: typeof json?.policySnapshotId === "string" ? json.policySnapshotId : null,
        matchedRules: json?.matchedRules ?? json?.rules ?? [],
        matchedRulesSummary: json?.matchedRulesSummary ?? null,
        raw: json,
      };
      setSbResult(result);
      setSbHistory(prev => [{ subjectId: sbSubjectId, scopeType: sbScopeType, scopeId: sbScopeId, resourceType: sbResourceType, resourceId: sbResourceId, action: sbAction, allowed, reason: result.reason, time: new Date().toLocaleTimeString(locale) }, ...prev].slice(0, 20));
    } catch (e: unknown) {
      setError(errText(locale, toApiError(e)));
    } finally {
      setSbLoading(false);
    }
  }

  const [renamingRoleId, setRenamingRoleId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  async function deleteRole(roleId: string) {
    setError("");
    try {
      const res = await apiFetch(`/rbac/roles/${encodeURIComponent(roleId)}`, { method: "DELETE", locale: props.locale });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      if (selectedRoleId === roleId) { setSelectedRoleId(""); setRoleDetail(null); }
      await refreshRoles();
    } catch (e: unknown) { setError(errText(props.locale, toApiError(e))); }
  }

  async function renameRole(roleId: string, newName: string) {
    setError("");
    try {
      const res = await apiFetch(`/rbac/roles`, {
        method: "POST", headers: { "content-type": "application/json" }, locale: props.locale,
        body: JSON.stringify({ id: roleId, name: newName }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw toApiError(json);
      setRenamingRoleId(null);
      await refreshRoles();
      if (selectedRoleId === roleId) await loadRoleDetail(roleId);
    } catch (e: unknown) { setError(errText(props.locale, toApiError(e))); }
  }

  /* ─── Tab 1: Roles ─── */
  const roleDetailObj = roleDetail as { role?: any; permissions?: any[]; bindings?: any[] } | null;
  const rolesTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.roles.desc")}</p>
      <Card title={t(locale, "admin.rbac.create")}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder={t(locale, "admin.rbac.roleNamePlaceholder")}
            style={{ flex: 1, maxWidth: 320, padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
          />
          <button onClick={createRole} disabled={!roleName.trim()} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
            {t(locale, "admin.rbac.create")}
          </button>
          <button onClick={refreshRoles} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
            {t(locale, "admin.rbac.refresh")}
          </button>
        </div>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 16 }}>
        <Card title={t(locale, "admin.rbac.list")}>
          {roleItems.length === 0 ? (
            <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.noRoles")}</p>
          ) : (
            <ul style={{ paddingLeft: 0, margin: 0, display: "grid", gap: 4, listStyle: "none" }}>
              {roleItems.map((r: RoleItem) => (
                <li key={String(r.id)} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {renamingRoleId === String(r.id) ? (
                    <div style={{ display: "flex", gap: 4, flex: 1 }}>
                      <input value={renameValue} onChange={e => setRenameValue(e.target.value)} style={{ flex: 1, padding: "3px 6px", borderRadius: 4, border: "1px solid var(--sl-border)", fontSize: 12 }} />
                      <button onClick={() => void renameRole(String(r.id), renameValue)} disabled={!renameValue.trim()} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-accent)", color: "#fff", cursor: "pointer", fontSize: 11 }}>✓</button>
                      <button onClick={() => setRenamingRoleId(null)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 11 }}>✗</button>
                    </div>
                  ) : (
                    <>
                      <button
                        style={{
                          background: selectedRoleId === String(r.id) ? "var(--sl-accent-bg)" : "none",
                          border: "none", cursor: "pointer", padding: "4px 8px", borderRadius: 4, fontWeight: selectedRoleId === String(r.id) ? 600 : 400,
                          color: selectedRoleId === String(r.id) ? "var(--sl-accent)" : "var(--sl-fg)", flex: 1, textAlign: "left",
                        }}
                        onClick={async () => {
                          setSelectedRoleId(String(r.id));
                          setRoleDetail(null);
                          try { await loadRoleDetail(String(r.id)); } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                        }}
                      >
                        {String(r.name ?? r.id)}
                      </button>
                      <button onClick={() => { setRenamingRoleId(String(r.id)); setRenameValue(String(r.name ?? r.id)); }} title={t(locale, "admin.rbac.action.rename")} style={{ all: "unset", cursor: "pointer", fontSize: 11, color: "var(--sl-muted)", padding: "2px 4px" }}>✏</button>
                      <button onClick={() => void deleteRole(String(r.id))} title={t(locale, "admin.rbac.action.delete")} style={{ all: "unset", cursor: "pointer", fontSize: 11, color: "#dc2626", padding: "2px 4px" }}>✗</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t(locale, "admin.rbac.detail")}>
          {roleDetailObj ? (
            <div style={{ display: "grid", gap: 16 }}>
              {/* 角色基本信息 */}
              <div style={{ fontSize: 13 }}>
                <strong>{t(locale, "admin.rbac.table.id")}:</strong> {String(roleDetailObj.role?.id ?? "")}
                <span style={{ marginLeft: 16 }}><strong>{t(locale, "admin.rbac.roleNamePlaceholder")}:</strong> {String(roleDetailObj.role?.name ?? "")}</span>
              </div>
              {/* 已绑定权限 */}
              <div>
                <strong style={{ fontSize: 13 }}>{t(locale, "admin.rbac.permissionsTitle")} ({roleDetailObj.permissions?.length ?? 0})</strong>
                {roleDetailObj.permissions && roleDetailObj.permissions.length > 0 ? (
                  <Table>
                    <thead>
                      <tr>
                        <th>{t(locale, "admin.rbac.table.resourceType")}</th>
                        <th>{t(locale, "admin.rbac.table.action")}</th>
                        <th>{t(locale, "admin.rbac.form.fieldRulesReadJson")}</th>
                        <th>{t(locale, "admin.rbac.form.rowFiltersReadJson")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roleDetailObj.permissions.map((p: any, i: number) => (
                        <tr key={i}>
                          <td>{t(locale, `admin.rbac.resourceType.${p.resource_type ?? ""}`)}</td>
                          <td>{String(p.action ?? "")}</td>
                          <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{p.field_rules_read ? JSON.stringify(p.field_rules_read) : "-"}</td>
                          <td style={{ fontSize: 11, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{p.row_filters_read ? JSON.stringify(p.row_filters_read) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : <p style={{ color: "var(--sl-muted)", fontSize: 12, margin: "4px 0 0" }}>{t(locale, "admin.rbac.noPermissions")}</p>}
              </div>
              {/* 已绑定用户 */}
              <div>
                <strong style={{ fontSize: 13 }}>{t(locale, "admin.rbac.bindingsTitle")} ({roleDetailObj.bindings?.length ?? 0})</strong>
                {roleDetailObj.bindings && roleDetailObj.bindings.length > 0 ? (
                  <Table>
                    <thead>
                      <tr>
                        <th>{t(locale, "admin.rbac.table.subjectId")}</th>
                        <th>{t(locale, "admin.rbac.table.scope")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roleDetailObj.bindings.map((b: any, i: number) => (
                        <tr key={i}>
                          <td>{String(b.subject_id ?? "")}</td>
                          <td>{String(b.scope_type ?? "")} / {String(b.scope_id ?? "")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : <p style={{ color: "var(--sl-muted)", fontSize: 12, margin: "4px 0 0" }}>{t(locale, "admin.rbac.noBindings")}</p>}
              </div>
            </div>
          ) : (
            <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.roles.desc")}</p>
          )}
        </Card>
      </div>
    </div>
  );

  /* ─── Tab 2: Permissions ─── */
  const permissionsTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.permissions.desc")}</p>
      <Card>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>{t(locale, "admin.rbac.resourceTypeLabel")}:</span>
          <select value={permFilterResource} onChange={(e) => setPermFilterResource(e.target.value)} style={{ width: 180, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
            <option value="">{t(locale, "admin.rbac.filter.allResources")}</option>
            {RESOURCE_TYPES.filter(rt => rt !== "*").map(rt => (
              <option key={rt} value={rt}>{t(locale, `admin.rbac.resourceType.${rt}`)}</option>
            ))}
          </select>
          <span style={{ fontSize: 13 }}>{t(locale, "admin.rbac.actionLabel")}:</span>
          <select value={permFilterAction} onChange={(e) => setPermFilterAction(e.target.value)} style={{ width: 160, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
            <option value="">{t(locale, "admin.rbac.filter.allActions")}</option>
            {(permFilterResource && RESOURCE_ACTIONS[permFilterResource] ? RESOURCE_ACTIONS[permFilterResource] : [...new Set(Object.values(RESOURCE_ACTIONS).flat())]).map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <button onClick={refreshPermissions} style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
            {t(locale, "admin.rbac.refresh")}
          </button>
        </div>
        {filteredPermissions.length === 0 ? (
          <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.noPermissions")}</p>
        ) : (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            <Table>
              <thead>
                <tr>
                  <th>{t(locale, "admin.rbac.table.id")}</th>
                  <th>{t(locale, "admin.rbac.table.resourceType")}</th>
                  <th>{t(locale, "admin.rbac.table.action")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredPermissions.map((p: PermissionItem) => (
                  <tr key={String(p.id)}>
                    <td>{String(p.id)}</td>
                    <td>{t(locale, `admin.rbac.resourceType.${p.resource_type ?? ""}`)}</td>
                    <td>{String(p.action)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  );

  /* ─── Tab 3: Assign ─── */
  const availableActions = RESOURCE_ACTIONS[grantResourceType] ?? ["*"];
  const assignTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.assign.desc")}</p>

      {/* ── 快捷场景 ── */}
      <Card title={t(locale, "admin.rbac.preset.title")}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PERM_PRESETS.map(p => (
            <button
              key={p.key}
              onClick={() => {
                setGrantResourceType(p.resourceType);
                setGrantAction(p.action);
                setGrantRowFiltersReadJson(p.rowFiltersRead ?? "");
                setGrantRowFiltersWriteJson("");
                setGrantFieldRulesReadJson(p.fieldRulesRead ?? "");
                setGrantFieldRulesWriteJson(p.fieldRulesWrite ?? "");
                if (p.rowFiltersRead || p.fieldRulesRead || p.fieldRulesWrite) setShowAdvanced(true);
              }}
              style={{ padding: "4px 10px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}
            >
              {t(locale, `admin.rbac.preset.${p.key}`)}
            </button>
          ))}
        </div>
      </Card>

      <Card title={t(locale, "admin.rbac.grantRevokeTitle")}>
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.roleId")}</span>
            <select
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="">{t(locale, "rbac.selectRole")}</option>
              {roleItems.map((r: RoleItem) => (
                <option key={String(r.id)} value={String(r.id)}>{String(r.name ?? r.id)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.resourceType")}</span>
            <select
              value={grantResourceType}
              onChange={(e) => { setGrantResourceType(e.target.value); const acts = RESOURCE_ACTIONS[e.target.value]; if (acts && !acts.includes(grantAction)) setGrantAction(acts[0] ?? "read"); }}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              {RESOURCE_TYPES.map(rt => (
                <option key={rt} value={rt}>{t(locale, `admin.rbac.resourceType.${rt}`)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.action")}</span>
            <select
              value={grantAction}
              onChange={(e) => setGrantAction(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="*">{t(locale, "admin.rbac.actionOption.all")}</option>
              {availableActions.filter(a => a !== "*").map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={grantPermission} style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}>
              {t(locale, "admin.rbac.action.grant")}
            </button>
            <button onClick={revokePermission} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
              {t(locale, "admin.rbac.action.revoke")}
            </button>
            <button onClick={preflightPolicy} style={{ padding: "6px 16px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
              {t(locale, "admin.rbac.action.preflight")}
            </button>
          </div>
        </div>

        {policyPreflight ? (
          <div style={{ marginTop: 16 }}>
            <StructuredData data={policyPreflight} />
          </div>
        ) : null}

        {/* Advanced section - collapsed by default */}
        <div style={{ marginTop: 20, borderTop: "1px solid var(--sl-border)", paddingTop: 12 }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "var(--sl-muted)", display: "flex", alignItems: "center", gap: 4, padding: 0 }}
          >
            <span style={{ transform: showAdvanced ? "rotate(90deg)" : "rotate(0deg)", transition: "transform .15s", display: "inline-block" }}>▶</span>
            {t(locale, "admin.rbac.template.advancedTip")}
          </button>
          {showAdvanced && (
            <div style={{ marginTop: 12, display: "grid", gap: 12, maxWidth: 520 }}>
              <div>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sl-muted)" }}>{t(locale, "admin.rbac.template.quickFill")}</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  {[
                    { label: t(locale, "admin.rbac.template.ownerOnly"), fn: () => { setGrantRowFiltersReadJson(JSON.stringify({ kind: "owner_only" }, null, 2)); setGrantRowFiltersWriteJson(""); } },
                    { label: t(locale, "admin.rbac.template.exprOwner"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "expr", expr: { op: "eq", left: { kind: "record", key: "ownerSubjectId" }, right: { kind: "subject", key: "subjectId" } } }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.spaceMember"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "space_member", roles: ["editor", "viewer"] }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.orgHierarchy"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "org_hierarchy", orgField: "orgUnitId", includeDescendants: true }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.andComposite"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "and", rules: [{ kind: "owner_only" }, { kind: "space_member" }] }, null, 2)) },
                    { label: t(locale, "admin.rbac.template.notNegate"), fn: () => setGrantRowFiltersReadJson(JSON.stringify({ kind: "not", rule: { kind: "payload_field_eq_literal", field: "status", value: "archived" } }, null, 2)) },
                  ].map((tpl) => (
                    <button key={tpl.label} onClick={tpl.fn} style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}>
                      {tpl.label}
                    </button>
                  ))}
                </div>
              </div>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.rowFiltersReadJson")}</span>
                <JsonFormEditor value={grantRowFiltersReadJson} onChange={setGrantRowFiltersReadJson} locale={locale} rows={5} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.rowFiltersWriteJson")}</span>
                <JsonFormEditor value={grantRowFiltersWriteJson} onChange={setGrantRowFiltersWriteJson} locale={locale} rows={3} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.fieldRulesReadJson")}</span>
                <JsonFormEditor value={grantFieldRulesReadJson} onChange={setGrantFieldRulesReadJson} locale={locale} rows={2} />
              </label>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.fieldRulesWriteJson")}</span>
                <JsonFormEditor value={grantFieldRulesWriteJson} onChange={setGrantFieldRulesWriteJson} locale={locale} rows={2} />
              </label>
            </div>
          )}
        </div>
      </Card>
    </div>
  );

  /* ─── Tab 4: Bindings ─── */
  const bindingsTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.bindings.desc")}</p>
      <Card title={t(locale, "admin.rbac.bindingsTitle")}>
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.subjectId")}</span>
            <input value={bindSubjectId} onChange={(e) => setBindSubjectId(e.target.value)} placeholder={t(locale, "admin.rbac.subjectIdPlaceholder")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.roleId")}</span>
            <select
              value={selectedRoleId}
              onChange={(e) => setSelectedRoleId(e.target.value)}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="">{t(locale, "rbac.selectRole")}</option>
              {roleItems.map((r: RoleItem) => (
                <option key={String(r.id)} value={String(r.id)}>{String(r.name ?? r.id)}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.scopeType")}</span>
            <select
              value={bindScopeType}
              onChange={(e) => setBindScopeType(e.target.value === "tenant" ? "tenant" : "space")}
              style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            >
              <option value="tenant">{t(locale, "admin.rbac.scopeType.tenant")}</option>
              <option value="space">{t(locale, "admin.rbac.scopeType.space")}</option>
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.scopeId")}</span>
            <input value={bindScopeId} onChange={(e) => setBindScopeId(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <button
            onClick={createBinding}
            disabled={!bindSubjectId.trim() || !selectedRoleId.trim()}
            style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, justifySelf: "start" }}
          >
            {t(locale, "admin.rbac.action.createBinding")}
          </button>
        </div>

        <div style={{ marginTop: 20, borderTop: "1px solid var(--sl-border)", paddingTop: 12, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t(locale, "admin.rbac.bindingsCurrent")}</div>
            <input
              value={bindingFilterSubject}
              onChange={(e) => setBindingFilterSubject(e.target.value)}
              placeholder={t(locale, "admin.rbac.subjectIdPlaceholder")}
              style={{ width: 220, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)" }}
            />
            <button
              onClick={() => void refreshBindings().catch((e: unknown) => setError(errText(locale, toApiError(e))))}
              style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}
            >
              {t(locale, "admin.rbac.refresh")}
            </button>
          </div>

          {filteredBindings.length === 0 ? (
            <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.noBindings")}</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th>{t(locale, "admin.rbac.table.id")}</th>
                  <th>{t(locale, "admin.rbac.table.subjectId")}</th>
                  <th>{t(locale, "admin.rbac.form.roleId")}</th>
                  <th>{t(locale, "admin.rbac.table.scope")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredBindings.map((item) => (
                  <tr key={item.id}>
                    <td>{item.id}</td>
                    <td>{String(item.subject_id ?? "")}</td>
                    <td>{String(item.role_name ?? item.role_id ?? "")}</td>
                    <td>{String(item.scope_type ?? "")} / {String(item.scope_id ?? "")}</td>
                    <td>
                      <button
                        style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12, color: "#dc2626" }}
                        onClick={() => void deleteBinding(item.id)}
                      >
                        {t(locale, "admin.rbac.action.delete")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  );

  /* ─── Tab 5: ABAC 策略集管理 ─── */
  const policiesTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.policies.desc")}</p>

      {/* ─── 规则详情视图 ─── */}
      {selectedPolicySetId ? (
        <>
          <button
            onClick={() => { setSelectedPolicySetId(null); setPolicySetRules([]); }}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", justifySelf: "start", fontSize: 13 }}
          >
            ← {t(locale, "admin.rbac.abac.backToSets")}
          </button>
          <Card title={t(locale, "admin.rbac.abac.rulesTitle")}>
            {/* 添加规则表单 */}
            <div style={{ display: "grid", gap: 10, maxWidth: 560, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.ruleName")}</span>
                  <input value={ruleName} onChange={e => setRuleName2(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }} />
                </label>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.resourceType")}</span>
                  <select value={ruleResource} onChange={e => setRuleResource(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }}>
                    {RESOURCE_TYPES.map(rt => (
                      <option key={rt} value={rt}>{t(locale, `admin.rbac.resourceType.${rt}`)}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.ruleActions")}</span>
                  <select
                    value=""
                    onChange={e => {
                      const v = e.target.value;
                      if (!v) return;
                      const cur = ruleActions.split(",").map(s => s.trim()).filter(Boolean);
                      if (!cur.includes(v)) setRuleActions([...cur, v].join(", "));
                    }}
                    style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }}
                  >
                    <option value="">{ruleActions || t(locale, "admin.rbac.abac.ruleActionsPlaceholder")}</option>
                    {(RESOURCE_ACTIONS[ruleResource] ?? ["*"]).map(a => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                  {ruleActions && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      {ruleActions.split(",").map(s => s.trim()).filter(Boolean).map(a => (
                        <span key={a} style={{ display: "inline-flex", alignItems: "center", gap: 2, padding: "1px 6px", borderRadius: 4, background: "var(--sl-surface)", border: "1px solid var(--sl-border)", fontSize: 11 }}>
                          {a}
                          <button onClick={() => setRuleActions(ruleActions.split(",").map(s => s.trim()).filter(x => x && x !== a).join(", "))} style={{ all: "unset", cursor: "pointer", fontSize: 10, color: "var(--sl-muted)" }}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                </label>
                <label style={{ display: "grid", gap: 4, width: 80 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.rulePriority")}</span>
                  <input value={rulePriority} onChange={e => setRulePriority(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }} />
                </label>
                <label style={{ display: "grid", gap: 4, width: 100 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.ruleEffect")}</span>
                  <select value={ruleEffect} onChange={e => setRuleEffect(e.target.value as "deny" | "allow")} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }}>
                    <option value="deny">{t(locale, "admin.rbac.abac.effectDeny")}</option>
                    <option value="allow">{t(locale, "admin.rbac.abac.effectAllow")}</option>
                  </select>
                </label>
              </div>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.conditionExpr")}</span>
                <JsonFormEditor value={ruleCondExpr} onChange={setRuleCondExpr} locale={locale} rows={3} />
              </label>
              <button
                disabled={!ruleName.trim()}
                onClick={async () => {
                  setError("");
                  try {
                    const condExpr = ruleCondExpr.trim() ? JSON.parse(ruleCondExpr) : {};
                    const actions = ruleActions.split(",").map(s => s.trim()).filter(Boolean);
                    const res = await apiFetch(`/rbac/abac/policy-sets/${encodeURIComponent(selectedPolicySetId)}/rules`, {
                      method: "POST", headers: { "content-type": "application/json" }, locale,
                      body: JSON.stringify({ name: ruleName, resourceType: ruleResource, actions, priority: Number(rulePriority) || 100, effect: ruleEffect, conditionExpr: condExpr, enabled: true }),
                    });
                    const json: unknown = await res.json().catch(() => null);
                    if (!res.ok) throw toApiError(json);
                    setRuleName2("");
                    await loadPolicySetRules(selectedPolicySetId);
                  } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                }}
                style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, justifySelf: "start" }}
              >
                {t(locale, "admin.rbac.abac.createRule")}
              </button>
            </div>
            {/* 规则列表 */}
            {policySetRules.length === 0 ? (
              <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.abac.noRules")}</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th>{t(locale, "admin.rbac.abac.ruleName")}</th>
                    <th>{t(locale, "admin.rbac.abac.ruleActions")}</th>
                    <th>{t(locale, "admin.rbac.abac.rulePriority")}</th>
                    <th>{t(locale, "admin.rbac.abac.ruleEffect")}</th>
                    <th>{t(locale, "admin.rbac.abac.enabled")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {policySetRules.map((r) => (
                    <tr key={r.rule_id}>
                      <td>{r.name}</td>
                      <td style={{ fontSize: 12 }}>{Array.isArray(r.actions) ? r.actions.join(", ") : ""}</td>
                      <td>
                        <input
                          type="number" value={r.priority} min={0} max={10000}
                          style={{ width: 60, padding: "2px 4px", borderRadius: 4, border: "1px solid var(--sl-border)", fontSize: 12 }}
                          onChange={async (e) => {
                            const val = Number(e.target.value);
                            if (isNaN(val)) return;
                            try {
                              const res = await apiFetch(`/rbac/abac/rules/${encodeURIComponent(r.rule_id)}/update`, {
                                method: "POST", headers: { "content-type": "application/json" }, locale,
                                body: JSON.stringify({ priority: val }),
                              });
                              const json: unknown = await res.json().catch(() => null);
                              if (!res.ok) throw toApiError(json);
                              await loadPolicySetRules(selectedPolicySetId);
                            } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                          }}
                        />
                      </td>
                      <td>
                        <select
                          value={r.effect}
                          style={{ padding: "2px 4px", borderRadius: 4, border: "1px solid var(--sl-border)", fontSize: 12 }}
                          onChange={async (e) => {
                            try {
                              const res = await apiFetch(`/rbac/abac/rules/${encodeURIComponent(r.rule_id)}/update`, {
                                method: "POST", headers: { "content-type": "application/json" }, locale,
                                body: JSON.stringify({ effect: e.target.value }),
                              });
                              const json: unknown = await res.json().catch(() => null);
                              if (!res.ok) throw toApiError(json);
                              await loadPolicySetRules(selectedPolicySetId);
                            } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                          }}
                        >
                          <option value="allow">{t(locale, "admin.rbac.abac.effectAllow")}</option>
                          <option value="deny">{t(locale, "admin.rbac.abac.effectDeny")}</option>
                        </select>
                      </td>
                      <td>
                        <button
                          style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: r.enabled ? "rgba(34,197,94,0.1)" : "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}
                          onClick={async () => {
                            try {
                              const res = await apiFetch(`/rbac/abac/rules/${encodeURIComponent(r.rule_id)}/update`, {
                                method: "POST", headers: { "content-type": "application/json" }, locale,
                                body: JSON.stringify({ enabled: !r.enabled }),
                              });
                              const json: unknown = await res.json().catch(() => null);
                              if (!res.ok) throw toApiError(json);
                              await loadPolicySetRules(selectedPolicySetId);
                            } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                          }}
                        >
                          {r.enabled ? "✓ " + t(locale, "admin.rbac.abac.enabled") : "✗ " + t(locale, "admin.rbac.abac.disabled")}
                        </button>
                      </td>
                      <td>
                        <button
                          style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12, color: "#dc2626" }}
                          onClick={async () => {
                            setError("");
                            try {
                              const res = await apiFetch(`/rbac/abac/rules/${encodeURIComponent(r.rule_id)}`, { method: "DELETE", locale });
                              const json: unknown = await res.json().catch(() => null);
                              if (!res.ok) throw toApiError(json);
                              await loadPolicySetRules(selectedPolicySetId);
                            } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                          }}
                        >
                          {t(locale, "admin.rbac.abac.deleteRule")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : (
        /* ─── 策略集列表视图 ─── */
        <>
          <Card title={t(locale, "admin.rbac.abacTitle")}>
            <div style={{ display: "grid", gap: 10, maxWidth: 520, marginBottom: 16 }}>
              <label style={{ display: "grid", gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.policySetName")}</span>
                <input value={psName} onChange={e => setPsName(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.resourceType")}</span>
                  <select value={psResource} onChange={e => setPsResource(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                    {RESOURCE_TYPES.map(rt => (
                      <option key={rt} value={rt}>{t(locale, `admin.rbac.resourceType.${rt}`)}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.combiningAlgorithm")}</span>
                  <select value={psCombining} onChange={e => setPsCombining(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                    {COMBINING_ALGORITHMS.map(a => <option key={a} value={a}>{t(locale, `admin.rbac.abac.combiningAlgorithm.${a}`)}</option>)}
                  </select>
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.status")}</span>
                  <select value={psStatus} onChange={e => setPsStatus(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                    {POLICY_STATUSES.map(s => <option key={s} value={s}>{t(locale, `admin.rbac.abac.status.${s}`)}</option>)}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.description")}</span>
                  <input value={psDesc} onChange={e => setPsDesc(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  disabled={!psName.trim()}
                  onClick={async () => {
                    setError("");
                    try {
                      const res = await apiFetch(`/rbac/abac/policy-sets`, {
                        method: "POST", headers: { "content-type": "application/json" }, locale,
                        body: JSON.stringify({ name: psName, resourceType: psResource, combiningAlgorithm: psCombining, status: psStatus, description: psDesc }),
                      });
                      const json: unknown = await res.json().catch(() => null);
                      if (!res.ok) throw toApiError(json);
                      setPsName("");
                      setPsDesc("");
                      await refreshPolicySets();
                    } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                  }}
                  style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 }}
                >
                  {t(locale, "admin.rbac.abac.createSet")}
                </button>
                <button onClick={refreshPolicySets} style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer" }}>
                  {t(locale, "admin.rbac.abac.refresh")}
                </button>
              </div>
            </div>
          </Card>

          {/* 策略集表格 */}
          {policySets.length === 0 ? (
            <Card><p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.abac.noPolicySets")}</p></Card>
          ) : (
            <Card>
              <Table>
                <thead>
                  <tr>
                    <th>{t(locale, "admin.rbac.abac.policySetName")}</th>
                    <th>{t(locale, "admin.rbac.abac.resourceType")}</th>
                    <th>{t(locale, "admin.rbac.abac.combiningAlgorithm")}</th>
                    <th>{t(locale, "admin.rbac.abac.status")}</th>
                    <th>{t(locale, "admin.rbac.abac.version")}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {policySets.map((ps) => (
                    editingPsId === ps.policy_set_id ? (
                      <tr key={ps.policy_set_id}>
                        <td>{ps.name}</td>
                        <td>{ps.resource_type}</td>
                        <td>
                          <select value={editPsCombining} onChange={e => setEditPsCombining(e.target.value)} style={{ padding: "2px 6px", borderRadius: 4, border: "1px solid var(--sl-border)", fontSize: 11 }}>
                            {COMBINING_ALGORITHMS.map(a => <option key={a} value={a}>{t(locale, `admin.rbac.abac.combiningAlgorithm.${a}`)}</option>)}
                          </select>
                        </td>
                        <td>
                          <select value={editPsStatus} onChange={e => setEditPsStatus(e.target.value)} style={{ padding: "2px 6px", borderRadius: 4, border: "1px solid var(--sl-border)", fontSize: 11 }}>
                            {POLICY_STATUSES.map(s => <option key={s} value={s}>{t(locale, `admin.rbac.abac.status.${s}`)}</option>)}
                          </select>
                        </td>
                        <td>
                          <input value={editPsDesc} onChange={e => setEditPsDesc(e.target.value)} style={{ width: 100, padding: "2px 6px", borderRadius: 4, border: "1px solid var(--sl-border)", fontSize: 11 }} />
                        </td>
                        <td style={{ display: "flex", gap: 4 }}>
                          <button
                            style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-accent)", color: "#fff", cursor: "pointer", fontSize: 12 }}
                            onClick={async () => {
                              setError("");
                              try {
                                const res = await apiFetch(`/rbac/abac/policy-sets/${encodeURIComponent(ps.policy_set_id)}/update`, {
                                  method: "POST", headers: { "content-type": "application/json" }, locale,
                                  body: JSON.stringify({ combiningAlgorithm: editPsCombining, status: editPsStatus, description: editPsDesc }),
                                });
                                const json: unknown = await res.json().catch(() => null);
                                if (!res.ok) throw toApiError(json);
                                setEditingPsId(null);
                                await refreshPolicySets();
                              } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                            }}
                          >
                            {t(locale, "admin.rbac.abac.save")}
                          </button>
                          <button onClick={() => setEditingPsId(null)} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}>
                            {t(locale, "admin.rbac.abac.cancel")}
                          </button>
                        </td>
                      </tr>
                    ) : (
                    <tr key={ps.policy_set_id}>
                      <td>{ps.name}</td>
                      <td>{t(locale, `admin.rbac.resourceType.${ps.resource_type}`)}</td>
                      <td style={{ fontSize: 12 }}>{t(locale, `admin.rbac.abac.combiningAlgorithm.${ps.combining_algorithm}`)}</td>
                      <td><Badge tone={ps.status === "active" ? "success" : ps.status === "deprecated" ? "warning" : undefined}>{t(locale, `admin.rbac.abac.status.${ps.status}`)}</Badge></td>
                      <td>{ps.version ?? 1}</td>
                      <td style={{ display: "flex", gap: 4 }}>
                        <button
                          style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}
                          onClick={async () => { setSelectedPolicySetId(ps.policy_set_id); setEvalPsId(ps.policy_set_id); await loadPolicySetRules(ps.policy_set_id); }}
                        >
                          {t(locale, "admin.rbac.abac.viewRules")}
                        </button>
                        <button
                          style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}
                          onClick={() => { setEditingPsId(ps.policy_set_id); setEditPsCombining(ps.combining_algorithm); setEditPsStatus(ps.status); setEditPsDesc(ps.description ?? ""); }}
                        >
                          {t(locale, "admin.rbac.abac.editSet")}
                        </button>
                        <button
                          style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12, color: "#dc2626" }}
                          onClick={async () => {
                            setError("");
                            try {
                              const res = await apiFetch(`/rbac/abac/policy-sets/${encodeURIComponent(ps.policy_set_id)}`, { method: "DELETE", locale });
                              const json: unknown = await res.json().catch(() => null);
                              if (!res.ok) throw toApiError(json);
                              await refreshPolicySets();
                            } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                          }}
                        >
                          {t(locale, "admin.rbac.abac.deleteSet")}
                        </button>
                      </td>
                    </tr>
                    )
                  ))}
                </tbody>
              </Table>
            </Card>
          )}

          {/* 实时评估卡片 */}
          <Card title={t(locale, "admin.rbac.abac.evaluate")}>
            <div style={{ display: "grid", gap: 10, maxWidth: 520 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.evalPolicySetId")}</span>
                  <select value={evalPsId} onChange={e => setEvalPsId(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }}>
                    <option value="">--</option>
                    {policySets.map(ps => <option key={ps.policy_set_id} value={ps.policy_set_id}>{ps.name}</option>)}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.evalSubjectId")}</span>
                  <input value={evalSubjectId} onChange={e => setEvalSubjectId(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.evalTenantId")}</span>
                  <input value={evalTenantId} onChange={e => setEvalTenantId(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }} />
                </label>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.evalResourceType")}</span>
                  <select value={evalResourceType} onChange={e => setEvalResourceType(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }}>
                    {RESOURCE_TYPES.map(rt => (
                      <option key={rt} value={rt}>{t(locale, `admin.rbac.resourceType.${rt}`)}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, flex: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{t(locale, "admin.rbac.abac.evalAction")}</span>
                  <select value={evalAction} onChange={e => setEvalAction(e.target.value)} style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--sl-border)", fontSize: 12 }}>
                    <option value="*">{t(locale, "admin.rbac.actionOption.all")}</option>
                    {(RESOURCE_ACTIONS[evalResourceType] ?? []).filter(a => a !== "*").map(a => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button
                disabled={!evalPsId || !evalSubjectId.trim() || !evalTenantId.trim()}
                onClick={async () => {
                  setError("");
                  setAbacEvalResult(null);
                  try {
                    const res = await apiFetch(`/rbac/abac/evaluate`, {
                      method: "POST", headers: { "content-type": "application/json" }, locale,
                      body: JSON.stringify({
                        policySetId: evalPsId,
                        request: {
                          subject: { subjectId: evalSubjectId, tenantId: evalTenantId },
                          resource: { resourceType: evalResourceType },
                          action: evalAction,
                          environment: { timestamp: new Date().toISOString() },
                        },
                      }),
                    });
                    const json: unknown = await res.json().catch(() => null);
                    if (!res.ok) throw toApiError(json);
                    setAbacEvalResult(json);
                  } catch (e: unknown) { setError(errText(locale, toApiError(e))); }
                }}
                style={{ padding: "6px 16px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, justifySelf: "start" }}
              >
                {t(locale, "admin.rbac.abac.evalRun")}
              </button>
            </div>
            {abacEvalResult ? (
              <div style={{ marginTop: 16 }}>
                <StructuredData data={abacEvalResult} />
              </div>
            ) : null}
          </Card>
        </>
      )}
    </div>
  );

  /* ─── Tab 6: Permission Test Sandbox ─── */
  const sandboxTab = (
    <div style={{ display: "grid", gap: 16 }}>
      <p style={{ color: "var(--sl-muted)", fontSize: 13, margin: 0 }}>{t(locale, "admin.rbac.sandbox.desc")}</p>

      {/* Quick scenarios */}
      <Card title={t(locale, "admin.rbac.sandbox.quickScenarios")}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {QUICK_SCENARIOS.map(sc => (
            <button
              key={sc.key}
              onClick={() => { setSbSubjectId(sc.subjectId); setSbScopeType("space"); setSbScopeId("space_dev"); setSbResourceType(sc.resourceType); setSbResourceId(sc.resourceId); setSbAction(sc.action); }}
              style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 12 }}
            >
              {t(locale, `admin.rbac.sandbox.scenario.${sc.key}`)}
            </button>
          ))}
        </div>
      </Card>

      {/* Test form */}
      <Card title={t(locale, "admin.rbac.sandbox.title")}>
        <div style={{ display: "grid", gap: 12, maxWidth: 520 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.sandbox.subjectId")}</span>
            <input value={sbSubjectId} onChange={e => setSbSubjectId(e.target.value)} placeholder={t(locale, "admin.rbac.sandbox.subjectIdHint")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.scopeType")}</span>
              <select value={sbScopeType} onChange={e => setSbScopeType(e.target.value === "tenant" ? "tenant" : "space")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                <option value="tenant">{t(locale, "admin.rbac.scopeType.tenant")}</option>
                <option value="space">{t(locale, "admin.rbac.scopeType.space")}</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.form.scopeId")}</span>
              <input value={sbScopeId} onChange={e => setSbScopeId(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.sandbox.resourceType")}</span>
              <select value={sbResourceType} onChange={e => { setSbResourceType(e.target.value); const acts = RESOURCE_ACTIONS[e.target.value]; if (acts && !acts.includes(sbAction)) setSbAction(acts[0] ?? "read"); }} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
                {RESOURCE_TYPES.map(rt => (
                  <option key={rt} value={rt}>{t(locale, `admin.rbac.resourceType.${rt}`)}</option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.sandbox.resourceId")}</span>
              <input value={sbResourceId} onChange={e => setSbResourceId(e.target.value)} placeholder={t(locale, "admin.rbac.sandbox.resourceIdPlaceholder")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }} />
            </label>
          </div>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{t(locale, "admin.rbac.sandbox.action")}</span>
            <select value={sbAction} onChange={e => setSbAction(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid var(--sl-border)" }}>
              <option value="*">{t(locale, "admin.rbac.actionOption.all")}</option>
              {(RESOURCE_ACTIONS[sbResourceType] ?? []).filter(a => a !== "*").map(a => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </label>
          <button
            disabled={!sbSubjectId.trim() || !sbScopeId.trim() || sbLoading}
            onClick={runSandboxCheck}
            style={{ padding: "8px 20px", borderRadius: 6, background: "var(--sl-accent)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600, opacity: (!sbSubjectId.trim() || !sbScopeId.trim() || sbLoading) ? 0.5 : 1 }}
          >
            {sbLoading ? "..." : t(locale, "admin.rbac.sandbox.run")}
          </button>
        </div>

        {/* Result */}
        {sbResult && (
          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: sbResult.allowed ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)", border: `1px solid ${sbResult.allowed ? "#86efac" : "#fecaca"}` }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
              {sbResult.allowed ? t(locale, "admin.rbac.sandbox.allowed") : t(locale, "admin.rbac.sandbox.denied")}
            </div>
            <div style={{ fontSize: 12, color: "var(--sl-muted)", display: "grid", gap: 4 }}>
              <div>{t(locale, "admin.rbac.sandbox.reason")}: {sbResult.reason || "-"}</div>
              {sbResult.policySnapshotId ? (
                <a href={`/gov/policy-snapshots/${encodeURIComponent(sbResult.policySnapshotId)}?lang=${encodeURIComponent(locale)}`} style={{ color: "var(--sl-accent)" }}>
                  {t(locale, "admin.rbac.sandbox.openSnapshot")}
                </a>
              ) : null}
              {sbResult.matchedRulesSummary ? (
                <div>{t(locale, "admin.rbac.sandbox.ruleSummary")}: {JSON.stringify(sbResult.matchedRulesSummary)}</div>
              ) : null}
            </div>
            <div style={{ fontSize: 12, color: "var(--sl-muted)" }}>
              <strong>{t(locale, "admin.rbac.sandbox.matchedRules")}:</strong>
              {sbResult.matchedRules && sbResult.matchedRules.length > 0 ? (
                <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                  {sbResult.matchedRules.map((rule: any, i: number) => (
                    <li key={i} style={{ marginBottom: 2 }}>
                      <Badge tone={rule.effect === "allow" ? "success" : "warning"}>{String(rule.effect ?? rule.type ?? "rule")}</Badge>
                      {" "}{String(rule.name ?? rule.policyName ?? rule.id ?? JSON.stringify(rule))}
                    </li>
                  ))}
                </ul>
              ) : (
                <span style={{ marginLeft: 4 }}>{t(locale, "admin.rbac.sandbox.noRules")}</span>
              )}
            </div>
            {sbResult.raw && (
              <details style={{ marginTop: 8, fontSize: 11 }}>
                <summary style={{ cursor: "pointer", color: "var(--sl-muted)" }}>Raw JSON</summary>
                <pre style={{ margin: "4px 0 0", padding: 8, borderRadius: 4, background: "var(--sl-surface)", overflow: "auto", maxHeight: 200, fontSize: 11 }}>
                  {JSON.stringify(sbResult.raw, null, 2)}
                </pre>
              </details>
            )}
          </div>
        )}
      </Card>

      {/* History */}
      {sbHistory.length > 0 && (
        <Card title={t(locale, "admin.rbac.sandbox.history")}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
            <button onClick={() => setSbHistory([])} style={{ padding: "2px 8px", borderRadius: 4, border: "1px solid var(--sl-border)", background: "var(--sl-surface)", cursor: "pointer", fontSize: 11 }}>
              {t(locale, "admin.rbac.sandbox.clearHistory")}
            </button>
          </div>
          <Table>
            <thead>
              <tr>
                <th style={{ fontSize: 12 }}>{t(locale, "admin.rbac.sandbox.subjectId")}</th>
                <th style={{ fontSize: 12 }}>{t(locale, "admin.rbac.sandbox.resourceType")}</th>
                <th style={{ fontSize: 12 }}>{t(locale, "admin.rbac.sandbox.action")}</th>
                <th style={{ fontSize: 12 }}>{t(locale, "admin.rbac.sandbox.result")}</th>
                <th style={{ fontSize: 12 }}>{t(locale, "admin.rbac.sandbox.reason")}</th>
                <th style={{ fontSize: 12 }}>{t(locale, "admin.rbac.sandbox.time")}</th>
              </tr>
            </thead>
            <tbody>
              {sbHistory.map((h, i) => (
                <tr key={i}>
                  <td style={{ fontSize: 12 }}>{h.subjectId}</td>
                  <td style={{ fontSize: 12 }}>{h.scopeType}:{h.scopeId} / {h.resourceType}{h.resourceId ? ` / ${h.resourceId}` : ""}</td>
                  <td style={{ fontSize: 12 }}>{h.action}</td>
                  <td><Badge tone={h.allowed ? "success" : "warning"}>{h.allowed ? t(locale, "admin.rbac.sandbox.allowed") : t(locale, "admin.rbac.sandbox.denied")}</Badge></td>
                  <td style={{ fontSize: 11, color: "var(--sl-muted)" }}>{h.reason ?? "-"}</td>
                  <td style={{ fontSize: 11, color: "var(--sl-muted)" }}>{h.time}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );

  return (
    <div style={{ padding: 24, display: "grid", gap: 16 }}>
      <PageHeader title={t(locale, "admin.rbac.title")} description={t(locale, "admin.rbac.desc")} helpHref={getHelpHref("/admin/rbac", locale) ?? undefined} />

      {(error || initialError) ? (
        <div style={{ padding: "12px 16px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", fontSize: 13 }}>
          {error || initialError}
        </div>
      ) : null}

      <TabNav
        defaultTab="roles"
        tabs={[
          { key: "roles", label: t(locale, "admin.rbac.tab.roles"), content: rolesTab },
          { key: "permissions", label: t(locale, "admin.rbac.tab.permissions"), content: permissionsTab },
          { key: "assign", label: t(locale, "admin.rbac.tab.assign"), content: assignTab },
          { key: "bindings", label: t(locale, "admin.rbac.tab.bindings"), content: bindingsTab },
          { key: "policies", label: t(locale, "admin.rbac.tab.policies"), content: policiesTab },
          { key: "sandbox", label: t(locale, "admin.rbac.tab.sandbox"), content: sandboxTab },
        ]}
      />
    </div>
  );
}
