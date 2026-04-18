import {
  afterAll,
  beforeAll,
  crypto,
  describe,
  expect,
  getTestContext,
  makeHeaders,
  pool,
  releaseTestContext,
  TEST_SCHEMA_NAME,
  type TestContext,
  it,
} from "./setup";

describe.sequential("e2e:dispatch", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("dispatch：auto + fastClassify 的纯问答请求不创建 run/task", async () => {
    if (!ctx.canRun) return;
    const headers = {
      ...makeHeaders("admin", `t-dispatch-answer-${crypto.randomUUID()}`),
      "content-type": "application/json",
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers,
      payload: JSON.stringify({
        message: "你好",
        mode: "auto",
        fastClassify: true,
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.mode).toBe("answer");
    expect(body.taskId ?? null).toBeNull();
    expect(body.runId ?? null).toBeNull();
    expect(typeof body.replyText).toBe("string");
  });

  it("dispatch：execute + toolSuggestions 会创建 needs_approval run/step/approval 并持久化 constraints", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-dispatch-approval-${crypto.randomUUID()}`;
    const headers = {
      ...makeHeaders("admin", traceId),
      "content-type": "application/json",
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers,
      payload: JSON.stringify({
        message: "请创建一条测试记录",
        mode: "execute",
        constraints: {
          allowedTools: ["entity.create", "entity.create@1"],
          allowWrites: true,
          maxSteps: 3,
          maxWallTimeMs: 30_000,
        },
        toolSuggestions: [
          {
            toolRef: "entity.create@1",
            inputDraft: {
              schemaName: TEST_SCHEMA_NAME,
              entityName: "test_items",
              payload: { title: `dispatch-e2e-${crypto.randomUUID()}` },
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.mode).toBe("execute");
    expect(body.phase).toBe("needs_approval");
    expect(typeof body.runId).toBe("string");
    expect(typeof body.taskId).toBe("string");
    expect(typeof body.jobId).toBe("string");

    const runRes = await pool.query(
      "SELECT status, input_digest FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
      ["tenant_dev", body.runId],
    );
    expect(runRes.rowCount).toBe(1);
    expect(runRes.rows[0]?.status).toBe("needs_approval");
    expect(runRes.rows[0]?.input_digest?.constraints).toEqual({
      allowedTools: ["entity.create", "entity.create@1"],
      allowWrites: true,
      maxSteps: 3,
      maxWallTimeMs: 30_000,
    });

    const taskStateRes = await pool.query(
      "SELECT phase, plan FROM memory_task_states WHERE tenant_id = $1 AND run_id = $2 AND deleted_at IS NULL LIMIT 1",
      ["tenant_dev", body.runId],
    );
    expect(taskStateRes.rowCount).toBe(1);
    expect(taskStateRes.rows[0]?.phase).toBe("needs_approval");
    expect(taskStateRes.rows[0]?.plan?.agentLoop).toBe(false);
    expect(taskStateRes.rows[0]?.plan?.constraints).toEqual({
      allowedTools: ["entity.create", "entity.create@1"],
      allowWrites: true,
      maxSteps: 3,
      maxWallTimeMs: 30_000,
    });

    const stepRes = await pool.query(
      "SELECT status, tool_ref FROM steps WHERE run_id = $1 ORDER BY seq ASC",
      [body.runId],
    );
    expect(stepRes.rowCount).toBe(1);
    expect(stepRes.rows[0]?.status).toBe("needs_approval");
    expect(stepRes.rows[0]?.tool_ref).toBe("entity.create@1");

    const approvalRes = await pool.query(
      "SELECT status, tool_ref, run_id FROM approvals WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1",
      ["tenant_dev", body.runId],
    );
    expect(approvalRes.rowCount).toBe(1);
    expect(approvalRes.rows[0]?.status).toBe("pending");
    expect(approvalRes.rows[0]?.tool_ref).toBe("entity.create@1");

    const taskStateView = await ctx.app.inject({
      method: "GET",
      url: `/task-states/${encodeURIComponent(String(body.runId))}`,
      headers: makeHeaders("admin", `t-dispatch-run-view-${crypto.randomUUID()}`),
    });
    expect(taskStateView.statusCode).toBe(200);
    const taskStateBody = taskStateView.json() as any;
    expect(taskStateBody.phase).toBe("needs_approval");
    expect(taskStateBody.needsApproval).toBe(true);

    const runView = await ctx.app.inject({
      method: "GET",
      url: `/runs/${encodeURIComponent(String(body.runId))}`,
      headers: makeHeaders("admin", `t-dispatch-run-status-${crypto.randomUUID()}`),
    });
    expect(runView.statusCode).toBe(200);
    const runViewBody = runView.json() as any;
    expect(runViewBody.run?.status ?? runViewBody.status).toBe("needs_approval");

    const jobView = await ctx.app.inject({
      method: "GET",
      url: `/jobs/${encodeURIComponent(String(body.jobId))}`,
      headers: makeHeaders("admin", `t-dispatch-job-view-${crypto.randomUUID()}`),
    });
    expect(jobView.statusCode).toBe(200);
    const jobViewBody = jobView.json() as any;
    expect(Array.isArray(jobViewBody.steps)).toBe(true);
    expect(jobViewBody.steps[0]?.status).toBe("needs_approval");
  });
});
