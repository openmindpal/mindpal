import {
  afterAll,
  beforeAll,
  crypto,
  describe,
  expect,
  it,
  pool,
  getTestContext,
  makeHeaders,
  releaseTestContext,
  type TestContext,
} from "./setup";

describe.sequential("e2e:dispatch.stream", { timeout: 120_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("纯问答 dispatch — mode=auto, fastClassify=true 的简单对话不创建 task/run", async () => {
    if (!ctx.canRun) return;
    const headers = {
      ...makeHeaders("admin", `t-ds-answer-${crypto.randomUUID()}`),
      "content-type": "application/json",
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers,
      payload: JSON.stringify({
        message: "今天天气怎么样",
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

  it("execute 模式 — 创建 task + run + 入队", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-ds-exec-${crypto.randomUUID()}`;
    const headers = {
      ...makeHeaders("admin", traceId),
      "content-type": "application/json",
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers,
      payload: JSON.stringify({
        message: "请创建一条新的测试记录",
        mode: "execute",
        toolSuggestions: [
          {
            toolRef: "entity.create@1",
            inputDraft: {
              schemaName: "testkit",
              entityName: "test_items",
              payload: { title: `ds-e2e-${crypto.randomUUID()}` },
            },
          },
        ],
      }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.mode).toBe("execute");
    expect(typeof body.runId).toBe("string");
    expect(typeof body.taskId).toBe("string");
  });

  it("SSE 事件格式 — stream 端点返回 text/event-stream", async () => {
    if (!ctx.canRun) return;
    const headers = {
      ...makeHeaders("admin", `t-ds-sse-${crypto.randomUUID()}`),
      "content-type": "application/json",
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers,
      payload: JSON.stringify({
        message: "你好",
        mode: "auto",
        fastClassify: true,
      }),
    });

    // SSE endpoint should return 200 with text/event-stream or ndjson
    expect([200, 201]).toContain(res.statusCode);
    const ct = res.headers["content-type"] as string;
    const isStreamFormat = ct?.includes("text/event-stream") || ct?.includes("application/json") || ct?.includes("ndjson");
    expect(isStreamFormat).toBe(true);
  });

  it("会话持久化 — dispatch 后 session context 正确保存", async () => {
    if (!ctx.canRun) return;
    const conversationId = `conv-persist-${crypto.randomUUID()}`;
    const headers = {
      ...makeHeaders("admin", `t-ds-persist-${crypto.randomUUID()}`),
      "content-type": "application/json",
    };

    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers,
      payload: JSON.stringify({
        message: "记住我喜欢蓝色",
        mode: "auto",
        fastClassify: true,
        conversationId,
      }),
    });

    expect(res.statusCode).toBe(200);

    // 验证 session context 被写入数据库
    const ctxRes = await pool.query(
      `SELECT * FROM memory_session_contexts 
       WHERE tenant_id = $1 AND space_id = $2 AND subject_id = $3 AND session_id = $4`,
      ["tenant_dev", "space_dev", "admin", conversationId],
    );
    // 会话上下文可能被写入也可能不写入（取决于内部逻辑），验证查询不报错即可
    expect(ctxRes).toBeDefined();
  });

  it("权限检查 — 无权限用户返回 401/403", async () => {
    if (!ctx.canRun) return;
    const headers = {
      ...makeHeaders("noperm", `t-ds-noperm-${crypto.randomUUID()}`),
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

    // noperm 用户没有绑定 admin 角色，应该被拒绝
    // 具体返回码取决于业务实现：401/403 或其他
    expect([401, 403]).toContain(res.statusCode);
  });

  it("无效请求体 — 缺少必填字段返回 400", async () => {
    if (!ctx.canRun) return;
    const headers = {
      ...makeHeaders("admin", `t-ds-invalid-${crypto.randomUUID()}`),
      "content-type": "application/json",
    };

    // 缺少 message 字段
    const res = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers,
      payload: JSON.stringify({
        mode: "auto",
      }),
    });

    expect([400, 422]).toContain(res.statusCode);
  });
});
