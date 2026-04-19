import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock 外部依赖 ──────────────────────────────────────────────

vi.mock("../log", () => ({
  safeLog: vi.fn(),
  safeError: vi.fn(),
  sha256_8: vi.fn((s: string) => s.slice(0, 8).padEnd(8, "0")),
}));

vi.mock("../tray", () => ({
  isToolLocallyDisabled: vi.fn(() => false),
}));

vi.mock("./capabilityRegistry", () => ({
  findPluginForTool: vi.fn(() => null),
  getToolRiskLevel: vi.fn(() => "low"),
  registerPlugin: vi.fn(),
  resolveToolAlias: vi.fn((name: string) => name),
}));

vi.mock("./auth", () => ({
  isCallerAllowed: vi.fn(() => true),
  isToolAllowed: vi.fn(() => true),
  getOrCreateContext: vi.fn(),
  extractCallerFromRequest: vi.fn(() => ({ callerId: "caller-1" })),
}));

vi.mock("./toolFeatureFlags", () => ({
  isToolFeatureEnabled: vi.fn(() => ({ enabled: true })),
  getDegradationRule: vi.fn(() => null),
  recordToolSuccess: vi.fn(),
  recordToolFailure: vi.fn(),
}));

vi.mock("./audit", () => ({
  auditToolStart: vi.fn(async () => "evt-1"),
  auditToolSuccess: vi.fn(async () => "evt-2"),
  auditToolFailed: vi.fn(async () => "evt-3"),
  auditToolDenied: vi.fn(async () => "evt-4"),
}));

vi.mock("../plugins/builtinToolPlugin", () => ({
  default: {
    name: "builtin-tool-plugin",
    toolPrefixes: ["device."],
    toolNames: ["noop", "echo"],
    execute: vi.fn(async () => ({ status: "succeeded" })),
  },
}));

import {
  initTaskQueue,
  enqueueTask,
  dequeueTask,
  completeTask,
  cancelTask,
  getQueueStatus,
  getTask,
  getPendingTasks,
  type TaskPriority,
} from "../kernel/taskExecutor";

describe("taskExecutor — queue operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset queue by re-initing with small limits for testing
    initTaskQueue({ maxQueueSize: 10, defaultPriority: "normal", defaultTimeoutMs: 5000, maxRetries: 2 });
    // Drain any existing tasks
    while (dequeueTask()) { /* drain */ }
  });

  // ── enqueueTask ─────────────────────────────────────────────

  it("enqueues a task and returns it with generated taskId", () => {
    const task = enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" });
    expect(task).not.toBeNull();
    expect(task!.taskId).toMatch(/^task_/);
    expect(task!.state).toBe("pending");
    expect(task!.priority).toBe("normal");
    expect(task!.retryCount).toBe(0);
  });

  it("returns null when queue is full", () => {
    initTaskQueue({ maxQueueSize: 2 });
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.a" });
    enqueueTask({ deviceExecutionId: "de-2", toolRef: "device.test.b" });
    const result = enqueueTask({ deviceExecutionId: "de-3", toolRef: "device.test.c" });
    expect(result).toBeNull();
  });

  it("deduplicates by idempotencyKey", () => {
    const t1 = enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.a", idempotencyKey: "key-1" });
    const t2 = enqueueTask({ deviceExecutionId: "de-2", toolRef: "device.test.a", idempotencyKey: "key-1" });
    expect(t1!.taskId).toBe(t2!.taskId);
  });

  // ── dequeueTask ─────────────────────────────────────────────

  it("dequeues task and sets state to claimed", () => {
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" });
    const task = dequeueTask();
    expect(task).not.toBeNull();
    expect(task!.state).toBe("claimed");
    expect(task!.claimedAt).toBeDefined();
  });

  it("returns null when queue is empty", () => {
    expect(dequeueTask()).toBeNull();
  });

  // ── priority ordering ───────────────────────────────────────

  it("dequeues urgent tasks before normal tasks", () => {
    enqueueTask({ deviceExecutionId: "de-n", toolRef: "device.test.normal", priority: "normal" });
    enqueueTask({ deviceExecutionId: "de-u", toolRef: "device.test.urgent", priority: "urgent" });

    const first = dequeueTask();
    expect(first!.priority).toBe("urgent");
    expect(first!.deviceExecutionId).toBe("de-u");
  });

  // ── completeTask ────────────────────────────────────────────

  it("completes an executing task with succeeded status", () => {
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" });
    const task = dequeueTask()!;

    completeTask(task.taskId, {
      status: "succeeded",
      executedAt: new Date().toISOString(),
      durationMs: 100,
    });

    const found = getTask(task.taskId);
    expect(found.status).toBe("completed");
  });

  it("ignores completeTask for unknown taskId", () => {
    // Should not throw
    expect(() => completeTask("nonexistent", {
      status: "failed",
      executedAt: new Date().toISOString(),
      durationMs: 0,
    })).not.toThrow();
  });

  // ── cancelTask ──────────────────────────────────────────────

  it("cancels a queued task", () => {
    const task = enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" })!;
    const result = cancelTask(task.taskId);
    expect(result).toBe(true);
    expect(getTask(task.taskId).status).toBe("not_found");
  });

  it("cancels an executing task", () => {
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" });
    const task = dequeueTask()!;
    const result = cancelTask(task.taskId);
    expect(result).toBe(true);
  });

  it("returns false for non-existent task cancel", () => {
    expect(cancelTask("no-such-task")).toBe(false);
  });

  // ── getQueueStatus ──────────────────────────────────────────

  it("reports correct queue status", () => {
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.a", priority: "high" });
    enqueueTask({ deviceExecutionId: "de-2", toolRef: "device.test.b", priority: "low" });

    const status = getQueueStatus();
    expect(status.queueSize).toBe(2);
    expect(status.byPriority.high).toBe(1);
    expect(status.byPriority.low).toBe(1);
    expect(status.executingCount).toBeTypeOf("number");
  });

  // ── getTask ─────────────────────────────────────────────────

  it("returns queued status for pending task", () => {
    const task = enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" })!;
    const found = getTask(task.taskId);
    expect(found.status).toBe("queued");
    expect(found.task).not.toBeNull();
  });

  it("returns executing status for claimed task", () => {
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" });
    const task = dequeueTask()!;
    const found = getTask(task.taskId);
    expect(found.status).toBe("executing");
  });

  it("returns not_found for unknown taskId", () => {
    expect(getTask("unknown").status).toBe("not_found");
  });

  // ── getPendingTasks ─────────────────────────────────────────

  it("returns all pending tasks as a copy", () => {
    enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.a" });
    enqueueTask({ deviceExecutionId: "de-2", toolRef: "device.test.b" });

    const pending = getPendingTasks();
    expect(pending).toHaveLength(2);
    // Verify it's a copy
    pending.pop();
    expect(getPendingTasks()).toHaveLength(2);
  });

  // ── timeoutMs / maxRetries defaults ─────────────────────────

  it("applies config defaults for timeoutMs and maxRetries", () => {
    const task = enqueueTask({ deviceExecutionId: "de-1", toolRef: "device.test.echo" });
    expect(task!.timeoutMs).toBe(5000);
    expect(task!.maxRetries).toBe(2);
  });

  it("allows overriding timeoutMs and maxRetries per task", () => {
    const task = enqueueTask({
      deviceExecutionId: "de-1",
      toolRef: "device.test.echo",
      timeoutMs: 30000,
      maxRetries: 5,
    });
    expect(task!.timeoutMs).toBe(30000);
    expect(task!.maxRetries).toBe(5);
  });
});
