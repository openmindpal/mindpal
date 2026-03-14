import type { Pool } from "pg";
import type { PolicyDecision } from "@openslin/shared";
import { validatePolicyExpr } from "@openslin/shared";
import { createPolicySnapshot } from "./policySnapshotRepo";
import { getPolicyCacheEpoch } from "./policyCacheEpochRepo";

export type ResourceAction = {
  resourceType: string;
  action: string;
};

type PermissionRow = {
  role_id: string;
  resource_type: string;
  action: string;
  field_rules_read?: any;
  field_rules_write?: any;
  row_filters_read?: any;
  row_filters_write?: any;
};

type CachedAuthz = {
  roleIds: string[];
  perms: PermissionRow[];
  expiresAtMs: number;
};

const authzCache = new Map<string, CachedAuthz>();

function isFieldRulesTrivial(fieldRules: any) {
  const readAllowAll = Boolean(fieldRules?.read?.allow?.includes?.("*"));
  const writeAllowAll = Boolean(fieldRules?.write?.allow?.includes?.("*"));
  const readDenyEmpty = !fieldRules?.read?.deny || fieldRules.read.deny.length === 0;
  const writeDenyEmpty = !fieldRules?.write?.deny || fieldRules.write.deny.length === 0;
  return readAllowAll && writeAllowAll && readDenyEmpty && writeDenyEmpty;
}

function buildExplainV1(params: {
  decision: "allow" | "deny";
  reason: string | null;
  matchedRules: any;
  rowFilters: any;
  fieldRules: any;
  policyRef: { name: string; version: number };
  policyCacheEpoch: any;
}) {
  const reasons: string[] = [];
  const r = params.reason ?? "";
  if (r === "no_role_binding" || r === "permission_denied") reasons.push("missing_permission");
  if (r === "unsupported_policy_expr") reasons.push("unsupported_policy_expr");
  if (params.rowFilters) reasons.push("row_filter_applied");
  if (params.fieldRules && !isFieldRulesTrivial(params.fieldRules)) reasons.push("field_rule_applied");

  const perms = Array.isArray(params.matchedRules?.permissions) ? params.matchedRules.permissions : [];
  const matchedRules = perms
    .map((p: any) => ({
      kind: "role_permission",
      roleId: String(p?.role_id ?? p?.roleId ?? ""),
      resourceType: String(p?.resource_type ?? p?.resourceType ?? ""),
      action: String(p?.action ?? ""),
    }))
    .filter((x: any) => x.roleId && x.resourceType && x.action);

  return {
    version: 1,
    decision: params.decision,
    reasons,
    policyRef: params.policyRef,
    policyCacheEpoch: params.policyCacheEpoch,
    matchedRules,
  };
}

function cacheGet<T>(m: Map<string, any>, key: string): T | null {
  const v = m.get(key);
  if (!v) return null;
  if (typeof v.expiresAtMs === "number" && v.expiresAtMs < Date.now()) {
    m.delete(key);
    return null;
  }
  return v as T;
}

function cacheSet(m: Map<string, any>, key: string, value: any, maxSize: number) {
  m.set(key, value);
  if (m.size <= maxSize) return;
  const it = m.keys().next();
  if (!it.done) m.delete(it.value);
}

function normalizeRule(v: any) {
  const allow = Array.isArray(v?.allow) ? v.allow.filter((x: any) => typeof x === "string") : undefined;
  const deny = Array.isArray(v?.deny) ? v.deny.filter((x: any) => typeof x === "string") : undefined;
  return { allow, deny };
}

function mergeAllow(existing: string[] | undefined, incoming: string[] | undefined) {
  if (!incoming || incoming.length === 0) return existing;
  if (incoming.includes("*")) return ["*"];
  if (existing && existing.includes("*")) return existing;
  const set = new Set<string>(existing ?? []);
  for (const k of incoming) set.add(k);
  return Array.from(set);
}

function mergeDeny(existing: string[] | undefined, incoming: string[] | undefined) {
  if (!incoming || incoming.length === 0) return existing;
  const set = new Set<string>(existing ?? []);
  for (const k of incoming) set.add(k);
  return Array.from(set);
}

function mergeFieldRules(perms: PermissionRow[]) {
  let readAllow: string[] | undefined;
  let readDeny: string[] | undefined;
  let writeAllow: string[] | undefined;
  let writeDeny: string[] | undefined;

  for (const p of perms) {
    const r = normalizeRule(p.field_rules_read);
    const w = normalizeRule(p.field_rules_write);
    readAllow = mergeAllow(readAllow, r.allow);
    readDeny = mergeDeny(readDeny, r.deny);
    writeAllow = mergeAllow(writeAllow, w.allow);
    writeDeny = mergeDeny(writeDeny, w.deny);
  }

  const out: any = {};
  if (readAllow || (readDeny && readDeny.length > 0)) out.read = { allow: readAllow, deny: readDeny };
  if (writeAllow || (writeDeny && writeDeny.length > 0)) out.write = { allow: writeAllow, deny: writeDeny };
  return Object.keys(out).length ? out : undefined;
}

function mergeRowFilters(perms: PermissionRow[], mode: "read" | "write") {
  let sawNull = false;
  const rules: any[] = [];
  for (const p of perms) {
    const rf = mode === "write" ? p.row_filters_write : p.row_filters_read;
    if (rf === null || rf === undefined) {
      sawNull = true;
      continue;
    }
    if (typeof rf !== "object" || Array.isArray(rf)) throw new Error("unsupported_row_filters");
    const kind = String((rf as any).kind ?? "");
    if (kind === "owner_only") {
      rules.push({ kind: "owner_only" });
      continue;
    }
    if (kind === "expr") {
      const expr = (rf as any).expr;
      const v = validatePolicyExpr(expr);
      if (!v.ok) throw new Error("unsupported_policy_expr");
      rules.push({ kind: "expr", expr: v.expr });
      continue;
    }
    if (kind === "payload_field_eq_subject") {
      const field = String((rf as any).field ?? "");
      if (!field) throw new Error("unsupported_row_filters");
      rules.push({ kind: "payload_field_eq_subject", field });
      continue;
    }
    if (kind === "payload_field_eq_literal") {
      const field = String((rf as any).field ?? "");
      const value = (rf as any).value;
      const t = typeof value;
      if (!field) throw new Error("unsupported_row_filters");
      if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("unsupported_row_filters");
      rules.push({ kind: "payload_field_eq_literal", field, value });
      continue;
    }
    if (kind === "or" && Array.isArray((rf as any).rules)) {
      for (const child of (rf as any).rules) {
        if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error("unsupported_row_filters");
        const ck = String((child as any).kind ?? "");
        if (ck === "owner_only") rules.push({ kind: "owner_only" });
        else if (ck === "expr") {
          const expr = (child as any).expr;
          const v = validatePolicyExpr(expr);
          if (!v.ok) throw new Error("unsupported_policy_expr");
          rules.push({ kind: "expr", expr: v.expr });
        }
        else if (ck === "payload_field_eq_subject") {
          const field = String((child as any).field ?? "");
          if (!field) throw new Error("unsupported_row_filters");
          rules.push({ kind: "payload_field_eq_subject", field });
        } else if (ck === "payload_field_eq_literal") {
          const field = String((child as any).field ?? "");
          const value = (child as any).value;
          const t = typeof value;
          if (!field) throw new Error("unsupported_row_filters");
          if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("unsupported_row_filters");
          rules.push({ kind: "payload_field_eq_literal", field, value });
        } else {
          throw new Error("unsupported_row_filters");
        }
      }
      continue;
    }
    throw new Error("unsupported_row_filters");
  }
  if (sawNull) return undefined;
  if (rules.length === 0) return undefined;
  if (rules.length === 1) return rules[0];
  return { kind: "or", rules };
}

export async function authorize(params: {
  pool: Pool;
  subjectId: string;
  tenantId: string;
  spaceId?: string;
  resourceType: string;
  action: string;
}): Promise<PolicyDecision> {
  const tenantEpoch = await getPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: "tenant", scopeId: params.tenantId });
  const spaceEpoch = params.spaceId ? await getPolicyCacheEpoch({ pool: params.pool, tenantId: params.tenantId, scopeType: "space", scopeId: params.spaceId }) : 0;
  const cacheKey = `${params.tenantId}|${params.spaceId ?? ""}|${params.subjectId}|${params.resourceType}|${params.action}|${tenantEpoch}|${spaceEpoch}`;
  const cached = cacheGet<CachedAuthz>(authzCache, cacheKey);
  const policyRef = { name: "default", version: 1 };
  const policyCacheEpoch = { tenant: tenantEpoch, space: spaceEpoch };

  let roleIds: string[];
  let perms: PermissionRow[];
  if (cached) {
    roleIds = cached.roleIds;
    perms = cached.perms;
  } else {
    const rolesRes = await params.pool.query(
      `
        SELECT DISTINCT rb.role_id
        FROM role_bindings rb
        JOIN roles r ON r.id = rb.role_id
        WHERE rb.subject_id = $1
          AND r.tenant_id = $2
          AND (
            (rb.scope_type = 'tenant' AND rb.scope_id = $2)
            OR ($3::text IS NOT NULL AND rb.scope_type = 'space' AND rb.scope_id = $3)
          )
      `,
      [params.subjectId, params.tenantId, params.spaceId ?? null],
    );
    roleIds = rolesRes.rows.map((r) => r.role_id as string);
    if (roleIds.length === 0) {
      perms = [];
    } else {
      const permsRes = await params.pool.query<PermissionRow>(
        `
          SELECT rp.role_id, p.resource_type, p.action, rp.field_rules_read, rp.field_rules_write, rp.row_filters_read, rp.row_filters_write
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ANY($1::text[])
        `,
        [roleIds],
      );
      perms = permsRes.rows;
    }
    cacheSet(authzCache, cacheKey, { roleIds, perms, expiresAtMs: Date.now() + 30000 } satisfies CachedAuthz, 50000);
  }

  if (roleIds.length === 0) {
    const explainV1 = buildExplainV1({ decision: "deny", reason: "no_role_binding", matchedRules: { roleIds: [], permissions: [] }, rowFilters: null, fieldRules: null, policyRef, policyCacheEpoch });
    const snap = await createPolicySnapshot({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId ?? null,
      resourceType: params.resourceType,
      action: params.action,
      decision: "deny",
      reason: "no_role_binding",
      matchedRules: { roleIds: [], permissions: [] },
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    return { decision: "deny", reason: "no_role_binding", snapshotRef: `policy_snapshot:${snap.snapshotId}`, policyRef, policyCacheEpoch, explainV1 };
  }

  const allowed = perms.some((p) => {
    const resourceOk = p.resource_type === "*" || p.resource_type === params.resourceType;
    const actionOk = p.action === "*" || p.action === params.action;
    return resourceOk && actionOk;
  });
  const matchedPerms = perms.filter((p) => {
    const resourceOk = p.resource_type === "*" || p.resource_type === params.resourceType;
    const actionOk = p.action === "*" || p.action === params.action;
    return resourceOk && actionOk;
  });
  const fieldRules = mergeFieldRules(matchedPerms);
  const mode = ["create", "update", "delete"].includes(params.action) ? ("write" as const) : ("read" as const);
  let rowFilters: any | undefined;
  try {
    rowFilters = mergeRowFilters(matchedPerms, mode);
  } catch (e: any) {
    const reason = String(e?.message ?? "") === "unsupported_policy_expr" ? "unsupported_policy_expr" : "unsupported_row_filters";
    const explainV1 = buildExplainV1({ decision: "deny", reason, matchedRules: { roleIds, permissions: perms }, rowFilters: null, fieldRules, policyRef, policyCacheEpoch });
    const snap = await createPolicySnapshot({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId ?? null,
      resourceType: params.resourceType,
      action: params.action,
      decision: "deny",
      reason,
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      rowFilters: null,
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    return {
      decision: "deny",
      reason,
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      rowFilters: null,
      snapshotRef: `policy_snapshot:${snap.snapshotId}`,
      policyRef,
      policyCacheEpoch,
      explainV1,
    };
  }

  if (!allowed) {
    const explainV1 = buildExplainV1({ decision: "deny", reason: "permission_denied", matchedRules: { roleIds, permissions: perms }, rowFilters, fieldRules, policyRef, policyCacheEpoch });
    const snap = await createPolicySnapshot({
      pool: params.pool,
      tenantId: params.tenantId,
      subjectId: params.subjectId,
      spaceId: params.spaceId ?? null,
      resourceType: params.resourceType,
      action: params.action,
      decision: "deny",
      reason: "permission_denied",
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      rowFilters,
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    return {
      decision: "deny",
      reason: "permission_denied",
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      rowFilters,
      snapshotRef: `policy_snapshot:${snap.snapshotId}`,
      policyRef,
      policyCacheEpoch,
      explainV1,
    };
  }

  const explainV1 = buildExplainV1({ decision: "allow", reason: "permission_allowed", matchedRules: { roleIds, permissions: perms }, rowFilters, fieldRules: fieldRules ?? { read: { allow: ["*"] }, write: { allow: ["*"] } }, policyRef, policyCacheEpoch });
  const snap = await createPolicySnapshot({
    pool: params.pool,
    tenantId: params.tenantId,
    subjectId: params.subjectId,
    spaceId: params.spaceId ?? null,
    resourceType: params.resourceType,
    action: params.action,
    decision: "allow",
    reason: "permission_allowed",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: fieldRules ?? { read: { allow: ["*"] }, write: { allow: ["*"] } },
    policyRef,
    policyCacheEpoch,
    explainV1,
  });
  const snapshotRef = `policy_snapshot:${snap.snapshotId}`;

  return {
    decision: "allow",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: fieldRules ?? { read: { allow: ["*"] }, write: { allow: ["*"] } },
    snapshotRef,
    policyRef,
    policyCacheEpoch,
    explainV1,
  };
}
