/**
 * RBAC/ABAC 模块 E2E 测试
 * 包含：角色管理、权限授予、绑定、字段级/行级规则
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:rbac", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("rbac：创建 role→授权→绑定→放行；解绑→拒绝；deny 也有 snapshotRef", async () => {
    if (!ctx.canRun) return;
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", ["user1", "tenant_dev"]);
    await pool.query(
      `
        DELETE FROM role_bindings
        WHERE subject_id = 'user1'
          AND NOT (role_id = 'role_user' AND scope_type = 'tenant' AND scope_id = 'tenant_dev')
      `,
    );
    await pool.query(
      `
        DELETE FROM role_permissions rp
        USING permissions p
        WHERE rp.role_id = 'role_user'
          AND rp.permission_id = p.id
          AND (p.resource_type = 'backup' OR p.resource_type = '*' OR p.action = '*')
      `,
    );

    const denied = await ctx.app.inject({
      method: "GET",
      url: "/spaces/space_dev/backups?limit=5",
      headers: { authorization: "Bearer user1", "x-trace-id": "t-rbac-denied" },
    });
    expect(denied.statusCode).toBe(403);

    const deniedAudit = await ctx.app.inject({
      method: "GET",
      url: "/audit?traceId=t-rbac-denied&limit=5",
      headers: { authorization: "Bearer admin", "x-trace-id": "t-rbac-denied-audit" },
    });
    expect(deniedAudit.statusCode).toBe(200);
    const deniedEvents = (deniedAudit.json() as any).events as any[];
    const deniedSnapRef = deniedEvents?.[0]?.policy_decision?.snapshotRef as string | undefined;
    expect(String(deniedSnapRef)).toContain("policy_snapshot:");
    const deniedSnapId = String(deniedSnapRef).split("policy_snapshot:")[1];
    const deniedSnap = await ctx.app.inject({
      method: "GET",
      url: `/policy-snapshots/${encodeURIComponent(deniedSnapId)}`,
      headers: { authorization: "Bearer admin", "x-trace-id": "t-rbac-denied-snap" },
    });
    expect(deniedSnap.statusCode).toBe(200);

    const roleCreate = await ctx.app.inject({
      method: "POST",
      url: "/rbac/roles",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-trace-id": "t-rbac-role-create" },
      payload: JSON.stringify({ name: `BackupReader_${Date.now()}` }),
    });
    expect(roleCreate.statusCode).toBe(200);
    const roleId = (roleCreate.json() as any).role.id as string;

    const grant = await ctx.app.inject({
      method: "POST",
      url: `/rbac/roles/${encodeURIComponent(roleId)}/permissions`,
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-trace-id": "t-rbac-grant" },
      payload: JSON.stringify({ resourceType: "backup", action: "list" }),
    });
    expect(grant.statusCode).toBe(200);

    const bind = await ctx.app.inject({
      method: "POST",
      url: "/rbac/bindings",
      headers: { authorization: "Bearer admin", "content-type": "application/json", "x-trace-id": "t-rbac-bind" },
      payload: JSON.stringify({ subjectId: "user1", roleId, scopeType: "space", scopeId: "space_dev" }),
    });
    expect(bind.statusCode).toBe(200);
    const bindingId = (bind.json() as any).bindingId as string;
    expect(bindingId).toBeTruthy();

    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/spaces/space_dev/backups?limit=5",
      headers: { authorization: "Bearer user1", "x-trace-id": "t-rbac-allowed" },
    });
    expect(allowed.statusCode).toBe(200);

    const unbind = await ctx.app.inject({
      method: "DELETE",
      url: `/rbac/bindings/${encodeURIComponent(bindingId)}`,
      headers: { authorization: "Bearer admin", "x-trace-id": "t-rbac-unbind" },
    });
    expect(unbind.statusCode).toBe(200);

    const denied2 = await ctx.app.inject({
      method: "GET",
      url: "/spaces/space_dev/backups?limit=5",
      headers: { authorization: "Bearer user1", "x-trace-id": "t-rbac-denied-2" },
    });
    expect(denied2.statusCode).toBe(403);
  });

  it("rbac ui：roles/permissions 基础读写链路可用", async () => {
    if (!ctx.canRun) return;
    const h = { authorization: "Bearer admin", "content-type": "application/json" };

    const roles = await ctx.app.inject({
      method: "GET",
      url: "/rbac/roles",
      headers: { ...h, "x-trace-id": `t-rbac-ui-roles-${crypto.randomUUID()}` },
    });
    expect(roles.statusCode).toBe(200);
    expect(Array.isArray((roles.json() as any).roles)).toBe(true);

    const perms = await ctx.app.inject({
      method: "GET",
      url: "/rbac/permissions",
      headers: { ...h, "x-trace-id": `t-rbac-ui-perms-${crypto.randomUUID()}` },
    });
    expect(perms.statusCode).toBe(200);
    expect(Array.isArray((perms.json() as any).permissions)).toBe(true);
  });

  it("rbac ui：角色详情、绑定列表、权限检查接口可用", async () => {
    if (!ctx.canRun) return;
    const h = { authorization: "Bearer admin", "content-type": "application/json" };
    const subjectId = `rbac_ui_${Date.now()}`;
    await pool.query("INSERT INTO subjects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING", [subjectId, "tenant_dev"]);

    const roleCreate = await ctx.app.inject({
      method: "POST",
      url: "/rbac/roles",
      headers: { ...h, "x-trace-id": `t-rbac-ui-role-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ name: `UiRole_${Date.now()}` }),
    });
    expect(roleCreate.statusCode).toBe(200);
    const roleId = (roleCreate.json() as any).role.id as string;

    const grant = await ctx.app.inject({
      method: "POST",
      url: `/rbac/roles/${encodeURIComponent(roleId)}/permissions`,
      headers: { ...h, "x-trace-id": `t-rbac-ui-grant-${crypto.randomUUID()}` },
      payload: JSON.stringify({ resourceType: "entity", action: "read" }),
    });
    expect(grant.statusCode).toBe(200);

    const bind = await ctx.app.inject({
      method: "POST",
      url: "/rbac/bindings",
      headers: { ...h, "x-trace-id": `t-rbac-ui-bind-${crypto.randomUUID()}` },
      payload: JSON.stringify({ subjectId, roleId, scopeType: "space", scopeId: "space_dev" }),
    });
    expect(bind.statusCode).toBe(200);
    const bindingId = (bind.json() as any).bindingId as string;
    expect(bindingId).toBeTruthy();

    const roleDetail = await ctx.app.inject({
      method: "GET",
      url: `/rbac/roles/${encodeURIComponent(roleId)}`,
      headers: { ...h, "x-trace-id": `t-rbac-ui-role-detail-${crypto.randomUUID()}` },
    });
    expect(roleDetail.statusCode).toBe(200);
    const roleDetailJson = roleDetail.json() as any;
    expect(roleDetailJson.role?.id).toBe(roleId);
    expect(Array.isArray(roleDetailJson.permissions)).toBe(true);
    expect(Array.isArray(roleDetailJson.bindings)).toBe(true);

    const bindings = await ctx.app.inject({
      method: "GET",
      url: `/rbac/bindings?roleId=${encodeURIComponent(roleId)}`,
      headers: { ...h, "x-trace-id": `t-rbac-ui-bindings-${crypto.randomUUID()}` },
    });
    expect(bindings.statusCode).toBe(200);
    const bindingsJson = bindings.json() as any;
    expect(Array.isArray(bindingsJson.bindings)).toBe(true);
    expect(bindingsJson.bindings.some((x: any) => x.id === bindingId)).toBe(true);

    const check = await ctx.app.inject({
      method: "POST",
      url: "/rbac/check",
      headers: { ...h, "x-trace-id": `t-rbac-ui-check-${crypto.randomUUID()}` },
      payload: JSON.stringify({ scopeType: "space", scopeId: "space_dev", subjectId, resourceType: "entity", resourceId: "doc_001", action: "read" }),
    });
    expect(check.statusCode).toBe(200);
    const checkJson = check.json() as any;
    expect(checkJson.allowed).toBe(true);
    expect(typeof checkJson.policySnapshotId).toBe("string");
  });

  it("backups：支持提交恢复到新空间", async () => {
    if (!ctx.canRun) return;
    const h = { authorization: "Bearer admin", "content-type": "application/json" };
    const targetSpaceId = `space_restore_${Date.now()}`;
    const contentText =
      JSON.stringify({
        entityName: "test_items",
        id: `restore_route_${Date.now()}`,
        payload: { title: "Route Restore", content: "isolated" },
      }) + "\n";
    const art = await pool.query(
      `
        INSERT INTO artifacts (tenant_id, space_id, type, format, content_type, byte_size, content_text, source)
        VALUES ('tenant_dev','space_dev','backup','jsonl','application/x-ndjson; charset=utf-8',$1,$2,$3)
        RETURNING artifact_id
      `,
      [Buffer.byteLength(contentText, "utf8"), contentText, JSON.stringify({ spaceId: "space_dev" })],
    );
    const backupArtifactId = art.rows[0].artifact_id as string;

    const restore = await ctx.app.inject({
      method: "POST",
      url: "/spaces/space_dev/restores",
      headers: { ...h, "x-trace-id": `t-backup-restore-isolated-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        backupArtifactId,
        mode: "commit",
        targetMode: "new_space",
        targetSpaceId,
        targetSpaceName: "Restore Isolated",
        conflictStrategy: "upsert",
        schemaName: "testkit",
      }),
    });
    expect(restore.statusCode).toBe(200);
    const restoreJson = restore.json() as any;
    expect(restoreJson.targetSpaceId).toBe(targetSpaceId);

    const targetSpace = await pool.query("SELECT name FROM spaces WHERE tenant_id = 'tenant_dev' AND id = $1 LIMIT 1", [targetSpaceId]);
    expect(targetSpace.rowCount).toBe(1);
    expect(targetSpace.rows[0].name).toBe("Restore Isolated");

    const stepInput = await pool.query(
      `
        SELECT s.input
        FROM steps s
        WHERE s.run_id = $1
        ORDER BY s.seq ASC
        LIMIT 1
      `,
      [restoreJson.runId],
    );
    expect(stepInput.rowCount).toBe(1);
    const input = stepInput.rows[0].input as any;
    expect(input.spaceId).toBe(targetSpaceId);
    expect(input.sourceSpaceId).toBe("space_dev");
    expect(input.targetSpaceId).toBe(targetSpaceId);
  });
});
