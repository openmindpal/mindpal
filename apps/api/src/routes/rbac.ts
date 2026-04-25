import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { POLICY_EXPR_JSON_SCHEMA_V1, validatePolicyExpr, validateAbacPolicyRule, evaluateAbacPolicySet } from "@openslin/shared";
import type { AbacEvaluationRequest, AbacPolicyRule, AbacPolicySet } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { authorize, invalidateRbacCache } from "../modules/auth/authz";
import { bumpPolicyCacheEpoch } from "../modules/auth/policyCacheEpochRepo";

function isSafeFieldName(name: string) {
  if (!name) return false;
  if (name.length > 100) return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/** 行级过滤器输入（未验证，由 normalizeRowFilters 归一化） */
interface RowFilterInput {
  kind?: string;
  field?: string;
  value?: string | number | boolean;
  rules?: RowFilterInput[];
  rule?: RowFilterInput;
  roles?: string[];
  orgField?: string;
  includeDescendants?: boolean;
  expr?: unknown;
}

function normalizeRowFilters(input: RowFilterInput | null | undefined): { normalized: RowFilterInput | null; usedPayloadPaths: string[] } {
  if (input === null || input === undefined) return { normalized: null, usedPayloadPaths: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Errors.policyExprInvalid("rowFilters 必须是对象");
  const kind = String(input.kind ?? "");
  if (kind === "owner_only") return { normalized: { kind: "owner_only" }, usedPayloadPaths: [] };
  if (kind === "payload_field_eq_subject") {
    const field = String(input.field ?? "");
    if (!isSafeFieldName(field)) throw Errors.policyExprInvalid("rowFilters.field 非法");
    return { normalized: { kind: "payload_field_eq_subject", field }, usedPayloadPaths: [field] };
  }
  if (kind === "payload_field_eq_literal") {
    const field = String(input.field ?? "");
    if (!isSafeFieldName(field)) throw Errors.policyExprInvalid("rowFilters.field 非法");
    const value = input.value;
    const t = typeof value;
    if (t !== "string" && t !== "number" && t !== "boolean") throw Errors.policyExprInvalid("rowFilters.value 类型非法");
    return { normalized: { kind: "payload_field_eq_literal", field, value }, usedPayloadPaths: [field] };
  }
  if (kind === "or") {
    const rules = input.rules;
    if (!Array.isArray(rules) || rules.length === 0) throw Errors.policyExprInvalid("rowFilters.or.rules 不能为空");
    const out: RowFilterInput[] = [];
    const paths = new Set<string>();
    for (const r of rules) {
      const sub = normalizeRowFilters(r);
      if (sub.normalized) out.push(sub.normalized);
      for (const p of sub.usedPayloadPaths) paths.add(p);
    }
    return { normalized: { kind: "or", rules: out }, usedPayloadPaths: Array.from(paths) };
  }
  if (kind === "and") {
    const rules = input.rules;
    if (!Array.isArray(rules) || rules.length === 0) throw Errors.policyExprInvalid("rowFilters.and.rules 不能为空");
    const out: RowFilterInput[] = [];
    const paths = new Set<string>();
    for (const r of rules) {
      const sub = normalizeRowFilters(r);
      if (sub.normalized) out.push(sub.normalized);
      for (const p of sub.usedPayloadPaths) paths.add(p);
    }
    return { normalized: { kind: "and", rules: out }, usedPayloadPaths: Array.from(paths) };
  }
  if (kind === "not") {
    const rule = input.rule;
    if (!rule || typeof rule !== "object") throw Errors.policyExprInvalid("rowFilters.not.rule 必须是对象");
    const sub = normalizeRowFilters(rule);
    if (!sub.normalized) throw Errors.policyExprInvalid("rowFilters.not.rule 无效");
    return { normalized: { kind: "not", rule: sub.normalized }, usedPayloadPaths: sub.usedPayloadPaths };
  }
  if (kind === "space_member") {
    const roles = input.roles;
    const normalized: RowFilterInput = { kind: "space_member" };
    if (Array.isArray(roles) && roles.length > 0) {
      normalized.roles = roles.map(String).filter(Boolean);
    }
    return { normalized, usedPayloadPaths: [] };
  }
  if (kind === "org_hierarchy") {
    const orgField = String(input.orgField ?? "orgUnitId");
    if (!isSafeFieldName(orgField)) throw Errors.policyExprInvalid("rowFilters.orgField 非法");
    const includeDescendants = Boolean(input.includeDescendants ?? true);
    return { normalized: { kind: "org_hierarchy", orgField, includeDescendants }, usedPayloadPaths: [orgField] };
  }
  if (kind === "expr") {
    const v = validatePolicyExpr(input.expr);
    if (!v.ok) throw Errors.policyExprInvalid(v.message);
    return { normalized: { kind: "expr", expr: v.expr }, usedPayloadPaths: v.usedPayloadPaths };
  }
  throw Errors.policyExprInvalid(`不支持的 rowFilters.kind：${kind || "unknown"}`);
}

function parseCsvText(input: unknown) {
  if (Array.isArray(input)) return input.map(String).map((x) => x.trim()).filter(Boolean);
  const text = String(input ?? "").trim();
  if (!text) return [] as string[];
  return text.split(",").map((x) => x.trim()).filter(Boolean);
}

function buildAbacCheckRequest(actor: { subjectId: string; tenantId: string; spaceId?: string }, input?: {
  resourceType?: string;
  action?: string;
  clientIp?: string;
  geoRegion?: string;
  riskLevel?: string;
  dataLabels?: string[] | string;
  deviceType?: string;
  attributes?: Record<string, unknown>;
}): AbacEvaluationRequest {
  return {
    subject: { subjectId: actor.subjectId, tenantId: actor.tenantId, spaceId: actor.spaceId, attributes: {} },
    resource: { resourceType: input?.resourceType ?? "*", attributes: input?.attributes ?? {} },
    action: input?.action ?? "*",
    environment: {
      ip: input?.clientIp,
      deviceType: input?.deviceType,
      geoCountry: input?.geoRegion,
      timestamp: new Date().toISOString(),
      attributes: {
        riskLevel: input?.riskLevel,
        dataLabels: parseCsvText(input?.dataLabels),
      },
    },
  };
}

export const rbacRoutes: FastifyPluginAsync = async (app) => {
  app.post("/rbac/policy/preflight", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "policy.preflight" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const body = z.object({ rowFilters: z.any().optional(), fieldRules: z.any().optional() }).parse(req.body);
    const rf = normalizeRowFilters(body.rowFilters);
    req.ctx.audit!.outputDigest = { rowFilters: Boolean(rf.normalized), usedPayloadPathCount: rf.usedPayloadPaths.length };
    return { ok: true, rowFilters: rf.normalized, usedPayloadPaths: rf.usedPayloadPaths, policyExprJsonSchema: POLICY_EXPR_JSON_SCHEMA_V1 };
  });

  app.post("/rbac/roles", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "role.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({ id: z.string().min(1).optional(), name: z.string().min(1) }).parse(req.body);
    const id = body.id ?? `role_${crypto.randomUUID()}`;
    await app.db.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [
      id,
      subject.tenantId,
      body.name,
    ]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "role_created" });
    req.ctx.audit!.outputDigest = { roleId: id, policyCacheEpochBumped: true, ...epoch };
    return { role: { id, tenantId: subject.tenantId, name: body.name } };
  });

  app.get("/rbac/roles", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "role.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(500).optional().parse((req.query as any)?.limit) ?? 100;
    const res = await app.db.query("SELECT id, tenant_id, name, created_at FROM roles WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2", [
      subject.tenantId,
      limit,
    ]);
    req.ctx.audit!.outputDigest = { count: res.rows.length };
    return { items: res.rows, roles: res.rows };
  });

  app.get("/rbac/roles/:roleId", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const res = await app.db.query("SELECT id, tenant_id, name, created_at FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [
      subject.tenantId,
      params.roleId,
    ]);
    if (!res.rowCount) throw Errors.badRequest("Role 不存在");
    const permissionsRes = await app.db.query(
      `
        SELECT p.id, p.resource_type, p.action, rp.field_rules_read, rp.field_rules_write, rp.row_filters_read, rp.row_filters_write
        FROM role_permissions rp
        JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1
        ORDER BY p.resource_type ASC, p.action ASC
      `,
      [params.roleId],
    );
    const bindingsRes = await app.db.query(
      `
        SELECT rb.id, rb.subject_id, rb.role_id, r.name AS role_name, rb.scope_type, rb.scope_id, rb.created_at
        FROM role_bindings rb
        JOIN roles r ON r.id = rb.role_id
        JOIN subjects s ON s.id = rb.subject_id
        WHERE rb.role_id = $1
          AND r.tenant_id = $2
          AND s.tenant_id = $2
        ORDER BY rb.created_at DESC
        LIMIT 200
      `,
      [params.roleId, subject.tenantId],
    );
    req.ctx.audit!.outputDigest = { roleId: params.roleId, permissionCount: permissionsRes.rows.length, bindingCount: bindingsRes.rows.length };
    return { role: res.rows[0], permissions: permissionsRes.rows, bindings: bindingsRes.rows };
  });

  app.delete("/rbac/roles/:roleId", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const role = await app.db.query("SELECT id, name, description FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [subject.tenantId, params.roleId]);
    if (!role.rowCount) throw Errors.badRequest("Role 不存在");
    const permCountRes = await app.db.query("SELECT COUNT(*)::int AS cnt FROM role_permissions WHERE role_id = $1", [params.roleId]);
    const bindCountRes = await app.db.query("SELECT COUNT(*)::int AS cnt FROM role_bindings WHERE role_id = $1", [params.roleId]);
    const snapshot = { roleName: role.rows[0].name, description: role.rows[0].description ?? null, permissionCount: permCountRes.rows[0].cnt, bindingCount: bindCountRes.rows[0].cnt };
    // 级联删除: role_permissions → role_bindings → roles
    await app.db.query("DELETE FROM role_permissions WHERE role_id = $1", [params.roleId]);
    await app.db.query("DELETE FROM role_bindings WHERE role_id = $1", [params.roleId]);
    await app.db.query("DELETE FROM roles WHERE tenant_id = $1 AND id = $2", [subject.tenantId, params.roleId]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "role_deleted" });
    req.ctx.audit!.outputDigest = { roleId: params.roleId, policyCacheEpochBumped: true, ...epoch, snapshot };
    return { ok: true };
  });

  app.post("/rbac/permissions", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "permission.register" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const body = z
      .object({
        resourceType: z.string().min(1),
        action: z.string().min(1),
        fieldRulesRead: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        fieldRulesWrite: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        rowFiltersRead: z.any().optional(),
        rowFiltersWrite: z.any().optional(),
      })
      .parse(req.body);
    const res = await app.db.query(
      `
        INSERT INTO permissions (resource_type, action)
        VALUES ($1, $2)
        ON CONFLICT (resource_type, action) DO UPDATE
        SET resource_type = EXCLUDED.resource_type
        RETURNING id
      `,
      [body.resourceType, body.action],
    );
    const actor = req.ctx.subject!;
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: actor.tenantId, scopeType: "tenant", scopeId: actor.tenantId });
    await invalidateRbacCache({ tenantId: actor.tenantId, scope: "tenant", reason: "permission_registered" });
    req.ctx.audit!.outputDigest = { permissionId: res.rows[0].id, policyCacheEpochBumped: true, ...epoch };
    return { permissionId: res.rows[0].id };
  });

  app.get("/rbac/permissions", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "permission.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const limit = z.coerce.number().int().positive().max(500).optional().parse((req.query as any)?.limit) ?? 200;
    const res = await app.db.query(
      "SELECT id, resource_type, action, field_rules_read, field_rules_write, row_filters_read, row_filters_write, created_at FROM permissions ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    req.ctx.audit!.outputDigest = { count: res.rows.length };
    return { items: res.rows, permissions: res.rows };
  });

  app.post("/rbac/roles/:roleId/permissions", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.grant" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z
      .object({
        resourceType: z.string().min(1),
        action: z.string().min(1),
        fieldRulesRead: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        fieldRulesWrite: z
          .object({ allow: z.array(z.string()).optional(), deny: z.array(z.string()).optional() })
          .optional(),
        rowFiltersRead: z.any().optional(),
        rowFiltersWrite: z.any().optional(),
      })
      .parse(req.body);
    const role = await app.db.query("SELECT 1 FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [subject.tenantId, params.roleId]);
    if (!role.rowCount) throw Errors.badRequest("Role 不存在");
    const permRes = await app.db.query(
      `
        INSERT INTO permissions (resource_type, action)
        VALUES ($1, $2)
        ON CONFLICT (resource_type, action) DO UPDATE
        SET resource_type = EXCLUDED.resource_type
        RETURNING id
      `,
      [body.resourceType, body.action],
    );
    await app.db.query(
      `
        INSERT INTO role_permissions (role_id, permission_id, field_rules_read, field_rules_write, row_filters_read, row_filters_write)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (role_id, permission_id) DO UPDATE
        SET field_rules_read = COALESCE(EXCLUDED.field_rules_read, role_permissions.field_rules_read),
            field_rules_write = COALESCE(EXCLUDED.field_rules_write, role_permissions.field_rules_write),
            row_filters_read = COALESCE(EXCLUDED.row_filters_read, role_permissions.row_filters_read),
            row_filters_write = COALESCE(EXCLUDED.row_filters_write, role_permissions.row_filters_write)
      `,
      [
        params.roleId,
        permRes.rows[0].id,
        body.fieldRulesRead ?? null,
        body.fieldRulesWrite ?? null,
        normalizeRowFilters(body.rowFiltersRead).normalized,
        normalizeRowFilters(body.rowFiltersWrite).normalized,
      ],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "permission_granted" });
    req.ctx.audit!.outputDigest = {
      roleId: params.roleId,
      permissionId: permRes.rows[0].id,
      fieldRules: Boolean(body.fieldRulesRead || body.fieldRulesWrite),
      rowFilters: Boolean(body.rowFiltersRead || body.rowFiltersWrite),
      policyCacheEpochBumped: true,
      ...epoch,
    };
    return { ok: true };
  });

  app.delete("/rbac/roles/:roleId/permissions", async (req) => {
    const params = z.object({ roleId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "role.revoke" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({ resourceType: z.string().min(1), action: z.string().min(1) }).parse(req.body);
    const role = await app.db.query("SELECT 1 FROM roles WHERE tenant_id = $1 AND id = $2 LIMIT 1", [subject.tenantId, params.roleId]);
    if (!role.rowCount) throw Errors.badRequest("Role 不存在");
    const perm = await app.db.query("SELECT id, resource_type, action FROM permissions WHERE resource_type = $1 AND action = $2 LIMIT 1", [body.resourceType, body.action]);
    if (!perm.rowCount) return { ok: true };
    const removedPermsRes = await app.db.query(
      "SELECT p.resource_type, p.action FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 AND rp.permission_id = $2",
      [params.roleId, perm.rows[0].id],
    );
    const removedPermissions = removedPermsRes.rows.map((r: any) => ({ resourceType: r.resource_type, action: r.action }));
    await app.db.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2", [params.roleId, perm.rows[0].id]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "permission_revoked" });
    req.ctx.audit!.outputDigest = { roleId: params.roleId, permissionId: perm.rows[0].id, policyCacheEpochBumped: true, ...epoch, snapshot: { removedPermissions } };
    return { ok: true };
  });

  app.post("/rbac/bindings", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "binding.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const actor = req.ctx.subject!;
    const body = z
      .object({
        subjectId: z.string().min(1),
        roleId: z.string().min(1),
        scopeType: z.enum(["tenant", "space"]),
        scopeId: z.string().min(1),
      })
      .parse(req.body);

    const subjectRes = await app.db.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [body.subjectId]);
    if (!subjectRes.rowCount) throw Errors.badRequest("Subject 不存在");
    if (String(subjectRes.rows[0].tenant_id) !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    const roleRes = await app.db.query("SELECT tenant_id FROM roles WHERE id = $1 LIMIT 1", [body.roleId]);
    if (!roleRes.rowCount) throw Errors.badRequest("Role 不存在");
    if (String(roleRes.rows[0].tenant_id) !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }

    if (body.scopeType === "tenant" && body.scopeId !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    if (body.scopeType === "space") {
      const spaceRes = await app.db.query("SELECT tenant_id FROM spaces WHERE id = $1 LIMIT 1", [body.scopeId]);
      if (!spaceRes.rowCount) throw Errors.badRequest("Space 不存在");
      if (String(spaceRes.rows[0].tenant_id) !== actor.tenantId) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden();
      }
    }

    const insert = await app.db.query(
      "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [body.subjectId, body.roleId, body.scopeType, body.scopeId],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: actor.tenantId, scopeType: body.scopeType, scopeId: body.scopeId });
    await invalidateRbacCache({ tenantId: actor.tenantId, subjectId: body.subjectId, scope: "subject", reason: "binding_created" });
    req.ctx.audit!.outputDigest = { bindingId: insert.rows[0].id, subjectId: body.subjectId, roleId: body.roleId, scopeType: body.scopeType, policyCacheEpochBumped: true, ...epoch };
    return { bindingId: insert.rows[0].id };
  });

  app.get("/rbac/bindings", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().positive().max(500).optional(),
        roleId: z.string().min(1).optional(),
        subjectId: z.string().min(1).optional(),
      })
      .parse(req.query);
    setAuditContext(req, { resourceType: "rbac", action: "binding.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const actor = req.ctx.subject!;
    const args: Array<string | number> = [actor.tenantId];
    const where: string[] = ["r.tenant_id = $1", "s.tenant_id = $1"];
    if (q.roleId) {
      args.push(q.roleId);
      where.push(`rb.role_id = $${args.length}`);
    }
    if (q.subjectId) {
      args.push(q.subjectId);
      where.push(`rb.subject_id = $${args.length}`);
    }
    args.push(q.limit ?? 200);
    const res = await app.db.query(
      `
        SELECT rb.id, rb.subject_id, rb.role_id, r.name AS role_name, rb.scope_type, rb.scope_id, rb.created_at
        FROM role_bindings rb
        JOIN roles r ON r.id = rb.role_id
        JOIN subjects s ON s.id = rb.subject_id
        WHERE ${where.join(" AND ")}
        ORDER BY rb.created_at DESC
        LIMIT $${args.length}
      `,
      args,
    );
    req.ctx.audit!.outputDigest = { count: res.rows.length, roleId: q.roleId ?? null, subjectId: q.subjectId ?? null };
    return { items: res.rows, bindings: res.rows };
  });

  app.delete("/rbac/bindings/:bindingId", async (req) => {
    const params = z.object({ bindingId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "binding.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const actor = req.ctx.subject!;

    const existing = await app.db.query(
      `
        SELECT rb.id, rb.subject_id, rb.role_id, rb.scope_type, rb.scope_id, s.tenant_id
        FROM role_bindings rb
        JOIN subjects s ON s.id = rb.subject_id
        WHERE rb.id = $1
        LIMIT 1
      `,
      [params.bindingId],
    );
    if (!existing.rowCount) return { ok: true };
    if (String(existing.rows[0].tenant_id) !== actor.tenantId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden();
    }
    const bindingSnapshot = { subjectId: existing.rows[0].subject_id, roleId: existing.rows[0].role_id, scopeType: existing.rows[0].scope_type, scopeId: existing.rows[0].scope_id };

    await app.db.query("DELETE FROM role_bindings WHERE id = $1", [params.bindingId]);
    const scopeType = String(existing.rows[0].scope_type ?? "");
    const scopeId = String(existing.rows[0].scope_id ?? "");
    const epoch = scopeType === "tenant" || scopeType === "space" ? await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: actor.tenantId, scopeType: scopeType as any, scopeId }) : null;
    await invalidateRbacCache({ tenantId: actor.tenantId, scope: "tenant", reason: "binding_deleted" });
    req.ctx.audit!.outputDigest = { bindingId: params.bindingId, policyCacheEpochBumped: Boolean(epoch), ...(epoch ?? {}), snapshot: bindingSnapshot };
    return { ok: true };
  });

  app.post("/rbac/check", async (req) => {
    const body = z
      .object({
        scopeType: z.enum(["tenant", "space"]).optional(),
        scopeId: z.string().min(1).optional(),
        subjectId: z.string().min(1),
        resourceType: z.string().min(1),
        resourceId: z.string().optional(),
        action: z.string().min(1),
        context: z
          .object({
            clientIp: z.string().optional(),
            geoRegion: z.string().optional(),
            riskLevel: z.string().optional(),
            dataLabels: z.union([z.array(z.string()), z.string()]).optional(),
            deviceType: z.string().optional(),
            attributes: z.record(z.string(), z.any()).optional(),
          })
          .optional(),
      })
      .parse(req.body);
    const actor = req.ctx.subject!;
    setAuditContext(req, { resourceType: "rbac", action: "check" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });

    const scopeType = body.scopeType ?? (body.scopeId ? "space" : actor.spaceId ? "space" : "tenant");
    const scopeId = body.scopeId ?? (scopeType === "tenant" ? actor.tenantId : actor.spaceId);
    if (!scopeId) throw Errors.policyDebugInvalidInput("缺少 scopeId");
    if (scopeType === "tenant" && scopeId !== actor.tenantId) throw Errors.policyDebugInvalidInput("scopeId 必须等于 tenantId");
    if (scopeType === "space") {
      const spaceRes = await app.db.query("SELECT 1 FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [scopeId, actor.tenantId]);
      if (!spaceRes.rowCount) throw Errors.policyDebugInvalidInput("space 不存在或不属于当前 tenant");
    }
    const subjectRes = await app.db.query("SELECT tenant_id FROM subjects WHERE id = $1 LIMIT 1", [body.subjectId]);
    if (!subjectRes.rowCount) throw Errors.policyDebugInvalidInput("subject 不存在");
    if (String(subjectRes.rows[0].tenant_id) !== actor.tenantId) throw Errors.policyDebugInvalidInput("subject 不属于当前 tenant");

    req.ctx.audit!.inputDigest = {
      scopeType,
      scopeId,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      resourceId: body.resourceId ?? null,
      action: body.action,
      hasContext: body.context !== undefined,
    };

    const decision = await authorize({
      pool: app.db,
      tenantId: actor.tenantId,
      spaceId: scopeType === "space" ? scopeId : undefined,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      action: body.action,
      abacRequest: buildAbacCheckRequest(actor, { ...body.context, resourceType: body.resourceType, action: body.action }),
    });
    const snapshotRef = String((decision as any).snapshotRef ?? "");
    const policySnapshotId = snapshotRef.startsWith("policy_snapshot:") ? snapshotRef.slice("policy_snapshot:".length) : null;
    const matchedRules: any = (decision as any).matchedRules ?? null;
    const roleIds = Array.isArray(matchedRules?.roleIds) ? matchedRules.roleIds : [];
    const permissions = Array.isArray(matchedRules?.permissions) ? matchedRules.permissions : [];

    req.ctx.audit!.outputDigest = {
      decision: decision.decision,
      reason: typeof decision.reason === "string" ? decision.reason : null,
      policySnapshotId,
      roleCount: roleIds.length,
      permissionCount: permissions.length,
    };

    return {
      allowed: decision.decision === "allow",
      decision: decision.decision,
      reason: typeof decision.reason === "string" ? decision.reason : null,
      scopeType,
      scopeId,
      subjectId: body.subjectId,
      resourceType: body.resourceType,
      resourceId: body.resourceId ?? null,
      action: body.action,
      policySnapshotId,
      policySnapshotRef: snapshotRef || null,
      matchedRules: permissions,
      matchedRulesSummary: { roleCount: roleIds.length, permissionCount: permissions.length, roleIds },
      rowFiltersEffective: (decision as any).rowFilters ?? null,
      fieldRulesEffective: (decision as any).fieldRules ?? null,
      explainV1: (decision as any).explainV1 ?? null,
      abacResult: (decision as any).abacResult ?? null,
    };
  });

  /* ─── ABAC 策略集 CRUD (新引擎) ─── */

  app.get("/rbac/abac/policy-sets", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "abac.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const limit = z.coerce.number().int().positive().max(500).optional().parse((req.query as any)?.limit) ?? 100;
    const res = await app.db.query(
      `SELECT policy_set_id, tenant_id, name, version, resource_type, combining_algorithm, status, description, metadata, created_at, updated_at
       FROM abac_policy_sets WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [subject.tenantId, limit],
    );
    req.ctx.audit!.outputDigest = { count: res.rows.length };
    return { items: res.rows };
  });

  app.post("/rbac/abac/policy-sets", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "abac.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({
      name: z.string().min(1).max(200),
      resourceType: z.string().min(1),
      combiningAlgorithm: z.enum(["deny_overrides", "permit_overrides", "first_applicable", "deny_unless_permit", "permit_unless_deny"]).optional(),
      description: z.string().max(2000).optional(),
      status: z.enum(["draft", "active", "deprecated"]).optional(),
    }).parse(req.body);

    const res = await app.db.query(
      `INSERT INTO abac_policy_sets (tenant_id, name, resource_type, combining_algorithm, status, description)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, name, version) DO UPDATE
       SET resource_type = EXCLUDED.resource_type, combining_algorithm = EXCLUDED.combining_algorithm, status = EXCLUDED.status, description = EXCLUDED.description, updated_at = now()
       RETURNING policy_set_id`,
      [subject.tenantId, body.name, body.resourceType, body.combiningAlgorithm ?? "deny_overrides", body.status ?? "draft", body.description ?? ""],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "abac_policy_set_created" });
    req.ctx.audit!.outputDigest = { policySetId: res.rows[0].policy_set_id, policyCacheEpochBumped: true, ...epoch };
    return { policySetId: res.rows[0].policy_set_id };
  });

  app.get("/rbac/abac/policy-sets/:policySetId", async (req) => {
    const params = z.object({ policySetId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const psRes = await app.db.query(
      "SELECT * FROM abac_policy_sets WHERE tenant_id = $1 AND policy_set_id = $2 LIMIT 1",
      [subject.tenantId, params.policySetId],
    );
    if (!psRes.rowCount) throw Errors.badRequest("ABAC 策略集不存在");
    const rulesRes = await app.db.query(
      "SELECT * FROM abac_policy_rules WHERE policy_set_id = $1 AND tenant_id = $2 ORDER BY priority ASC",
      [params.policySetId, subject.tenantId],
    );
    req.ctx.audit!.outputDigest = { policySetId: params.policySetId, ruleCount: rulesRes.rows.length };
    return { policySet: psRes.rows[0], rules: rulesRes.rows };
  });

  app.post("/rbac/abac/policy-sets/:policySetId/update", async (req) => {
    const params = z.object({ policySetId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({
      combiningAlgorithm: z.enum(["deny_overrides", "permit_overrides", "first_applicable", "deny_unless_permit", "permit_unless_deny"]).optional(),
      description: z.string().max(2000).optional(),
      status: z.enum(["draft", "active", "deprecated"]).optional(),
    }).parse(req.body);

    const existing = await app.db.query("SELECT combining_algorithm, description, status FROM abac_policy_sets WHERE tenant_id = $1 AND policy_set_id = $2 LIMIT 1", [subject.tenantId, params.policySetId]);
    if (!existing.rowCount) throw Errors.badRequest("ABAC 策略集不存在");
    const before = { combiningAlgorithm: existing.rows[0].combining_algorithm, description: existing.rows[0].description, status: existing.rows[0].status };
    req.ctx.audit!.inputDigest = { policySetId: params.policySetId, before, after: body };

    const sets: string[] = ["updated_at = now()"];
    const args: any[] = [subject.tenantId, params.policySetId];
    let idx = 2;
    if (body.combiningAlgorithm !== undefined) { args.push(body.combiningAlgorithm); sets.push(`combining_algorithm = $${++idx}`); }
    if (body.description !== undefined) { args.push(body.description); sets.push(`description = $${++idx}`); }
    if (body.status !== undefined) { args.push(body.status); sets.push(`status = $${++idx}`); }

    await app.db.query(`UPDATE abac_policy_sets SET ${sets.join(", ")} WHERE tenant_id = $1 AND policy_set_id = $2`, args);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "abac_policy_set_updated" });
    req.ctx.audit!.outputDigest = { policySetId: params.policySetId, policyCacheEpochBumped: true, ...epoch };
    return { ok: true };
  });

  app.delete("/rbac/abac/policy-sets/:policySetId", async (req) => {
    const params = z.object({ policySetId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const psSnap = await app.db.query("SELECT name, combining_algorithm, description, status FROM abac_policy_sets WHERE tenant_id = $1 AND policy_set_id = $2 LIMIT 1", [subject.tenantId, params.policySetId]);
    const ruleCountRes = psSnap.rowCount ? await app.db.query("SELECT COUNT(*)::int AS cnt FROM abac_policy_rules WHERE policy_set_id = $1 AND tenant_id = $2", [params.policySetId, subject.tenantId]) : null;
    const psSnapshot = psSnap.rowCount ? { name: psSnap.rows[0].name, combiningAlgorithm: psSnap.rows[0].combining_algorithm, description: psSnap.rows[0].description, status: psSnap.rows[0].status, ruleCount: ruleCountRes!.rows[0].cnt } : null;
    await app.db.query("DELETE FROM abac_policy_sets WHERE tenant_id = $1 AND policy_set_id = $2", [subject.tenantId, params.policySetId]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "abac_policy_set_deleted" });
    req.ctx.audit!.outputDigest = { policySetId: params.policySetId, policyCacheEpochBumped: true, ...epoch, snapshot: psSnapshot };
    return { ok: true };
  });

  /* ─── ABAC 规则 CRUD ─── */

  app.post("/rbac/abac/policy-sets/:policySetId/rules", async (req) => {
    const params = z.object({ policySetId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.rule.create" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      resourceType: z.string().min(1),
      actions: z.array(z.string().min(1)).min(1),
      priority: z.number().int().min(0).max(10000).optional(),
      effect: z.enum(["allow", "deny"]),
      conditionExpr: z.any(),
      enabled: z.boolean().optional(),
      spaceId: z.string().optional(),
    }).parse(req.body);

    // 验证 conditionExpr 是合法的 PolicyExpr
    const exprValidation = validatePolicyExpr(body.conditionExpr);
    if (!exprValidation.ok) throw Errors.badRequest(`条件表达式无效: ${(exprValidation as any).message}`);

    const psCheck = await app.db.query("SELECT 1 FROM abac_policy_sets WHERE tenant_id = $1 AND policy_set_id = $2 LIMIT 1", [subject.tenantId, params.policySetId]);
    if (!psCheck.rowCount) throw Errors.badRequest("ABAC 策略集不存在");

    const res = await app.db.query(
      `INSERT INTO abac_policy_rules (policy_set_id, tenant_id, name, description, resource_type, actions, priority, effect, condition_expr, enabled, space_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10,$11)
       RETURNING rule_id`,
      [params.policySetId, subject.tenantId, body.name, body.description ?? "", body.resourceType, JSON.stringify(body.actions), body.priority ?? 100, body.effect, JSON.stringify(body.conditionExpr), body.enabled ?? true, body.spaceId ?? null],
    );
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "abac_rule_created" });
    req.ctx.audit!.outputDigest = { ruleId: res.rows[0].rule_id, policyCacheEpochBumped: true, ...epoch };
    return { ruleId: res.rows[0].rule_id };
  });

  app.post("/rbac/abac/rules/:ruleId/update", async (req) => {
    const params = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.rule.update" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      actions: z.array(z.string().min(1)).min(1).optional(),
      priority: z.number().int().min(0).max(10000).optional(),
      effect: z.enum(["allow", "deny"]).optional(),
      conditionExpr: z.any().optional(),
      enabled: z.boolean().optional(),
    }).parse(req.body);

    if (body.conditionExpr !== undefined) {
      const exprValidation = validatePolicyExpr(body.conditionExpr);
      if (!exprValidation.ok) throw Errors.badRequest(`条件表达式无效: ${(exprValidation as any).message}`);
    }

    const existing = await app.db.query("SELECT name, effect, priority, condition_expr FROM abac_policy_rules WHERE tenant_id = $1 AND rule_id = $2 LIMIT 1", [subject.tenantId, params.ruleId]);
    if (!existing.rowCount) throw Errors.badRequest("ABAC 规则不存在");
    req.ctx.audit!.inputDigest = { ruleId: params.ruleId, before: { name: existing.rows[0].name, effect: existing.rows[0].effect, priority: existing.rows[0].priority, conditionExpr: existing.rows[0].condition_expr }, after: body };

    const sets: string[] = ["updated_at = now()"];
    const args: any[] = [subject.tenantId, params.ruleId];
    let idx = 2;
    if (body.name !== undefined) { args.push(body.name); sets.push(`name = $${++idx}`); }
    if (body.description !== undefined) { args.push(body.description); sets.push(`description = $${++idx}`); }
    if (body.actions !== undefined) { args.push(JSON.stringify(body.actions)); sets.push(`actions = $${++idx}::jsonb`); }
    if (body.priority !== undefined) { args.push(body.priority); sets.push(`priority = $${++idx}`); }
    if (body.effect !== undefined) { args.push(body.effect); sets.push(`effect = $${++idx}`); }
    if (body.conditionExpr !== undefined) { args.push(JSON.stringify(body.conditionExpr)); sets.push(`condition_expr = $${++idx}::jsonb`); }
    if (body.enabled !== undefined) { args.push(body.enabled); sets.push(`enabled = $${++idx}`); }

    await app.db.query(`UPDATE abac_policy_rules SET ${sets.join(", ")} WHERE tenant_id = $1 AND rule_id = $2`, args);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "abac_rule_updated" });
    req.ctx.audit!.outputDigest = { ruleId: params.ruleId, policyCacheEpochBumped: true, ...epoch };
    return { ok: true };
  });

  app.delete("/rbac/abac/rules/:ruleId", async (req) => {
    const params = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "rbac", action: "abac.rule.delete" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const ruleSnap = await app.db.query("SELECT name, effect, priority, condition_expr, policy_set_id FROM abac_policy_rules WHERE tenant_id = $1 AND rule_id = $2 LIMIT 1", [subject.tenantId, params.ruleId]);
    const ruleSnapshot = ruleSnap.rowCount ? { name: ruleSnap.rows[0].name, effect: ruleSnap.rows[0].effect, priority: ruleSnap.rows[0].priority, conditionExpr: ruleSnap.rows[0].condition_expr, policySetId: ruleSnap.rows[0].policy_set_id } : null;
    await app.db.query("DELETE FROM abac_policy_rules WHERE tenant_id = $1 AND rule_id = $2", [subject.tenantId, params.ruleId]);
    const epoch = await bumpPolicyCacheEpoch({ pool: app.db as any, tenantId: subject.tenantId, scopeType: "tenant", scopeId: subject.tenantId });
    await invalidateRbacCache({ tenantId: subject.tenantId, scope: "tenant", reason: "abac_rule_deleted" });
    req.ctx.audit!.outputDigest = { ruleId: params.ruleId, policyCacheEpochBumped: true, ...epoch, snapshot: ruleSnapshot };
    return { ok: true };
  });

  /* ─── ABAC 实时评估端点 ─── */

  app.post("/rbac/abac/evaluate", async (req) => {
    setAuditContext(req, { resourceType: "rbac", action: "abac.evaluate" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.RBAC_MANAGE });
    const subject = req.ctx.subject!;
    const body = z.object({
      policySetId: z.string().uuid(),
      request: z.object({
        subject: z.object({
          subjectId: z.string().min(1),
          tenantId: z.string().min(1),
          spaceId: z.string().optional(),
          roles: z.array(z.string()).optional(),
          groups: z.array(z.string()).optional(),
          department: z.string().optional(),
          clearanceLevel: z.number().optional(),
          attributes: z.record(z.string(), z.any()).optional(),
        }),
        resource: z.object({
          resourceType: z.string().min(1),
          resourceId: z.string().optional(),
          ownerSubjectId: z.string().optional(),
          classification: z.string().optional(),
          tags: z.array(z.string()).optional(),
          hierarchy: z.string().optional(),
          attributes: z.record(z.string(), z.any()).optional(),
        }),
        action: z.string().min(1),
        environment: z.object({
          ip: z.string().optional(),
          userAgent: z.string().optional(),
          deviceType: z.string().optional(),
          geoCountry: z.string().optional(),
          geoCity: z.string().optional(),
          timestamp: z.string().optional(),
          attributes: z.record(z.string(), z.any()).optional(),
        }).optional(),
      }),
    }).parse(req.body);

    // 加载策略集 + 规则
    const psRes = await app.db.query("SELECT * FROM abac_policy_sets WHERE tenant_id = $1 AND policy_set_id = $2 LIMIT 1", [subject.tenantId, body.policySetId]);
    if (!psRes.rowCount) throw Errors.badRequest("ABAC 策略集不存在");
    const psRow = psRes.rows[0] as any;

    const rulesRes = await app.db.query(
      "SELECT * FROM abac_policy_rules WHERE policy_set_id = $1 AND tenant_id = $2 AND enabled = true ORDER BY priority ASC",
      [body.policySetId, subject.tenantId],
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
      tenantId: subject.tenantId,
      spaceId: r.space_id ?? undefined,
      metadata: r.metadata ?? {},
    }));

    const policySet: AbacPolicySet = {
      policySetId: psRow.policy_set_id,
      name: psRow.name,
      version: psRow.version,
      rules,
      combiningAlgorithm: psRow.combining_algorithm,
      resourceType: psRow.resource_type,
      status: psRow.status,
    };

    const result = evaluateAbacPolicySet(policySet, body.request);
    req.ctx.audit!.outputDigest = { decision: result.decision, evaluationMs: result.evaluationMs, matchedRuleCount: result.matchedRules.length };
    return result;
  });
};
