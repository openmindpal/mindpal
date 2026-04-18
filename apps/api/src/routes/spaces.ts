/**
 * 空间与组织管理路由 — 暴露 orgIsolationRuntime 仓储层为 HTTP API。
 *
 * 端点清单：
 *   GET    /spaces                              — 列出当前租户所有空间
 *   POST   /spaces                              — 创建空间
 *   GET    /spaces/:spaceId                     — 获取单个空间详情
 *   DELETE /spaces/:spaceId                    — 删除空间
 *   GET    /spaces/:spaceId/members             — 列出空间成员
 *   POST   /spaces/:spaceId/members             — 添加空间成员
 *   PUT    /spaces/:spaceId/members/:subjectId  — 更新成员角色
 *   DELETE /spaces/:spaceId/members/:subjectId  — 移除空间成员
 *   GET    /org/units                           — 列出组织单元
 *   POST   /org/units                           — 创建组织单元
 *   PUT    /org/units/:orgUnitId                — 更新组织单元
 *   DELETE /org/units/:orgUnitId                — 删除组织单元
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import {
  addSpaceMember,
  removeSpaceMember,
  listSpaceMembers,
  updateSpaceMemberRole,
  createOrgUnit,
  listOrgUnits,
  updateOrgUnit,
  deleteOrgUnit,
} from "../modules/auth/orgIsolationRuntime";

/* ─── 内部辅助 ─── */

/** 将 DB 行映射为前端期望的 Space 对象 */
function toSpaceDto(r: any) {
  return {
    id: String(r.id),
    name: r.name ? String(r.name) : null,
    tenantId: String(r.tenant_id),
    defaultLocale: r.default_locale ? String(r.default_locale) : "zh-CN",
    createdAt: String(r.created_at),
  };
}

/** 将 SpaceMember 映射为前端期望格式 (memberId = subjectId，DELETE 路由以此为标识) */
function toMemberDto(m: any) {
  return {
    memberId: String(m.subjectId),
    spaceId: String(m.spaceId),
    subjectId: String(m.subjectId),
    role: String(m.role),
    createdAt: String(m.createdAt),
  };
}

/** 将 OrgUnit 映射为前端期望格式 (unitId = orgUnitId) */
function toOrgUnitDto(u: any) {
  return {
    unitId: String(u.orgUnitId),
    tenantId: String(u.tenantId),
    name: String(u.orgName),
    parentUnitId: u.parentId ? String(u.parentId) : null,
    path: String(u.orgPath),
    depth: Number(u.depth ?? 0),
    createdAt: String(u.createdAt),
  };
}

/* ─── 路由定义 ─── */

export const spacesRoutes: FastifyPluginAsync = async (app) => {
  // ────────────────────────────────────────────────────────────────────
  // Space CRUD
  // ────────────────────────────────────────────────────────────────────

  /** GET /spaces — 列出当前租户所有空间 */
  app.get("/spaces", async (req) => {
    setAuditContext(req, { resourceType: "space", action: "list" });
    await requirePermission({ req, resourceType: "space", action: "list" });
    const subject = req.ctx.subject!;

    const res = await app.db.query(
      "SELECT * FROM spaces WHERE tenant_id = $1 ORDER BY created_at DESC",
      [subject.tenantId],
    );

    const spaces = res.rows.map(toSpaceDto);
    req.ctx.audit!.outputDigest = { count: spaces.length };
    return { spaces };
  });

  /** POST /spaces — 创建空间 */
  app.post("/spaces", async (req) => {
    setAuditContext(req, { resourceType: "space", action: "create" });
    await requirePermission({ req, resourceType: "space", action: "create" });
    const subject = req.ctx.subject!;

    const body = z
      .object({
        id: z.string().min(1).max(128).optional(),
        name: z.string().min(1).max(200).optional(),
      })
      .parse(req.body ?? {});

    const spaceId = body.id || `space_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const spaceName = body.name || spaceId;

    const insertRes = await app.db.query(
      `INSERT INTO spaces (id, tenant_id, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING *`,
      [spaceId, subject.tenantId, spaceName],
    );

    if (!insertRes.rowCount) {
      throw Errors.badRequest("空间已存在");
    }

    const space = toSpaceDto(insertRes.rows[0]);
    req.ctx.audit!.outputDigest = { spaceId: space.id };
    return { space };
  });

  /** GET /spaces/:spaceId — 获取单个空间 */
  app.get("/spaces/:spaceId", async (req) => {
    const params = z.object({ spaceId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "space", action: "get" });
    await requirePermission({ req, resourceType: "space", action: "get" });
    const subject = req.ctx.subject!;

    const res = await app.db.query(
      "SELECT * FROM spaces WHERE id = $1 AND tenant_id = $2",
      [params.spaceId, subject.tenantId],
    );
    if (!res.rowCount) throw Errors.badRequest("空间不存在");

    const space = toSpaceDto(res.rows[0]);
    req.ctx.audit!.outputDigest = { spaceId: space.id };
    return { space };
  });

  /** DELETE /spaces/:spaceId — 删除空间 */
  app.delete("/spaces/:spaceId", async (req) => {
    const params = z.object({ spaceId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "space", action: "delete" });
    await requirePermission({ req, resourceType: "space", action: "delete" });
    const subject = req.ctx.subject!;

    // 先检查空间是否存在
    const check = await app.db.query(
      "SELECT id FROM spaces WHERE id = $1 AND tenant_id = $2",
      [params.spaceId, subject.tenantId],
    );
    if (!check.rowCount) throw Errors.badRequest("空间不存在");

    // 删除空间成员
    await app.db.query(
      "DELETE FROM space_members WHERE tenant_id = $1 AND space_id = $2",
      [subject.tenantId, params.spaceId],
    );

    // 删除空间
    await app.db.query(
      "DELETE FROM spaces WHERE id = $1 AND tenant_id = $2",
      [params.spaceId, subject.tenantId],
    );

    req.ctx.audit!.outputDigest = { spaceId: params.spaceId, removed: true };
    return { ok: true };
  });

  // ────────────────────────────────────────────────────────────────────
  // Space Members
  // ────────────────────────────────────────────────────────────────────

  /** GET /spaces/:spaceId/members — 列出空间成员 */
  app.get("/spaces/:spaceId/members", async (req) => {
    const params = z.object({ spaceId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "space_member", action: "list" });
    await requirePermission({ req, resourceType: "space_member", action: "list" });
    const subject = req.ctx.subject!;

    const rawMembers = await listSpaceMembers({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: params.spaceId,
    });

    const members = rawMembers.map(toMemberDto);
    req.ctx.audit!.outputDigest = { spaceId: params.spaceId, count: members.length };
    return { members };
  });

  /** POST /spaces/:spaceId/members — 添加空间成员 */
  app.post("/spaces/:spaceId/members", async (req) => {
    const params = z.object({ spaceId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "space_member", action: "create" });
    await requirePermission({ req, resourceType: "space_member", action: "create" });
    const subject = req.ctx.subject!;

    const body = z
      .object({
        subjectId: z.string().min(1),
        role: z.enum(["owner", "admin", "member", "viewer"]).optional(),
      })
      .parse(req.body);

    const result = await addSpaceMember({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: params.spaceId,
      subjectId: body.subjectId,
      role: body.role,
    });

    const member = toMemberDto(result);
    req.ctx.audit!.outputDigest = { spaceId: params.spaceId, subjectId: body.subjectId, role: member.role };
    return { member };
  });

  /** PUT /spaces/:spaceId/members/:subjectId — 更新成员角色 */
  app.put("/spaces/:spaceId/members/:subjectId", async (req) => {
    const params = z.object({ spaceId: z.string().min(1), subjectId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "space_member", action: "update" });
    await requirePermission({ req, resourceType: "space_member", action: "update" });
    const subject = req.ctx.subject!;

    const body = z
      .object({
        role: z.enum(["owner", "admin", "member", "viewer"]),
      })
      .parse(req.body);

    const result = await updateSpaceMemberRole({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
      role: body.role,
    });
    if (!result) throw Errors.badRequest("成员不存在");

    const member = toMemberDto(result);
    req.ctx.audit!.outputDigest = { spaceId: params.spaceId, subjectId: params.subjectId, role: member.role };
    return { member };
  });

  /** DELETE /spaces/:spaceId/members/:subjectId — 移除空间成员 */
  app.delete("/spaces/:spaceId/members/:subjectId", async (req) => {
    const params = z.object({ spaceId: z.string().min(1), subjectId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "space_member", action: "delete" });
    await requirePermission({ req, resourceType: "space_member", action: "delete" });
    const subject = req.ctx.subject!;

    const removed = await removeSpaceMember({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: params.spaceId,
      subjectId: params.subjectId,
    });
    if (!removed) throw Errors.badRequest("成员不存在");

    req.ctx.audit!.outputDigest = { spaceId: params.spaceId, subjectId: params.subjectId, removed: true };
    return { ok: true };
  });

  // ────────────────────────────────────────────────────────────────────
  // Organization Units
  // ────────────────────────────────────────────────────────────────────

  /** GET /org/units — 列出组织单元 */
  app.get("/org/units", async (req) => {
    setAuditContext(req, { resourceType: "org_unit", action: "list" });
    await requirePermission({ req, resourceType: "org_unit", action: "list" });
    const subject = req.ctx.subject!;

    const query = z
      .object({
        parentId: z.string().optional(),
        includeDescendants: z.enum(["true", "false"]).optional(),
      })
      .parse(req.query ?? {});

    const rawUnits = await listOrgUnits({
      pool: app.db,
      tenantId: subject.tenantId,
      parentId: query.parentId ?? undefined,
      includeDescendants: query.includeDescendants === "true",
    });

    const units = rawUnits.map(toOrgUnitDto);
    req.ctx.audit!.outputDigest = { count: units.length };
    return { units };
  });

  /** POST /org/units — 创建组织单元 */
  app.post("/org/units", async (req) => {
    setAuditContext(req, { resourceType: "org_unit", action: "create" });
    await requirePermission({ req, resourceType: "org_unit", action: "create" });
    const subject = req.ctx.subject!;

    const body = z
      .object({
        name: z.string().min(1).max(200),
        parentUnitId: z.string().optional(),
      })
      .parse(req.body);

    const result = await createOrgUnit({
      pool: app.db,
      tenantId: subject.tenantId,
      orgName: body.name,
      parentId: body.parentUnitId ?? null,
    });

    const unit = toOrgUnitDto(result);
    req.ctx.audit!.outputDigest = { unitId: unit.unitId, name: unit.name };
    return { unit };
  });

  /** PUT /org/units/:orgUnitId — 更新组织单元 */
  app.put("/org/units/:orgUnitId", async (req) => {
    const params = z.object({ orgUnitId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "org_unit", action: "update" });
    await requirePermission({ req, resourceType: "org_unit", action: "update" });
    const subject = req.ctx.subject!;

    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
      })
      .parse(req.body ?? {});

    const result = await updateOrgUnit({
      pool: app.db,
      tenantId: subject.tenantId,
      orgUnitId: params.orgUnitId,
      orgName: body.name,
    });
    if (!result) throw Errors.badRequest("组织单元不存在");

    const unit = toOrgUnitDto(result);
    req.ctx.audit!.outputDigest = { unitId: unit.unitId, name: unit.name };
    return { unit };
  });

  /** DELETE /org/units/:orgUnitId — 删除组织单元 */
  app.delete("/org/units/:orgUnitId", async (req) => {
    const params = z.object({ orgUnitId: z.string().min(1) }).parse(req.params);
    setAuditContext(req, { resourceType: "org_unit", action: "delete" });
    await requirePermission({ req, resourceType: "org_unit", action: "delete" });
    const subject = req.ctx.subject!;

    try {
      const removed = await deleteOrgUnit({
        pool: app.db,
        tenantId: subject.tenantId,
        orgUnitId: params.orgUnitId,
      });
      if (!removed) throw Errors.badRequest("组织单元不存在");
    } catch (e: any) {
      if (e?.message?.includes("children")) {
        throw Errors.badRequest("无法删除：该组织单元下存在子单元");
      }
      throw e;
    }

    req.ctx.audit!.outputDigest = { orgUnitId: params.orgUnitId, removed: true };
    return { ok: true };
  });
};
