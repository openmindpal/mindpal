import type { Pool } from "pg";
import type { PolicyDecision, AbacEvaluationRequest, AbacEvaluationResult, AbacPolicySet, AbacPolicyRule } from "@openslin/shared";
import { validatePolicyExpr, evaluateAbacPolicySet, buildPolicySetIndex, StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "authz" });
import { createPolicySnapshot } from "./policySnapshotRepo";
import { getPolicyCacheEpoch } from "./policyCacheEpochRepo";
import { insertAuditEvent } from "../audit/auditRepo";

// ─── RBAC 缓存失效 Pub/Sub ────────────────────────────────────────
const RBAC_CACHE_INVALIDATE_CHANNEL = "rbac:cache:invalidate";

export interface RbacCacheInvalidation {
  tenantId: string;
  subjectId?: string;
  scope: "subject" | "tenant";
  reason: string;
}

/** Redis 客户端引用（由 initRbacCacheSubscriber 注入） */
let _redis: { publish(channel: string, message: string): Promise<number> } | null = null;
/** 专用 subscriber 连接（ioredis 要求 subscribe 模式用独立连接） */
let _subClient: any = null;
let _subReady = false;

/**
 * 发布 RBAC 缓存失效消息：
 * 1. 本地立即清除匹配条目
 * 2. 通过 Redis PUBLISH 广播到所有 API 实例
 */
export async function invalidateRbacCache(msg: RbacCacheInvalidation): Promise<void> {
  // 本地清除
  _applyInvalidation(msg);

  // 广播
  if (_redis) {
    try {
      await _redis.publish(RBAC_CACHE_INVALIDATE_CHANNEL, JSON.stringify(msg));
      _logger.info("rbac_cache_invalidation_published", {
        tenantId: msg.tenantId,
        subjectId: msg.subjectId ?? null,
        scope: msg.scope,
        reason: msg.reason,
      });
    } catch (err: any) {
      _logger.warn("rbac_cache_invalidation_publish_failed", {
        tenantId: msg.tenantId,
        reason: msg.reason,
        error: err?.message ?? String(err),
      });
    }
  }
}

/** 按失效消息清除本地缓存条目 */
function _applyInvalidation(msg: RbacCacheInvalidation): void {
  const prefix = `${msg.tenantId}|`;
  if (msg.scope === "tenant") {
    // 清除该租户所有缓存
    for (const key of authzCache.keys()) {
      if (key.startsWith(prefix)) authzCache.delete(key);
    }
    for (const key of abacPolicySetCache.keys()) {
      if (key.startsWith(`abac|${msg.tenantId}|`)) abacPolicySetCache.delete(key);
    }
    _logger.info("rbac_cache_invalidated_tenant", { tenantId: msg.tenantId, reason: msg.reason });
  } else if (msg.scope === "subject" && msg.subjectId) {
    // 清除该租户下特定 subject 的缓存
    const subjectToken = `|${msg.subjectId}|`;
    for (const key of authzCache.keys()) {
      if (key.startsWith(prefix) && key.includes(subjectToken)) authzCache.delete(key);
    }
    _logger.info("rbac_cache_invalidated_subject", { tenantId: msg.tenantId, subjectId: msg.subjectId, reason: msg.reason });
  }
}

/**
 * 初始化 RBAC 缓存 Pub/Sub 订阅。
 * 在 API 服务启动时调用一次，注入 Redis publish 客户端 + 创建独立 subscriber。
 */
export async function initRbacCacheSubscriber(redis: { publish(channel: string, message: string): Promise<number> }): Promise<void> {
  _redis = redis;
  try {
    const { default: Redis } = await import("ioredis");
    const redisCfg = {
      host: process.env.REDIS_HOST ?? "127.0.0.1",
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null as null,
      lazyConnect: true,
      connectTimeout: 500,
    };
    _subClient = new Redis(redisCfg);
    _subClient.on("error", () => undefined);
    _subClient.on("close", () => { _subReady = false; });
    _subClient.on("ready", () => {
      _subReady = true;
      // 重连后重新订阅
      _subClient.subscribe(RBAC_CACHE_INVALIDATE_CHANNEL).catch(() => {});
    });
    _subClient.on("message", (_ch: string, raw: string) => {
      try {
        const msg: RbacCacheInvalidation = JSON.parse(raw);
        if (msg.tenantId) _applyInvalidation(msg);
      } catch { /* ignore malformed */ }
    });
    await _subClient.connect();
    await _subClient.subscribe(RBAC_CACHE_INVALIDATE_CHANNEL);
    _subReady = true;
    _logger.info("rbac_cache_subscriber_started", { channel: RBAC_CACHE_INVALIDATE_CHANNEL });
  } catch (err: any) {
    _logger.warn("rbac_cache_subscriber_failed", { error: err?.message ?? String(err) });
  }
}

/**
 * 关闭 RBAC 缓存 Pub/Sub 订阅（graceful shutdown 时调用）。
 */
export async function stopRbacCacheSubscriber(): Promise<void> {
  if (_subClient) {
    try {
      const quitP = (async () => {
        await _subClient.unsubscribe(RBAC_CACHE_INVALIDATE_CHANNEL);
        await _subClient.quit();
      })().catch(() => {});
      await Promise.race([quitP, new Promise<void>((r) => setTimeout(r, 1_000))]);
    } catch { /* ignore */ }
    try { _subClient.disconnect(); } catch { /* ignore */ }
    _subClient = null;
    _subReady = false;
    _logger.info("rbac_cache_subscriber_stopped");
  }
  _redis = null;
}

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
  field_rules_condition?: any;
};

type CachedAuthz = {
  roleIds: string[];
  perms: PermissionRow[];
  expiresAtMs: number;
};

const authzCache = new Map<string, CachedAuthz>();

/**
 * 清除授权缓存（用于测试）
 */
export function clearAuthzCache(): void {
  authzCache.clear();
  abacPolicySetCache.clear();
}

// ─── 阶段1: ABAC 策略集查询缓存 ────────────────────────────────────
// 避免每次 ABAC 评估都查询数据库,基于 tenantId + resourceType + epoch 做版本化缓存
type CachedAbacPolicySets = {
  policySets: AbacPolicySet[];
  epoch: number;
  expiresAtMs: number;
};
const abacPolicySetCache = new Map<string, CachedAbacPolicySets>();
const ABAC_CACHE_TTL_MS = 5_000; // 5秒本地热缓存 TTL（主缓存由 epoch 版本管理）
const ABAC_CACHE_MAX_SIZE = 5000;

function getAbacCacheKey(tenantId: string, resourceType: string, epoch: number): string {
  return `abac|${tenantId}|${resourceType}|${epoch}`;
}

async function loadAbacPolicySetsWithCache(params: {
  pool: Pool;
  tenantId: string;
  resourceType: string;
  tenantEpoch: number;
}): Promise<AbacPolicySet[]> {
  const key = getAbacCacheKey(params.tenantId, params.resourceType, params.tenantEpoch);
  const cached = cacheGet<CachedAbacPolicySets>(abacPolicySetCache, key);
  if (cached) {
    return cached.policySets;
  }

  const policySetsRes = await params.pool.query(
    `SELECT ps.policy_set_id, ps.name, ps.version, ps.resource_type, ps.combining_algorithm, ps.status
     FROM abac_policy_sets ps
     WHERE ps.tenant_id = $1 AND ps.resource_type = $2 AND ps.status = 'active'
     ORDER BY ps.version DESC LIMIT 5`,
    [params.tenantId, params.resourceType],
  );

  const policySets: AbacPolicySet[] = [];
  for (const psRow of policySetsRes.rows) {
    const rulesRes = await params.pool.query(
      `SELECT rule_id, name, description, resource_type, actions, priority, effect, condition_expr, enabled, space_id, metadata
       FROM abac_policy_rules
       WHERE policy_set_id = $1 AND tenant_id = $2 AND enabled = true
       ORDER BY priority ASC LIMIT 50`,
      [psRow.policy_set_id, params.tenantId],
    );

    const rules: AbacPolicyRule[] = rulesRes.rows.map((r: any) => ({
      ruleId: r.rule_id,
      name: r.name,
      description: r.description ?? "",
      resourceType: r.resource_type,
      actions: Array.isArray(r.actions) ? r.actions : [],
      priority: r.priority,
      effect: r.effect,
      condition: r.condition_expr,
      enabled: r.enabled,
      tenantId: params.tenantId,
      spaceId: r.space_id ?? undefined,
      metadata: r.metadata ?? {},
    }));

    policySets.push({
      policySetId: psRow.policy_set_id,
      name: psRow.name,
      version: psRow.version,
      rules,
      combiningAlgorithm: psRow.combining_algorithm,
      resourceType: psRow.resource_type,
      status: psRow.status,
    });
  }

  cacheSet(abacPolicySetCache, key, {
    policySets,
    epoch: params.tenantEpoch,
    expiresAtMs: Date.now() + ABAC_CACHE_TTL_MS,
  }, ABAC_CACHE_MAX_SIZE);

  return policySets;
}

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
  const conditionalRules: any[] = [];

  for (const p of perms) {
    // Conditional field rules (attached to ABAC condition)
    if (p.field_rules_condition) {
      const r = normalizeRule(p.field_rules_read);
      const w = normalizeRule(p.field_rules_write);
      const fr: any = {};
      if (r.allow || r.deny) fr.read = { allow: r.allow, deny: r.deny };
      if (w.allow || w.deny) fr.write = { allow: w.allow, deny: w.deny };
      if (Object.keys(fr).length) {
        conditionalRules.push({ condition: p.field_rules_condition, fieldRules: fr });
      }
      continue;
    }
    const r = normalizeRule(p.field_rules_read);
    const w = normalizeRule(p.field_rules_write);
    readAllow = mergeAllow(readAllow, r.allow);
    readDeny = mergeDeny(readDeny, r.deny);
    writeAllow = mergeAllow(writeAllow, w.allow);
    writeDeny = mergeDeny(writeDeny, w.deny);
  }

  // Deny-wins: if a field is in both allow and deny, deny takes precedence
  if (readAllow && readDeny) {
    readAllow = readAllow.filter((f) => f === "*" || !readDeny!.includes(f));
    if (readAllow.length === 0) readAllow = undefined;
  }
  if (writeAllow && writeDeny) {
    writeAllow = writeAllow.filter((f) => f === "*" || !writeDeny!.includes(f));
    if (writeAllow.length === 0) writeAllow = undefined;
  }

  const out: any = {};
  if (readAllow || (readDeny && readDeny.length > 0)) out.read = { allow: readAllow, deny: readDeny };
  if (writeAllow || (writeDeny && writeDeny.length > 0)) out.write = { allow: writeAllow, deny: writeDeny };
  const result = Object.keys(out).length ? out : undefined;
  return { fieldRules: result, conditionalFieldRules: conditionalRules.length > 0 ? conditionalRules : undefined };
}

function normalizeOneRowFilter(rf: any): any {
  if (!rf || typeof rf !== "object" || Array.isArray(rf)) throw new Error("unsupported_row_filters");
  const kind = String((rf as any).kind ?? "");
  if (kind === "owner_only") return { kind: "owner_only" };
  if (kind === "expr") {
    const expr = (rf as any).expr;
    const v = validatePolicyExpr(expr);
    if (!v.ok) throw new Error("unsupported_policy_expr");
    return { kind: "expr", expr: v.expr };
  }
  if (kind === "payload_field_eq_subject") {
    const field = String((rf as any).field ?? "");
    if (!field) throw new Error("unsupported_row_filters");
    return { kind: "payload_field_eq_subject", field };
  }
  if (kind === "payload_field_eq_literal") {
    const field = String((rf as any).field ?? "");
    const value = (rf as any).value;
    const t = typeof value;
    if (!field) throw new Error("unsupported_row_filters");
    if (t !== "string" && t !== "number" && t !== "boolean") throw new Error("unsupported_row_filters");
    return { kind: "payload_field_eq_literal", field, value };
  }
  if (kind === "space_member") {
    const roles = (rf as any).roles;
    const out: any = { kind: "space_member" };
    if (Array.isArray(roles) && roles.length > 0) out.roles = roles.map(String).filter(Boolean);
    return out;
  }
  if (kind === "org_hierarchy") {
    const orgField = String((rf as any).orgField ?? "orgUnitId");
    const includeDescendants = Boolean((rf as any).includeDescendants ?? true);
    return { kind: "org_hierarchy", orgField, includeDescendants };
  }
  if (kind === "or" && Array.isArray((rf as any).rules)) {
    const children = (rf as any).rules.map((child: any) => normalizeOneRowFilter(child));
    return { kind: "or", rules: children };
  }
  if (kind === "and" && Array.isArray((rf as any).rules)) {
    const children = (rf as any).rules.map((child: any) => normalizeOneRowFilter(child));
    return { kind: "and", rules: children };
  }
  if (kind === "not" && (rf as any).rule) {
    const child = normalizeOneRowFilter((rf as any).rule);
    return { kind: "not", rule: child };
  }
  throw new Error("unsupported_row_filters");
}

function resolveRowFilterMergeMode(resourceType: string) {
  const raw = String(process.env.AUTHZ_ROW_FILTER_MERGE_MODE ?? "").trim().toLowerCase();
  if (raw === "intersection" || raw === "and") return "intersection";
  if (raw === "union" || raw === "or") return "union";

  const conf = String(process.env.AUTHZ_ROW_FILTER_CONSERVATIVE_RESOURCE_TYPES ?? "").trim();
  const conservative = new Set(conf.split(",").map((x) => x.trim()).filter(Boolean));
  if (conservative.size === 0) {
    for (const t of ["secret", "secrets", "audit", "policy_snapshot", "policy-snapshot", "connector_secret", "keyring"]) conservative.add(t);
  }
  return conservative.has(resourceType) ? "intersection" : "union";
}

function mergeRowFilters(perms: PermissionRow[], mode: "read" | "write", resourceType: string) {
  const mergeMode = resolveRowFilterMergeMode(resourceType);
  let sawNull = false;
  const rules: any[] = [];
  for (const p of perms) {
    const rf = mode === "write" ? p.row_filters_write : p.row_filters_read;
    if (rf === null || rf === undefined) {
      sawNull = true;
      continue;
    }
    rules.push(normalizeOneRowFilter(rf));
  }
  if (rules.length === 0) return undefined;
  if (rules.length === 1) return rules[0];
  if (mergeMode === "intersection") return { kind: "and", rules };
  if (sawNull) return undefined;
  return { kind: "or", rules };
}

export async function authorize(params: {
  pool: Pool;
  subjectId: string;
  tenantId: string;
  spaceId?: string;
  resourceType: string;
  action: string;
  abacRequest?: AbacEvaluationRequest;
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
        _logger.info("authorize", { subjectId: params.subjectId, tenantId: params.tenantId, spaceId: params.spaceId, roleIds });
    if (roleIds.length === 0) {
      perms = [];
    } else {
      const permsRes = await params.pool.query<PermissionRow>(
        `
          SELECT rp.role_id, p.resource_type, p.action, rp.field_rules_read, rp.field_rules_write, rp.row_filters_read, rp.row_filters_write, rp.field_rules_condition
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.role_id = ANY($1::text[])
        `,
        [roleIds],
      );
      perms = permsRes.rows;
    }
    cacheSet(authzCache, cacheKey, { roleIds, perms, expiresAtMs: Date.now() + 5_000 } satisfies CachedAuthz, 50000);
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
    // 无角色绑定拒绝审计日志
    insertAuditEvent(params.pool, {
      subjectId: params.subjectId,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      resourceType: params.resourceType,
      action: params.action,
      result: "denied",
      traceId: "",
      inputDigest: {
        subject: params.subjectId,
        resource: params.resourceType,
        requestedAction: params.action,
        reason: "no_role_binding",
        matchedPolicy: { roleIds: [], snapshotRef: `policy_snapshot:${snap.snapshotId}` },
      },
      outputDigest: { decision: "deny", reason: "no_role_binding" },
    }).catch(() => { /* 审计写入失败不影响主流程 */ });
    return { decision: "deny", reason: "no_role_binding", snapshotRef: `policy_snapshot:${snap.snapshotId}`, policyRef, policyCacheEpoch, explainV1 };
  }

  /* ─── 权限拒绝审计辅助函数 ─── */
  const emitDenyAudit = (reason: string, matchedPolicy: any) => {
    insertAuditEvent(params.pool, {
      subjectId: params.subjectId,
      tenantId: params.tenantId,
      spaceId: params.spaceId,
      resourceType: params.resourceType,
      action: params.action,
      result: "denied",
      traceId: "",
      inputDigest: {
        subject: params.subjectId,
        resource: params.resourceType,
        requestedAction: params.action,
        reason,
        matchedPolicy,
      },
      outputDigest: { decision: "deny", reason },
    }).catch(() => { /* 审计写入失败不影响主流程 */ });
  };

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
  const { fieldRules, conditionalFieldRules } = mergeFieldRules(matchedPerms);
  const mode = ["create", "update", "delete"].includes(params.action) ? ("write" as const) : ("read" as const);
  let rowFilters: any | undefined;
  try {
    rowFilters = mergeRowFilters(matchedPerms, mode, params.resourceType);
  } catch (e: any) {
    const reason = String(e?.message ?? "") === "unsupported_policy_expr" ? "unsupported_policy_expr" : "unsupported_row_filters";
    const explainV1 = buildExplainV1({ decision: "deny", reason, matchedRules: { roleIds, permissions: perms }, rowFilters: null, fieldRules: fieldRules as any, policyRef, policyCacheEpoch });
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
      fieldRules: fieldRules as any,
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
      conditionalFieldRules,
      rowFilters: null,
      snapshotRef: `policy_snapshot:${snap.snapshotId}`,
      policyRef,
      policyCacheEpoch,
      explainV1,
    };
  }

  if (!allowed) {
    const explainV1 = buildExplainV1({ decision: "deny", reason: "permission_denied", matchedRules: { roleIds, permissions: perms }, rowFilters, fieldRules: fieldRules as any, policyRef, policyCacheEpoch });
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
      fieldRules: fieldRules as any,
      rowFilters,
      policyRef,
      policyCacheEpoch,
      explainV1,
    });
    // 权限拒绝审计日志
    emitDenyAudit("permission_denied", { roleIds, snapshotRef: `policy_snapshot:${snap.snapshotId}` });
    return {
      decision: "deny",
      reason: "permission_denied",
      matchedRules: { roleIds, permissions: perms },
      fieldRules,
      conditionalFieldRules,
      rowFilters,
      snapshotRef: `policy_snapshot:${snap.snapshotId}`,
      policyRef,
      policyCacheEpoch,
      explainV1,
    };
  }

  const effectiveFieldRules = fieldRules ?? { read: { allow: ["*"] }, write: { allow: ["*"] } };
  let lastAbacResult: AbacEvaluationResult | undefined;

  /* ─── ABAC 策略集评估 (新引擎 policyEngine.ts + 缓存 + 索引优化) ─── */
  if (params.abacRequest) {
    try {
      const abacPolicySets = await loadAbacPolicySetsWithCache({
        pool: params.pool,
        tenantId: params.tenantId,
        resourceType: params.resourceType,
        tenantEpoch: tenantEpoch,
      });

      for (const policySet of abacPolicySets) {
        // 阶段2: 使用预构建索引进行快速评估
        const index = buildPolicySetIndex(policySet);
        const abacResult = evaluateAbacPolicySet(policySet, params.abacRequest, index);
        lastAbacResult = abacResult;

        if (abacResult.decision === "deny") {
          const reason = `abac:${abacResult.reason}`;
          const explainV1 = buildExplainV1({
            decision: "deny",
            reason,
            matchedRules: { roleIds, permissions: perms },
            rowFilters,
            fieldRules: effectiveFieldRules,
            policyRef,
            policyCacheEpoch,
          });
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
            rowFilters,
            fieldRules: effectiveFieldRules,
            policyRef,
            policyCacheEpoch,
            explainV1: { ...explainV1, abac: abacResult },
          });
          // ABAC 权限拒绝审计日志
          emitDenyAudit(reason, { roleIds, abacResult, snapshotRef: `policy_snapshot:${snap.snapshotId}` });
          return {
            decision: "deny",
            reason,
            matchedRules: { roleIds, permissions: perms },
            fieldRules: effectiveFieldRules,
            conditionalFieldRules,
            rowFilters,
            snapshotRef: `policy_snapshot:${snap.snapshotId}`,
            policyRef,
            policyCacheEpoch,
            explainV1: { ...explainV1, abac: abacResult },
            abacResult,
          };
        }
      }
    } catch (err) {
      /* ABAC 新表可能尚未迁移 — 优雅降级，记录错误日志 */
      if (process.env.NODE_ENV !== "test") {
                _logger.error("ABAC policy evaluation failed, degrading to skip", { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  const baseExplainV1 = buildExplainV1({
    decision: "allow",
    reason: "permission_allowed",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: effectiveFieldRules,
    policyRef,
    policyCacheEpoch,
  });
  const explainV1 = lastAbacResult ? { ...baseExplainV1, abac: lastAbacResult } : baseExplainV1;
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
    fieldRules: effectiveFieldRules,
    policyRef,
    policyCacheEpoch,
    explainV1,
  });
  const snapshotRef = `policy_snapshot:${snap.snapshotId}`;

  return {
    decision: "allow",
    matchedRules: { roleIds, permissions: perms },
    rowFilters,
    fieldRules: effectiveFieldRules,
    conditionalFieldRules,
    snapshotRef,
    policyRef,
    policyCacheEpoch,
    explainV1,
  };
}
