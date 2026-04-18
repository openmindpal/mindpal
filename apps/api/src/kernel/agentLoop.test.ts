import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  acquireLoopSlot,
  discoverEnabledTools,
  recallRelevantMemory,
  recallRecentTasks,
  recallRelevantKnowledge,
  recallProceduralStrategies,
  upsertTaskState,
  writeCheckpoint,
  finalizeCheckpoint,
  startHeartbeat,
  registerProcess,
  updateProcessStatus,
  decomposeGoal,
  buildWorldStateFromObservations,
  prepareRunForExecution,
  safeTransitionRun,
  normalizeExecutionConstraints,
  filterToolDiscoveryByConstraints,
  parseAgentDecision,
  buildThinkPrompt,
  triggerAutoReflexion,
  buildIterationContext,
  invokeLlmForDecision,
  handleDoneAction,
  handleToolCallAction,
  executeToolCall,
  waitForStepCompletion,
} = vi.hoisted(() => ({
  acquireLoopSlot: vi.fn(),
  discoverEnabledTools: vi.fn(),
  recallRelevantMemory: vi.fn(),
  recallRecentTasks: vi.fn(),
  recallRelevantKnowledge: vi.fn(),
  recallProceduralStrategies: vi.fn(),
  upsertTaskState: vi.fn(),
  writeCheckpoint: vi.fn(),
  finalizeCheckpoint: vi.fn(),
  startHeartbeat: vi.fn(),
  registerProcess: vi.fn(),
  updateProcessStatus: vi.fn(),
  decomposeGoal: vi.fn(),
  buildWorldStateFromObservations: vi.fn(),
  prepareRunForExecution: vi.fn(),
  safeTransitionRun: vi.fn(),
  normalizeExecutionConstraints: vi.fn(),
  filterToolDiscoveryByConstraints: vi.fn(),
  parseAgentDecision: vi.fn(),
  buildThinkPrompt: vi.fn(),
  triggerAutoReflexion: vi.fn(),
  buildIterationContext: vi.fn(),
  invokeLlmForDecision: vi.fn(),
  handleDoneAction: vi.fn(),
  handleToolCallAction: vi.fn(),
  executeToolCall: vi.fn(),
  waitForStepCompletion: vi.fn(),
}));

vi.mock("./priorityScheduler", () => ({
  acquireLoopSlot,
}));

vi.mock("../modules/agentContext", () => ({
  discoverEnabledTools,
  recallRelevantMemory,
  recallRecentTasks,
  recallRelevantKnowledge,
  recallProceduralStrategies,
}));

vi.mock("../modules/memory/repo", () => ({
  upsertTaskState,
}));

vi.mock("./loopCheckpoint", () => ({
  writeCheckpoint,
  finalizeCheckpoint,
  startHeartbeat,
  registerProcess,
  updateProcessStatus,
}));

vi.mock("./goalDecomposer", () => ({
  decomposeGoal,
}));

vi.mock("./worldStateExtractor", () => ({
  extractFromObservation: vi.fn(),
  evaluateGoalConditions: vi.fn(),
  buildWorldStateFromObservations,
}));

vi.mock("./loopStateHelpers", () => ({
  prepareRunForExecution,
  safeTransitionRun,
}));

vi.mock("./loopThinkDecide", () => ({
  normalizeExecutionConstraints,
  filterToolDiscoveryByConstraints,
  parseAgentDecision,
  buildThinkPrompt,
}));

vi.mock("./loopAutoReflexion", () => ({
  triggerAutoReflexion,
}));

vi.mock("./loopIterationHelpers", () => ({
  buildIterationContext,
  invokeLlmForDecision,
}));

vi.mock("./loopActHandlers", () => ({
  handleDoneAction,
  handleToolCallAction,
}));

vi.mock("./loopToolExecutor", () => ({
  executeToolCall,
  waitForStepCompletion,
}));

vi.mock("./verifierAgent", () => ({
  verifyGoalCompletion: vi.fn(),
  verifySimple: vi.fn(),
}));

vi.mock("./intentAnchoringService", () => ({
  checkAndEnforceIntentBoundary: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop";

function createParams(poolQuery?: ReturnType<typeof vi.fn>) {
  return {
    app: {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      metrics: {
        observeAgentDecision: vi.fn(),
        observeParallelToolCalls: vi.fn(),
        observeGoalDecompose: vi.fn(),
        observePlanQualityScore: vi.fn(),
      },
    } as any,
    pool: {
      query: poolQuery ?? vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any,
    queue: {} as any,
    subject: {
      tenantId: "tenant-1",
      spaceId: "space-1",
      subjectId: "subject-1",
      roles: ["user"],
    } as any,
    locale: "zh-CN",
    authorization: null,
    traceId: "trace-1",
    goal: "打开百度网页",
    runId: "run-1",
    jobId: "job-1",
    taskId: "task-1",
    signal: { aborted: true } as AbortSignal,
    maxIterations: 2,
    maxWallTimeMs: 5000,
  };
}

describe("runAgentLoop initialization order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acquireLoopSlot.mockResolvedValue(vi.fn());
    discoverEnabledTools.mockResolvedValue({ catalog: "", tools: [] });
    recallRelevantMemory.mockResolvedValue({ text: "" });
    recallRecentTasks.mockResolvedValue({ text: "" });
    recallRelevantKnowledge.mockResolvedValue({ text: "" });
    recallProceduralStrategies.mockResolvedValue({ text: "", strategyCount: 0 });
    upsertTaskState.mockResolvedValue(null);
    writeCheckpoint.mockResolvedValue(null);
    finalizeCheckpoint.mockResolvedValue(null);
    startHeartbeat.mockReturnValue({ stop: vi.fn() });
    registerProcess.mockResolvedValue("process-1");
    updateProcessStatus.mockResolvedValue(null);
    decomposeGoal.mockResolvedValue({
      ok: true,
      graph: {
        graphId: "graph-1",
        subGoals: [],
        decompositionReasoning: null,
        decomposedByModel: null,
        status: "active",
        version: 1,
      },
    });
    buildWorldStateFromObservations.mockReturnValue(null);
    prepareRunForExecution.mockResolvedValue(true);
    safeTransitionRun.mockResolvedValue(true);
    normalizeExecutionConstraints.mockImplementation((value: unknown) => value ?? null);
    filterToolDiscoveryByConstraints.mockImplementation((value: unknown) => value);
    parseAgentDecision.mockReturnValue({
      action: "done",
      reasoning: "",
      summary: "done",
    });
    buildIterationContext.mockResolvedValue({ updatedWorldState: null });
    invokeLlmForDecision.mockResolvedValue("agent_decision");
    handleDoneAction.mockResolvedValue({ outcome: "done", message: "done", verification: null });
    triggerAutoReflexion.mockResolvedValue(null);
  });

  it("writes the first checkpoint before inserting the GoalGraph", async () => {
    const events: string[] = [];
    prepareRunForExecution.mockImplementation(async () => {
      events.push("prepareRun");
      return true;
    });
    upsertTaskState.mockImplementation(async () => {
      events.push("taskState");
      return null;
    });
    writeCheckpoint.mockImplementation(async () => {
      events.push("checkpoint");
      return null;
    });
    decomposeGoal.mockImplementation(async () => {
      events.push("decomposeGoal");
      return {
        ok: true,
        graph: {
          graphId: "graph-1",
          subGoals: [],
          decompositionReasoning: null,
          decomposedByModel: null,
          status: "active",
          version: 1,
        },
      };
    });
    registerProcess.mockImplementation(async () => {
      events.push("registerProcess");
      return "process-1";
    });
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps")) {
        events.push("readMaxSeq");
        return { rowCount: 1, rows: [{ max_seq: 0 }] };
      }
      if (sql.includes("INSERT INTO goal_graphs")) {
        events.push("insertGoalGraph");
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const result = await runAgentLoop(createParams(poolQuery) as any);

    expect(result.endReason).toBe("interrupted");
    expect(events).toContain("checkpoint");
    expect(events).toContain("insertGoalGraph");
    expect(events.indexOf("prepareRun")).toBeLessThan(events.indexOf("checkpoint"));
    expect(events.indexOf("checkpoint")).toBeLessThan(events.indexOf("insertGoalGraph"));
    expect(events.indexOf("insertGoalGraph")).toBeLessThan(events.indexOf("registerProcess"));
  });

  it("parallel_tool_calls 按实际完成顺序写入观察并触发回调", async () => {
    const gateRelease = vi.fn();
    acquireLoopSlot.mockResolvedValue(gateRelease);
    const stepOrder: number[] = [];
    const firstStepPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ status: "succeeded", outputDigest: { step: 1 }, output: { step: 1 }, errorCategory: null }), 20);
    });
    const secondStepPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ status: "succeeded", outputDigest: { step: 2 }, output: { step: 2 }, errorCategory: null }), 0);
    });
    waitForStepCompletion
      .mockReturnValueOnce(firstStepPromise)
      .mockReturnValueOnce(secondStepPromise);
    executeToolCall
      .mockResolvedValueOnce({ ok: true, stepId: "step-1" })
      .mockResolvedValueOnce({ ok: true, stepId: "step-2" });
    parseAgentDecision
      .mockReturnValueOnce({
        action: "parallel_tool_calls",
        reasoning: "parallel",
        parallelCalls: [
          { toolRef: "tool.first@1", inputDraft: {} },
          { toolRef: "tool.second@1", inputDraft: {} },
        ],
      })
      .mockReturnValueOnce({
        action: "done",
        reasoning: "done",
        summary: "完成",
      });

    const doneResult = {
      outcome: "done",
      message: "完成",
      verification: null,
    };
    handleDoneAction.mockResolvedValue(doneResult);

    const params = {
      ...createParams(),
      signal: undefined,
      onStepComplete: vi.fn(async (obs: any) => {
        stepOrder.push(obs.seq);
      }),
    };

    const loopPromise = runAgentLoop(params as any);
    const result = await loopPromise;

    expect(stepOrder).toEqual([2, 1]);
    expect(result.observations.map((obs) => obs.seq)).toEqual([2, 1]);
    expect(result.observations.map((obs) => obs.stepId)).toEqual(["step-2", "step-1"]);
    expect(result.endReason).toBe("done");
    expect(gateRelease).toHaveBeenCalled();
  });

  it("replan 会按 run_id 清理 pending steps 而不依赖 tenant_id 列", async () => {
    acquireLoopSlot.mockResolvedValue(vi.fn());
    parseAgentDecision
      .mockReturnValueOnce({
        action: "replan",
        reasoning: "need replan",
      })
      .mockReturnValueOnce({
        action: "done",
        reasoning: "done",
        summary: "完成",
      });
    handleDoneAction.mockResolvedValue({ outcome: "done", message: "完成", verification: null });

    const poolQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps")) {
        return { rowCount: 1, rows: [{ max_seq: 0 }] };
      }
      if (sql === "DELETE FROM steps WHERE run_id = $1 AND status = 'pending'") {
        expect(params).toEqual(["run-1"]);
        return { rowCount: 2, rows: [] };
      }
      if (sql.includes("INSERT INTO goal_graphs")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const result = await runAgentLoop({
      ...createParams(poolQuery),
      signal: undefined,
      maxIterations: 3,
    } as any);

    expect(result.endReason).toBe("done");
    expect(
      poolQuery.mock.calls.some(
        ([sql, params]) =>
          sql === "DELETE FROM steps WHERE run_id = $1 AND status = 'pending'" &&
          JSON.stringify(params) === JSON.stringify(["run-1"]),
      ),
    ).toBe(true);
    expect(
      poolQuery.mock.calls.some(([sql]) => String(sql).includes("tenant_id") && String(sql).includes("DELETE FROM steps")),
    ).toBe(false);
  });
});
