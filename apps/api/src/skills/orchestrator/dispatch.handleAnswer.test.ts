import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchContext } from "./dispatch.schema";

const mockOrchestrateChatTurn = vi.fn();
const mockDiscoverEnabledTools = vi.fn();
const mockCreateOrchestratorTurn = vi.fn();
const mockCreateJobRun = vi.fn();
const mockAppendStepToRun = vi.fn();
const mockUpsertTaskState = vi.fn();
const mockCreateTask = vi.fn();
const mockClassifyToolCalls = vi.fn();
const mockLoadInlineWritableEntities = vi.fn();
const mockRequirePermission = vi.fn();
const mockValidateToolInput = vi.fn();
const mockResolveAndValidateTool = vi.fn();
const mockAdmitAndBuildStepEnvelope = vi.fn();
const mockBuildStepInputPayload = vi.fn();
const mockGenerateIdempotencyKey = vi.fn();
const mockSubmitStepToExistingRun = vi.fn();

vi.mock("./modules/orchestrator", () => ({
  orchestrateChatTurn: (...args: any[]) => mockOrchestrateChatTurn(...args),
  discoverEnabledTools: (...args: any[]) => mockDiscoverEnabledTools(...args),
}));

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

vi.mock("../task-manager/modules/taskRepo", () => ({
  createTask: (...args: any[]) => mockCreateTask(...args),
}));

vi.mock("./modules/inlineToolExecutor", () => ({
  classifyToolCalls: (...args: any[]) => mockClassifyToolCalls(...args),
  executeInlineTools: vi.fn(),
  formatInlineResultsForLLM: vi.fn(),
  loadInlineWritableEntities: (...args: any[]) => mockLoadInlineWritableEntities(...args),
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
}));

vi.mock("../../lib/llm", () => ({
  invokeModelChat: vi.fn(),
}));

import { handleAnswerMode } from "./dispatch.handleAnswer";

function buildContext(): DispatchContext {
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
      message: "帮我处理数据",
      constraints: {
        allowedTools: ["entity.create@1"],
        allowWrites: true,
        maxSteps: 2,
        maxWallTimeMs: 15_000,
      },
    } as any,
    locale: "zh-CN",
    message: "帮我处理数据",
    conversationId: "conv_answer",
    classification: { mode: "answer", confidence: 0.4, reason: "needs tools", needsTask: true } as any,
    messageDigest: { len: 6, sha256_8: "deadbeef" },
    piSummary: { blocked: false },
    authorization: "Bearer admin",
    traceId: "trace_answer",
  };
}

describe("dispatch.handleAnswer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrchestrateChatTurn.mockResolvedValue({
      replyText: "先给你结果",
      toolSuggestions: [
        { toolRef: "knowledge.search@1", inputDraft: { query: "alpha" }, riskLevel: "low", approvalRequired: false },
        { toolRef: "entity.create@1", inputDraft: { entityName: "tasks", payload: { title: "x" } }, riskLevel: "high", approvalRequired: true },
      ],
    });
    mockDiscoverEnabledTools.mockResolvedValue({ tools: [] });
    mockLoadInlineWritableEntities.mockResolvedValue([]);
    mockClassifyToolCalls.mockReturnValue({
      inlineTools: [{ toolRef: "knowledge.search@1", inputDraft: { query: "alpha" } }],
      upgradeTools: [{ toolRef: "entity.create@1", inputDraft: { entityName: "tasks", payload: { title: "x" } } }],
    });
    mockCreateTask.mockResolvedValue({ taskId: "task_1" });
    mockCreateJobRun.mockResolvedValue({ run: { runId: "run_1" }, job: { jobId: "job_1" } });
    mockCreateOrchestratorTurn.mockResolvedValue({ turnId: "turn_1" });
    mockRequirePermission.mockResolvedValue({ decision: "allow", snapshotRef: "snap_1" });
    mockValidateToolInput.mockReturnValue(undefined);
    mockResolveAndValidateTool.mockResolvedValue({
      toolRef: "entity.create@1",
      toolName: "entity.create",
      scope: "write",
      resourceType: "entity",
      action: "create",
      version: { inputSchema: {} },
      definition: { riskLevel: "high", approvalRequired: true },
      idempotencyRequired: true,
    });
    mockAdmitAndBuildStepEnvelope.mockResolvedValue({ capabilityEnvelope: { format: "capabilityEnvelope.v1" } });
    mockBuildStepInputPayload.mockImplementation((params: any) => ({ toolRef: params.resolved.toolRef, input: params.input }));
    mockGenerateIdempotencyKey.mockReturnValue("idem_answer");
    mockSubmitStepToExistingRun.mockResolvedValue({ outcome: "needs_approval", stepId: "step_1", approvalId: "approval_1" });
  });

  it("answer 模式只保留 upgrade 工具建议而不直接创建执行 run", async () => {
    const ctx = buildContext();

    const result = await handleAnswerMode(ctx);

    expect(mockCreateJobRun).not.toHaveBeenCalled();
    expect(mockSubmitStepToExistingRun).not.toHaveBeenCalled();
    expect(mockAppendStepToRun).not.toHaveBeenCalled();
    expect(result.mode).toBe("answer");
    expect(result.executionClass).toBe("workflow");
    expect(result.toolSuggestions).toEqual([
      expect.objectContaining({ toolRef: "entity.create@1" }),
    ]);
    expect(result.actionReceipt).toEqual(expect.objectContaining({
      status: "suggested",
      toolCount: 1,
    }));
    expect(mockUpsertTaskState).not.toHaveBeenCalled();
  });
});
