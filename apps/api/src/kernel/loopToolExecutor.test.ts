import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetSharedSubClient,
  mockResolveAndValidateTool,
  mockAdmitAndBuildStepEnvelope,
  mockBuildStepInputPayload,
  mockGenerateIdempotencyKey,
  mockSubmitStepToExistingRun,
  mockValidateToolInput,
  mockIsToolAllowedByConstraints,
  mockAuthorize,
  mockBuildAbacEvaluationRequestFromContext,
} = vi.hoisted(() => ({
  mockGetSharedSubClient: vi.fn(),
  mockResolveAndValidateTool: vi.fn(),
  mockAdmitAndBuildStepEnvelope: vi.fn(),
  mockBuildStepInputPayload: vi.fn(),
  mockGenerateIdempotencyKey: vi.fn(),
  mockSubmitStepToExistingRun: vi.fn(),
  mockValidateToolInput: vi.fn(),
  mockIsToolAllowedByConstraints: vi.fn(),
  mockAuthorize: vi.fn(),
  mockBuildAbacEvaluationRequestFromContext: vi.fn(),
}));

vi.mock("./loopRedisClient", () => ({
  getSharedSubClient: (...args: any[]) => mockGetSharedSubClient(...args),
}));

vi.mock("./executionKernel", () => ({
  resolveAndValidateTool: (...args: any[]) => mockResolveAndValidateTool(...args),
  admitAndBuildStepEnvelope: (...args: any[]) => mockAdmitAndBuildStepEnvelope(...args),
  buildStepInputPayload: (...args: any[]) => mockBuildStepInputPayload(...args),
  generateIdempotencyKey: (...args: any[]) => mockGenerateIdempotencyKey(...args),
  submitStepToExistingRun: (...args: any[]) => mockSubmitStepToExistingRun(...args),
}));

vi.mock("../modules/tools/validate", () => ({
  validateToolInput: (...args: any[]) => mockValidateToolInput(...args),
}));

vi.mock("./loopThinkDecide", () => ({
  isToolAllowedByConstraints: (...args: any[]) => mockIsToolAllowedByConstraints(...args),
}));

vi.mock("../modules/auth/authz", () => ({
  authorize: (...args: any[]) => mockAuthorize(...args),
}));

vi.mock("../modules/auth/guard", () => ({
  buildAbacEvaluationRequestFromContext: (...args: any[]) => mockBuildAbacEvaluationRequestFromContext(...args),
}));

import { executeToolCall, waitForStepCompletion } from "./loopToolExecutor";

describe("loopToolExecutor.waitForStepCompletion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to DB polling when Redis is unavailable", async () => {
    mockGetSharedSubClient.mockResolvedValue(null);
    let callCount = 0;
    const pool = {
      query: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { rowCount: 1, rows: [{ status: "running", output_digest: null, output: null, error_category: null }] };
        }
        return { rowCount: 1, rows: [{ status: "succeeded", output_digest: { ok: true }, output: { ok: true }, error_category: null }] };
      }),
    } as any;

    const resultPromise = waitForStepCompletion(pool, "step-db-fallback", undefined, 20_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toEqual({
      status: "succeeded",
      outputDigest: { ok: true },
      output: { ok: true },
      errorCategory: null,
    });
    expect(mockGetSharedSubClient).toHaveBeenCalledTimes(1);
  });

  it("keeps DB fallback active when Redis subscribe fails", async () => {
    const client = {
      subscribe: vi.fn(async () => {
        throw new Error("subscribe_failed");
      }),
      on: vi.fn(),
      removeListener: vi.fn(),
      unsubscribe: vi.fn(async () => undefined),
    };
    mockGetSharedSubClient.mockResolvedValue(client);
    let callCount = 0;
    const pool = {
      query: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { rowCount: 1, rows: [{ status: "pending", output_digest: null, output: null, error_category: null }] };
        }
        return { rowCount: 1, rows: [{ status: "needs_approval", output_digest: null, output: null, error_category: null }] };
      }),
    } as any;

    const resultPromise = waitForStepCompletion(pool, "step-subscribe-failed", undefined, 20_000);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toEqual({
      status: "needs_approval",
      outputDigest: null,
      output: null,
      errorCategory: null,
    });
    expect(client.subscribe).toHaveBeenCalledWith("step:done:step-subscribe-failed");
    expect(client.on).not.toHaveBeenCalled();
  });

  it("cleans up the abort listener after DB fallback settles", async () => {
    mockGetSharedSubClient.mockResolvedValue(null);
    let callCount = 0;
    const pool = {
      query: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return { rowCount: 1, rows: [{ status: "running", output_digest: null, output: null, error_category: null }] };
        }
        return { rowCount: 1, rows: [{ status: "failed", output_digest: null, output: null, error_category: "policy_violation" }] };
      }),
    } as any;
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    const resultPromise = waitForStepCompletion(pool, "step-abort-cleanup", controller.signal, 20_000);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(resultPromise).resolves.toEqual({
      status: "failed",
      outputDigest: null,
      output: null,
      errorCategory: "policy_violation",
    });
    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("loopToolExecutor.executeToolCall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAndValidateTool.mockResolvedValue({
      toolName: "memory.read",
      toolRef: "memory.read@1",
      version: { inputSchema: { type: "object" } },
      definition: { riskLevel: "low", approvalRequired: false },
      scope: "read",
      resourceType: "memory",
      action: "read",
      idempotencyRequired: false,
    });
    mockIsToolAllowedByConstraints.mockReturnValue({ ok: true });
    mockBuildAbacEvaluationRequestFromContext.mockImplementation((params: any) => ({ ...params, built: true }));
    mockAuthorize
      .mockResolvedValueOnce({ decision: "allow", snapshotRef: "policy_snapshot:tool-execute" })
      .mockResolvedValueOnce({
        decision: "allow",
        snapshotRef: "policy_snapshot:memory-read",
        fieldRules: { read: { allow: ["title"] } },
        rowFilters: { kind: "owner_only" },
      });
    mockAdmitAndBuildStepEnvelope.mockResolvedValue({ envelope: {}, limits: {}, networkPolicy: {}, networkPolicyDigest: {}, effectiveEnvelope: {} });
    mockGenerateIdempotencyKey.mockReturnValue("agent-loop-run-1-1");
    mockBuildStepInputPayload.mockReturnValue({ kind: "agent.loop.step" });
    mockSubmitStepToExistingRun.mockResolvedValue({ stepId: "step-1", outcome: "queued" });
  });

  it("authorizes both tool.execute and resolved resource action before submitting", async () => {
    const result = await executeToolCall({
      app: { cfg: { secrets: { masterKey: "mk" } }, log: { warn: vi.fn() } } as any,
      pool: {} as any,
      queue: {} as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      subjectId: "subject-1",
      traceId: "trace-1",
      runId: "run-1",
      jobId: "job-1",
      seq: 1,
      decision: { toolRef: "memory.read", inputDraft: {}, reasoning: "read memory" } as any,
    });

    expect(result).toEqual({ stepId: "step-1", ok: true });
    expect(mockAuthorize).toHaveBeenCalledTimes(2);
    expect(mockAuthorize).toHaveBeenNthCalledWith(1, expect.objectContaining({
      resourceType: "tool",
      action: "execute",
      abacRequest: expect.objectContaining({
        resourceType: "tool",
        action: "execute",
        environment: expect.objectContaining({
          attributes: expect.objectContaining({
            runtime: "agent_loop",
            runId: "run-1",
            jobId: "job-1",
            traceId: "trace-1",
          }),
        }),
      }),
    }));
    expect(mockAuthorize).toHaveBeenNthCalledWith(2, expect.objectContaining({
      resourceType: "memory",
      action: "read",
    }));
    expect(mockAdmitAndBuildStepEnvelope).toHaveBeenCalledWith(expect.objectContaining({
      opDecision: expect.objectContaining({
        snapshotRef: "policy_snapshot:memory-read",
        fieldRules: { read: { allow: ["title"] } },
        rowFilters: { kind: "owner_only" },
      }),
    }));
    expect(mockSubmitStepToExistingRun).toHaveBeenCalledWith(expect.objectContaining({
      opDecision: expect.objectContaining({
        snapshotRef: "policy_snapshot:memory-read",
      }),
    }));
  });
});
