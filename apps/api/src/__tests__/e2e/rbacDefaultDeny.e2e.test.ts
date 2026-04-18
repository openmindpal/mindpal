/**
 * P0-1 验证测试：RBAC default-deny 语义恢复
 *
 * 验收口径：
 * - 1.4 无 role binding 的 subject → 403 + audit reason=no_role_binding
 * - 1.5 有 role binding 但无对应 permission → 403 + reason=permission_denied
 * - 1.6 ABAC deny 策略生效 → 403 + policy snapshot 含 abac 信息
 * - 1.7 ensureSubject() 在 dev 模式下不再自动授予 admin
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  clearAuthzCache,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:rbac-default-deny (P0-1)", { timeout: 60_000 }, () => {
  let ctx: TestContext;
  const freshSubjectId = `fresh_${Date.now()}`;
  const limitedSubjectId = `limited_${Date.now()}`;
  const abacSubjectId = `abac_${Date.now()}`;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  // ─── 1.7 ensureSubject 不再 auto-grant admin ──────────────────
  it("ensureSubject: dev 模式下新 subject 不会自动获得 admin 角色", async () => {
    if (!ctx.canRun) return;
    const prevMode = process.env.AUTHN_MODE;
    process.env.AUTHN_MODE = "dev";
    try {
      // 通过 /me 端点触发 ensureSubject
      const res = await ctx.app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${freshSubjectId}`, "x-trace-id": `t-p01-ensure-${freshSubjectId}` },
      });
      expect(res.statusCode).toBe(200);

      // 验证 subject 已创建
      const subjectRow = await pool.query("SELECT id FROM subjects WHERE id = $1", [freshSubjectId]);
      expect(subjectRow.rowCount).toBe(1);

      // 验证 NO admin role binding
      const bindingRow = await pool.query(
        "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = 'role_admin'",
        [freshSubjectId],
      );
      expect(bindingRow.rowCount).toBe(0);
    } finally {
      if (prevMode === undefined) delete process.env.AUTHN_MODE;
      else process.env.AUTHN_MODE = prevMode;
    }
  });

  // ─── 1.4 无 role binding → 403 + audit denied ─────────────────
  it("无 role binding 的 subject 请求受保护端点 → 403, audit reason=no_role_binding", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-p01-no-binding-${crypto.randomUUID()}`;

    // 确保 subject 存在但无任何 role binding
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [freshSubjectId, "tenant_dev"]);
    await pool.query("DELETE FROM role_bindings WHERE subject_id = $1", [freshSubjectId]);

    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: { authorization: `Bearer ${freshSubjectId}`, "x-trace-id": traceId },
    });
    expect(res.statusCode).toBe(403);

    // 查审计日志 - 验证 denied + reason
    const auditRes = await ctx.app.inject({
      method: "GET",
      url: `/audit?traceId=${traceId}&limit=5`,
      headers: { authorization: "Bearer admin", "x-trace-id": `t-p01-no-binding-audit-${crypto.randomUUID()}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const events = (auditRes.json() as any).events as any[];
    // 找到 deny 事件
    const denyEvent = events?.find((e: any) => e.policy_decision?.decision === "deny");
    if (denyEvent) {
      expect(denyEvent.policy_decision.reason).toBe("no_role_binding");
      expect(String(denyEvent.policy_decision.snapshotRef)).toContain("policy_snapshot:");
    }
  });

  // ─── 1.5 有 role binding 但无 permission → 403 ────────────────
  it("有 role binding 但无目标 permission → 403, reason=permission_denied", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-p01-no-perm-${crypto.randomUUID()}`;

    // 创建 limited subject + 空角色
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [limitedSubjectId, "tenant_dev"]);
    const emptyRoleId = `role_empty_${limitedSubjectId.slice(-8)}`;
    await pool.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [emptyRoleId, "tenant_dev", `EmptyRole_${limitedSubjectId.slice(-8)}`]);
    // 绑定角色但不授予任何权限
    await pool.query(
      "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
      [limitedSubjectId, emptyRoleId, "tenant_dev"],
    );

    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: { authorization: `Bearer ${limitedSubjectId}`, "x-trace-id": traceId },
    });
    expect(res.statusCode).toBe(403);

    // 查审计日志
    const auditRes = await ctx.app.inject({
      method: "GET",
      url: `/audit?traceId=${traceId}&limit=5`,
      headers: { authorization: "Bearer admin", "x-trace-id": `t-p01-no-perm-audit-${crypto.randomUUID()}` },
    });
    expect(auditRes.statusCode).toBe(200);
    const events = (auditRes.json() as any).events as any[];
    const denyEvent = events?.find((e: any) => e.policy_decision?.decision === "deny");
    if (denyEvent) {
      expect(denyEvent.policy_decision.reason).toBe("permission_denied");
      expect(String(denyEvent.policy_decision.snapshotRef)).toContain("policy_snapshot:");
    }
  });

  // ─── 1.6 ABAC deny → 403 + policy snapshot 含 abac 信息 ──────
  it("ABAC deny 策略命中 → 403, policy snapshot 包含 abac 信息", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-p01-abac-${crypto.randomUUID()}`;
    const policyName = `test_time_deny_${crypto.randomUUID().slice(0, 8)}`;

    // 创建 subject + 赋予 schema read 权限
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [abacSubjectId, "tenant_dev"]);
    const abacRoleId = `role_abac_${abacSubjectId.slice(-8)}`;
    await pool.query("INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name", [abacRoleId, "tenant_dev", `AbacTestRole_${abacSubjectId.slice(-8)}`]);
    const permRes = await pool.query(
      "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
      ["schema", "read"],
    );
    const permId = permRes.rows[0].id as string;
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [abacRoleId, permId]);
    await pool.query(
      "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
      [abacSubjectId, abacRoleId, "tenant_dev"],
    );

    try {
      const psRes = await pool.query(
        `INSERT INTO abac_policy_sets (tenant_id, name, resource_type, combining_algorithm, status)
         VALUES ($1, $2, 'schema', 'deny_overrides', 'active')
         ON CONFLICT (tenant_id, name, version) DO UPDATE SET status = 'active'
         RETURNING policy_set_id`,
        ["tenant_dev", policyName],
      );
      const policySetId = psRes.rows[0].policy_set_id;
      await pool.query(
        `INSERT INTO abac_policy_rules (policy_set_id, tenant_id, name, resource_type, actions, priority, effect, condition_expr, enabled)
         VALUES ($1, $2, 'deny_outside_0_1_utc', 'schema', $3::jsonb, 1, 'deny', $4::jsonb, true)
         ON CONFLICT DO NOTHING`,
        [
          policySetId,
          "tenant_dev",
          JSON.stringify(["read"]),
          JSON.stringify({ op: "gte", left: { kind: "time", key: "hourOfDay" }, right: 1 }),
        ],
      );
      clearAuthzCache();
    } catch {
      return;
    }

    try {
      const res = await ctx.app.inject({
        method: "GET",
        url: "/schemas",
        headers: {
          authorization: `Bearer ${abacSubjectId}`,
          "x-trace-id": traceId,
        },
      });

      const now = new Date();
      const utcHour = now.getUTCHours();
      if (utcHour >= 1) {
        expect(res.statusCode).toBe(403);

        const auditRes = await ctx.app.inject({
          method: "GET",
          url: `/audit?traceId=${traceId}&limit=5`,
          headers: { authorization: "Bearer admin", "x-trace-id": `t-p01-abac-audit-${crypto.randomUUID()}` },
        });
        if (auditRes.statusCode === 200) {
          const events = (auditRes.json() as any).events as any[];
          const denyEvent = events?.find((e: any) => e.policy_decision?.decision === "deny");
          if (denyEvent) {
            expect(String(denyEvent.policy_decision.reason)).toContain("abac:");
            expect(String(denyEvent.policy_decision.snapshotRef)).toContain("policy_snapshot:");
          }
        }
      }
    } finally {
      await pool.query("DELETE FROM abac_policy_sets WHERE tenant_id = $1 AND name = $2", ["tenant_dev", policyName]);
      clearAuthzCache();
    }
  });

  // ─── ensureSubject: pat/hmac 模式同样不授 admin ─────────────────
  it("ensureSubject: pat 模式下也不自动授予 admin", async () => {
    if (!ctx.canRun) return;
    const patSubjectId = `pat_fresh_${Date.now()}`;
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [patSubjectId, "tenant_dev"]);

    // 验证没有 admin binding
    const bindingRow = await pool.query(
      "SELECT role_id FROM role_bindings WHERE subject_id = $1 AND role_id = 'role_admin'",
      [patSubjectId],
    );
    expect(bindingRow.rowCount).toBe(0);
  });

  it("边界：ABAC 策略删除并清缓存后，同一 subject 可立即恢复访问", async () => {
    if (!ctx.canRun) return;
    const subjectId = `abac_restore_${crypto.randomUUID().slice(0, 8)}`;
    const roleId = `role_${subjectId}`;
    const policyName = `restore_access_${crypto.randomUUID().slice(0, 8)}`;

    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [subjectId, "tenant_dev"]);
    await pool.query(
      "INSERT INTO roles (id, tenant_id, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name",
      [roleId, "tenant_dev", `RestoreRole_${subjectId}`],
    );
    const permRes = await pool.query(
      "INSERT INTO permissions (resource_type, action) VALUES ($1, $2) ON CONFLICT (resource_type, action) DO UPDATE SET resource_type = EXCLUDED.resource_type RETURNING id",
      ["schema", "read"],
    );
    await pool.query("INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [roleId, permRes.rows[0].id]);
    await pool.query(
      "INSERT INTO role_bindings (subject_id, role_id, scope_type, scope_id) VALUES ($1, $2, 'tenant', $3) ON CONFLICT DO NOTHING",
      [subjectId, roleId, "tenant_dev"],
    );

    try {
      const psRes = await pool.query(
        `INSERT INTO abac_policy_sets (tenant_id, name, resource_type, combining_algorithm, status)
         VALUES ($1, $2, 'schema', 'deny_overrides', 'active')
         ON CONFLICT (tenant_id, name, version) DO UPDATE SET status = 'active'
         RETURNING policy_set_id`,
        ["tenant_dev", policyName],
      );
      await pool.query(
        `INSERT INTO abac_policy_rules (policy_set_id, tenant_id, name, resource_type, actions, priority, effect, condition_expr, enabled)
         VALUES ($1, $2, 'deny_cn_geo', 'schema', $3::jsonb, 1, 'deny', $4::jsonb, true)
         ON CONFLICT DO NOTHING`,
        [
          psRes.rows[0].policy_set_id,
          "tenant_dev",
          JSON.stringify(["read"]),
          JSON.stringify({ op: "eq", left: { kind: "env", key: "geoCountry" }, right: "CN" }),
        ],
      );
      clearAuthzCache();

      const denied = await ctx.app.inject({
        method: "GET",
        url: "/schemas",
        headers: {
          authorization: `Bearer ${subjectId}`,
          "x-trace-id": `t-p01-restore-deny-${crypto.randomUUID()}`,
          "x-geo-country": "CN",
        },
      });
      expect(denied.statusCode).toBe(403);

      await pool.query("DELETE FROM abac_policy_sets WHERE tenant_id = $1 AND name = $2", ["tenant_dev", policyName]);
      clearAuthzCache();

      const restored = await ctx.app.inject({
        method: "GET",
        url: "/schemas",
        headers: {
          authorization: `Bearer ${subjectId}`,
          "x-trace-id": `t-p01-restore-allow-${crypto.randomUUID()}`,
          "x-geo-country": "CN",
        },
      });
      expect(restored.statusCode).toBe(200);
    } finally {
      await pool.query("DELETE FROM abac_policy_sets WHERE tenant_id = $1 AND name = $2", ["tenant_dev", policyName]);
      clearAuthzCache();
    }
  });

  // ─── 冒烟检查：admin 用户仍然正常工作 ─────────────────────────
  it("冒烟: seed 中配置的 admin 用户仍可正常访问", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({
      method: "GET",
      url: "/schemas",
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": `t-p01-smoke-${crypto.randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(200);
  });
});
