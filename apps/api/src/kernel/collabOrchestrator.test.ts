import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  invokeModelChat,
  runAgentLoop,
  discoverEnabledTools,
  setCollabRunPrimaryRun,
  updateCollabRunStatus,
  upsertTaskState,
} = vi.hoisted(() => ({
  invokeModelChat: vi.fn(),
  runAgentLoop: vi.fn(),
  discoverEnabledTools: vi.fn(),
  setCollabRunPrimaryRun: vi.fn(),
  updateCollabRunStatus: vi.fn(),
  upsertTaskState: vi.fn(),
}));

vi.mock("../lib/llm", () => ({
  invokeModelChat,
}));

vi.mock("./agentLoop", () => ({
  runAgentLoop,
}));

vi.mock("../modules/agentContext", () => ({
  discoverEnabledTools,
}));

vi.mock("../modules/agentRuntime/collabRepo", () => ({
  setCollabRunPrimaryRun,
  updateCollabRunStatus,
}));

vi.mock("../modules/memory/repo", () => ({
  upsertTaskState,
}));

import { runCollabOrchestrator, runDebatePhase } from "./collabOrchestrator";

function createParams() {
  return {
    app: {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any,
    pool: {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any,
    queue: {} as any,
    subject: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      subjectId: "subject-1",
    } as any,
    locale: "zh-CN",
    authorization: null,
    traceId: "trace-1",
    goal: "完成复杂协作任务",
    taskId: "task-1",
    collabRunId: "11111111-1111-1111-1111-111111111111",
  };
}

describe("runCollabOrchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoverEnabledTools.mockResolvedValue({ catalog: "- tool@1.0" });
    setCollabRunPrimaryRun.mockResolvedValue(null);
    updateCollabRunStatus.mockResolvedValue(null);
    upsertTaskState.mockResolvedValue(null);
  });

  it("在规划失败时真正回退到单 Agent 执行", async () => {
    invokeModelChat.mockResolvedValue({ outputText: "not a valid plan" });
    runAgentLoop.mockResolvedValue({
      ok: true,
      endReason: "done",
      message: "fallback done",
      iterations: 1,
      succeededSteps: 1,
      failedSteps: 0,
      observations: [],
    });

    const params = createParams();
    const result = await runCollabOrchestrator(params as any);

    expect(result.ok).toBe(true);
    expect(result.endReason).toBe("all_done");
    expect(result.agentResults).toHaveLength(1);
    expect(result.agentResults[0].agentId).toBe("fallback");
    expect(runAgentLoop).toHaveBeenCalledTimes(1);
    expect(setCollabRunPrimaryRun).toHaveBeenCalledTimes(1);
    expect(updateCollabRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ collabRunId: params.collabRunId, status: "executing" }),
    );
  });

  it("在 parallel 策略下为每个 Agent 写入结构化信封", async () => {
    invokeModelChat.mockResolvedValue({
      outputText: `\`\`\`collab_plan
{
  "strategy": "parallel",
  "reasoning": "independent",
  "agents": [
    { "agentId": "agent_1", "role": "research", "goal": "收集资料", "dependencies": [] },
    { "agentId": "agent_2", "role": "writer", "goal": "整理输出", "dependencies": [] }
  ]
}
\`\`\``,
    });
    runAgentLoop.mockResolvedValue({
      ok: true,
      endReason: "done",
      message: "done",
      iterations: 1,
      succeededSteps: 1,
      failedSteps: 0,
      observations: [],
    });

    const params = createParams();
    const result = await runCollabOrchestrator(params as any);

    expect(result.ok).toBe(true);
    expect(runAgentLoop).toHaveBeenCalledTimes(2);
    const envelopeWrites = (params.pool.query as any).mock.calls.filter(([sql]: [string]) => String(sql).includes("INSERT INTO collab_envelopes"));
    expect(envelopeWrites.length).toBeGreaterThanOrEqual(2);
  });
});

/* ================================================================== */
/*  runDebatePhase — 辩论阶段集成测试                                    */
/* ================================================================== */

function createDebateParams(overrides?: Partial<Record<string, any>>) {
  return {
    app: {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as any,
    pool: {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any,
    queue: {} as any,
    subject: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      subjectId: "subject-1",
    } as any,
    locale: "zh-CN",
    authorization: null,
    traceId: "trace-debate",
    collabRunId: "22222222-2222-2222-2222-222222222222",
    taskId: "task-debate-1",
    topic: "应该用 React 还是 Vue",
    sideA: { agentId: "agent_a", role: "architect", goal: "推荐 React" },
    sideB: { agentId: "agent_b", role: "frontend_lead", goal: "推荐 Vue" },
    maxRounds: 2,
    maxIterationsPerRound: 3,
    ...overrides,
  };
}

describe("runDebatePhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("2 轮对抗后未收敛 → max_rounds_reached + arbiter 仲裁", async () => {
    // 每次 runAgentLoop 返回不同 Agent 的输出
    let callCount = 0;
    runAgentLoop.mockImplementation(async (params: any) => {
      callCount++;
      const goal = params.goal as string;
      // 根据 goal 内容区分正方/反方/仲裁
      if (goal.includes("impartial arbiter")) {
        // 仲裁输出
        return {
          ok: true, endReason: "done", iterations: 1,
          succeededSteps: 1, failedSteps: 0, observations: [],
          message: `**Outcome**: side_a_wins
**Winner**: architect
**Reasoning**: React 生态更成熟
**Synthesized Conclusion**: React 更适合
**Round Scores**: Round 0: 0.7, 0.6 Round 1: 0.8, 0.5`,
        };
      }
      // 正方/反方 — 模拟有分歧（低置信度）
      const isFirstInRound = goal.includes('Present your initial position') || !goal.includes('Opponent');
      return {
        ok: true, endReason: "done", iterations: 1,
        succeededSteps: 1, failedSteps: 0, observations: [],
        message: `**Claim**: ${isFirstInRound ? '选 React' : '选 Vue'}\n**Reasoning**: 各有优势\n**Evidence**: 社区数据\n**Confidence**: 0.6`,
      };
    });

    const params = createDebateParams();
    const session = await runDebatePhase(params as any);

    // 验证辩论结构
    expect(session.debateId).toBeTruthy();
    expect(session.rounds).toHaveLength(2);
    expect(session.sideA).toBe("architect");
    expect(session.sideB).toBe("frontend_lead");

    // 2 轮 × 2 Agent + 1 仲裁 = 5 次 runAgentLoop
    expect(runAgentLoop).toHaveBeenCalledTimes(5);

    // 最终应有仲裁裁决
    expect(session.status).toBe("verdicted");
    expect(session.verdict).toBeDefined();
    expect(session.verdict!.outcome).toBe("side_a_wins");
    expect(session.verdict!.winnerRole).toBe("architect");

    // 审计信封应被写入
    const envelopeWrites = (params.pool.query as any).mock.calls.filter(
      ([sql]: [string]) => String(sql).includes("INSERT INTO collab_envelopes"),
    );
    expect(envelopeWrites.length).toBeGreaterThanOrEqual(1);
  });

  it("第 1 轮即收敛 → converged + 仲裁", async () => {
    runAgentLoop.mockImplementation(async (params: any) => {
      const goal = params.goal as string;
      if (goal.includes("impartial arbiter")) {
        return {
          ok: true, endReason: "done", iterations: 1,
          succeededSteps: 1, failedSteps: 0, observations: [],
          message: `**Outcome**: synthesis\n**Reasoning**: 综合双方优势\n**Synthesized Conclusion**: 两框架各取所长`,
        };
      }
      // 双方高置信度、无分歧（收敛条件）
      return {
        ok: true, endReason: "done", iterations: 1,
        succeededSteps: 1, failedSteps: 0, observations: [],
        message: `**Claim**: React 和 Vue 各有优势\n**Reasoning**: 经讨论达成一致\n**Confidence**: 0.9`,
      };
    });

    const params = createDebateParams({ maxRounds: 5 });
    const session = await runDebatePhase(params as any);

    // 应该只有 1 轮就收敛了
    expect(session.rounds.length).toBeLessThanOrEqual(2);
    // 状态应是 verdicted（收敛后仍会进入仲裁）
    expect(session.status).toBe("verdicted");
    expect(session.verdict).toBeDefined();
    expect(session.verdict!.outcome).toBe("synthesis");

    // 1 轮 × 2 Agent + 1 仲裁 = 3 次
    const totalCalls = runAgentLoop.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(3);
    expect(totalCalls).toBeLessThanOrEqual(5); // 至多 2 轮
  });

  it("signal 中止 → aborted 且无仲裁", async () => {
    const controller = new AbortController();
    // 第一次 runAgentLoop 成功后中止
    runAgentLoop.mockImplementation(async () => {
      controller.abort();
      return {
        ok: true, endReason: "done", iterations: 1,
        succeededSteps: 1, failedSteps: 0, observations: [],
        message: `**Claim**: test\n**Confidence**: 0.5`,
      };
    });

    const params = createDebateParams({ signal: controller.signal, maxRounds: 3 });
    const session = await runDebatePhase(params as any);

    expect(session.status).toBe("aborted");
    expect(session.verdict).toBeUndefined();
  });

  it("仲裁失败时降级为无裁决", async () => {
    let callIdx = 0;
    runAgentLoop.mockImplementation(async (params: any) => {
      callIdx++;
      const goal = params.goal as string;
      if (goal.includes("impartial arbiter")) {
        throw new Error("arbiter model unavailable");
      }
      return {
        ok: true, endReason: "done", iterations: 1,
        succeededSteps: 1, failedSteps: 0, observations: [],
        message: `**Claim**: test claim ${callIdx}\n**Confidence**: 0.5`,
      };
    });

    const params = createDebateParams({ maxRounds: 1 });
    const session = await runDebatePhase(params as any);

    // 辩论轮次正常完成
    expect(session.rounds).toHaveLength(1);
    // 仲裁失败 → 没有 verdict 但不会 throw
    expect(session.verdict).toBeUndefined();
    // 状态应是 max_rounds_reached（仲裁失败不改变状态）
    expect(session.status).toBe("max_rounds_reached");
    // warn 日志应被调用
    expect(params.app.log.warn).toHaveBeenCalled();
  });

  it("DB 写入 runs/jobs 被正确调用", async () => {
    runAgentLoop.mockResolvedValue({
      ok: true, endReason: "done", iterations: 1,
      succeededSteps: 1, failedSteps: 0, observations: [],
      message: `**Claim**: test\n**Confidence**: 0.5`,
    });

    const params = createDebateParams({ maxRounds: 1 });
    await runDebatePhase(params as any);

    const queryCalls = (params.pool.query as any).mock.calls;
    // 每个 Agent 每轮 2 次 DB INSERT (runs + jobs) + 仲裁 2 次 + envelopes 1 次
    // 1 轮 × 2 Agent × 2 + 1 仲裁 × 2 + 1 envelope = 7
    const insertRunsCalls = queryCalls.filter(([sql]: [string]) => String(sql).includes("INSERT INTO runs"));
    const insertJobsCalls = queryCalls.filter(([sql]: [string]) => String(sql).includes("INSERT INTO jobs"));
    expect(insertRunsCalls.length).toBeGreaterThanOrEqual(2); // 至少 2 Agent 的 runs
    expect(insertJobsCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("辩论 goal 包含正确的角色和主题信息", async () => {
    runAgentLoop.mockResolvedValue({
      ok: true, endReason: "done", iterations: 1,
      succeededSteps: 1, failedSteps: 0, observations: [],
      message: `**Claim**: test\n**Confidence**: 0.5`,
    });

    const params = createDebateParams({ maxRounds: 1 });
    await runDebatePhase(params as any);

    const calls = runAgentLoop.mock.calls;
    // 第一次调用（正方）的 goal 应包含 topic
    const firstGoal = (calls[0] as any)[0].goal as string;
    expect(firstGoal).toContain("应该用 React 还是 Vue");
    expect(firstGoal).toContain("architect");

    // 第二次调用（反方）的 goal 应包含正方立场
    const secondGoal = (calls[1] as any)[0].goal as string;
    expect(secondGoal).toContain("应该用 React 还是 Vue");
    expect(secondGoal).toContain("frontend_lead");
  });
});
