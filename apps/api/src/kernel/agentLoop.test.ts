import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  acquireLoopSlot,
  discoverEnabledTools,
  recallRelevantMemory,
  recallRecentTasks,
  recallRelevantKnowledge,
  recallProceduralStrategies,
  inferSemanticMeta,
  upsertTaskState,
  updateMemoryConfidenceFromFacts,
  writeCheckpoint,
  finalizeCheckpoint,
  startHeartbeat,
  registerProcess,
  updateProcessStatus,
  decomposeGoal,
  buildWorldStateFromObservations,
  updateWorldState,
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
  getDecisionQualityConfig,
  extractConfidenceFromOutput,
  evaluateDecisionQuality,
  getMaxStepSeq,
  upsertGoalGraph,
  deletePendingSteps,
} = vi.hoisted(() => ({
  acquireLoopSlot: vi.fn(),
  discoverEnabledTools: vi.fn(),
  recallRelevantMemory: vi.fn(),
  recallRecentTasks: vi.fn(),
  recallRelevantKnowledge: vi.fn(),
  recallProceduralStrategies: vi.fn(),
  inferSemanticMeta: vi.fn(),
  upsertTaskState: vi.fn(),
  updateMemoryConfidenceFromFacts: vi.fn(),
  writeCheckpoint: vi.fn(),
  finalizeCheckpoint: vi.fn(),
  startHeartbeat: vi.fn(),
  registerProcess: vi.fn(),
  updateProcessStatus: vi.fn(),
  decomposeGoal: vi.fn(),
  buildWorldStateFromObservations: vi.fn(),
  updateWorldState: vi.fn(),
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
  getDecisionQualityConfig: vi.fn(),
  extractConfidenceFromOutput: vi.fn(),
  evaluateDecisionQuality: vi.fn(),
  getMaxStepSeq: vi.fn(),
  upsertGoalGraph: vi.fn(),
  deletePendingSteps: vi.fn(),
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
  inferSemanticMeta,
}));

vi.mock("../modules/memory/repo", () => ({
  upsertTaskState,
  updateMemoryConfidenceFromFacts,
}));

vi.mock("./loopCheckpoint", () => ({
  writeCheckpoint,
  finalizeCheckpoint,
  startHeartbeat,
  registerProcess,
  updateProcessStatus,
  AGENT_LOOP_FULL_CHECKPOINT_INTERVAL: 5,
}));

vi.mock("./goalDecomposer", () => ({
  decomposeGoal,
}));

vi.mock("./worldStateExtractor", () => ({
  extractFromObservation: vi.fn(),
  evaluateGoalConditions: vi.fn(),
  buildWorldStateFromObservations,
  extractWorldState: vi.fn().mockReturnValue(null),
  updateWorldState,
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
  getDecisionQualityConfig,
  extractConfidenceFromOutput,
  evaluateDecisionQuality,
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
  detectIntentBoundary: vi.fn(),
}));

vi.mock("./agentLoopRepo", () => ({
  getMaxStepSeq,
  upsertGoalGraph,
  deletePendingSteps,
}));

vi.mock("./loopCacheConfig", () => ({
  getCacheConfig: vi.fn(() => ({ ENABLED: false })),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  prepareCacheKey: vi.fn(() => "test-key"),
  getLightIterationConfig: vi.fn(() => ({ ENABLED: false })),
  isLightIteration: vi.fn(() => false),
}));

vi.mock("./loopTurboMode", () => ({
  getTurboPolicy: vi.fn(() => ({
    skipFastCheckpoint: false,
    skipPolicySafety: false,
    skipIntentDrift: false,
    skipDecisionRetry: false,
    skipStrategyRecall: false,
  })),
}));

vi.mock("./loopObservation", () => ({
  buildObservation: vi.fn(),
  buildObservationsBatch: vi.fn(async () => ({ observations: [], dbDurationMs: 0 })),
  compressStepHistory: vi.fn(),
  AGENT_LOOP_BATCH_OBSERVE: false,
}));

vi.mock("../modules/audit/auditRepo", () => ({
  insertAuditEvent: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop";

function createParams(poolQuery?: ReturnType<typeof vi.fn>) {
  return {
    app: {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      metrics: {
        observeAgentDecision: vi.fn(),
        observeParallelToolCalls: vi.fn(),
        observeGoalDecompose: vi.fn(),
        observePlanQualityScore: vi.fn(),
        observeObserveDbDuration: vi.fn(),
        observeThinkLlmDuration: vi.fn(),
        setDriftScore: vi.fn(),
        incDriftDetectionMethod: vi.fn(),
        incThinkRetryCount: vi.fn(),
        setThinkConfidence: vi.fn(),
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
    vi.resetAllMocks();
    acquireLoopSlot.mockResolvedValue(vi.fn());
    discoverEnabledTools.mockResolvedValue({ catalog: "", tools: [] });
    recallRelevantMemory.mockResolvedValue({ text: "" });
    recallRecentTasks.mockResolvedValue({ text: "" });
    recallRelevantKnowledge.mockResolvedValue({ text: "" });
    recallProceduralStrategies.mockResolvedValue({ text: "", strategyCount: 0 });
    inferSemanticMeta.mockReturnValue({});
    upsertTaskState.mockResolvedValue(null);
    updateMemoryConfidenceFromFacts.mockResolvedValue({ corroborated: 0, contradicted: 0 });
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
    updateWorldState.mockImplementation((obs: any, ws: any, gg: any) => ({ worldState: ws, goalGraph: gg }));
    getMaxStepSeq.mockResolvedValue(0);
    upsertGoalGraph.mockResolvedValue(null);
    deletePendingSteps.mockResolvedValue(null);
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
    invokeLlmForDecision.mockResolvedValue({ outputText: "agent_decision", modelUsed: "test-model" });
    handleDoneAction.mockResolvedValue({ outcome: "done", message: "done", verification: null });
    triggerAutoReflexion.mockResolvedValue(null);
    getDecisionQualityConfig.mockReturnValue({ retryThreshold: 0.3, upgradeThreshold: 0.2, maxRetries: 1 });
    extractConfidenceFromOutput.mockReturnValue(0.9);
    evaluateDecisionQuality.mockReturnValue({ action: "accept" });
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
    upsertGoalGraph.mockImplementation(async () => {
      events.push("insertGoalGraph");
    });
    registerProcess.mockImplementation(async () => {
      events.push("registerProcess");
      return "process-1";
    });
    getMaxStepSeq.mockImplementation(async () => {
      events.push("readMaxSeq");
      return 0;
    });

    const result = await runAgentLoop(createParams() as any);

    expect(result.endReason).toBe("interrupted");
    expect(events).toContain("checkpoint");
    expect(events).toContain("insertGoalGraph");
    expect(events.indexOf("prepareRun")).toBeLessThan(events.indexOf("checkpoint"));
    expect(events.indexOf("checkpoint")).toBeLessThan(events.indexOf("insertGoalGraph"));
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

    const result = await runAgentLoop({
      ...createParams(),
      signal: undefined,
      maxIterations: 3,
    } as any);

    expect(result.endReason).toBe("done");
    // deletePendingSteps 应被调用，且只传 pool + runId（不含 tenant_id）
    expect(deletePendingSteps).toHaveBeenCalledWith(expect.anything(), "run-1");
  });
});
