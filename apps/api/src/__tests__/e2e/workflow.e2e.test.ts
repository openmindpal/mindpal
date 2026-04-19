/**
 * Workflow 模块 E2E 测试
 * 包含：工作流审批、步骤执行、deadletter
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext, TEST_SCHEMA_NAME,
  processStep,
  type TestContext,
} from "./setup";
import { setConfigOverride, deleteConfigOverride } from "../../modules/governance/configGovernanceRepo";
import { APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY } from "../../kernel/executionKernel";
import { upsertTaskState } from "../../modules/memory/repo";

describe.sequential("e2e:workflow", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("workflow：run 创建幂等与 cancel", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const idem = `idem-run-${crypto.randomUUID()}`;

    const create1 = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": idem, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-run-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "wf" }),
    });
    expect(create1.statusCode).toBe(200);
    const runId = String((create1.json() as any).runId);

    const create2 = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": idem, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-run-create-dup-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "wf" }),
    });
    expect(create2.statusCode).toBe(200);
    expect(String((create2.json() as any).runId)).toBe(runId);

    const cancel = await ctx.app.inject({
      method: "POST",
      url: `/runs/${encodeURIComponent(runId)}/cancel`,
      headers: { ...h, "x-trace-id": `t-run-cancel-${crypto.randomUUID()}` },
      payload: "{}",
    });
    expect([200, 409].includes(cancel.statusCode)).toBe(true);
  });

  it("workflow：run retry + space 隔离", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const create = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": `idem-retry-${crypto.randomUUID()}`, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-run-retry-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "retry" }),
    });
    expect(create.statusCode).toBe(200);
    const runId = String((create.json() as any).runId);

    const get = await ctx.app.inject({
      method: "GET",
      url: `/runs/${encodeURIComponent(runId)}`,
      headers: { ...h, "x-trace-id": `t-run-get-${crypto.randomUUID()}` },
    });
    expect(get.statusCode).toBe(200);

    // space 隔离测试
    const otherSpace = await ctx.app.inject({
      method: "GET",
      url: `/runs/${encodeURIComponent(runId)}`,
      headers: { ...h, authorization: "Bearer admin@space_other", "x-space-id": "space_other", "x-trace-id": `t-run-other-space-${crypto.randomUUID()}` },
    });
    expect([403, 404].includes(otherSpace.statusCode)).toBe(true);
  });

  it("workflow：steps 返回 policySnapshotRef", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const create = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": `idem-steps-${crypto.randomUUID()}`, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-steps-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "steps" }),
    });
    expect(create.statusCode).toBe(200);
    const jobId = String((create.json() as any).jobId);

    const stepsRes = await ctx.app.inject({
      method: "GET",
      url: `/jobs/${encodeURIComponent(jobId)}`,
      headers: { ...h, "x-trace-id": `t-run-steps-${crypto.randomUUID()}` },
    });
    expect(stepsRes.statusCode).toBe(200);
    const steps = (stepsRes.json() as any).steps as any[];
    expect(Array.isArray(steps)).toBe(true);
    expect(steps[0]?.policySnapshotRef).toBeTruthy();
  });

  it("workflow：补偿记录可查询", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
    };
    const created = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { authorization: "Bearer admin", "x-tenant-id": "tenant_dev", "x-space-id": "space_dev", "content-type": "application/json", "idempotency-key": `idem-comp-${crypto.randomUUID()}`, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-comp-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "comp" }),
    });
    expect(created.statusCode).toBe(200);
    const jobId = String((created.json() as any).jobId);
    const job = await ctx.app.inject({ method: "GET", url: `/jobs/${encodeURIComponent(jobId)}`, headers: { ...h, "x-trace-id": `t-comp-job-${crypto.randomUUID()}` } });
    expect(job.statusCode).toBe(200);
    const stepId = String(((job.json() as any).steps?.[0]?.stepId ?? ""));
    expect(stepId).toBeTruthy();

    const r = await ctx.app.inject({
      method: "GET",
      url: `/governance/workflow/steps/${encodeURIComponent(stepId)}/compensations`,
      headers: { ...h, "x-trace-id": `t-comp-${crypto.randomUUID()}` },
    });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray((r.json() as any).items)).toBe(true);
  });

  it("workflow：双人审批在第二个审批人放行前保持 pending", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    await setConfigOverride({
      pool,
      tenantId: "tenant_dev",
      configKey: APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY,
      configValue: "true",
      changedBy: "admin",
    });

    try {
      const created = await ctx.app.inject({
        method: "POST",
        url: "/orchestrator/dispatch/execute",
        headers: { ...h, "idempotency-key": `idem-dual-${crypto.randomUUID()}`, "x-trace-id": `t-dual-${crypto.randomUUID()}` },
        payload: JSON.stringify({ toolRef: "entity.create@1", input: { schemaName: TEST_SCHEMA_NAME, entityName: "test_items", payload: { title: "dual-approval" } } }),
      });
      expect(created.statusCode, `[dual] Expected 200 but got ${created.statusCode}: ${created.body}`).toBe(200);
      const runId = String((created.json() as any).runId);
      const approvalId = String((created.json() as any).approvalId ?? "");
      expect(approvalId).toBeTruthy();

      const firstApprove = await ctx.app.inject({
        method: "POST",
        url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        headers: { ...h, "x-trace-id": `t-approval-first-${crypto.randomUUID()}` },
        payload: JSON.stringify({ decision: "approve", reason: "first approver" }),
      });
      expect(firstApprove.statusCode).toBe(200);
      const firstJson = firstApprove.json() as any;
      expect(firstJson.receipt?.status).toBe("awaiting_additional_approval");
      expect(firstJson.receipt?.approvalsCollected).toBe(1);
      expect(firstJson.receipt?.approvalsRemaining).toBe(1);

      const midRun = await ctx.app.inject({
        method: "GET",
        url: `/runs/${encodeURIComponent(runId)}`,
        headers: { ...h, "x-trace-id": `t-run-mid-${crypto.randomUUID()}` },
      });
      expect(midRun.statusCode).toBe(200);
      expect((midRun.json() as any).run?.status ?? (midRun.json() as any).status).toBe("needs_approval");

      const secondApprove = await ctx.app.inject({
        method: "POST",
        url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        headers: { ...h, authorization: "Bearer approver", "x-trace-id": `t-approval-second-${crypto.randomUUID()}` },
        payload: JSON.stringify({ decision: "approve", reason: "second approver" }),
      });
      expect(secondApprove.statusCode).toBe(200);
      expect((secondApprove.json() as any).receipt?.status).toBe("queued");

      const resumedRun = await pool.query(
        "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
        ["tenant_dev", runId],
      );
      expect(resumedRun.rows[0]?.status).toBe("queued");

      const resumedStep = await pool.query(
        "SELECT status FROM steps WHERE run_id = $1 ORDER BY seq ASC LIMIT 1",
        [runId],
      );
      expect(resumedStep.rows[0]?.status).toBe("pending");
    } finally {
      await deleteConfigOverride({
        pool,
        tenantId: "tenant_dev",
        configKey: APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY,
        changedBy: "admin",
      });
    }
  });

  it("workflow：双人审批拒绝同一审批人重复批准", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    await setConfigOverride({
      pool,
      tenantId: "tenant_dev",
      configKey: APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY,
      configValue: "true",
      changedBy: "admin",
    });

    try {
      const created = await ctx.app.inject({
        method: "POST",
        url: "/orchestrator/dispatch/execute",
        headers: { ...h, "idempotency-key": `idem-dupe-${crypto.randomUUID()}`, "x-trace-id": `t-dupe-${crypto.randomUUID()}` },
        payload: JSON.stringify({ toolRef: "entity.create@1", input: { schemaName: TEST_SCHEMA_NAME, entityName: "test_items", payload: { title: "duplicate-approver" } } }),
      });
      expect(created.statusCode, `[dupe] Expected 200 but got ${created.statusCode}: ${created.body}`).toBe(200);
      const approvalId = String((created.json() as any).approvalId ?? "");
      expect(approvalId).toBeTruthy();

      const firstApprove = await ctx.app.inject({
        method: "POST",
        url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        headers: { ...h, "x-trace-id": `t-dupe-first-${crypto.randomUUID()}` },
        payload: JSON.stringify({ decision: "approve" }),
      });
      expect(firstApprove.statusCode).toBe(200);

      const duplicateApprove = await ctx.app.inject({
        method: "POST",
        url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        headers: { ...h, "x-trace-id": `t-dupe-second-${crypto.randomUUID()}` },
        payload: JSON.stringify({ decision: "approve" }),
      });
      expect(duplicateApprove.statusCode).toBe(400);
      expect(JSON.stringify(duplicateApprove.json())).toContain("双人审批需要不同审批人");
    } finally {
      await deleteConfigOverride({
        pool,
        tenantId: "tenant_dev",
        configKey: APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY,
        changedBy: "admin",
      });
    }
  });

  it("workflow：审批最终通过但入队失败时回落为 failed，避免伪 queued", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    await setConfigOverride({
      pool,
      tenantId: "tenant_dev",
      configKey: APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY,
      configValue: "true",
      changedBy: "admin",
    });

    const originalAdd = ctx.app.queue.add.bind(ctx.app.queue);
    ctx.app.queue.add = async () => {
      throw new Error("queue offline for test");
    };

    try {
      const created = await ctx.app.inject({
        method: "POST",
        url: "/orchestrator/dispatch/execute",
        headers: { ...h, "idempotency-key": `idem-enqueue-fail-${crypto.randomUUID()}`, "x-trace-id": `t-enqueue-fail-${crypto.randomUUID()}` },
        payload: JSON.stringify({ toolRef: "entity.create@1", input: { schemaName: TEST_SCHEMA_NAME, entityName: "test_items", payload: { title: "enqueue-fail" } } }),
      });
      expect(created.statusCode, `[enqueue] Expected 200 but got ${created.statusCode}: ${created.body}`).toBe(200);
      const runId = String((created.json() as any).runId);
      const approvalId = String((created.json() as any).approvalId ?? "");
      expect(approvalId).toBeTruthy();

      const firstApprove = await ctx.app.inject({
        method: "POST",
        url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        headers: { ...h, "x-trace-id": `t-enqueue-fail-first-${crypto.randomUUID()}` },
        payload: JSON.stringify({ decision: "approve", reason: "first approver" }),
      });
      expect(firstApprove.statusCode).toBe(200);

      const secondApprove = await ctx.app.inject({
        method: "POST",
        url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
        headers: { ...h, authorization: "Bearer approver", "x-trace-id": `t-enqueue-fail-second-${crypto.randomUUID()}` },
        payload: JSON.stringify({ decision: "approve", reason: "second approver" }),
      });
      expect(secondApprove.statusCode).toBe(503);
      expect((secondApprove.json() as any).errorCode).toBe("SERVICE_NOT_READY");

      const runState = await pool.query(
        "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
        ["tenant_dev", runId],
      );
      expect(runState.rows[0]?.status).toBe("failed");

      const jobState = await pool.query(
        "SELECT status FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1",
        ["tenant_dev", runId],
      );
      expect(jobState.rows[0]?.status).toBe("failed");

      const stepState = await pool.query(
        "SELECT status, error_category, queue_job_id FROM steps WHERE run_id = $1 ORDER BY seq ASC LIMIT 1",
        [runId],
      );
      expect(stepState.rows[0]?.status).toBe("failed");
      expect(stepState.rows[0]?.error_category).toBe("queue_error");
      expect(stepState.rows[0]?.queue_job_id).toBeNull();

      const taskState = await ctx.app.inject({
        method: "GET",
        url: `/task-states/${encodeURIComponent(runId)}`,
        headers: { ...h, "x-trace-id": `t-enqueue-fail-state-${crypto.randomUUID()}` },
      });
      expect(taskState.statusCode).toBe(200);
      const taskStateBody = taskState.json() as any;
      expect(taskStateBody.phase).toBe("failed");
      expect(taskStateBody.approvalStatus).toBe("approved");
      expect(taskStateBody.nextAction).toBe("retry_run");
    } finally {
      ctx.app.queue.add = originalAdd;
      await deleteConfigOverride({
        pool,
        tenantId: "tenant_dev",
        configKey: APPROVAL_REQUIRE_DUAL_APPROVAL_FOR_HIGH_RISK_CONFIG_KEY,
        changedBy: "admin",
      });
    }
  });

  it("workflow：pause 使用请求 spaceId 同步 task state，而不是依赖 run input_digest", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const created = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": `idem-pause-${crypto.randomUUID()}`, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-pause-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "pause-task-state" }),
    });
    expect(created.statusCode).toBe(200);
    const runId = String((created.json() as any).runId);

    await pool.query("UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", ["tenant_dev", runId]);
    await pool.query("UPDATE runs SET input_digest = '{}'::jsonb WHERE tenant_id = $1 AND run_id = $2", ["tenant_dev", runId]);
    await upsertTaskState({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      runId,
      phase: "queued",
      plan: { source: "e2e.pause" },
    });

    const paused = await ctx.app.inject({
      method: "POST",
      url: `/runs/${encodeURIComponent(runId)}/pause`,
      headers: { ...h, "x-trace-id": `t-pause-${crypto.randomUUID()}` },
      payload: JSON.stringify({ reason: "manual_pause_e2e" }),
    });
    expect(paused.statusCode).toBe(200);
    expect((paused.json() as any).status).toBe("paused");

    const taskState = await ctx.app.inject({
      method: "GET",
      url: `/task-states/${encodeURIComponent(runId)}`,
      headers: { ...h, "x-trace-id": `t-pause-state-${crypto.randomUUID()}` },
    });
    expect(taskState.statusCode).toBe(200);
    const stateBody = taskState.json() as any;
    expect(stateBody.phase).toBe("paused");
    expect(String(stateBody.blockReason ?? "")).toContain("manual_pause_e2e");
  });

  it("workflow：resume 会恢复 paused step 并清理 task state 阻塞态", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const created = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": `idem-resume-${crypto.randomUUID()}`, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-resume-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "resume-paused-step" }),
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as any;
    const runId = String(body.runId);
    const jobId = String(body.jobId);

    const stepRes = await pool.query(
      "SELECT step_id FROM steps WHERE run_id = $1 ORDER BY seq ASC LIMIT 1",
      [runId],
    );
    expect(stepRes.rowCount).toBe(1);
    const stepId = String(stepRes.rows[0].step_id);

    await upsertTaskState({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      runId,
      stepId,
      phase: "paused",
      blockReason: "waiting_manual_resume",
      plan: { source: "e2e.resume" },
    });
    await pool.query("UPDATE runs SET status = 'paused', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", ["tenant_dev", runId]);
    await pool.query("UPDATE jobs SET status = 'paused', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", ["tenant_dev", jobId]);
    await pool.query("UPDATE steps SET status = 'paused', updated_at = now() WHERE step_id = $1", [stepId]);

    const resumed = await ctx.app.inject({
      method: "POST",
      url: `/runs/${encodeURIComponent(runId)}/resume`,
      headers: { ...h, "x-trace-id": `t-resume-${crypto.randomUUID()}` },
      payload: JSON.stringify({ reason: "resume_from_paused_step" }),
    });
    expect(resumed.statusCode).toBe(200);
    const resumedBody = resumed.json() as any;
    expect(resumedBody.status).toBe("queued");
    expect(resumedBody.stepId).toBe(stepId);

    const runStateRes = await pool.query(
      "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
      ["tenant_dev", runId],
    );
    expect(runStateRes.rows[0]?.status).toBe("queued");

    const stepStateRes = await pool.query(
      "SELECT status FROM steps WHERE step_id = $1 LIMIT 1",
      [stepId],
    );
    expect(stepStateRes.rows[0]?.status).toBe("pending");

    const taskState = await ctx.app.inject({
      method: "GET",
      url: `/task-states/${encodeURIComponent(runId)}`,
      headers: { ...h, "x-trace-id": `t-resume-state-${crypto.randomUUID()}` },
    });
    expect(taskState.statusCode).toBe(200);
    const stateBody = taskState.json() as any;
    expect(stateBody.phase).toBe("queued");
    expect(stateBody.blockReason).toBeNull();
  });

  it("workflow：approval binding mismatch 时拒绝放行并保持 needs_approval", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const created = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/execute",
      headers: { ...h, "idempotency-key": `idem-bind-${crypto.randomUUID()}`, "x-trace-id": `t-bind-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ toolRef: "entity.create@1", input: { schemaName: TEST_SCHEMA_NAME, entityName: "test_items", payload: { title: "approval-binding" } } }),
    });
    expect(created.statusCode, `[bind] Expected 200 but got ${created.statusCode}: ${created.body}`).toBe(200);
    const runId = String((created.json() as any).runId);
    const approvalId = String((created.json() as any).approvalId ?? "");
    expect(approvalId).toBeTruthy();

    await pool.query(
      "UPDATE steps SET input_digest = jsonb_build_object('tampered', true), updated_at = now() WHERE run_id = $1",
      [runId],
    );

    const approve = await ctx.app.inject({
      method: "POST",
      url: `/approvals/${encodeURIComponent(approvalId)}/decisions`,
      headers: { ...h, "x-trace-id": `t-bind-approve-${crypto.randomUUID()}` },
      payload: JSON.stringify({ decision: "approve", reason: "tampered test" }),
    });
    expect(approve.statusCode).toBe(409);
    expect((approve.json() as any).errorCode).toBe("APPROVAL_BINDING_MISMATCH");

    const runRes = await pool.query(
      "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
      ["tenant_dev", runId],
    );
    expect(runRes.rows[0]?.status).toBe("needs_approval");
  });

  it("workflow：旧 run 级 approve 接口已移除", async () => {
    if (!ctx.canRun) return;
    const res = await ctx.app.inject({
      method: "POST",
      url: `/runs/${encodeURIComponent(`run-removed-${crypto.randomUUID()}`)}/approve`,
      headers: {
        authorization: "Bearer admin",
        "x-tenant-id": "tenant_dev",
        "x-space-id": "space_dev",
        "x-trace-id": `t-run-approve-removed-${crypto.randomUUID()}`,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("workflow：device result 恢复 needs_device 时同步 task state 与 step 状态", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const deviceCreated = await ctx.app.inject({
      method: "POST",
      url: "/devices",
      headers: { ...h, "x-trace-id": `t-device-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ ownerScope: "space", deviceType: "desktop", os: "Windows", agentVersion: "1.0.0" }),
    });
    expect(deviceCreated.statusCode).toBe(200);
    const deviceId = String((deviceCreated.json() as any).device?.deviceId);
    expect(deviceId).toBeTruthy();

    const policyUpdated = await ctx.app.inject({
      method: "PUT",
      url: `/devices/${encodeURIComponent(deviceId)}/policy`,
      headers: { ...h, "x-trace-id": `t-device-policy-${crypto.randomUUID()}` },
      payload: JSON.stringify({ allowedTools: ["entity.create"] }),
    });
    expect(policyUpdated.statusCode).toBe(200);

    const pairing = await ctx.app.inject({
      method: "POST",
      url: `/devices/${encodeURIComponent(deviceId)}/pairing`,
      headers: { ...h, "x-trace-id": `t-device-pairing-${crypto.randomUUID()}` },
      payload: JSON.stringify({}),
    });
    expect(pairing.statusCode).toBe(200);
    const pairingCode = String((pairing.json() as any).pairingCode);

    const paired = await ctx.app.inject({
      method: "POST",
      url: "/device-agent/pair",
      headers: { "content-type": "application/json", "x-trace-id": `t-device-pair-${crypto.randomUUID()}` },
      payload: JSON.stringify({ pairingCode, deviceType: "desktop", os: "Windows", agentVersion: "1.0.0" }),
    });
    expect(paired.statusCode).toBe(200);
    const deviceToken = String((paired.json() as any).deviceToken);
    expect(deviceToken).toBeTruthy();

    const created = await ctx.app.inject({
      method: "POST",
      url: "/jobs/entities/test_items/create",
      headers: { ...h, "idempotency-key": `idem-needs-device-${crypto.randomUUID()}`, "x-schema-name": TEST_SCHEMA_NAME, "x-trace-id": `t-needs-device-create-${crypto.randomUUID()}` },
      payload: JSON.stringify({ title: "needs-device-resume" }),
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as any;
    const runId = String(body.runId);
    const jobId = String(body.jobId);

    const jobView = await ctx.app.inject({
      method: "GET",
      url: `/jobs/${encodeURIComponent(jobId)}`,
      headers: { ...h, "x-trace-id": `t-needs-device-job-${crypto.randomUUID()}` },
    });
    expect(jobView.statusCode).toBe(200);
    const stepId = String((jobView.json() as any).steps?.[0]?.stepId ?? "");
    expect(stepId).toBeTruthy();

    await pool.query("UPDATE runs SET status = 'needs_device', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", ["tenant_dev", runId]);
    await pool.query("UPDATE jobs SET status = 'needs_device', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", ["tenant_dev", jobId]);
    await pool.query("UPDATE steps SET status = 'needs_device', queue_job_id = NULL, updated_at = now() WHERE step_id = $1", [stepId]);
    await upsertTaskState({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      runId,
      stepId,
      phase: "needs_device",
      blockReason: "waiting_for_device",
      nextAction: "await_device_result",
      plan: { source: "e2e.device.resume" },
    });

    const deviceExecutionRes = await pool.query(
      `
        INSERT INTO device_executions (
          tenant_id, space_id, created_by_subject_id, device_id, tool_ref,
          policy_snapshot_ref, idempotency_key, require_user_presence, input_json,
          input_digest, status, run_id, step_id, claimed_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'claimed',$11,$12,now())
        RETURNING device_execution_id
      `,
      [
        "tenant_dev",
        "space_dev",
        "admin",
        deviceId,
        "entity.create@1",
        "policy:test",
        null,
        false,
        JSON.stringify({ schemaName: TEST_SCHEMA_NAME, entityName: "test_items", payload: { title: "device-result" } }),
        JSON.stringify({ keyCount: 3, keys: ["schemaName", "entityName", "payload"] }),
        runId,
        stepId,
      ],
    );
    const deviceExecutionId = String(deviceExecutionRes.rows[0].device_execution_id);

    const result = await ctx.app.inject({
      method: "POST",
      url: `/device-agent/executions/${encodeURIComponent(deviceExecutionId)}/result`,
      headers: {
        authorization: `Device ${deviceToken}`,
        "content-type": "application/json",
        "x-trace-id": `t-device-result-${crypto.randomUUID()}`,
      },
      payload: JSON.stringify({ status: "succeeded", outputDigest: { ok: true } }),
    });
    expect(result.statusCode).toBe(200);
    expect((result.json() as any).workflowResumed).toBe(true);

    const runRes = await pool.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", ["tenant_dev", runId]);
    expect(runRes.rows[0]?.status).toBe("queued");

    const stepRes = await pool.query("SELECT status FROM steps WHERE step_id = $1 LIMIT 1", [stepId]);
    expect(stepRes.rows[0]?.status).toBe("pending");

    const taskState = await ctx.app.inject({
      method: "GET",
      url: `/task-states/${encodeURIComponent(runId)}`,
      headers: { ...h, "x-trace-id": `t-device-state-${crypto.randomUUID()}` },
    });
    expect(taskState.statusCode).toBe(200);
    const stateBody = taskState.json() as any;
    expect(stateBody.phase).toBe("executing");
    expect(stateBody.blockReason).toBeNull();
    expect(stateBody.nextAction).toBeNull();
  });
});
