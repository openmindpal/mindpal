/**
 * TEST-01: taskQueueManager 单元测试
 *
 * 覆盖：enqueue / 调度 / cancel / retry / 前后台切换 / 自动重试 / 依赖链修复 / 优雅关闭
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

/* ── mock 整个 repo 层 ────────────────────────────────── */
const mockRepo = vi.hoisted(() => ({
  insertQueueEntry: vi.fn(),
  countExecuting: vi.fn(),
  listActiveEntries: vi.fn(),
  listSchedulable: vi.fn(),
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

/* ── 辅助工厂 ────────────────────────────────────────── */
function fakeEntry(overrides: Partial<TaskQueueEntry> = {}): TaskQueueEntry {
  return {
    entryId: "e-1",
    tenantId: "t-1",
    spaceId: null,
    sessionId: "s-1",
    taskId: "task-1",
    runId: null,
    jobId: null,
    goal: "Test goal",
    mode: "execute",
    priority: 50,
    position: 0,
    status: "queued",
    foreground: true,
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

/* ── 测试 ────────────────────────────────────────────── */
describe("TaskQueueManager", () => {
  let mgr: TaskQueueManager;
  let emittedEvents: QueueEvent[];

  beforeEach(() => {
    vi.resetAllMocks();
    emittedEvents = [];
    mgr = new TaskQueueManager({} as any);
    mgr.setEmitter({ emit: (e) => emittedEvents.push(e) });
  });

  /* ── enqueue ──────────────────────────────────────── */
  describe("enqueue", () => {
    it("should enqueue a task and emit taskQueued event", async () => {
      const entry = fakeEntry();
      mockRepo.insertQueueEntry.mockResolvedValueOnce(entry);
      mockRepo.countExecuting.mockResolvedValueOnce(0);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await mgr.enqueue({
        tenantId: "t-1",
        sessionId: "s-1",
        goal: "Test goal",
        mode: "execute",
        createdBySubjectId: "sub-1",
      });

      expect(result.entry.entryId).toBe("e-1");
      expect(result.position).toBe(0);
      expect(result.activeCount).toBe(0);

      const queued = emittedEvents.find((e) => e.type === "taskQueued");
      expect(queued).toBeDefined();
      expect(queued!.entryId).toBe("e-1");
    });
  });

  /* ── markCompleted ────────────────────────────────── */
  describe("markCompleted", () => {
    it("should mark task completed, emit event, resolve deps, and schedule next", async () => {
      const entry = fakeEntry({ status: "completed" });
      mockRepo.updateEntryStatus.mockResolvedValueOnce(entry);
      mockRepo.resolveUpstreamDeps.mockResolvedValueOnce([]);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      await mgr.markCompleted("e-1");

      const completed = emittedEvents.find((e) => e.type === "taskCompleted");
      expect(completed).toBeDefined();
    });

    it("should notify when background task completes", async () => {
      const entry = fakeEntry({ status: "completed", foreground: false });
      mockRepo.updateEntryStatus.mockResolvedValueOnce(entry);
      mockRepo.resolveUpstreamDeps.mockResolvedValueOnce([]);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const { notifyBackgroundTaskCompleted } = await import("./completionNotifier");
      await mgr.markCompleted("e-1");

      expect(notifyBackgroundTaskCompleted).toHaveBeenCalled();
    });
  });

  /* ── markFailed + auto retry ──────────────────────── */
  describe("markFailed", () => {
    it("should mark task failed and emit taskFailed", async () => {
      const entry = fakeEntry({ status: "failed", retryCount: 2 });
      // P0-2 修复：markFailed 新增状态守卫，需要 getEntry 返回非终态状态
      mockRepo.getEntry.mockResolvedValueOnce(fakeEntry({ status: "executing" }));
      mockRepo.updateEntryStatus.mockResolvedValueOnce(entry);
      mockRepo.blockUpstreamDeps.mockResolvedValueOnce([]);
      mockRepo.getCascadeCancelTargets.mockResolvedValueOnce([]);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      // disable auto retry (retryCount >= maxAutoRetries=2)
      await mgr.markFailed("e-1", "some error");

      const failed = emittedEvents.find((e) => e.type === "taskFailed");
      expect(failed).toBeDefined();
    });

    it("should auto-retry when retryCount < maxAutoRetries", async () => {
      vi.useFakeTimers();
      const entry = fakeEntry({ status: "failed", retryCount: 0 });
      // P0-2 修复：markFailed 状态守卫的 getEntry
      mockRepo.getEntry.mockResolvedValueOnce(fakeEntry({ status: "executing" }));
      mockRepo.updateEntryStatus.mockResolvedValueOnce(entry);

      // retry mock
      const retried = fakeEntry({ status: "queued", retryCount: 1 });
      mockRepo.getEntry.mockResolvedValueOnce(fakeEntry({ status: "failed" }));
      mockRepo.incrementRetry.mockResolvedValueOnce(retried);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      await mgr.markFailed("e-1", "transient error");

      // Should emit taskRetried
      const retriedEvent = emittedEvents.find((e) => e.type === "taskRetried");
      expect(retriedEvent).toBeDefined();
      expect((retriedEvent!.data as any).retryCount).toBe(1);

      // Advance timer to trigger the retry
      vi.advanceTimersByTime(5000);
      vi.useRealTimers();
    });
  });

  /* ── cancel ───────────────────────────────────────── */
  describe("cancel", () => {
    it("should cancel an active task", async () => {
      const entry = fakeEntry({ status: "executing" });
      mockRepo.getEntry.mockResolvedValueOnce(entry);
      mockRepo.updateEntryStatus.mockResolvedValueOnce({ ...entry, status: "cancelled" });
      mockRepo.blockUpstreamDeps.mockResolvedValueOnce([]);
      mockRepo.getCascadeCancelTargets.mockResolvedValueOnce([]);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await mgr.cancel("e-1");
      expect(result).toBeDefined();
      expect(result!.status).toBe("cancelled");

      const cancelled = emittedEvents.find((e) => e.type === "taskCancelled");
      expect(cancelled).toBeDefined();
    });

    it("should return null for terminal tasks", async () => {
      mockRepo.getEntry.mockResolvedValueOnce(fakeEntry({ status: "completed" }));
      const result = await mgr.cancel("e-1");
      expect(result).toBeNull();
    });
  });

  /* ── pause / resume ───────────────────────────────── */
  describe("pause / resume", () => {
    it("should pause an executing task", async () => {
      const entry = fakeEntry({ status: "executing" });
      mockRepo.getEntry.mockResolvedValueOnce(entry);
      mockRepo.updateEntryStatus.mockResolvedValueOnce({ ...entry, status: "paused" });
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await mgr.pause("e-1");
      expect(result!.status).toBe("paused");
    });

    it("should resume a paused task", async () => {
      const entry = fakeEntry({ status: "paused" });
      mockRepo.getEntry.mockResolvedValueOnce(entry);
      mockRepo.updateEntryStatus.mockResolvedValueOnce({ ...entry, status: "ready" });
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await mgr.resume("e-1");
      expect(result!.status).toBe("ready");
    });
  });

  /* ── retry ────────────────────────────────────────── */
  describe("retry", () => {
    it("should retry a failed task", async () => {
      const entry = fakeEntry({ status: "failed", lastError: "err" });
      mockRepo.getEntry.mockResolvedValueOnce(entry);
      const retried = fakeEntry({ status: "queued", retryCount: 1 });
      mockRepo.incrementRetry.mockResolvedValueOnce(retried);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await mgr.retry("e-1");
      expect(result!.retryCount).toBe(1);
    });

    it("should return null for non-failed task", async () => {
      mockRepo.getEntry.mockResolvedValueOnce(fakeEntry({ status: "executing" }));
      const result = await mgr.retry("e-1");
      expect(result).toBeNull();
    });
  });

  /* ── foreground / background ──────────────────────── */
  describe("setForeground", () => {
    it("should toggle foreground and emit event", async () => {
      const entry = fakeEntry({ foreground: false });
      mockRepo.updateForeground.mockResolvedValueOnce({ ...entry, foreground: true });

      const result = await mgr.setForeground("e-1", true);
      expect(result!.foreground).toBe(true);

      const fg = emittedEvents.find((e) => e.type === "taskForeground");
      expect(fg).toBeDefined();
    });
  });

  /* ── dependency chain repair (P3-14) ──────────────── */
  describe("repairDependencyChain", () => {
    it("should repair blocked deps and emit depRepaired events", async () => {
      const entry = fakeEntry({ status: "failed" });
      mockRepo.getEntry.mockResolvedValueOnce(entry);
      mockRepo.getBlockedDownstreamEntries.mockResolvedValueOnce(["e-2", "e-3"]);
      mockRepo.repairBlockedDeps.mockResolvedValueOnce([
        { depId: "d-1", fromEntryId: "e-2", depType: "finish_to_start" },
        { depId: "d-2", fromEntryId: "e-3", depType: "output_to_input" },
      ]);
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await mgr.repairDependencyChain("e-1");
      expect(result.repairedDeps).toBe(2);
      expect(result.unblockedEntries).toEqual(["e-2", "e-3"]);

      const repaired = emittedEvents.filter((e) => e.type === "depRepaired");
      expect(repaired).toHaveLength(2);
    });
  });

  /* ── graceful shutdown (P3-15) ────────────────────── */
  describe("pauseAllForShutdown", () => {
    it("should pause all active tasks and write checkpoint", async () => {
      const entries = [
        fakeEntry({ entryId: "e-1", status: "executing", sessionId: "s-1" }),
        fakeEntry({ entryId: "e-2", status: "queued", sessionId: "s-1" }),
      ];
      mockRepo.listGlobalActiveEntries.mockResolvedValueOnce(entries);
      mockRepo.batchPauseForShutdown.mockResolvedValueOnce(2);

      const count = await mgr.pauseAllForShutdown();
      expect(count).toBe(2);
      expect(mockRepo.batchPauseForShutdown).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining("shutdown:"),
      );
    });
  });

  /* ── getSnapshot ──────────────────────────────────── */
  describe("getSnapshot", () => {
    it("should return queue snapshot with correct counts", async () => {
      const entries = [
        fakeEntry({ entryId: "e-1", status: "executing", foreground: true }),
        fakeEntry({ entryId: "e-2", status: "queued", foreground: false }),
      ];
      mockRepo.listActiveEntries.mockResolvedValueOnce(entries);
      mockRepo.listSessionDependencies.mockResolvedValueOnce([]);

      const snapshot = await mgr.getSnapshot("t-1", "s-1");
      expect(snapshot.activeCount).toBe(1);
      expect(snapshot.queuedCount).toBe(1);
      expect(snapshot.foregroundEntryId).toBe("e-1");
    });
  });
});
