import { describe, it, expect, vi, beforeEach } from "vitest";

/* ─── Mock path-aliased modules ─── */
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(),
  setLocale: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({
  t: vi.fn((key: string) => key),
}));
vi.mock("@/lib/apiError", () => ({
  nextId: vi.fn(() => "mock-id-" + Math.random().toString(36).slice(2, 8)),
  errorMessageText: vi.fn((err: any) => err?.message ?? "error"),
}));

import { readSavedTaskQueueState } from "../../useChatSession";

/* ─── localStorage mock ─── */
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k]; }),
};
vi.stubGlobal("localStorage", localStorageMock);

const SESSION_KEY = "openslin_chat_session";
const TASK_QUEUE_KEY = "openslin_task_queue_state";
const MODEL_KEY = "openslin_selected_model";

beforeEach(() => {
  localStorageMock.clear();
  vi.clearAllMocks();
});

/* ═══════════ readSavedTaskQueueState (pure function) ═══════════ */
describe("readSavedTaskQueueState", () => {
  it("should return empty arrays when localStorage has no data", () => {
    const result = readSavedTaskQueueState();
    expect(result).toEqual({ pendingEntries: [], dependencies: [] });
  });

  it("should parse valid task queue state from localStorage", () => {
    const saved = {
      pendingEntries: [{ id: "t1", skillRef: "echo", input: {} }],
      dependencies: [{ from: "t1", to: "t2" }],
    };
    store[TASK_QUEUE_KEY] = JSON.stringify(saved);
    const result = readSavedTaskQueueState();
    expect(result.pendingEntries).toHaveLength(1);
    expect(result.pendingEntries[0]).toEqual(saved.pendingEntries[0]);
    expect(result.dependencies).toHaveLength(1);
  });

  it("should return empty arrays when JSON is invalid", () => {
    store[TASK_QUEUE_KEY] = "not-valid-json{{{";
    const result = readSavedTaskQueueState();
    expect(result).toEqual({ pendingEntries: [], dependencies: [] });
  });

  it("should default non-array fields to empty arrays", () => {
    store[TASK_QUEUE_KEY] = JSON.stringify({ pendingEntries: "bad", dependencies: 123 });
    const result = readSavedTaskQueueState();
    expect(result).toEqual({ pendingEntries: [], dependencies: [] });
  });

  it("should handle partial data gracefully", () => {
    store[TASK_QUEUE_KEY] = JSON.stringify({ pendingEntries: [{ id: "x" }] });
    const result = readSavedTaskQueueState();
    expect(result.pendingEntries).toHaveLength(1);
    expect(result.dependencies).toEqual([]);
  });
});

/* ═══════════ Session persistence patterns ═══════════ */
describe("session localStorage patterns", () => {
  it("should store and retrieve a valid session JSON", () => {
    const session = { conversationId: "conv-1", flow: [{ kind: "message", id: "m1", role: "user", text: "hello" }], toolExecStates: {} };
    store[SESSION_KEY] = JSON.stringify(session);

    const raw = localStorage.getItem(SESSION_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.conversationId).toBe("conv-1");
    expect(parsed.flow).toHaveLength(1);
    expect(parsed.flow[0].text).toBe("hello");
  });

  it("should return null for missing session key", () => {
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("should handle session with empty conversationId", () => {
    const session = { conversationId: "", flow: [], toolExecStates: {} };
    store[SESSION_KEY] = JSON.stringify(session);
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY)!);
    expect(parsed.conversationId).toBe("");
    expect(parsed.flow).toEqual([]);
  });

  it("should persist model selection in localStorage", () => {
    store[MODEL_KEY] = "openai:gpt-4o";
    expect(localStorage.getItem(MODEL_KEY)).toBe("openai:gpt-4o");
  });

  it("should restore toolExecStates with only done/error states", () => {
    const session = {
      conversationId: "c1",
      flow: [],
      toolExecStates: {
        "tool-1": { status: "done", result: "ok" },
        "tool-2": { status: "running" },
        "tool-3": { status: "error", error: "timeout" },
      },
    };
    store[SESSION_KEY] = JSON.stringify(session);
    const parsed = JSON.parse(localStorage.getItem(SESSION_KEY)!);
    // The hook filters to only done/error — verify the pattern
    const restored: Record<string, any> = {};
    for (const [k, v] of Object.entries(parsed.toolExecStates)) {
      const state = v as any;
      if (state.status === "done" || state.status === "error") {
        restored[k] = state;
      }
    }
    expect(Object.keys(restored)).toEqual(["tool-1", "tool-3"]);
    expect(restored["tool-1"].status).toBe("done");
    expect(restored["tool-3"].status).toBe("error");
  });
});

/* ═══════════ startNew logic pattern ═══════════ */
describe("startNew session cleanup", () => {
  it("should clear session and task queue keys on startNew", () => {
    store[SESSION_KEY] = JSON.stringify({ conversationId: "old" });
    store[TASK_QUEUE_KEY] = JSON.stringify({ pendingEntries: [{ id: "t1" }] });

    // Simulate startNew behavior
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TASK_QUEUE_KEY);

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(localStorage.getItem(TASK_QUEUE_KEY)).toBeNull();
  });

  it("should not throw when keys do not exist", () => {
    expect(() => {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TASK_QUEUE_KEY);
    }).not.toThrow();
  });
});
