import { describe, expect, it, vi } from "vitest";

vi.mock("../model-gateway/modules/invokeChatUpstreamStream", () => ({
  invokeModelChatUpstreamStream: vi.fn(async () => {
    throw new Error("stream_unavailable");
  }),
}));

import {
  deriveLoopPresentationStatus,
  makeOnLoopEnd,
  makeOnStepComplete,
  normalizeStepPresentationStatus,
} from "./dispatch.streamHelpers";

describe("dispatch.streamHelpers", () => {
  it("maps blocked step statuses without collapsing them into failed", async () => {
    const events: Array<{ event: string; data: any }> = [];
    const onStepComplete = makeOnStepComplete({
      app: {
        db: {
          query: vi.fn(async () => ({ rowCount: 1, rows: [{ approval_id: "approval-1" }] })),
        },
        log: { warn: vi.fn() },
      },
      sse: { sendEvent: (event: string, data: any) => events.push({ event, data }) },
      subject: { tenantId: "tenant_dev", spaceId: "space_dev", subjectId: "admin" },
      locale: "zh-CN",
      message: "帮我执行任务",
      runId: "run-1",
      traceId: "trace-1",
      requestId: "req-1",
    });

    await onStepComplete(
      {
        stepId: "step-1",
        seq: 1,
        toolRef: "entity.create@1",
        status: "needs_approval",
        outputDigest: null,
        output: null,
        errorCategory: null,
        durationMs: null,
      },
      { reasoning: "需要审批" } as any,
    );

    expect(normalizeStepPresentationStatus("needs_approval")).toBe("needs_approval");
    expect(events.find((item) => item.event === "stepProgress")?.data?.traceId).toBe("trace-1");
    expect(events.find((item) => item.event === "stepProgress")?.data?.requestId).toBe("req-1");
    expect(events.find((item) => item.event === "stepProgress")?.data?.step?.stepId).toBe("step-1");
    expect(events.find((item) => item.event === "executionReceipt")?.data?.status).toBe("needs_approval");
    expect(events.find((item) => item.event === "executionReceipt")?.data?.traceId).toBe("trace-1");
    expect(events.find((item) => item.event === "approvalNode")?.data?.status).toBe("pending");
    expect(events.find((item) => item.event === "approvalNode")?.data?.approvalId).toBe("approval-1");
    expect(events.find((item) => item.event === "approvalNode")?.data?.requestId).toBe("req-1");
    expect(events.find((item) => item.event === "delta")?.data?.text).toContain("等待审批");
  });

  it("maps ask_user loop end to paused runSummary status", () => {
    const events: Array<{ event: string; data: any }> = [];
    const onLoopEnd = makeOnLoopEnd({
      sse: { sendEvent: (event: string, data: any) => events.push({ event, data }) },
      runId: "run-1",
      traceId: "trace-2",
      requestId: "req-2",
    });

    onLoopEnd({
      ok: true,
      endReason: "ask_user",
      iterations: 2,
      succeededSteps: 1,
      failedSteps: 0,
      message: "请补充信息",
      observations: [],
      lastDecision: null,
    });

    expect(deriveLoopPresentationStatus({
      ok: true,
      endReason: "ask_user",
      iterations: 0,
      succeededSteps: 0,
      failedSteps: 0,
      message: "",
      observations: [],
      lastDecision: null,
    })).toBe("paused");
    expect(events.find((item) => item.event === "runSummary")?.data?.status).toBe("paused");
    expect(events.find((item) => item.event === "runSummary")?.data?.traceId).toBe("trace-2");
    expect(events.find((item) => item.event === "agentLoopEnd")?.data?.requestId).toBe("req-2");
    expect(events.find((item) => item.event === "agentLoopEnd")?.data?.status).toBe("paused");
    expect(events.find((item) => item.event === "agentLoopEnd")?.data?.endReason).toBe("ask_user");
  });
});
