import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchContext } from "./dispatch.schema";

const mockBuildExecutionReplyText = vi.fn();
const mockCreateOrchestratorTurn = vi.fn();
const mockCreateJobRun = vi.fn();
const mockUpsertTaskState = vi.fn();
const mockRunPlanningPipeline = vi.fn();
const mockCreateTask = vi.fn();
const mockRequirePermission = vi.fn();
const mockValidateToolInput = vi.fn();
const mockResolveAndValidateTool = vi.fn();
const mockAdmitAndBuildStepEnvelope = vi.fn();
const mockBuildStepInputPayload = vi.fn();
const mockGenerateIdempotencyKey = vi.fn();
const mockSubmitStepToExistingRun = vi.fn();

vi.mock("./dispatch.helpers", () => ({
  buildExecutionReplyText: (...args: any[]) => mockBuildExecutionReplyText(...args),
}));

vi.mock("./modules/turnRepo", () => ({
  createOrchestratorTurn: (...args: any[]) => mockCreateOrchestratorTurn(...args),
}));

vi.mock("../../modules/workflow/jobRepo", () => ({
  createJobRun: (...args: any[]) => mockCreateJobRun(...args),
}));

vi.mock("../../modules/memory/repo", () => ({
  upsertTaskState: (...args: any[]) => mockUpsertTaskState(...args),
}));

vi.mock("../../kernel/planningKernel", () => ({
  runPlanningPipeline: (...args: any[]) => mockRunPlanningPipeline(...args),
}));

vi.mock("../task-manager/modules/taskRepo", () => ({
  createTask: (...args: any[]) => mockCreateTask(...args),
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

import { handleCollabMode } from "./dispatch.handleCollab";

function buildContext(): DispatchContext {
  return {
    app: {
      db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
      queue: {},
      cfg: { secrets: { masterKey: "mk_test" } },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    req: { ctx: { audit: {} } },
    subject: { tenantId: "tenant_test", spaceId: "space_test", subjectId: "user_test" },
    body: {
      message: "多人协作处理任务",
      constraints: {
        maxSteps: 4,
        maxWallTimeMs: 25_000,
      },
    } as any,
    locale: "zh-CN",
    message: "多人协作处理任务",
    conversationId: "conv_collab",
    classification: { mode: "collab", confidence: 0.93, reason: "collab", needsTask: true } as any,
    messageDigest: { len: 8, sha256_8: "deadbeef" },
    piSummary: { blocked: false },
    authorization: "Bearer admin",
    traceId: "trace_collab",
  };
}

describe("dispatch.handleCollab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTask.mockResolvedValue({ taskId: "task_1" });
    mockCreateJobRun.mockResolvedValue({ run: { runId: "run_1" }, job: { jobId: "job_1" } });
    mockRunPlanningPipeline.mockResolvedValue({
      ok: true,
      planSteps: [
        { toolRef: "entity.create@1", inputDraft: { entityName: "tasks", payload: { title: "collab" } } },
      ],
    });
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
    mockGenerateIdempotencyKey.mockReturnValue("idem_collab");
    mockSubmitStepToExistingRun.mockResolvedValue({ outcome: "needs_approval", stepId: "step_1", approvalId: "approval_1" });
    mockBuildExecutionReplyText.mockReturnValue("协作计划已生成");
    mockCreateOrchestratorTurn.mockResolvedValue({ turnId: "turn_1" });
  });

  it("首个协作步骤走统一执行内核并将审批态返回给前端", async () => {
    const ctx = buildContext();

    const result = await handleCollabMode(ctx);

    expect(mockSubmitStepToExistingRun).toHaveBeenCalledTimes(1);
    expect(result.phase).toBe("needs_approval");
    expect(result.taskState?.needsApproval).toBe(true);
    expect(mockUpsertTaskState).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "needs_approval",
      stepId: "step_1",
      artifactsDigest: expect.objectContaining({ collabRunId: expect.any(String), approvalId: "approval_1" }),
    }));
    const dbCalls = (ctx.app.db.query as any).mock.calls.map((call: any[]) => String(call[0]));
    expect(dbCalls.some((sql: string) => sql.includes("INSERT INTO steps"))).toBe(false);
    expect(dbCalls.some((sql: string) => sql.includes("UPDATE collab_runs SET status"))).toBe(true);
  });
});
