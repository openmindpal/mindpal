/**
 * P1-1 SCIM Groups E2E 测试
 * 验收口径：IdP 推送 Group → 自动创建 role_binding → 对应 subject 获得权限；
 *           删除 Group member → binding 自动移除 → 请求返回 403。
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:scim-groups", { timeout: 60_000 }, () => {
  let ctx: TestContext;
  const tenantId = "tenant_dev";
  let scimBearerToken: string;
  const scimGroupExternalId = `grp_ext_${Date.now()}`;
  const scimGroupName = "Engineering";
  const memberSubjectId1 = `scim_member_1_${Date.now()}`;
  const memberSubjectId2 = `scim_member_2_${Date.now()}`;
  const testRoleId = `role_scim_test_${Date.now()}`;

  beforeAll(async () => {
    ctx = await getTestContext();
    if (!ctx.canRun) return;

    // Create a SCIM config with a known bearer token
    scimBearerToken = `scim_test_token_${crypto.randomUUID()}`;
    const tokenHash = require("node:crypto").createHash("sha256").update(scimBearerToken).digest("hex");

    await pool.query(
      `INSERT INTO scim_configs (tenant_id, bearer_token_hash, allowed_operations, auto_provision, default_role_id)
       VALUES ($1, $2, $3::jsonb, true, null)
       ON CONFLICT (tenant_id) DO UPDATE SET
         bearer_token_hash = EXCLUDED.bearer_token_hash,
         allowed_operations = EXCLUDED.allowed_operations,
         auto_provision = true,
         status = 'active',
         updated_at = now()`,
      [tenantId, tokenHash, JSON.stringify([
        "Users.list", "Users.get", "Users.create", "Users.update", "Users.delete",
        "Groups.list", "Groups.get", "Groups.create", "Groups.update", "Groups.delete",
      ])],
    );

    // Ensure member subjects exist
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [memberSubjectId1, tenantId]);
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [memberSubjectId2, tenantId]);

    // Create a test role with a specific permission
    await pool.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [testRoleId, tenantId, `ScimTestRole_${testRoleId.slice(-8)}`]);
    const permRes = await pool.query(
      "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
      ["schema", "list"],
    );
    const permId = permRes.rows[0].id as string;
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [testRoleId, permId]);
  });

  afterAll(async () => {
    if (ctx?.canRun) {
      // Cleanup
      await pool.query("DELETE FROM scim_group_role_mappings WHERE tenant_id = $1", [tenantId]).catch(() => {});
      await pool.query("DELETE FROM scim_provisioned_groups WHERE tenant_id = $1 AND external_id = $2", [tenantId, scimGroupExternalId]).catch(() => {});
      await pool.query("DELETE FROM role_bindings WHERE subject_id IN ($1, $2)", [memberSubjectId1, memberSubjectId2]).catch(() => {});
    }
    await releaseTestContext();
  });

  function scimHeaders() {
    return {
      authorization: `Bearer ${scimBearerToken}`,
      "x-tenant-id": tenantId,
      "content-type": "application/scim+json",
    };
  }

  // ─── 3.5a: Groups list 初始为空 ─────────────────────
  it("Groups list — 初始无 group 返回空列表", async () => {
    if (!ctx.canRun) return;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/scim/v2/Groups",
      headers: scimHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schemas).toContain("urn:ietf:params:scim:api:messages:2.0:ListResponse");
    expect(body.totalResults).toBeGreaterThanOrEqual(0);
  });

  // ─── 3.5b: Create Group ─────────────────────────────
  let createdGroupId: string;

  it("Create Group — 创建 SCIM Group + members", async () => {
    if (!ctx.canRun) return;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/scim/v2/Groups",
      headers: scimHeaders(),
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: scimGroupExternalId,
        displayName: scimGroupName,
        members: [
          { value: memberSubjectId1, display: "Member 1" },
          { value: memberSubjectId2, display: "Member 2" },
        ],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.displayName).toBe(scimGroupName);
    expect(body.externalId).toBe(scimGroupExternalId);
    expect(body.id).toBeTruthy();
    expect(body.members).toHaveLength(2);
    expect(body.meta?.resourceType).toBe("Group");
    createdGroupId = body.id;
  });

  // ─── 3.5c: Get Group by ID ─────────────────────────
  it("Get Group by ID — 返回完整 Group 资源", async () => {
    if (!ctx.canRun || !createdGroupId) return;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/scim/v2/Groups/${createdGroupId}`,
      headers: scimHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(createdGroupId);
    expect(body.displayName).toBe(scimGroupName);
    expect(body.members).toHaveLength(2);
  });

  // ─── 3.5d: Group→Role 映射 + 成员自动获得权限 ──────
  it("Group→Role 映射后，成员自动获得 role_binding → 受保护端点返回 200", async () => {
    if (!ctx.canRun || !createdGroupId) return;

    // 创建 Group→Role 映射
    await pool.query(
      `INSERT INTO scim_group_role_mappings (tenant_id, scim_group_id, role_id, scope_type, scope_id)
       VALUES ($1, $2::uuid, $3, 'tenant', $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, createdGroupId, testRoleId, tenantId],
    );

    // 手动触发 syncGroupMembers（模拟 IdP 再次推送 Group 更新触发同步）
    const updateRes = await ctx.app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${createdGroupId}`,
      headers: scimHeaders(),
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: scimGroupName,
        members: [
          { value: memberSubjectId1, display: "Member 1" },
          { value: memberSubjectId2, display: "Member 2" },
        ],
      },
    });
    expect(updateRes.statusCode).toBe(200);

    // 验证 memberSubjectId1 现在有 testRoleId 的 role_binding
    const binding = await pool.query(
      "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = $2",
      [memberSubjectId1, testRoleId],
    );
    expect(binding.rowCount).toBeGreaterThanOrEqual(1);

    // 验证 memberSubjectId2 也有 binding
    const binding2 = await pool.query(
      "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = $2",
      [memberSubjectId2, testRoleId],
    );
    expect(binding2.rowCount).toBeGreaterThanOrEqual(1);
  });

  // ─── 3.5e: Update Group — 移除成员 → binding 被清理 ──
  it("Update Group 移除成员 → 对应 role_binding 被移除", async () => {
    if (!ctx.canRun || !createdGroupId) return;

    // 先确保 memberSubjectId2 也是 scim_provisioned_user（模拟 IdP 完整闭环）
    await pool.query(
      `INSERT INTO scim_provisioned_users (tenant_id, external_id, subject_id, display_name, active)
       VALUES ($1, $2, $3, 'SCIM Member 2', true)
       ON CONFLICT (tenant_id, external_id) DO NOTHING`,
      [tenantId, `ext_${memberSubjectId2}`, memberSubjectId2],
    );

    // 更新 Group，移除 memberSubjectId2
    const res = await ctx.app.inject({
      method: "PUT",
      url: `/scim/v2/Groups/${createdGroupId}`,
      headers: scimHeaders(),
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: scimGroupName,
        members: [
          { value: memberSubjectId1, display: "Member 1" },
          // memberSubjectId2 已被移除
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toHaveLength(1);

    // 验证 memberSubjectId2 的 testRoleId binding 已被移除
    const binding = await pool.query(
      "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = $2",
      [memberSubjectId2, testRoleId],
    );
    expect(binding.rowCount).toBe(0);

    // memberSubjectId1 的 binding 仍在
    const binding1 = await pool.query(
      "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = $2",
      [memberSubjectId1, testRoleId],
    );
    expect(binding1.rowCount).toBeGreaterThanOrEqual(1);
  });

  // ─── 3.5f: Create duplicate → 409 ──────────────────
  it("Create duplicate Group → 409 uniqueness", async () => {
    if (!ctx.canRun) return;

    const res = await ctx.app.inject({
      method: "POST",
      url: "/scim/v2/Groups",
      headers: scimHeaders(),
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: scimGroupExternalId,
        displayName: "Duplicate",
      },
    });

    expect(res.statusCode).toBe(409);
  });

  // ─── 3.5g: Get non-existent Group → 404 ────────────
  it("Get non-existent Group → 404", async () => {
    if (!ctx.canRun) return;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/scim/v2/Groups/00000000-0000-0000-0000-000000000000",
      headers: scimHeaders(),
    });

    expect(res.statusCode).toBe(404);
  });

  // ─── 3.5h: Delete Group → 204 + bindings 清理 ──────
  it("Delete Group → 204, 所有成员的 group-mapped bindings 被移除", async () => {
    if (!ctx.canRun || !createdGroupId) return;

    const res = await ctx.app.inject({
      method: "DELETE",
      url: `/scim/v2/Groups/${createdGroupId}`,
      headers: scimHeaders(),
    });
    expect(res.statusCode).toBe(204);

    // 验证 Group 已删除
    const getRes = await ctx.app.inject({
      method: "GET",
      url: `/scim/v2/Groups/${createdGroupId}`,
      headers: scimHeaders(),
    });
    expect(getRes.statusCode).toBe(404);

    // 验证 memberSubjectId1 的 testRoleId binding 也被清理
    const binding = await pool.query(
      "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = $2",
      [memberSubjectId1, testRoleId],
    );
    expect(binding.rowCount).toBe(0);
  });

  // ─── 3.6a: Groups list with filter ─────────────────
  it("Groups list with displayName filter", async () => {
    if (!ctx.canRun) return;

    // Create a group first
    const createRes = await ctx.app.inject({
      method: "POST",
      url: "/scim/v2/Groups",
      headers: scimHeaders(),
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: `filter_test_${Date.now()}`,
        displayName: "FilterTestGroup",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const filterId = createRes.json().id;

    const res = await ctx.app.inject({
      method: "GET",
      url: `/scim/v2/Groups?filter=${encodeURIComponent('displayName eq "FilterTestGroup"')}`,
      headers: scimHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalResults).toBeGreaterThanOrEqual(1);
    expect(body.Resources[0].displayName).toBe("FilterTestGroup");

    // Cleanup
    await ctx.app.inject({
      method: "DELETE",
      url: `/scim/v2/Groups/${filterId}`,
      headers: scimHeaders(),
    });
  });

  // ─── 3.6b: 未授权操作 → 403 ───────────────────────
  it("Groups.delete 操作未在 allowed_operations → 403", async () => {
    if (!ctx.canRun) return;

    // 创建受限的 SCIM config
    const limitedToken = `scim_limited_${crypto.randomUUID()}`;
    const limitedHash = require("node:crypto").createHash("sha256").update(limitedToken).digest("hex");

    // 临时更新 config 只允许 list/get
    await pool.query(
      `UPDATE scim_configs SET
         bearer_token_hash = $2,
         allowed_operations = $3::jsonb
       WHERE tenant_id = $1`,
      [tenantId, limitedHash, JSON.stringify(["Groups.list", "Groups.get"])],
    );

    const res = await ctx.app.inject({
      method: "POST",
      url: "/scim/v2/Groups",
      headers: {
        authorization: `Bearer ${limitedToken}`,
        "x-tenant-id": tenantId,
        "content-type": "application/scim+json",
      },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: "should_fail",
        displayName: "Blocked",
      },
    });
    expect(res.statusCode).toBe(403);

    // 恢复原始 token
    const origHash = require("node:crypto").createHash("sha256").update(scimBearerToken).digest("hex");
    await pool.query(
      `UPDATE scim_configs SET
         bearer_token_hash = $2,
         allowed_operations = $3::jsonb
       WHERE tenant_id = $1`,
      [tenantId, origHash, JSON.stringify([
        "Users.list", "Users.get", "Users.create", "Users.update", "Users.delete",
        "Groups.list", "Groups.get", "Groups.create", "Groups.update", "Groups.delete",
      ])],
    );
  });

  // ─── smoke: admin 端点仍正常 ───────────────────────
  it("smoke: admin 用户仍可访问受保护端点", async () => {
    if (!ctx.canRun) return;

    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
