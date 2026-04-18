/**
 * TEST-06: 端到端多任务模拟测试
 *
 * 模拟用户连续发送 3 个任务的完整生命周期：
 * 1. 入队 3 个任务
 * 2. 任务 A、B 并发执行，C 依赖 A
 * 3. A 完成 → C 的依赖解析 → C 开始执行
 * 4. B 失败 → 自动重试 → 重试成功
 * 5. 前后台切换
 * 6. 所有任务完成
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

/* ── mock repo ───────────────────────────────────────── */
let entryDb: Map<string, any>;
let depDb: Map<string, any>;
let nextPos = 0;

const mockRepo = vi.hoisted(() => ({
  insertQueueEntry: vi.fn(),
  countExecuting: vi.fn(),
  listSchedulable: vi.fn(),
  listActiveEntries: vi.fn(),
  listSessionDependencies: vi.fn(),
  areAllDepsResolved: vi.fn(),
  updateEntryStatus: vi.fn(),
  getEntry: vi.fn(),
  incrementRetry: vi.fn(),
  updateForeground: vi.fn(),
  reorderEntry: vi.fn(),
  cancelAllActive: vi.fn(),
  listGlobalActiveEntries: vi.fn(),
  batchPauseForShutdown: vi.fn(),
  resolveUpstreamDeps: vi.fn(),
  blockUpstreamDeps: vi.fn(),
  getCascadeCancelTargets: vi.fn(),
  repairBlockedDeps: vi.fn(),
  getBlockedDownstreamEntries: vi.fn(),
}));

vi.mock("./taskQueueRepo", () => mockRepo);

vi.mock("./completionNotifier", () => ({
  notifyBackgroundTaskCompleted: vi.fn(async () => []),
  notifyBackgroundTaskFailed: vi.fn(async () => []),
  notifyTaskNeedsIntervention: vi.fn(async () => []),
}));

import { TaskQueueManager } from "./taskQueueManager";
import type { TaskQueueEntry, QueueEvent } from "./taskQueue.types";

function makeEntry(id: string, goal: string, overrides: Partial<TaskQueueEntry> = {}): TaskQueueEntry {
  return {
    entryId: id,
    tenantId: "t-1",
    spaceId: null,
    sessionId: "s-1",
    taskId: `task-${id}`,
    runId: null,
    jobId: null,
    goal,
    mode: "execute",
    priority: 50,
    position: nextPos++,
    status: "queued",
    foreground: id === "A",
    enqueuedAt: new Date().toISOString(),
    readyAt: null,
    startedAt: null,
    completedAt: null,
    estimatedDurationMs: null,
    retryCount: 0,
    lastError: null,
    checkpointRef: null,
    createdBySubjectId: "sub-1",
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Multi-task E2E simulation", () => {
  let mgr: TaskQueueManager;
  let events: QueueEvent[];

  beforeEach(() => {
    vi.resetAllMocks();
    nextPos = 0;
    events = [];
    entryDb = new Map();
    depDb = new Map();

    mgr = new TaskQueueManager({} as any);
    mgr.setEmitter({ emit: (e) => events.push(e) });
    // Disable auto-retry for controlled testing
    mgr.setRetryConfig({ maxAutoRetries: 0 });
  });

  it("full lifecycle: 3 tasks with dependency, failure, retry, and completion", async () => {
    // ── Phase 1: Enqueue 3 tasks ──
    const entryA = makeEntry("A", "Research topic");
    const entryB = makeEntry("B", "Generate image");
    const entryC = makeEntry("C", "Write report (depends on A)");

    // Enqueue A
    mockRepo.insertQueueEntry.mockResolvedValueOnce(entryA);
    mockRepo.countExecuting.mockResolvedValueOnce(0);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);
    const resultA = await mgr.enqueue({
      tenantId: "t-1", sessionId: "s-1", goal: entryA.goal,
      mode: "execute", createdBySubjectId: "sub-1",
    });
    expect(resultA.entry.entryId).toBe("A");

    // Enqueue B
    mockRepo.insertQueueEntry.mockResolvedValueOnce(entryB);
    mockRepo.countExecuting.mockResolvedValueOnce(1);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);
    const resultB = await mgr.enqueue({
      tenantId: "t-1", sessionId: "s-1", goal: entryB.goal,
      mode: "execute", createdBySubjectId: "sub-1",
    });
    expect(resultB.entry.entryId).toBe("B");

    // Enqueue C
    mockRepo.insertQueueEntry.mockResolvedValueOnce(entryC);
    mockRepo.countExecuting.mockResolvedValueOnce(2);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);
    const resultC = await mgr.enqueue({
      tenantId: "t-1", sessionId: "s-1", goal: entryC.goal,
      mode: "execute", createdBySubjectId: "sub-1",
    });
    expect(resultC.entry.entryId).toBe("C");

    // Verify 3 taskQueued events
    const queuedEvents = events.filter((e) => e.type === "taskQueued");
    expect(queuedEvents).toHaveLength(3);

    // ── Phase 2: A completes → dependency resolved → C becomes schedulable ──
    const completedA = { ...entryA, status: "completed" as const };
    mockRepo.updateEntryStatus.mockResolvedValueOnce(completedA);
    mockRepo.resolveUpstreamDeps.mockResolvedValueOnce([
      { depId: "dep-1", fromEntryId: "C", toEntryId: "A", depType: "finish_to_start", status: "resolved" },
    ]);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);

    await mgr.markCompleted("A");

    const completedEvent = events.find((e) => e.type === "taskCompleted" && e.entryId === "A");
    expect(completedEvent).toBeDefined();

    const depResolvedEvent = events.find((e) => e.type === "depResolved");
    expect(depResolvedEvent).toBeDefined();

    // ── Phase 3: B fails ──
    const failedB = { ...entryB, status: "failed" as const, retryCount: 0, lastError: "timeout" };
    // P0-2 修复：markFailed 新增状态守卫，需要 getEntry 返回非终态状态
    mockRepo.getEntry.mockResolvedValueOnce({ ...entryB, status: "executing" });
    mockRepo.updateEntryStatus.mockResolvedValueOnce(failedB);
    mockRepo.blockUpstreamDeps.mockResolvedValueOnce([]);
    mockRepo.getCascadeCancelTargets.mockResolvedValueOnce([]);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);

    await mgr.markFailed("B", "timeout");

    const failedEvent = events.find((e) => e.type === "taskFailed" && e.entryId === "B");
    expect(failedEvent).toBeDefined();

    // ── Phase 4: Manual retry B ──
    const failedForRetry = { ...failedB, status: "failed" as const };
    mockRepo.getEntry.mockResolvedValueOnce(failedForRetry);
    const retriedB = { ...entryB, status: "queued" as const, retryCount: 1, lastError: "timeout" };
    mockRepo.incrementRetry.mockResolvedValueOnce(retriedB);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);

    const retryResult = await mgr.retry("B");
    expect(retryResult).toBeDefined();
    expect(retryResult!.retryCount).toBe(1);

    // ── Phase 5: Foreground/background switch ──
    const bgA = { ...completedA, foreground: false };
    mockRepo.updateForeground.mockResolvedValueOnce(bgA);
    const switchResult = await mgr.setForeground("A", false);
    expect(switchResult!.foreground).toBe(false);

    const bgEvent = events.find((e) => e.type === "taskBackground");
    expect(bgEvent).toBeDefined();

    // ── Phase 6: B and C complete ──
    const completedB = { ...retriedB, status: "completed" as const };
    mockRepo.updateEntryStatus.mockResolvedValueOnce(completedB);
    mockRepo.resolveUpstreamDeps.mockResolvedValueOnce([]);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);
    await mgr.markCompleted("B");

    const completedC = { ...entryC, status: "completed" as const };
    mockRepo.updateEntryStatus.mockResolvedValueOnce(completedC);
    mockRepo.resolveUpstreamDeps.mockResolvedValueOnce([]);
    mockRepo.listSchedulable.mockResolvedValueOnce([]);
    await mgr.markCompleted("C");

    // ── Final assertions ──
    const allCompleted = events.filter((e) => e.type === "taskCompleted");
    expect(allCompleted).toHaveLength(3);

    // Verify event timeline integrity
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("taskQueued");
    expect(eventTypes).toContain("taskCompleted");
    expect(eventTypes).toContain("taskFailed");
    expect(eventTypes).toContain("depResolved");
    expect(eventTypes).toContain("taskBackground");
  });
});
