import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const mockRunAgentLoop = vi.fn();

vi.mock("../kernel/agentLoop", () => ({
  runAgentLoop: (...args: any[]) => mockRunAgentLoop(...args),
}));

import { internalRoutes } from "./internal";

function createBody(overrides: Partial<Record<string, any>> = {}) {
  return {
    loopId: "loop-1",
    runId: "run-1",
    jobId: "job-1",
    taskId: "task-1",
    tenantId: "tenant-1",
    spaceId: "space-1",
    goal: "resume loop",
    maxIterations: 12,
    maxWallTimeMs: 60_000,
    subjectPayload: { subjectId: "subject-1" },
    locale: "zh-CN",
    authorization: "Bearer test",
    traceId: "trace-1",
    defaultModelRef: "mock:echo-1",
    executionConstraints: { allowedTools: ["tool.a@1"], allowWrites: false },
    resumeState: {
      iteration: 3,
      currentSeq: 5,
      succeededSteps: 2,
      failedSteps: 1,
      observations: [],
      lastDecision: { action: "tool_call" },
      toolDiscoveryCache: { tools: [] },
      memoryContext: "memory",
      taskHistory: "history",
      knowledgeContext: "knowledge",
    },
    ...overrides,
  };
}

function createCheckpointRow(body: ReturnType<typeof createBody>) {
  return {
    tenant_id: body.tenantId,
    space_id: body.spaceId,
    run_id: body.runId,
    job_id: body.jobId,
    task_id: body.taskId,
    goal: body.goal,
    max_iterations: body.maxIterations,
    max_wall_time_ms: String(body.maxWallTimeMs),
    subject_payload: body.subjectPayload,
    decision_context: { executionConstraints: body.executionConstraints },
  };
}

function buildTestApp(query: ReturnType<typeof vi.fn>) {
  const app = Fastify({ logger: false });
  (app as any).decorate("db", { query });
  (app as any).decorate("queue", {});
  app.register(internalRoutes);
  return app as FastifyInstance;
}

async function flushAsyncWork(times: number = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("internalRoutes", () => {
  let app: FastifyInstance;
  let query: ReturnType<typeof vi.fn>;
  const originalSecret = process.env.INTERNAL_API_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_API_SECRET = "secret";
    query = vi.fn();
    app = buildTestApp(query);
    await app.ready();
  });

  afterAll(async () => {
    process.env.INTERNAL_API_SECRET = originalSecret;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    query.mockReset();
    mockRunAgentLoop.mockResolvedValue({ ok: true, endReason: "done", iterations: 3 });
  });

  it("拒绝缺少正确 internal secret 的请求", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/loop-resume",
      payload: createBody(),
      headers: {
        "x-internal-secret": "wrong",
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", message: "invalid internal secret" });
  });

  it("在 payload 与 checkpoint 不匹配时返回 409", async () => {
    const body = createBody();
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [createCheckpointRow(createBody({ goal: "different goal" }))],
    });

    const res = await app.inject({
      method: "POST",
      url: "/internal/loop-resume",
      payload: body,
      headers: {
        "x-internal-secret": "secret",
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "payload_mismatch", message: "loop resume payload does not match checkpoint" });
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  it("接受合法恢复请求并异步启动 runAgentLoop", async () => {
    const body = createBody();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT tenant_id, space_id, run_id")) {
        return { rowCount: 1, rows: [createCheckpointRow(body)] };
      }
      if (sql.includes("SET status = 'resuming'")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const res = await app.inject({
      method: "POST",
      url: "/internal/loop-resume",
      payload: body,
      headers: {
        "x-internal-secret": "secret",
        "x-source": "worker-loop-resume",
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      ok: true,
      loopId: "loop-1",
      runId: "run-1",
      message: "loop resume dispatched",
    });
    expect(mockRunAgentLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        jobId: "job-1",
        taskId: "task-1",
        goal: "resume loop",
        resumeLoopId: "loop-1",
        resumeState: body.resumeState,
      }),
    );
  });

  it("在异步恢复失败时回退 checkpoint 为 running", async () => {
    const body = createBody();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT tenant_id, space_id, run_id")) {
        return { rowCount: 1, rows: [createCheckpointRow(body)] };
      }
      if (sql.includes("SET status = 'resuming'")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("SET status = 'running'")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });
    mockRunAgentLoop.mockRejectedValueOnce(new Error("resume_failed"));

    const res = await app.inject({
      method: "POST",
      url: "/internal/loop-resume",
      payload: body,
      headers: {
        "x-internal-secret": "secret",
      },
    });

    expect(res.statusCode).toBe(202);
    await flushAsyncWork();
    expect(query).toHaveBeenCalledWith(
      "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1 AND status = 'resuming'",
      ["loop-1"],
    );
  });
});
