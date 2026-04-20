import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runAgentLoop,
  writeCollabEnvelope,
  collabConfigMock,
} = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  writeCollabEnvelope: vi.fn(),
  collabConfigMock: vi.fn(),
}));

vi.mock("./agentLoop", () => ({
  runAgentLoop,
}));

vi.mock("./collabEnvelope", () => ({
  writeCollabEnvelope,
}));

vi.mock("@openslin/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@openslin/shared")>();
  return {
    ...original,
    collabConfig: collabConfigMock,
  };
});

import {
  runCrossValidationPhase,
  runDynamicCorrectionPhase,
  recordRolePerformance,
} from "./collabValidation";
import type { AgentState, CollabOrchestratorParams } from "./collabTypes";

/* ================================================================== */
/*  共用工厂                                                            */
/* ================================================================== */

function createOrchestratorParams(overrides?: Partial<Record<string, any>>): CollabOrchestratorParams {
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
    traceId: "trace-cv",
    goal: "测试任务",
    taskId: "task-1",
    collabRunId: "cr-11111111-1111-1111-1111-111111111111",
    ...overrides,
  } as CollabOrchestratorParams;
}

function makeAgentState(id: string, role: string, opts?: Partial<AgentState>): AgentState {
  return {
    agentId: id,
    role,
    goal: `完成 ${role} 工作`,
    runId: `run-${id}`,
    jobId: `job-${id}`,
    status: "done",
    result: {
      ok: true,
      endReason: "done",
      message: `Agent ${id} 完成`,
      iterations: 2,
      succeededSteps: 2,
      failedSteps: 0,
      observations: [],
      lastDecision: null,
    },
    ...opts,
  };
}

/* ================================================================== */
/*  runCrossValidationPhase                                            */
/* ================================================================== */

describe("runCrossValidationPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeCollabEnvelope.mockResolvedValue(undefined);
  });

  it("全部通过：所有 Agent 结果被邻居认可，返回全 approved", async () => {
    // 验证者返回"确认通过"的输出
    runAgentLoop.mockResolvedValue({
      ok: true, endReason: "done", message: "Output is correct and complete. 确认通过",
      iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
    });

    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "research"), makeAgentState("a2", "writer")];
    const results = await runCrossValidationPhase({
      agentStates: agents,
      params,
      maxIterationsPerAgent: 5,
    });

    expect(results).toHaveLength(1); // 2个Agent → 1对交叉验证
    expect(results[0]!.verdict).toBe("approved");
    expect(results[0]!.validatedAgent).toBe("a1");
    expect(results[0]!.validatorAgent).toBe("a2");
    // DB INSERT 应被调用（runs + jobs + cross_validation_log）
    expect((params.pool.query as any).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("部分拒绝：验证者拒绝被验证者，返回 rejected + reasoning", async () => {
    runAgentLoop.mockResolvedValue({
      ok: true, endReason: "done",
      message: "I reject this output because it is incomplete. 拒绝",
      iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
    });

    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "research"), makeAgentState("a2", "writer"), makeAgentState("a3", "reviewer")];
    const results = await runCrossValidationPhase({
      agentStates: agents,
      params,
      maxIterationsPerAgent: 5,
    });

    expect(results).toHaveLength(2); // 3个Agent → 2对
    expect(results[0]!.verdict).toBe("rejected");
    expect(results[0]!.reasoning).toBeDefined();
    expect(results[0]!.reasoning.length).toBeGreaterThan(0);
  });

  it("单个 Agent 时跳过：只有一个 Agent 时返回空数组", async () => {
    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "solo")];
    const results = await runCrossValidationPhase({
      agentStates: agents,
      params,
      maxIterationsPerAgent: 5,
    });

    expect(results).toHaveLength(0);
    expect(runAgentLoop).not.toHaveBeenCalled();
  });
});

/* ================================================================== */
/*  runDynamicCorrectionPhase                                          */
/* ================================================================== */

describe("runDynamicCorrectionPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    writeCollabEnvelope.mockResolvedValue(undefined);
    collabConfigMock.mockReturnValue(500); // COLLAB_CORRECTION_FEEDBACK_MAX_LEN / PREV_OUTPUT_MAX_LEN
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次纠正成功：重试 1 次后验证通过", async () => {
    let callIdx = 0;
    runAgentLoop.mockImplementation(async () => {
      callIdx++;
      // 第1次: 纠错Agent重新执行
      // 第2次: 验证者验证 → approved
      if (callIdx % 2 === 0) {
        return {
          ok: true, endReason: "done",
          message: "Output is correct. 确认通过",
          iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
        };
      }
      return {
        ok: true, endReason: "done",
        message: "已修正输出",
        iterations: 2, succeededSteps: 2, failedSteps: 0, observations: [],
      };
    });

    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "research"), makeAgentState("a2", "writer")];
    const cvResults = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "rejected", reasoning: "不完整" }];

    const promise = runDynamicCorrectionPhase({
      agentStates: agents,
      crossValidationResults: cvResults,
      params,
      maxIterationsPerAgent: 5,
      maxRetries: 3,
    });

    // 无需等待延迟（第一次重试 retry=0 不延迟）
    await vi.runAllTimersAsync();
    const corrections = await promise;

    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.corrected).toBe(true);
    expect(corrections[0]!.retriesAttempted).toBe(1);
    expect(corrections[0]!.finalVerdict).toBe("approved");
  });

  it("达到上限仍失败：重试 maxRetries 次后仍 rejected", async () => {
    // 所有验证者都返回 rejected
    runAgentLoop.mockImplementation(async (_params: any) => {
      const goal = _params.goal as string;
      if (goal.includes("quality validator")) {
        return {
          ok: true, endReason: "done",
          message: "Still reject this output. 拒绝",
          iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
        };
      }
      return {
        ok: true, endReason: "done",
        message: "已尝试修正",
        iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
      };
    });

    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "research"), makeAgentState("a2", "writer")];
    const cvResults = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "rejected", reasoning: "错误严重" }];

    const promise = runDynamicCorrectionPhase({
      agentStates: agents,
      crossValidationResults: cvResults,
      params,
      maxIterationsPerAgent: 5,
      maxRetries: 2,
    });

    await vi.runAllTimersAsync();
    const corrections = await promise;

    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.corrected).toBe(false);
    expect(corrections[0]!.retriesAttempted).toBe(2);
    expect(corrections[0]!.finalVerdict).toBe("rejected");
  });

  it("纠错信号变化时不触发中止：每轮验证者返回不同 reasoning，循环跑满 maxRetries", async () => {
    let revalidationCallCount = 0;
    runAgentLoop.mockImplementation(async (_params: any) => {
      const goal = _params.goal as string;
      if (goal.includes("quality validator")) {
        revalidationCallCount++;
        // 每轮返回不同的 reasoning，模拟验证者给出不同反馈
        return {
          ok: true, endReason: "done",
          message: `Still needs revision round ${revalidationCallCount}. 需要修改`,
          iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
        };
      }
      return {
        ok: true, endReason: "done",
        message: "已修正输出",
        iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
      };
    });

    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "research"), makeAgentState("a2", "writer")];
    const cvResults = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "needs_revision", reasoning: "内容不足" }];

    const promise = runDynamicCorrectionPhase({
      agentStates: agents,
      crossValidationResults: cvResults,
      params,
      maxIterationsPerAgent: 5,
      maxRetries: 3,
    });

    await vi.runAllTimersAsync();
    const corrections = await promise;

    expect(corrections).toHaveLength(1);
    // 每轮 reasoning 不同，signature 不重复，循环跑满 maxRetries
    expect(corrections[0]!.retriesAttempted).toBe(3);
    expect(corrections[0]!.corrected).toBe(false);
    // goal_unchanged 不应被触发
    const warnCalls = (params.app.log.warn as any).mock.calls;
    const unchangedWarn = warnCalls.find((c: any[]) => c[0]?.event === "collab.correction.goal_unchanged");
    expect(unchangedWarn).toBeUndefined();
  });

  it("纠错信号未变时触发中止：多轮验证者返回相同 verdict+reasoning，提前中止", async () => {
    // 每轮验证者都返回完全相同的 verdict 和 reasoning
    runAgentLoop.mockImplementation(async (_params: any) => {
      const goal = _params.goal as string;
      if (goal.includes("quality validator")) {
        return {
          ok: true, endReason: "done",
          message: "Still needs revision. 需要修改",
          iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
        };
      }
      return {
        ok: true, endReason: "done",
        message: "已修正输出",
        iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
      };
    });

    const params = createOrchestratorParams();
    const agents = [makeAgentState("a1", "research"), makeAgentState("a2", "writer")];
    const cvResults = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "needs_revision", reasoning: "内容不足" }];

    const promise = runDynamicCorrectionPhase({
      agentStates: agents,
      crossValidationResults: cvResults,
      params,
      maxIterationsPerAgent: 5,
      maxRetries: 5,
    });

    await vi.runAllTimersAsync();
    const corrections = await promise;

    expect(corrections).toHaveLength(1);
    // 第1轮记录 signature，第2轮检测到相同 signature 后中止，所以 retriesAttempted=2
    expect(corrections[0]!.retriesAttempted).toBe(2);
    expect(corrections[0]!.corrected).toBe(false);
    // goal_unchanged 应被触发
    const warnCalls = (params.app.log.warn as any).mock.calls;
    const unchangedWarn = warnCalls.find((c: any[]) => c[0]?.event === "collab.correction.goal_unchanged");
    expect(unchangedWarn).toBeDefined();
    expect(unchangedWarn[1]).toContain("纠错信号未变化");
  });
});

/* ================================================================== */
/*  buildCorrectionGoal (通过 runDynamicCorrectionPhase 间接测试)      */
/* ================================================================== */

describe("buildCorrectionGoal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    writeCollabEnvelope.mockResolvedValue(undefined);
  });

  it("基础构建：验证 goal 包含原始目标、验证者反馈、重试次数", async () => {
    let capturedGoal = "";
    runAgentLoop.mockImplementation(async (p: any) => {
      if (!p.goal.includes("quality validator")) {
        capturedGoal = p.goal;
      }
      // 纠错Agent执行后，验证者approve
      if (p.goal.includes("quality validator")) {
        return {
          ok: true, endReason: "done",
          message: "Approved. 确认通过",
          iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
        };
      }
      return {
        ok: true, endReason: "done",
        message: "修正完成",
        iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
      };
    });
    collabConfigMock.mockReturnValue(2000);

    const params = createOrchestratorParams();
    const agents = [
      makeAgentState("a1", "research", { goal: "收集市场数据" }),
      makeAgentState("a2", "writer"),
    ];
    const cvResults = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "rejected", reasoning: "缺少关键数据源" }];

    await runDynamicCorrectionPhase({
      agentStates: agents,
      crossValidationResults: cvResults,
      params,
      maxIterationsPerAgent: 5,
      maxRetries: 1,
    });

    expect(capturedGoal).toContain("收集市场数据"); // 原始目标
    expect(capturedGoal).toContain("缺少关键数据源"); // 验证者反馈
    expect(capturedGoal).toContain("Attempt 1"); // 重试次数
    expect(capturedGoal).toContain("Correction Required");
  });

  it("反馈截断：验证超长反馈被截断到配置长度", async () => {
    collabConfigMock.mockReturnValue(50); // 截断长度设为50

    let capturedGoal = "";
    runAgentLoop.mockImplementation(async (p: any) => {
      if (!p.goal.includes("quality validator")) {
        capturedGoal = p.goal;
      }
      if (p.goal.includes("quality validator")) {
        return {
          ok: true, endReason: "done",
          message: "Approved. 确认通过",
          iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
        };
      }
      return {
        ok: true, endReason: "done",
        message: "修正完成",
        iterations: 1, succeededSteps: 1, failedSteps: 0, observations: [],
      };
    });

    const params = createOrchestratorParams();
    const longReasoning = "A".repeat(5000);
    const agents = [
      makeAgentState("a1", "research"),
      makeAgentState("a2", "writer"),
    ];
    const cvResults = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "rejected", reasoning: longReasoning }];

    await runDynamicCorrectionPhase({
      agentStates: agents,
      crossValidationResults: cvResults,
      params,
      maxIterationsPerAgent: 5,
      maxRetries: 1,
    });

    // 验证反馈部分不超过配置的截断长度
    const feedbackSection = capturedGoal.split("Reviewer's Feedback")[1]?.split("### Your Previous Output")[0] ?? "";
    // 截断长度50，反馈原文5000，截取后应远小于5000
    expect(feedbackSection.length).toBeLessThan(5000);
  });
});

/* ================================================================== */
/*  recordRolePerformance                                              */
/* ================================================================== */

describe("recordRolePerformance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("评分公式验证：overall = taskCompletion*0.4 + quality*0.3 + efficiency*0.2 + collaboration*0.1", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as any;

    const agents: AgentState[] = [
      makeAgentState("a1", "researcher", {
        result: {
          ok: true, endReason: "done", message: "done",
          iterations: 4, succeededSteps: 3, failedSteps: 1, observations: [],
          lastDecision: null,
        },
      }),
    ];

    await recordRolePerformance({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      collabRunId: "cr-1",
      agentStates: agents,
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    const callArgs = pool.query.mock.calls[0]![1]!;
    // taskCompletion = 0.9 (ok=true), quality = 0.8, efficiency = 3/4=0.75, collaboration = 0.5 (baseline)
    const taskCompletion = 0.9;
    const quality = 0.8;
    const efficiency = 3 / 4;
    const collaboration = 0.5;
    const expectedOverall = taskCompletion * 0.4 + quality * 0.3 + efficiency * 0.2 + collaboration * 0.1;

    expect(callArgs[5]).toBeCloseTo(taskCompletion, 2); // task_completion
    expect(callArgs[6]).toBeCloseTo(quality, 2);        // quality_score
    expect(callArgs[7]).toBeCloseTo(efficiency, 2);     // efficiency_score
    expect(callArgs[8]).toBeCloseTo(collaboration, 2);  // collaboration_score
    expect(callArgs[9]).toBeCloseTo(expectedOverall, 2); // overall_score
  });

  it("协作度加分：交叉验证通过时 collaboration 加 0.2", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as any;

    const agents: AgentState[] = [makeAgentState("a1", "researcher")];
    const crossValidation = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "approved", reasoning: "good" }];

    await recordRolePerformance({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      collabRunId: "cr-1",
      agentStates: agents,
      crossValidation,
    });

    const callArgs = pool.query.mock.calls[0]![1]!;
    // collaboration = 0.5 (base) + 0.2 (approved) = 0.7
    expect(callArgs[8]).toBeCloseTo(0.7, 2);
  });

  it("协作度扣分：交叉验证拒绝时 collaboration 减 0.15", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as any;

    const agents: AgentState[] = [makeAgentState("a1", "researcher")];
    const crossValidation = [{ validatedAgent: "a1", validatorAgent: "a2", verdict: "rejected", reasoning: "bad" }];

    await recordRolePerformance({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      collabRunId: "cr-1",
      agentStates: agents,
      crossValidation,
    });

    const callArgs = pool.query.mock.calls[0]![1]!;
    // collaboration = 0.5 (base) - 0.15 (rejected) = 0.35
    expect(callArgs[8]).toBeCloseTo(0.35, 2);
  });
});
