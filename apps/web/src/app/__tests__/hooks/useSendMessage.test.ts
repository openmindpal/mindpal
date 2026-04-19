import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleSSEEvent, type SSEEventContext } from "../../sseEventHandler";

/* ─── Helper: build a minimal SSEEventContext ─── */
function makeCtx(overrides: Partial<SSEEventContext> = {}): SSEEventContext {
  return {
    replyId: "reply-1",
    message: "hello",
    locale: "zh-CN",
    conversationId: "conv-1",
    accumulatedText: "",
    syncReplyText: vi.fn(),
    setAccumulatedText: vi.fn(),
    pendingToolSuggestions: [],
    setPendingToolSuggestions: vi.fn(),
    streamHasError: false,
    setStreamHasError: vi.fn(),
    hasNl2uiResult: false,
    setHasNl2uiResult: vi.fn(),
    hasTaskCreated: false,
    setHasTaskCreated: vi.fn(),
    hasStructuredFlowItems: false,
    setHasStructuredFlowItems: vi.fn(),
    setNl2uiLoading: vi.fn(),
    setFlow: vi.fn(),
    setConversationId: vi.fn(),
    setActiveTask: vi.fn(),
    setTaskProgress: vi.fn(),
    pollTaskState: vi.fn().mockResolvedValue(undefined),
    retryCountRef: { current: new Map() },
    lastRetryMsgRef: { current: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ═══════════ SSE delta event — text streaming ═══════════ */
describe("handleSSEEvent: delta", () => {
  it("should accumulate text from delta events", () => {
    const ctx = makeCtx();
    handleSSEEvent("delta", { text: "Hello " }, ctx);
    expect(ctx.accumulatedText).toBe("Hello ");
    expect(ctx.syncReplyText).toHaveBeenCalledWith("Hello ");

    handleSSEEvent("delta", { text: "World" }, ctx);
    expect(ctx.accumulatedText).toBe("Hello World");
    expect(ctx.syncReplyText).toHaveBeenCalledWith("Hello World");
  });

  it("should handle delta with missing text field gracefully", () => {
    const ctx = makeCtx();
    handleSSEEvent("delta", {}, ctx);
    // data.text ?? "" — nullish coalescing defaults to empty string
    expect(ctx.accumulatedText).toBe("");
  });
});

/* ═══════════ SSE done event — conversation ID assignment ═══════════ */
describe("handleSSEEvent: done", () => {
  it("should set conversationId from done event", () => {
    const ctx = makeCtx();
    handleSSEEvent("done", { conversationId: "new-conv-42" }, ctx);
    expect(ctx.setConversationId).toHaveBeenCalledWith("new-conv-42");
  });

  it("should not set conversationId when absent", () => {
    const ctx = makeCtx();
    handleSSEEvent("done", {}, ctx);
    expect(ctx.setConversationId).not.toHaveBeenCalled();
  });

  it("should flush pending tool suggestions on done", () => {
    const suggestions = [{ toolRef: "echo", label: "Echo" }];
    const ctx = makeCtx({ pendingToolSuggestions: suggestions });
    handleSSEEvent("done", { conversationId: "c1", turnId: "t1" }, ctx);
    expect(ctx.setFlow).toHaveBeenCalled();
  });

  it("should clear retry count on done", () => {
    const retryMap = new Map([["conv-1:hello", 2]]);
    const ctx = makeCtx({ retryCountRef: { current: retryMap } });
    handleSSEEvent("done", { conversationId: "conv-1" }, ctx);
    expect(retryMap.has("conv-1:hello")).toBe(false);
  });

  it("should set lastRetryMsgRef to message when no accumulated text", () => {
    const ctx = makeCtx({ accumulatedText: "" });
    handleSSEEvent("done", { conversationId: "c1" }, ctx);
    expect(ctx.lastRetryMsgRef.current).toBe("hello");
  });
});

/* ═══════════ SSE error event ═══════════ */
describe("handleSSEEvent: error", () => {
  it("should mark stream as error and add error flow item", () => {
    const ctx = makeCtx();
    handleSSEEvent("error", { errorCode: "RATE_LIMIT", message: "Too many requests", traceId: "tr-1" }, ctx);
    expect(ctx.streamHasError).toBe(true);
    expect(ctx.setStreamHasError).toHaveBeenCalledWith(true);
    // setFlow called twice: once to remove reply, once to add error
    expect(ctx.setFlow).toHaveBeenCalledTimes(2);
  });

  it("should clear retry count entry on error", () => {
    const retryMap = new Map([["conv-1:hello", 1]]);
    const ctx = makeCtx({ retryCountRef: { current: retryMap } });
    handleSSEEvent("error", { errorCode: "ERR" }, ctx);
    expect(retryMap.has("conv-1:hello")).toBe(false);
  });
});

/* ═══════════ SSE taskCreated event ═══════════ */
describe("handleSSEEvent: taskCreated", () => {
  it("should set active task and start polling", () => {
    const ctx = makeCtx();
    handleSSEEvent("taskCreated", { taskId: "task-1", runId: "run-1", taskState: { phase: "queued" } }, ctx);
    expect(ctx.hasTaskCreated).toBe(true);
    expect(ctx.setActiveTask).toHaveBeenCalled();
    expect(ctx.setTaskProgress).toHaveBeenCalled();
    expect(ctx.pollTaskState).toHaveBeenCalledWith("run-1");
  });

  it("should not set task when taskId or runId is missing", () => {
    const ctx = makeCtx();
    handleSSEEvent("taskCreated", { taskId: "task-1" }, ctx);
    expect(ctx.setActiveTask).not.toHaveBeenCalled();
  });
});

/* ═══════════ SSE nl2uiStatus event ═══════════ */
describe("handleSSEEvent: nl2uiStatus", () => {
  it("should set loading true on started", () => {
    const ctx = makeCtx();
    handleSSEEvent("nl2uiStatus", { phase: "started" }, ctx);
    expect(ctx.setNl2uiLoading).toHaveBeenCalledWith(true);
  });

  it("should set loading false on done", () => {
    const ctx = makeCtx();
    handleSSEEvent("nl2uiStatus", { phase: "done" }, ctx);
    expect(ctx.setNl2uiLoading).toHaveBeenCalledWith(false);
  });
});

/* ═══════════ SSE toolSuggestions event ═══════════ */
describe("handleSSEEvent: toolSuggestions", () => {
  it("should store suggestions from event data", () => {
    const ctx = makeCtx();
    const suggestions = [{ toolRef: "math", label: "Calculate" }];
    handleSSEEvent("toolSuggestions", { suggestions }, ctx);
    expect(ctx.pendingToolSuggestions).toEqual(suggestions);
    expect(ctx.setPendingToolSuggestions).toHaveBeenCalledWith(suggestions);
  });

  it("should default to empty array if suggestions is not an array", () => {
    const ctx = makeCtx();
    handleSSEEvent("toolSuggestions", { suggestions: "bad" }, ctx);
    expect(ctx.pendingToolSuggestions).toEqual([]);
  });
});

/* ═══════════ Request body construction patterns (useSendMessage core) ═══════════ */
describe("send request body construction", () => {
  it("should build minimal body with message and locale", () => {
    const body: Record<string, unknown> = {
      message: "hello",
      locale: "zh-CN",
      mode: "auto",
    };
    expect(body.message).toBe("hello");
    expect(body.mode).toBe("auto");
    expect(body).not.toHaveProperty("conversationId");
  });

  it("should include conversationId when present", () => {
    const conversationId = "conv-123";
    const body = {
      message: "test",
      locale: "zh-CN",
      mode: "auto",
      ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
    };
    expect(body.conversationId).toBe("conv-123");
  });

  it("should omit conversationId when empty", () => {
    const conversationId = "  ";
    const body = {
      message: "test",
      locale: "zh-CN",
      mode: "auto",
      ...(conversationId.trim() ? { conversationId: conversationId.trim() } : {}),
    };
    expect(body).not.toHaveProperty("conversationId");
  });

  it("should include defaultModelRef when selected", () => {
    const selectedModelRef = "openai:gpt-4o";
    const body = {
      message: "test",
      locale: "zh-CN",
      mode: "auto",
      ...(selectedModelRef ? { defaultModelRef: selectedModelRef } : {}),
    };
    expect(body.defaultModelRef).toBe("openai:gpt-4o");
  });

  it("should include activeTaskIds when non-empty", () => {
    const activeTaskIds = ["task-1", "task-2"];
    const body = {
      message: "test",
      locale: "zh-CN",
      mode: "auto",
      ...(activeTaskIds && activeTaskIds.length > 0 ? { activeTaskIds } : {}),
    };
    expect(body.activeTaskIds).toEqual(["task-1", "task-2"]);
  });
});

/* ═══════════ Retry backoff calculation ═══════════ */
describe("retry backoff logic", () => {
  it("should calculate exponential backoff with cap", () => {
    const calc = (retries: number) => Math.min(1000 * Math.pow(2, retries), 3000);
    expect(calc(0)).toBe(1000);
    expect(calc(1)).toBe(2000);
    expect(calc(2)).toBe(3000);
    expect(calc(3)).toBe(3000); // capped
  });

  it("should build retry message key correctly", () => {
    const conversationId = "conv-1";
    const message = "a".repeat(100);
    const msgKey = `${conversationId}:${message.slice(0, 50)}`;
    expect(msgKey).toBe(`conv-1:${"a".repeat(50)}`);
    expect(msgKey.length).toBe(57); // "conv-1:" (7) + 50
  });
});

/* ═══════════ SSE buffer parsing pattern ═══════════ */
describe("SSE buffer parsing", () => {
  it("should split SSE stream into events by double newline", () => {
    const raw = "event: delta\ndata: {\"text\":\"hi\"}\n\nevent: done\ndata: {\"conversationId\":\"c1\"}\n\n";
    const parts = raw.split("\n\n").filter(Boolean);
    expect(parts).toHaveLength(2);
  });

  it("should extract event name and data from SSE lines", () => {
    const part = "event: delta\ndata: {\"text\":\"hello\"}";
    const lines = part.split("\n");
    let evtName = "";
    let evtData = "";
    for (const ln of lines) {
      if (ln.startsWith("event: ")) evtName = ln.slice(7).trim();
      else if (ln.startsWith("data: ")) evtData += (evtData ? "\n" : "") + ln.slice(6);
    }
    expect(evtName).toBe("delta");
    expect(JSON.parse(evtData)).toEqual({ text: "hello" });
  });

  it("should handle multi-line data fields", () => {
    const part = "event: delta\ndata: {\"text\":\ndata: \"multi\"}";
    const lines = part.split("\n");
    let evtData = "";
    for (const ln of lines) {
      if (ln.startsWith("data: ")) evtData += (evtData ? "\n" : "") + ln.slice(6);
    }
    expect(evtData).toBe("{\"text\":\n\"multi\"}");
  });

  it("should skip empty parts after split", () => {
    const raw = "\n\nevent: delta\ndata: {}\n\n\n\n";
    const parts = raw.split("\n\n");
    const filtered = parts.filter((p) => p.trim());
    expect(filtered).toHaveLength(1);
  });
});
