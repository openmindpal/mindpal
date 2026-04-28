import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Mock SDK 内部依赖模块（迁移后路径） ──────────────────────────

const { mockExecuteNativeGuiAction } = vi.hoisted(() => ({
  mockExecuteNativeGuiAction: vi.fn(async (_action: string, _target?: any, _params?: any) => {
    return { detail: { key: _params?.key, keys: _params?.keys } };
  }),
}));

// Mock SDK 内核 GUI Action Kernel
vi.mock("../../../../packages/device-agent-sdk/src/kernel/guiActionKernel", () => ({
  executeNativeGuiAction: mockExecuteNativeGuiAction,
  SCREEN_CHANGING_ACTIONS: new Set(["click", "doubleClick", "type", "pressKey", "pressCombo", "scroll"]),
}));

// Mock SDK 内核审计模块
vi.mock("../../../../packages/device-agent-sdk/src/kernel/audit", () => ({
  logAuditEvent: vi.fn(async () => "evt-mock"),
  uploadArtifact: vi.fn(async () => ({ artifactId: "art-1", storageRef: "file://art", hash: "abc", sizeBytes: 0 })),
  initAudit: vi.fn(),
  getAuditDir: vi.fn(),
  isAuditEnabled: vi.fn(() => false),
  auditToolStart: vi.fn(),
  auditToolSuccess: vi.fn(),
  auditToolFailed: vi.fn(),
  auditToolDenied: vi.fn(),
  cleanupOldAuditLogs: vi.fn(),
  readAuditLogs: vi.fn(),
  recordReplayTrace: vi.fn(),
}));

// Mock SDK 内核能力注册表
vi.mock("../../../../packages/device-agent-sdk/src/kernel/capabilityRegistry", () => ({
  registerCapabilities: vi.fn(),
  dispatchMessageToPlugins: vi.fn(async () => {}),
  registerCapability: vi.fn(),
  unregisterCapability: vi.fn(),
  unregisterPluginCapabilities: vi.fn(),
  getCapability: vi.fn(),
  findCapabilitiesByPrefix: vi.fn(() => []),
  findCapabilitiesByRiskLevel: vi.fn(() => []),
  findCapabilitiesByTag: vi.fn(() => []),
  listCapabilities: vi.fn(() => []),
  getToolRiskLevel: vi.fn(),
  registerPlugin: vi.fn(),
  unregisterPlugin: vi.fn(),
  findPluginForTool: vi.fn(() => null),
  listPlugins: vi.fn(() => []),
  clearAll: vi.fn(),
  registerToolAlias: vi.fn(),
  registerToolAliases: vi.fn(),
  registerPrefixRule: vi.fn(),
  registerPrefixRules: vi.fn(),
  resolveToolAlias: vi.fn(),
  listToolAliases: vi.fn(() => []),
  listPrefixRules: vi.fn(() => []),
  loadAliasesFromFile: vi.fn(),
  loadAliasesFromEnv: vi.fn(),
  initToolAliases: vi.fn(),
  exportCapabilityManifest: vi.fn(() => []),
  getMultimodalCapabilities: vi.fn(() => []),
}));

// Mock SDK OCR 缓存服务
vi.mock("../../../../packages/device-agent-sdk/src/kernel/ocrCacheService", () => ({
  OcrCacheService: vi.fn(),
  getOcrCacheService: vi.fn(() => ({
    get: vi.fn(() => null),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
    clear: vi.fn(),
  })),
  resetOcrCacheService: vi.fn(),
}));

import { createStreamingExecutor, setVisionProvider, type StreamingEvent } from "@openslin/device-agent-sdk";

// 提供测试用 VisionProvider
const mockVisionProvider = {
  captureScreen: vi.fn(async () => ({ filePath: "/tmp/screen.png", width: 1920, height: 1080 })),
  cleanupCapture: vi.fn(async () => {}),
  ocrScreen: vi.fn(async () => []),
  findTextInOcrResults: vi.fn(() => null),
  clickMouse: vi.fn(async () => {}),
  doubleClick: vi.fn(async () => {}),
  typeText: vi.fn(async () => {}),
  pressKey: vi.fn(async () => {}),
  pressCombo: vi.fn(async () => {}),
  moveMouse: vi.fn(async () => {}),
  scroll: vi.fn(async () => {}),
};

describe("StreamingExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setVisionProvider(mockVisionProvider as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts in idle state and transitions to running on start()", () => {
    const executor = createStreamingExecutor();
    expect(executor.state).toBe("idle");
    executor.start();
    expect(executor.state).toBe("running");
    executor.stop();
  });

  it("executes multiple pressKey steps sequentially", async () => {
    const executor = createStreamingExecutor({ interStepDelayMs: 0, stepTimeoutMs: 5000 });
    const events: StreamingEvent[] = [];
    executor.onEvent((e) => events.push(e));

    executor.start();
    executor.appendSteps([
      { action: "pressKey", key: "a" } as any,
      { action: "pressKey", key: "b" } as any,
    ]);
    executor.markInputDone();

    // Let the run loop process steps
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(50);

    expect(executor.state).toBe("stopped");
    expect(executor.completedSteps).toBe(2);
    expect(executor.failedSteps).toBe(0);
    expect(mockExecuteNativeGuiAction).toHaveBeenCalledTimes(2);
  });

  it("stopOnError causes transition to error state on step failure", async () => {
    mockExecuteNativeGuiAction.mockRejectedValueOnce(new Error("key fail"));

    const executor = createStreamingExecutor({ stopOnError: true, interStepDelayMs: 0 });
    const events: StreamingEvent[] = [];
    executor.onEvent((e) => events.push(e));

    executor.start();
    executor.appendSteps([{ action: "pressKey", key: "x" } as any]);
    executor.markInputDone();

    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50);

    expect(executor.state).toBe("error");
    expect(executor.failedSteps).toBe(1);
  });

  it("skips failed step and continues when stopOnError is false", async () => {
    mockExecuteNativeGuiAction
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({ detail: { key: undefined, keys: undefined } });

    const executor = createStreamingExecutor({ stopOnError: false, interStepDelayMs: 0 });
    executor.start();
    executor.appendSteps([
      { action: "pressKey", key: "a" } as any,
      { action: "pressKey", key: "b" } as any,
    ]);
    executor.markInputDone();

    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(50);

    expect(executor.state).toBe("stopped");
    expect(executor.completedSteps).toBe(1);
    expect(executor.failedSteps).toBe(1);
  });

  it("pause and resume controls execution flow", async () => {
    const executor = createStreamingExecutor({ interStepDelayMs: 0 });
    executor.start();
    expect(executor.state).toBe("running");

    executor.pause();
    expect(executor.state).toBe("paused");

    executor.resume();
    expect(executor.state).toBe("running");

    executor.stop();
    expect(executor.state).toBe("stopped");
  });

  it("getSummary returns correct statistics", async () => {
    const executor = createStreamingExecutor({ interStepDelayMs: 0 });
    executor.start();
    executor.appendSteps([{ action: "pressKey", key: "a" } as any]);
    executor.markInputDone();

    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50);

    const summary = executor.getSummary();
    expect(summary.totalSteps).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.state).toBe("stopped");
  });

  it("emits backpressure event when queue exceeds maxQueueSize", () => {
    const executor = createStreamingExecutor({ maxQueueSize: 3 });
    const events: StreamingEvent[] = [];
    executor.onEvent((e) => events.push(e));

    const steps = Array.from({ length: 5 }, () => ({ action: "pressKey", key: "a" }) as any);
    executor.appendSteps(steps);

    const backpressure = events.find((e) => e.type === "backpressure");
    expect(backpressure).toBeDefined();
    expect((backpressure as any).paused).toBe(true);
    executor.stop();
  });

  it("stop clears queue and transitions to stopped", () => {
    const executor = createStreamingExecutor();
    executor.start();
    executor.appendSteps([
      { action: "pressKey", key: "a" } as any,
      { action: "pressKey", key: "b" } as any,
    ]);
    expect(executor.queueSize).toBe(2);

    executor.stop();
    expect(executor.queueSize).toBe(0);
    expect(executor.state).toBe("stopped");
  });

  it("emits session_end event when execution completes", async () => {
    const executor = createStreamingExecutor({ interStepDelayMs: 0 });
    const events: StreamingEvent[] = [];
    executor.onEvent((e) => events.push(e));

    executor.start();
    executor.appendSteps([{ action: "pressKey", key: "a" } as any]);
    executor.markInputDone();

    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50);

    const sessionEnd = events.find((e) => e.type === "session_end");
    expect(sessionEnd).toBeDefined();
    expect((sessionEnd as any).totalSteps).toBe(1);
    expect((sessionEnd as any).succeeded).toBe(1);
  });

  it("handles unknown action as failed step", async () => {
    const executor = createStreamingExecutor({ interStepDelayMs: 0 });
    executor.start();
    executor.appendSteps([{ action: "unknownAction" } as any]);
    executor.markInputDone();

    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50);

    expect(executor.failedSteps).toBe(1);
    expect(executor.completedSteps).toBe(0);
  });
});
