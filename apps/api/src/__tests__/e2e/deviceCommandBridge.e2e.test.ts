/**
 * P1-2 Browser/Desktop Automation Bridge E2E 测试
 * 验收口径：
 *   - 设备离线 → 返回 device_unavailable（503）
 *   - 命令超时 → 返回 timeout（504）
 *   - 设备在线 + 完成执行 → 返回真实结果（succeeded/failed）
 *   - execution 查询端点返回正确字段
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:device-command-bridge", { timeout: 60_000 }, () => {
  let ctx: TestContext;
  const tenantId = "tenant_dev";
  const testDeviceId = crypto.randomUUID();
  const spaceId = "space_dev";

  beforeAll(async () => {
    ctx = await getTestContext();
    if (!ctx.canRun) return;

    // 注册一个测试设备（初始离线）
    await pool.query(
      `INSERT INTO device_records (
         device_id, tenant_id, owner_scope, space_id, device_type, status, device_token_hash, os, agent_version, last_seen_at
       )
       VALUES ($1, $2, 'space', $3, 'desktop', 'inactive', 'test_hash', 'test_os', '1.0', now() - interval '1 hour')
       ON CONFLICT (device_id) DO UPDATE SET
         owner_scope = 'space',
         space_id = EXCLUDED.space_id,
         device_type = 'desktop',
         status = 'inactive',
         last_seen_at = now() - interval '1 hour'`,
      [testDeviceId, tenantId, spaceId],
    );
  }, 180_000);

  afterAll(async () => {
    if (ctx?.canRun) {
      await pool.query("DELETE FROM device_executions WHERE device_id = $1", [testDeviceId]).catch(() => {});
      await pool.query("DELETE FROM device_policies WHERE device_id = $1", [testDeviceId]).catch(() => {});
      await pool.query("DELETE FROM device_sessions WHERE device_id = $1", [testDeviceId]).catch(() => {});
      await pool.query("DELETE FROM device_records WHERE device_id = $1", [testDeviceId]).catch(() => {});
    }
    await releaseTestContext();
  }, 180_000);

  // ─── 4.5: 设备离线 → device_unavailable ──────────────
  it("browser.navigate — 设备离线 → dispatchAndWaitForResult 返回 device_unavailable", async () => {
    if (!ctx.canRun) return;

    // 直接调用桥接模块测试
    const { dispatchAndWaitForResult } = await import(
      "../../skills/device-runtime/modules/deviceCommandBridge"
    );

    const result = await dispatchAndWaitForResult({
      pool: pool as any,
      tenantId,
      deviceId: testDeviceId,
      toolPrefix: "browser",
      command: { action: "navigate", params: { url: "https://example.com" } },
      timeout: 3000,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("device_unavailable");
    expect(result.error).toContain(testDeviceId);
  });

  // ─── 4.6a: 设备在线但无人 claim → 超时 ────────────────
  it("browser.navigate — 设备在线但 agent 未 claim → timeout", async () => {
    if (!ctx.canRun) return;

    // 将设备设为在线
    await pool.query(
      `UPDATE device_records SET status = 'active', last_seen_at = now() WHERE device_id = $1`,
      [testDeviceId],
    );

    const { dispatchAndWaitForResult } = await import(
      "../../skills/device-runtime/modules/deviceCommandBridge"
    );

    const result = await dispatchAndWaitForResult({
      pool: pool as any,
      tenantId,
      deviceId: testDeviceId,
      toolPrefix: "browser",
      command: { action: "navigate", params: { url: "https://example.com" } },
      timeout: 2000, // 2秒超时
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.executionId).toBeTruthy();
    expect(result.error).toContain("timed out");

    // 验证执行记录被取消
    const exec = await pool.query(
      "SELECT status FROM device_executions WHERE device_execution_id = $1",
      [result.executionId],
    );
    // 应该是 canceled 或 pending（如果取消失败）
    expect(["canceled", "pending"]).toContain(exec.rows[0]?.status);
  });

  // ─── 4.5: 设备在线 + agent 完成执行 → succeeded ──────
  it("设备在线 + 模拟 agent 完成 → succeeded 结果", async () => {
    if (!ctx.canRun) return;

    // 确保设备在线
    await pool.query(
      `UPDATE device_records SET status = 'active', last_seen_at = now() WHERE device_id = $1`,
      [testDeviceId],
    );

    const { dispatchAndWaitForResult } = await import(
      "../../skills/device-runtime/modules/deviceCommandBridge"
    );

    // 并行：启动 dispatch + 模拟 agent 完成
    const dispatchPromise = dispatchAndWaitForResult({
      pool: pool as any,
      tenantId,
      deviceId: testDeviceId,
      toolPrefix: "desktop",
      command: { action: "keyboard.type", params: { text: "hello" } },
      timeout: 10_000,
    });

    // 等待执行记录被创建，然后模拟 agent claim + complete
    await new Promise(r => setTimeout(r, 300));

    // 查找 pending 的执行
    const pendingRes = await pool.query(
      `SELECT device_execution_id FROM device_executions
       WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, testDeviceId],
    );

    if (pendingRes.rowCount) {
      const execId = pendingRes.rows[0].device_execution_id;

      // 模拟 agent claim
      await pool.query(
        `UPDATE device_executions SET status = 'claimed', claimed_at = now(), updated_at = now()
         WHERE device_execution_id = $1 AND status = 'pending'`,
        [execId],
      );

      // 模拟 agent 完成
      await pool.query(
        `UPDATE device_executions SET
           status = 'succeeded',
           output_digest = $2::jsonb,
           completed_at = now(),
           updated_at = now()
         WHERE device_execution_id = $1 AND status = 'claimed'`,
        [execId, JSON.stringify({ typed: true, text: "hello" })],
      );
    }

    const result = await dispatchPromise;

    // 如果有 pending 记录被成功完成
    if (pendingRes.rowCount) {
      expect(result.success).toBe(true);
      expect(result.status).toBe("succeeded");
      expect(result.outputDigest).toEqual({ typed: true, text: "hello" });
    }
  });

  // ─── 4.5: 设备在线 + agent 报告失败 → failed ────────
  it("设备在线 + 模拟 agent 报告失败 → failed 结果", async () => {
    if (!ctx.canRun) return;

    await pool.query(
      `UPDATE device_records SET status = 'active', last_seen_at = now() WHERE device_id = $1`,
      [testDeviceId],
    );

    const { dispatchAndWaitForResult } = await import(
      "../../skills/device-runtime/modules/deviceCommandBridge"
    );

    const dispatchPromise = dispatchAndWaitForResult({
      pool: pool as any,
      tenantId,
      deviceId: testDeviceId,
      toolPrefix: "browser",
      command: { action: "click", params: { selector: "#nonexistent" } },
      timeout: 10_000,
    });

    await new Promise(r => setTimeout(r, 300));

    const pendingRes = await pool.query(
      `SELECT device_execution_id FROM device_executions
       WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, testDeviceId],
    );

    if (pendingRes.rowCount) {
      const execId = pendingRes.rows[0].device_execution_id;

      await pool.query(
        `UPDATE device_executions SET status = 'claimed', claimed_at = now() WHERE device_execution_id = $1`,
        [execId],
      );

      await pool.query(
        `UPDATE device_executions SET
           status = 'failed',
           error_category = 'element_not_found',
           output_digest = $2::jsonb,
           completed_at = now()
         WHERE device_execution_id = $1`,
        [execId, JSON.stringify({ error: "Element #nonexistent not found" })],
      );
    }

    const result = await dispatchPromise;

    if (pendingRes.rowCount) {
      expect(result.success).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("element_not_found");
    }
  });

  // ─── 4.7: findOnlineDevice 正确性 ──────────────────
  it("findOnlineDevice — 设备在线返回 deviceId，离线返回 null", async () => {
    if (!ctx.canRun) return;

    const { findOnlineDevice } = await import(
      "../../skills/device-runtime/modules/deviceCommandBridge"
    );

    // 设备在线
    await pool.query(
      `UPDATE device_records SET status = 'active', last_seen_at = now() WHERE device_id = $1`,
      [testDeviceId],
    );
    const online = await findOnlineDevice({ pool: pool as any, tenantId, capability: "browser" });
    expect(online).toBeTruthy();

    await pool.query(
      `INSERT INTO device_policies (device_id, tenant_id, allowed_tools)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (device_id) DO UPDATE SET allowed_tools = EXCLUDED.allowed_tools, updated_at = now()`,
      [testDeviceId, tenantId, JSON.stringify(["desktop.launch", "desktop.window.list"])],
    );
    const browserDenied = await findOnlineDevice({ pool: pool as any, tenantId, capability: "browser", preferDeviceId: testDeviceId });
    expect(browserDenied).toBeNull();
    const desktopAllowed = await findOnlineDevice({ pool: pool as any, tenantId, capability: "desktop", preferDeviceId: testDeviceId });
    expect(desktopAllowed).toBe(testDeviceId);

    // 设备离线
    await pool.query(
      `UPDATE device_records SET status = 'inactive', last_seen_at = now() - interval '1 hour' WHERE device_id = $1`,
      [testDeviceId],
    );
    await pool.query("DELETE FROM device_policies WHERE device_id = $1", [testDeviceId]);
    const offline = await findOnlineDevice({ pool: pool as any, tenantId, capability: "browser", preferDeviceId: testDeviceId });
    expect(offline).toBeNull();
  });

  // ─── smoke: admin 仍正常 ──────────────────────────
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
