import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processLoopResume, type LoopResumePayload } from "./loopResumeHandler";

function createPayload(): LoopResumePayload {
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
  };
}

function createPool(status: string | null = "running") {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status FROM agent_loop_checkpoints")) {
        if (status === null) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ status }] };
      }
      if (sql.includes("UPDATE agent_loop_checkpoints SET status = 'running'")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
  } as any;
}

describe("processLoopResume", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("在 checkpoint 不存在时返回 checkpoint_not_found", async () => {
    const result = await processLoopResume(createPayload(), {
      pool: createPool(null),
      apiEndpoints: ["http://api-a"],
      internalSecret: "secret",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("checkpoint_not_found");
  });

  it("成功调用内部恢复接口并返回命中的 api 节点", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ ok: true }),
      text: async () => "",
    } as any);

    const payload = createPayload();
    const result = await processLoopResume(payload, {
      pool: createPool("running"),
      apiEndpoints: ["http://api-a"],
      internalSecret: "secret",
    });

    expect(result.ok).toBe(true);
    expect(result.apiNode).toBe("http://api-a");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api-a/internal/loop-resume",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-internal-secret": "secret",
          "x-source": "worker-loop-resume",
          "x-loop-id": payload.loopId,
        }),
        body: JSON.stringify(payload),
      }),
    );
  });

  it("在 API 持续失败后回滚 checkpoint 状态", async () => {
    const pool = createPool("running");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server error",
    } as any);

    const result = await processLoopResume(createPayload(), {
      pool,
      apiEndpoints: ["http://api-a"],
      internalSecret: "secret",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("all_retries_failed");
    expect(pool.query).toHaveBeenCalledWith(
      "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1 AND status = 'resuming'",
      ["loop-1"],
    );
    expect(fetchMock).toHaveBeenCalled();
  });
});
