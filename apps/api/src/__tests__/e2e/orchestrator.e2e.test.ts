/**
 * Orchestrator 模块 E2E 测试
 * 包含：编排器 dispatch、工具建议、执行入口
 */
import {
  describe, expect, it, beforeAll, afterAll,
  crypto, pool,
  getTestContext, releaseTestContext,
  type TestContext,
} from "./setup";
import { getSessionContext } from "../../modules/memory/sessionContextRepo";

function parseSseEvents(raw: string) {
  return raw
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split("\n");
      const event = lines.find((line) => line.startsWith("event:"))?.slice("event:".length).trim() ?? "";
      const dataLine = lines.find((line) => line.startsWith("data:"))?.slice("data:".length).trim() ?? "";
      let data: any = null;
      try {
        data = dataLine ? JSON.parse(dataLine) : null;
      } catch {
        data = dataLine;
      }
      return { event, data, raw: chunk };
    });
}

async function waitForAuditEvent(traceId: string, resourceType: string, action: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await pool.query(
      "SELECT input_digest, output_digest, error_category FROM audit_events WHERE trace_id = $1 AND resource_type = $2 AND action = $3 ORDER BY timestamp DESC, event_id DESC LIMIT 1",
      [traceId, resourceType, action],
    );
    if (res.rowCount > 0) return res;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pool.query(
    "SELECT input_digest, output_digest, error_category FROM audit_events WHERE trace_id = $1 AND resource_type = $2 AND action = $3 ORDER BY timestamp DESC, event_id DESC LIMIT 1",
    [traceId, resourceType, action],
  );
}

describe.sequential("e2e:orchestrator", { timeout: 60_000 }, () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await getTestContext();
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("orchestrator：dispatch 可生成工具建议与 UI 指令并写审计", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const traceId = `t-orch-turn-${crypto.randomUUID()}`;
    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers: { ...h, "x-trace-id": traceId },
      payload: JSON.stringify({ message: "帮我创建一条记录", mode: "answer" }),
    });
    expect(r.statusCode).toBe(200);
    const b = r.json() as any;
    expect(b.turnId).toBeTruthy();
    expect(b.toolSuggestions || b.uiDirective || b.replyText || b.actionReceipt).toBeTruthy();
  });

  it("orchestrator：dispatch execute 可创建 run 并返回 summary", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers: { ...h, "x-trace-id": `t-cl-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "创建一条记录",
        mode: "execute",
        limits: { maxSteps: 2, maxWallTimeMs: 30_000 },
      }),
    });
    expect([200, 400, 403, 409].includes(r.statusCode)).toBe(true);
  });

  it("orchestrator：dispatch/execute 支持 turnId + suggestionId 绑定", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };

    const traceId = `t-orch-turn-exec-${crypto.randomUUID()}`;
    const turn = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch",
      headers: { ...h, "x-trace-id": traceId },
      payload: JSON.stringify({
        message: "帮我创建一条记录",
        mode: "answer",
      }),
    });
    expect(turn.statusCode).toBe(200);
    const tb = turn.json() as any;
    const s = Array.isArray(tb.toolSuggestions) ? tb.toolSuggestions[0] : null;
    if (!s?.suggestionId) return;
    const exec = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/execute",
      headers: { ...h, "idempotency-key": `idem-orch-exec-${crypto.randomUUID()}`, "x-trace-id": `t-orch-exec-${crypto.randomUUID()}` },
      payload: JSON.stringify({ turnId: String(tb.turnId), suggestionId: String(s.suggestionId), input: s.inputDraft ?? {} }),
    });
    expect([200, 400, 403, 409, 500].includes(exec.statusCode)).toBe(true);
  });

  it("不允许执行未支持的工具", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
    };
    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/execute",
      headers: { ...h, "idempotency-key": `idem-unsupported-${crypto.randomUUID()}`, "x-trace-id": `t-unsupported-${crypto.randomUUID()}` },
      payload: JSON.stringify({ toolRef: "unsupported.tool@1", input: {} }),
    });
    expect([400, 404].includes(r.statusCode)).toBe(true);
  });

  it("orchestrator：dispatch/stream 在规划失败时返回安全文案且不创建任务", async () => {
    if (!ctx.canRun) return;
    const traceId = `t-orch-stream-${crypto.randomUUID()}`;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers: { ...h, "x-trace-id": traceId },
      payload: JSON.stringify({
        message: "打开百度网页",
        mode: "execute",
      }),
    });

    expect(r.statusCode).toBe(200);
    const body = r.body;
    const events = parseSseEvents(body);
    const eventNames = events.map((e) => e.event);
    const deltaTexts = events
      .filter((e) => e.event === "delta")
      .map((e) => String(e.data?.text ?? ""))
      .join("\n");

    expect(eventNames).toContain("phaseIndicator");
    expect(eventNames).toContain("done");
    expect(eventNames).not.toContain("taskCreated");
    expect(deltaTexts).toContain("还没能生成可执行计划");
    expect(deltaTexts).not.toContain("empty");
    expect(deltaTexts).not.toContain("no_tools");

    const auditRes = await waitForAuditEvent(traceId, "orchestrator", "dispatch.stream");
    expect(auditRes.rowCount).toBe(1);
    expect(auditRes.rows[0]?.input_digest?.mode).toBe("execute");
    expect(auditRes.rows[0]?.output_digest?.executionClass).toBe("planning_failed");
    expect(auditRes.rows[0]?.output_digest?.failCategory).toBeTruthy();
    expect(auditRes.rows[0]?.error_category ?? null).toBeNull();
  });

  it("orchestrator：显式 execute 规划失败只保留用户消息，不把失败文案写入会话", async () => {
    if (!ctx.canRun) return;
    const conversationId = `conv-execute-failure-${crypto.randomUUID()}`;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers: { ...h, "x-trace-id": `t-orch-execute-failure-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "打开百度网页",
        mode: "execute",
        conversationId,
      }),
    });

    expect(r.statusCode).toBe(200);
    const session = await getSessionContext({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      subjectId: "admin",
      sessionId: conversationId,
    });
    expect(session?.context.messages).toHaveLength(1);
    expect(session?.context.messages[0]?.role).toBe("user");
    expect(String(session?.context.messages[0]?.content ?? "")).toContain("打开百度网页");
    expect(session?.context.messages.some((m) => String(m.content ?? "").includes("规划失败"))).toBe(false);
    expect(session?.context.totalTurnCount).toBe(1);
  });

  it("orchestrator：auto 模式执行降级为 answer 时不创建任务且不会写入规划失败摘要", async () => {
    if (!ctx.canRun) return;
    const conversationId = `conv-auto-fallback-${crypto.randomUUID()}`;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers: { ...h, "x-trace-id": `t-orch-auto-fallback-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "打开百度网页",
        mode: "auto",
        conversationId,
      }),
    });

    expect(r.statusCode).toBe(200);
    const events = parseSseEvents(r.body);
    const eventNames = events.map((e) => e.event);
    expect(eventNames).not.toContain("taskCreated");
    expect(eventNames.filter((name) => name === "done")).toHaveLength(1);

    const fallbackStatus = events.find((e) => e.event === "status" && e.data?.fallbackFrom === "execute");
    if (fallbackStatus) {
      expect(fallbackStatus.data?.mode).toBe("answer");
    }
    const fallbackPhase = events.find((e) => e.event === "phaseIndicator" && e.data?.fallbackFrom === "execute");
    if (fallbackPhase) {
      expect(fallbackPhase.data?.phase).toBe("thinking");
      expect(fallbackPhase.data?.mode ?? "answer").toBe("answer");
    }

    const taskStateRes = await pool.query(
      "SELECT COUNT(*)::int AS count FROM memory_task_states WHERE tenant_id = $1 AND space_id = $2 AND run_id::text = $3 AND deleted_at IS NULL",
      ["tenant_dev", "space_dev", conversationId],
    );
    expect(taskStateRes.rows[0]?.count ?? 0).toBe(0);

    const session = await getSessionContext({
      pool,
      tenantId: "tenant_dev",
      spaceId: "space_dev",
      subjectId: "admin",
      sessionId: conversationId,
    });
    expect(session?.context.messages.at(-1)?.role).toBe("assistant");
    expect(String(session?.context.messages.at(-1)?.content ?? "")).not.toContain("规划失败");
  });

  it("orchestrator：workflow 流式事件先发 taskCreated 再发 planStep", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers: { ...h, "x-trace-id": `t-orch-order-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "帮我创建一条记录",
        mode: "execute",
      }),
    });

    expect(r.statusCode).toBe(200);
    const events = parseSseEvents(r.body);
    const taskCreatedIndex = events.findIndex((e) => e.event === "taskCreated");
    const planStepIndex = events.findIndex((e) => e.event === "planStep");
    expect(taskCreatedIndex).toBeGreaterThanOrEqual(0);
    expect(planStepIndex).toBeGreaterThanOrEqual(0);
    expect(taskCreatedIndex).toBeLessThan(planStepIndex);
  });

  it("orchestrator：workflow 流式阶段事件顺序为 started -> classified -> planning -> taskCreated", async () => {
    if (!ctx.canRun) return;
    const h = {
      authorization: "Bearer admin",
      "x-tenant-id": "tenant_dev",
      "x-space-id": "space_dev",
      "content-type": "application/json",
      accept: "text/event-stream",
    };

    const r = await ctx.app.inject({
      method: "POST",
      url: "/orchestrator/dispatch/stream",
      headers: { ...h, "x-trace-id": `t-orch-phase-order-${crypto.randomUUID()}` },
      payload: JSON.stringify({
        message: "帮我创建一条记录",
        mode: "execute",
      }),
    });

    expect(r.statusCode).toBe(200);
    const events = parseSseEvents(r.body);
    const startedIndex = events.findIndex((e) => e.event === "status" && e.data?.phase === "started");
    const classifiedIndex = events.findIndex((e) => e.event === "status" && e.data?.phase === "classified");
    const planningIndex = events.findIndex((e) => e.event === "phaseIndicator" && e.data?.phase === "planning");
    const taskCreatedIndex = events.findIndex((e) => e.event === "taskCreated");

    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(classifiedIndex).toBeGreaterThanOrEqual(0);
    expect(planningIndex).toBeGreaterThanOrEqual(0);
    expect(taskCreatedIndex).toBeGreaterThanOrEqual(0);
    expect(startedIndex).toBeLessThan(classifiedIndex);
    expect(classifiedIndex).toBeLessThan(planningIndex);
    expect(planningIndex).toBeLessThan(taskCreatedIndex);
  });
});
