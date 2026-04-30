import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchContext } from "./dispatch.schema";

const mockCreateTask = vi.fn();
const mockCreateJobRun = vi.fn();
const mockUpsertTaskState = vi.fn();
const mockRunPlanningPipeline = vi.fn();
const mockRunAgentLoop = vi.fn();
const mockCreateOrchestratorTurn = vi.fn();
const mockRequirePermission = vi.fn();
const mockValidateToolInput = vi.fn();
const mockResolveAndValidateTool = vi.fn();
const mockAdmitAndBuildStepEnvelope = vi.fn();
const mockBuildStepInputPayload = vi.fn();
const mockGenerateIdempotencyKey = vi.fn();
const mockSubmitStepToExistingRun = vi.fn();
const mockAppendStepToRun = vi.fn();
const mockPrepareToolStep = vi.fn();

vi.mock("./modules/turnRepo", () => ({
  createOrchestratorTurn: (...args: any[]) => mockCreateOrchestratorTurn(...args),
}));

vi.mock("../../modules/workflow/jobRepo", () => ({
  createJobRun: (...args: any[]) => mockCreateJobRun(...args),
  appendStepToRun: (...args: any[]) => mockAppendStepToRun(...args),
}));

vi.mock("../../modules/memory/repo", () => ({
  upsertTaskState: (...args: any[]) => mockUpsertTaskState(...args),
}));

vi.mock("../../modules/auth/guard", () => ({
  requirePermission: (...args: any[]) => mockRequirePermission(...args),
}));

vi.mock("../../modules/tools/validate", () => ({
  validateToolInput: (...args: any[]) => mockValidateToolInput(...args),
}));

vi.mock("../../kernel/executionKernel", () => ({
  resolveAndValidateTool: (...args: any[]) => mockResolveAndValidateTool(...args),
  admitAndBuildStepEnvelope: (...args: any[]) => mockAdmitAndBuildStepEnvelope(...args),
  buildStepInputPayload: (...args: any[]) => mockBuildStepInputPayload(...args),
  generateIdempotencyKey: (...args: any[]) => mockGenerateIdempotencyKey(...args),
  submitStepToExistingRun: (...args: any[]) => mockSubmitStepToExistingRun(...args),
  prepareToolStep: (...args: any[]) => mockPrepareToolStep(...args),
}));

vi.mock("../../kernel/planningKernel", () => ({
  runPlanningPipeline: (...args: any[]) => mockRunPlanningPipeline(...args),
}));

vi.mock("../../kernel/agentLoop", () => ({
  runAgentLoop: (...args: any[]) => mockRunAgentLoop(...args),
}));

vi.mock("../task-manager/modules/taskRepo", () => ({
  createTask: (...args: any[]) => mockCreateTask(...args),
}));

import { handleExecuteMode } from "./dispatch.handleExecute";

function buildContext(overrides?: Partial<DispatchContext>): DispatchContext {
  return {
    app: {
      db: { query: vi.fn() },
      queue: {},
      cfg: { secrets: { masterKey: "mk_test" } },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    req: { ctx: { audit: {} } },
    subject: { tenantId: "tenant_test", spaceId: "space_test", subjectId: "user_test" },
    body: {
      message: "执行任务",
      constraints: {
        allowedTools: ["knowledge.search", "entity.read"],
        allowWrites: false,
        maxSteps: 7,
        maxWallTimeMs: 45_000,
      },
    } as any,
    locale: "zh-CN",
    message: "执行任务",
    conversationId: "conv_test",
    classification: { mode: "execute", confidence: 0.98, reason: "mock", needsTask: true } as any,
    messageDigest: { len: 4, sha256_8: "deadbeef" },
    piSummary: { blocked: false },
    authorization: "Bearer admin",
    traceId: "trace_test",
    ...overrides,
  };
}

describe("dispatch.handleExecute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTask.mockResolvedValue({ taskId: "task_1" });
    mockCreateJobRun.mockResolvedValue({ run: { runId: "run_1" }, job: { jobId: "job_1" } });
    mockUpsertTaskState.mockResolvedValue(undefined);
    mockRunPlanningPipeline.mockResolvedValue({ ok: true, planSteps: [] });
    mockRunAgentLoop.mockResolvedValue({ loopId: "loop_1", endReason: "done" });
    mockCreateOrchestratorTurn.mockResolvedValue({ turnId: "turn_1" });
    mockRequirePermission.mockResolvedValue({ decision: "allow", snapshotRef: "snap_1" });
    mockValidateToolInput.mockReturnValue(undefined);
    mockResolveAndValidateTool.mockResolvedValue({
      toolRef: "knowledge.search@1",
      toolName: "knowledge.search",
      scope: "read",
      resourceType: "knowledge",
      action: "search",
      version: { inputSchema: {} },
      definition: { riskLevel: "low", approvalRequired: false },
    });
    mockAdmitAndBuildStepEnvelope.mockResolvedValue({ capabilityEnvelope: { format: "capabilityEnvelope.v1" } });
    mockBuildStepInputPayload.mockImplementation((params: any) => ({ kind: params.kind, toolRef: params.resolved.toolRef, input: params.input }));
    mockGenerateIdempotencyKey.mockReturnValue("idem_test");
    mockSubmitStepToExistingRun.mockResolvedValue({ outcome: "queued", stepId: "step_1" });
    mockAppendStepToRun.mockResolvedValue({ stepId: "step_2" });
    mockPrepareToolStep.mockResolvedValue({
      resolved: {
        toolRef: "knowledge.search@1",
        toolName: "knowledge.search",
        scope: "read",
        resourceType: "knowledge",
        action: "search",
        version: { inputSchema: {} },
        definition: { riskLevel: "low", approvalRequired: false },
      },
      opDecision: { snapshotRef: "snap_1" },
      admitted: { capabilityEnvelope: { format: "capabilityEnvelope.v1" } },
      stepInput: { kind: "execute", toolRef: "knowledge.search@1", input: {} },
      idempotencyKey: "idem_test",
    });
  });

  it("无预生成 toolSuggestions 时向 Agent Loop 透传 executionConstraints", async () => {
    const ctx = buildContext();

    const result = await handleExecuteMode(ctx);

    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
    expect(mockRunAgentLoop).toHaveBeenCalledWith(expect.objectContaining({
      maxIterations: 7,
      maxWallTimeMs: 45_000,
      executionConstraints: {
        allowedTools: ["knowledge.search", "entity.read"],
        allowWrites: false,
      },
    }));
    expect(result.mode).toBe("execute");
    expect(result.phase).toBe("executing");
  });

  it("预生成 toolSuggestions 时走统一执行内核而不是重新启动 Agent Loop", async () => {
    const ctx = buildContext({
      body: {
        message: "执行任务",
        constraints: {
          allowedTools: ["knowledge.search"],
          allowWrites: false,
          maxSteps: 3,
          maxWallTimeMs: 15_000,
        },
        toolSuggestions: [
          { toolRef: "knowledge.search@1", inputDraft: { query: "alpha" } },
          { toolRef: "knowledge.search@1", inputDraft: { query: "beta" } },
        ],
      } as any,
    });
    mockSubmitStepToExistingRun.mockResolvedValue({ outcome: "needs_approval", stepId: "step_1" });

    const result = await handleExecuteMode(ctx);

    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    // P0-1 FIX: 有2个toolSuggestions，所以submitStepToExistingRun会被调用2次（每个步骤一次）
    expect(mockSubmitStepToExistingRun).toHaveBeenCalledTimes(2);
    expect(mockAppendStepToRun).toHaveBeenCalledTimes(0); // P0-1修复后不再直接调用appendStepToRun
    expect(ctx.app.db.query).not.toHaveBeenCalled();
    expect(result.phase).toBe("needs_approval");
    expect(mockUpsertTaskState).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "needs_approval",
      plan: expect.objectContaining({
        constraints: {
          allowedTools: ["knowledge.search"],
          allowWrites: false,
          maxSteps: 3,
          maxWallTimeMs: 15_000,
        },
        agentLoop: false,
      }),
    }));
  });
});
