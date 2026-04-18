import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockBreakerCall,
  mockGetOrCreateBreaker,
  mockCreateDeltaIterable,
  mockInvokeModelChatUpstreamStream,
} = vi.hoisted(() => {
  const mockBreakerCall = vi.fn();
  const mockGetOrCreateBreaker = vi.fn(() => ({ call: mockBreakerCall }));
  const mockCreateDeltaIterable = vi.fn();
  const mockInvokeModelChatUpstreamStream = vi.fn();
  return {
    mockBreakerCall,
    mockGetOrCreateBreaker,
    mockCreateDeltaIterable,
    mockInvokeModelChatUpstreamStream,
  };
});

vi.mock("@openslin/shared", () => ({
  getOrCreateBreaker: mockGetOrCreateBreaker,
}));

vi.mock("./streamingPipeline", () => ({
  createDeltaIterable: mockCreateDeltaIterable,
}));

vi.mock("../skills/model-gateway/modules/invokeChatUpstreamStream", () => ({
  invokeModelChatUpstreamStream: mockInvokeModelChatUpstreamStream,
}));

import { buildModelChatInvocation, invokeModelChat, invokeModelChatStream } from "./llm";

describe("llm invocation parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBreakerCall.mockImplementation(async (fn: any) => await fn());
    mockCreateDeltaIterable.mockReturnValue({
      iterable: {
        async *[Symbol.asyncIterator]() {},
      },
      onDelta: vi.fn(),
      done: vi.fn(),
    });
  });

  it("buildModelChatInvocation preserves purpose, constraints, traceId and headers", () => {
    const invocation = buildModelChatInvocation({
      subject: { tenantId: "tenant_dev", spaceId: "space_dev", subjectId: "admin" },
      locale: "zh-CN",
      authorization: "Bearer admin",
      traceId: "trace-1",
      purpose: "orchestrator.dispatch.stream.summary",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 3210,
      headers: { "x-budget-key": "budget-1" },
      constraints: { candidates: ["model-a"] },
    });

    expect(invocation.headers).toMatchObject({
      authorization: "Bearer admin",
      "x-user-locale": "zh-CN",
      "x-trace-id": "trace-1",
      "x-budget-key": "budget-1",
    });
    expect(invocation.payload).toEqual({
      purpose: "orchestrator.dispatch.stream.summary",
      messages: [{ role: "user", content: "hello" }],
      timeoutMs: 3210,
      constraints: { candidates: ["model-a"] },
    });
  });

  it("invokeModelChat forwards the shared payload to /models/chat", async () => {
    const inject = vi.fn(async () => ({
      statusCode: 200,
      body: JSON.stringify({ outputText: "ok" }),
      headers: {},
    }));

    const result = await invokeModelChat({
      app: { inject } as any,
      subject: { tenantId: "tenant_dev", spaceId: "space_dev", subjectId: "admin" },
      locale: "zh-CN",
      authorization: "Bearer admin",
      traceId: "trace-sync",
      purpose: "planner.test",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 111,
      headers: { "x-budget-key": "budget-sync" },
      constraints: { candidates: ["model-sync"] },
    });

    expect(result.outputText).toBe("ok");
    expect(mockGetOrCreateBreaker).toHaveBeenCalledWith(
      "llm:model-sync:planner.test",
      expect.any(Object),
    );
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({
      url: "/models/chat",
      headers: expect.objectContaining({
        authorization: "Bearer admin",
        "x-trace-id": "trace-sync",
        "x-budget-key": "budget-sync",
      }),
      payload: {
        purpose: "planner.test",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 111,
        constraints: { candidates: ["model-sync"] },
      },
    }));
  });

  it("invokeModelChatStream forwards the same purpose and payload shape to upstream stream path", async () => {
    const done = vi.fn();
    const onDelta = vi.fn();
    mockCreateDeltaIterable.mockReturnValue({
      iterable: {
        async *[Symbol.asyncIterator]() {},
      },
      onDelta,
      done,
    });
    mockInvokeModelChatUpstreamStream.mockResolvedValue({ outputText: "stream-ok" });

    const streamResult = invokeModelChatStream({
      app: {} as any,
      subject: { tenantId: "tenant_dev", spaceId: "space_dev", subjectId: "admin" },
      locale: "zh-CN",
      authorization: "Bearer admin",
      traceId: "trace-stream",
      purpose: "planner.test",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 222,
      headers: { "x-budget-key": "budget-stream" },
      constraints: { candidates: ["model-stream"] },
    });

    await expect(streamResult.result).resolves.toEqual({ outputText: "stream-ok" });
    expect(mockInvokeModelChatUpstreamStream).toHaveBeenCalledWith(expect.objectContaining({
      locale: "zh-CN",
      traceId: "trace-stream",
      body: {
        purpose: "planner.test",
        messages: [{ role: "user", content: "hi" }],
        timeoutMs: 222,
        constraints: { candidates: ["model-stream"] },
        stream: true,
      },
      onDelta,
    }));
    expect(done).toHaveBeenCalled();
  });
});
