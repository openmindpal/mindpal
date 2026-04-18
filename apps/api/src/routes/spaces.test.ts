import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

/* ─── Mock: 权限系统 ─── */
vi.mock("../modules/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ decision: "allow" })),
}));

vi.mock("../modules/audit/context", () => ({
  setAuditContext: vi.fn(),
}));

/* ─── Mock: orgIsolationRuntime ─── */
const mockListSpaceMembers = vi.fn();
const mockAddSpaceMember = vi.fn();
const mockRemoveSpaceMember = vi.fn();
const mockUpdateSpaceMemberRole = vi.fn();
const mockCreateOrgUnit = vi.fn();
const mockListOrgUnits = vi.fn();
const mockUpdateOrgUnit = vi.fn();
const mockDeleteOrgUnit = vi.fn();

vi.mock("../modules/auth/orgIsolationRuntime", () => ({
  listSpaceMembers: (...args: any[]) => mockListSpaceMembers(...args),
  addSpaceMember: (...args: any[]) => mockAddSpaceMember(...args),
  removeSpaceMember: (...args: any[]) => mockRemoveSpaceMember(...args),
  updateSpaceMemberRole: (...args: any[]) => mockUpdateSpaceMemberRole(...args),
  createOrgUnit: (...args: any[]) => mockCreateOrgUnit(...args),
  listOrgUnits: (...args: any[]) => mockListOrgUnits(...args),
  updateOrgUnit: (...args: any[]) => mockUpdateOrgUnit(...args),
  deleteOrgUnit: (...args: any[]) => mockDeleteOrgUnit(...args),
}));

import { spacesRoutes } from "./spaces";
import { isAppError } from "../lib/errors";

/* ─── 测试用 Fastify 实例 ─── */

const TENANT_ID = "tenant_test";
const SUBJECT_ID = "user_alice";

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false }) as any;

  // 简洁错误处理器，将 AppError / ZodError 映射为正确 HTTP 状态码
  app.setErrorHandler(async (err: any, _req: any, reply: any) => {
    if (isAppError(err)) {
      return reply.status(err.httpStatus).send({ errorCode: err.errorCode, message: err.messageI18n });
    }
    if (err?.name === "ZodError" || err?.constructor?.name === "ZodError") {
      return reply.status(400).send({ errorCode: "BAD_REQUEST", message: err.message });
    }
    return reply.status(500).send({ errorCode: "INTERNAL", message: String(err?.message ?? err) });
  });

  // Mock db pool
  app.decorate("db", {
    query: vi.fn(async (sql: string, params?: any[]) => {
      const s = String(sql);
      // GET /spaces → list
      if (s.includes("SELECT * FROM spaces WHERE tenant_id")) {
        return {
          rowCount: 1,
          rows: [{ id: "sp1", name: "测试空间", tenant_id: TENANT_ID, default_locale: "zh-CN", created_at: "2026-01-01T00:00:00Z" }],
        };
      }
      // POST /spaces → insert
      if (s.includes("INSERT INTO spaces")) {
        return {
          rowCount: 1,
          rows: [{ id: params?.[0] ?? "sp_new", name: params?.[2] ?? "新空间", tenant_id: TENANT_ID, default_locale: "zh-CN", created_at: "2026-01-01T00:00:00Z" }],
        };
      }
      // GET /spaces/:spaceId → single
      if (s.includes("SELECT * FROM spaces WHERE id")) {
        return {
          rowCount: 1,
          rows: [{ id: params?.[0], name: "空间详情", tenant_id: TENANT_ID, default_locale: "zh-CN", created_at: "2026-01-01T00:00:00Z" }],
        };
      }
      return { rowCount: 0, rows: [] };
    }),
  });

  // Inject request context
  app.addHook("onRequest", async (req: any) => {
    req.ctx = {
      locale: "zh-CN",
      traceId: "t-test",
      requestId: "r-test",
      subject: { subjectId: SUBJECT_ID, tenantId: TENANT_ID, spaceId: undefined },
      audit: {},
    };
  });

  app.register(spacesRoutes);
  return app;
}

/* ─── 测试套件 ─── */

describe("routes/spaces — 空间管理路由", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  // ──── Space CRUD ────

  describe("GET /spaces", () => {
    it("应返回 spaces 数组", async () => {
      const res = await app.inject({ method: "GET", url: "/spaces" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.spaces)).toBe(true);
      expect(body.spaces.length).toBeGreaterThan(0);
      expect(body.spaces[0]).toHaveProperty("id");
      expect(body.spaces[0]).toHaveProperty("name");
      expect(body.spaces[0]).toHaveProperty("tenantId");
    });
  });

  describe("POST /spaces", () => {
    it("应创建空间并返回 space 对象", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/spaces",
        payload: { name: "新建空间" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.space).toBeDefined();
      expect(body.space.name).toBeDefined();
    });

    it("空 body 时应自动生成 id 和 name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/spaces",
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.space.id).toContain("space_");
    });
  });

  describe("GET /spaces/:spaceId", () => {
    it("应返回单个空间详情", async () => {
      const res = await app.inject({ method: "GET", url: "/spaces/sp1" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.space).toBeDefined();
      expect(body.space.id).toBe("sp1");
    });
  });

  // ──── Space Members ────

  describe("GET /spaces/:spaceId/members", () => {
    it("应返回 members 数组", async () => {
      mockListSpaceMembers.mockResolvedValue([
        { tenantId: TENANT_ID, spaceId: "sp1", subjectId: "user_bob", role: "member", createdAt: "2026-01-01" },
      ]);

      const res = await app.inject({ method: "GET", url: "/spaces/sp1/members" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.members)).toBe(true);
      expect(body.members[0]).toHaveProperty("memberId");
      expect(body.members[0]).toHaveProperty("subjectId");
      expect(body.members[0]).toHaveProperty("role");
    });
  });

  describe("POST /spaces/:spaceId/members", () => {
    it("应添加成员并返回 member 对象", async () => {
      mockAddSpaceMember.mockResolvedValue({
        tenantId: TENANT_ID, spaceId: "sp1", subjectId: "user_carol", role: "member", createdAt: "2026-01-01",
      });

      const res = await app.inject({
        method: "POST",
        url: "/spaces/sp1/members",
        payload: { subjectId: "user_carol", role: "member" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.member).toBeDefined();
      expect(body.member.subjectId).toBe("user_carol");
    });

    it("缺少 subjectId 应返回 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/spaces/sp1/members",
        payload: { role: "member" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PUT /spaces/:spaceId/members/:subjectId", () => {
    it("应更新角色", async () => {
      mockUpdateSpaceMemberRole.mockResolvedValue({
        tenantId: TENANT_ID, spaceId: "sp1", subjectId: "user_bob", role: "admin", createdAt: "2026-01-01",
      });

      const res = await app.inject({
        method: "PUT",
        url: "/spaces/sp1/members/user_bob",
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.member.role).toBe("admin");
    });

    it("成员不存在时应返回 400", async () => {
      mockUpdateSpaceMemberRole.mockResolvedValue(null);

      const res = await app.inject({
        method: "PUT",
        url: "/spaces/sp1/members/user_nobody",
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /spaces/:spaceId/members/:subjectId", () => {
    it("应成功移除成员", async () => {
      mockRemoveSpaceMember.mockResolvedValue(true);

      const res = await app.inject({ method: "DELETE", url: "/spaces/sp1/members/user_bob" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
    });

    it("成员不存在时应返回 400", async () => {
      mockRemoveSpaceMember.mockResolvedValue(false);

      const res = await app.inject({ method: "DELETE", url: "/spaces/sp1/members/user_nobody" });
      expect(res.statusCode).toBe(400);
    });
  });

  // ──── Org Units ────

  describe("GET /org/units", () => {
    it("应返回 units 数组", async () => {
      mockListOrgUnits.mockResolvedValue([
        { orgUnitId: "ou1", tenantId: TENANT_ID, parentId: null, orgName: "研发部", orgPath: "/研发部", depth: 1, createdAt: "2026-01-01" },
      ]);

      const res = await app.inject({ method: "GET", url: "/org/units" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.units)).toBe(true);
      expect(body.units[0]).toHaveProperty("unitId");
      expect(body.units[0]).toHaveProperty("name");
      expect(body.units[0]).toHaveProperty("path");
    });
  });

  describe("POST /org/units", () => {
    it("应创建组织单元", async () => {
      mockCreateOrgUnit.mockResolvedValue({
        orgUnitId: "ou_new", tenantId: TENANT_ID, parentId: null, orgName: "市场部", orgPath: "/市场部", depth: 1, createdAt: "2026-01-01",
      });

      const res = await app.inject({
        method: "POST",
        url: "/org/units",
        payload: { name: "市场部" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.unit).toBeDefined();
      expect(body.unit.name).toBe("市场部");
    });

    it("缺少 name 应返回 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/org/units",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PUT /org/units/:orgUnitId", () => {
    it("应更新组织单元名称", async () => {
      mockUpdateOrgUnit.mockResolvedValue({
        orgUnitId: "ou1", tenantId: TENANT_ID, parentId: null, orgName: "研发中心", orgPath: "/研发中心", depth: 1, createdAt: "2026-01-01",
      });

      const res = await app.inject({
        method: "PUT",
        url: "/org/units/ou1",
        payload: { name: "研发中心" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.unit.name).toBe("研发中心");
    });

    it("组织单元不存在时应返回 400", async () => {
      mockUpdateOrgUnit.mockResolvedValue(null);

      const res = await app.inject({
        method: "PUT",
        url: "/org/units/ou_nonexist",
        payload: { name: "不存在" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /org/units/:orgUnitId", () => {
    it("应成功删除组织单元", async () => {
      mockDeleteOrgUnit.mockResolvedValue(true);

      const res = await app.inject({ method: "DELETE", url: "/org/units/ou1" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
    });

    it("组织单元不存在时应返回 400", async () => {
      mockDeleteOrgUnit.mockResolvedValue(false);

      const res = await app.inject({ method: "DELETE", url: "/org/units/ou_nonexist" });
      expect(res.statusCode).toBe(400);
    });

    it("存在子单元时应返回 400", async () => {
      mockDeleteOrgUnit.mockRejectedValue(new Error("Cannot delete org unit with children"));

      const res = await app.inject({ method: "DELETE", url: "/org/units/ou_parent" });
      expect(res.statusCode).toBe(400);
    });
  });

  // ──── 字段映射验证 ────

  describe("响应字段映射一致性", () => {
    it("Space DTO 应包含 id, name, tenantId, createdAt", async () => {
      const res = await app.inject({ method: "GET", url: "/spaces" });
      const space = JSON.parse(res.body).spaces[0];
      expect(space).toHaveProperty("id");
      expect(space).toHaveProperty("name");
      expect(space).toHaveProperty("tenantId");
      expect(space).toHaveProperty("createdAt");
    });

    it("Member DTO memberId 应等于 subjectId", async () => {
      mockListSpaceMembers.mockResolvedValue([
        { tenantId: TENANT_ID, spaceId: "sp1", subjectId: "user_xyz", role: "admin", createdAt: "2026-01-01" },
      ]);
      const res = await app.inject({ method: "GET", url: "/spaces/sp1/members" });
      const member = JSON.parse(res.body).members[0];
      expect(member.memberId).toBe("user_xyz");
      expect(member.memberId).toBe(member.subjectId);
    });

    it("OrgUnit DTO 应将 orgUnitId 映射为 unitId, orgName 映射为 name", async () => {
      mockListOrgUnits.mockResolvedValue([
        { orgUnitId: "ou99", tenantId: TENANT_ID, parentId: "ou1", orgName: "子部门", orgPath: "/研发部/子部门", depth: 2, createdAt: "2026-01-01" },
      ]);
      const res = await app.inject({ method: "GET", url: "/org/units" });
      const unit = JSON.parse(res.body).units[0];
      expect(unit.unitId).toBe("ou99");
      expect(unit.name).toBe("子部门");
      expect(unit.parentUnitId).toBe("ou1");
      expect(unit.path).toBe("/研发部/子部门");
      expect(unit.depth).toBe(2);
    });
  });
});
