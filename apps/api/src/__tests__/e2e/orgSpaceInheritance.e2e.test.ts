/**
 * P1-3 Org-level Space Inheritance E2E 测试
 * 验收口径：
 *   - subject 属于 org A → org A 配置了对 space X 的 member 继承 → getEffectiveSpaceRole 返回 member
 *   - 直接成员优先级 > org 继承
 *   - 多层 org 继承 + include_descendants
 *   - org 解绑后权限回收
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:org-space-inheritance", { timeout: 60_000 }, () => {
  let ctx: TestContext;
  const tenantId = "tenant_dev";
  const testSpaceId = `space_org_test_${Date.now()}`;
  const orgSubjectId = `org_user_${Date.now()}`;
  const directSubjectId = `direct_user_${Date.now()}`;
  let rootOrgId: string;
  let childOrgId: string;

  beforeAll(async () => {
    ctx = await getTestContext();
    if (!ctx.canRun) return;

    // Create test space
    await pool.query(
      "INSERT INTO spaces (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [testSpaceId, tenantId],
    );

    // Create test subjects
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [orgSubjectId, tenantId]);
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [directSubjectId, tenantId]);

    // Create org hierarchy: root_org → child_org
    const orgTs = Date.now();
    const rootPath = `/TestRootOrg_${orgTs}`;
    const rootRes = await pool.query(
      `INSERT INTO org_units (tenant_id, org_name, org_path, depth)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (tenant_id, org_path) DO UPDATE SET org_name = EXCLUDED.org_name
       RETURNING org_unit_id`,
      [tenantId, "TestRootOrg", rootPath],
    );
    rootOrgId = String(rootRes.rows[0].org_unit_id);

    const childRes = await pool.query(
      `INSERT INTO org_units (tenant_id, parent_id, org_name, org_path, depth)
       VALUES ($1, $2, $3, $4, 2)
       ON CONFLICT (tenant_id, org_path) DO UPDATE SET org_name = EXCLUDED.org_name
       RETURNING org_unit_id`,
      [tenantId, rootOrgId, "TestChildOrg", `${rootPath}/TestChildOrg`],
    );
    childOrgId = String(childRes.rows[0].org_unit_id);

    // Assign orgSubjectId to childOrg
    await pool.query(
      `INSERT INTO subject_org_assignments (tenant_id, subject_id, org_unit_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, orgSubjectId, childOrgId],
    );
  });

  afterAll(async () => {
    if (ctx?.canRun) {
      await pool.query("DELETE FROM org_space_access_policies WHERE tenant_id = $1 AND space_id = $2", [tenantId, testSpaceId]).catch(() => {});
      await pool.query("DELETE FROM space_members WHERE tenant_id = $1 AND space_id = $2", [tenantId, testSpaceId]).catch(() => {});
      await pool.query("DELETE FROM subject_org_assignments WHERE tenant_id = $1 AND subject_id IN ($2, $3)", [tenantId, orgSubjectId, directSubjectId]).catch(() => {});
      await pool.query("DELETE FROM org_units WHERE org_unit_id IN ($1, $2)", [childOrgId, rootOrgId]).catch(() => {});
      await pool.query("DELETE FROM spaces WHERE id = $1", [testSpaceId]).catch(() => {});
    }
    await releaseTestContext();
  });

  // ─── 5.4a: 无 org policy → getEffectiveSpaceRole 返回 null ──
  it("无 org-space policy → getEffectiveSpaceRole 返回 null", async () => {
    if (!ctx.canRun) return;

    const { getEffectiveSpaceRole } = await import("../../modules/auth/orgIsolationRuntime");
    const role = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId,
    });
    expect(role).toBeNull();
  });

  // ─── 5.4b: rootOrg 配置 space policy + include_descendants → child 成员继承 ──
  it("rootOrg 配置 space access policy + include_descendants → childOrg 成员继承 member 角色", async () => {
    if (!ctx.canRun) return;

    // 为 rootOrg 配置对 testSpace 的 member 继承
    await pool.query(
      `INSERT INTO org_space_access_policies (tenant_id, org_unit_id, space_id, inherited_role, include_descendants)
       VALUES ($1, $2, $3, 'member', true)
       ON CONFLICT (tenant_id, org_unit_id, space_id) DO UPDATE SET inherited_role = 'member', include_descendants = true`,
      [tenantId, rootOrgId, testSpaceId],
    );

    const { getEffectiveSpaceRole } = await import("../../modules/auth/orgIsolationRuntime");
    const role = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId, // 属于 childOrg（rootOrg 的后代）
    });
    expect(role).toBe("member");
  });

  // ─── 5.5a: 直接成员优先级 > org 继承 ────────────────
  it("直接成员 admin > org 继承 member", async () => {
    if (!ctx.canRun) return;

    // 先添加 orgSubjectId 为 space 的直接 admin 成员
    await pool.query(
      `INSERT INTO space_members (tenant_id, space_id, subject_id, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (tenant_id, space_id, subject_id) DO UPDATE SET role = 'admin'`,
      [tenantId, testSpaceId, orgSubjectId],
    );

    const { getEffectiveSpaceRole } = await import("../../modules/auth/orgIsolationRuntime");
    const role = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId,
    });
    // 直接成员 admin 优先
    expect(role).toBe("admin");

    // 清理直接成员，恢复继承
    await pool.query("DELETE FROM space_members WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3", [tenantId, testSpaceId, orgSubjectId]);
  });

  // ─── 5.5b: include_descendants = false → child 不继承 ──
  it("include_descendants = false → childOrg 成员不继承", async () => {
    if (!ctx.canRun) return;

    // 修改 policy 为 include_descendants = false
    await pool.query(
      `UPDATE org_space_access_policies SET include_descendants = false
       WHERE tenant_id = $1 AND org_unit_id = $2 AND space_id = $3`,
      [tenantId, rootOrgId, testSpaceId],
    );

    const { getEffectiveSpaceRole } = await import("../../modules/auth/orgIsolationRuntime");
    const role = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId, // childOrg member，rootOrg 不继承后代
    });
    expect(role).toBeNull();

    // 恢复 include_descendants
    await pool.query(
      `UPDATE org_space_access_policies SET include_descendants = true
       WHERE tenant_id = $1 AND org_unit_id = $2 AND space_id = $3`,
      [tenantId, rootOrgId, testSpaceId],
    );
  });

  // ─── 5.5c: org 解绑后权限回收 ─────────────────────
  it("移除 subject 的 org 分配 → 权限回收，返回 null", async () => {
    if (!ctx.canRun) return;

    // 确认当前有继承权限
    const { getEffectiveSpaceRole } = await import("../../modules/auth/orgIsolationRuntime");
    const before = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId,
    });
    expect(before).toBe("member");

    // 移除 org 分配
    await pool.query(
      "DELETE FROM subject_org_assignments WHERE tenant_id = $1 AND subject_id = $2 AND org_unit_id = $3",
      [tenantId, orgSubjectId, childOrgId],
    );

    const after = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId,
    });
    expect(after).toBeNull();

    // 恢复 org 分配
    await pool.query(
      `INSERT INTO subject_org_assignments (tenant_id, subject_id, org_unit_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, orgSubjectId, childOrgId],
    );
  });

  // ─── 5.5d: 多层 org 继承 — childOrg 直接配置更高角色 ──
  it("childOrg 直接配置 admin → 高于 rootOrg 的 member 继承", async () => {
    if (!ctx.canRun) return;

    // 为 childOrg 也配置 access policy（admin 角色）
    await pool.query(
      `INSERT INTO org_space_access_policies (tenant_id, org_unit_id, space_id, inherited_role, include_descendants)
       VALUES ($1, $2, $3, 'admin', false)
       ON CONFLICT (tenant_id, org_unit_id, space_id) DO UPDATE SET inherited_role = 'admin'`,
      [tenantId, childOrgId, testSpaceId],
    );

    const { getEffectiveSpaceRole } = await import("../../modules/auth/orgIsolationRuntime");
    const role = await getEffectiveSpaceRole({
      pool: pool as any,
      tenantId,
      spaceId: testSpaceId,
      subjectId: orgSubjectId,
    });
    // childOrg admin > rootOrg member → 返回 admin
    expect(role).toBe("admin");

    // 清理 childOrg policy
    await pool.query(
      "DELETE FROM org_space_access_policies WHERE tenant_id = $1 AND org_unit_id = $2 AND space_id = $3",
      [tenantId, childOrgId, testSpaceId],
    );
  });

  // ─── smoke ─────────────────────────────────────────
  it("smoke: admin 用户仍可正常访问", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: { authorization: "Bearer admin" },
    });
    expect(res.statusCode).toBe(200);
  });
});
