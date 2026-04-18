/**
 * TEST-04 + TEST-05: sessionScheduler 单元 + 集成测试
 *
 * 覆盖：调度策略 / 并发限制 / 抢占 / 饥饿检测 / 指标
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

/* ── mock repo layer ─────────────────────────────────── */
const mockRepo = vi.hoisted(() => ({
  listSchedulable: vi.fn(),
  countExecuting: vi.fn(),
  areAllDepsResolved: vi.fn(),
  listActiveEntries: vi.fn(),
  getEntry: vi.fn(),
  updateEntryStatus: vi.fn(),
  updatePriority: vi.fn(),
}));

vi.mock("./taskQueueRepo", () => mockRepo);

import { SessionScheduler, getSessionConfig, updateSessionConfig, resetSchedulerMetrics, getSchedulerMetrics, recordScheduleMetric, recordStarvationBoost } from "./sessionScheduler";
import type { TaskQueueEntry } from "./taskQueue.types";

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

describe("SessionScheduler", () => {
  let scheduler: SessionScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSchedulerMetrics();
    scheduler = new SessionScheduler({} as any);
  });

  describe("decideNext", () => {
    it("returns no_schedulable_tasks when queue is empty", async () => {
      mockRepo.listSchedulable.mockResolvedValueOnce([]);

      const result = await scheduler.decideNext("t-1", "s-1");
      expect(result.decision.immediate).toBe(false);
      expect(result.decision.reason).toBe("no_schedulable_tasks");
      expect(result.candidate).toBeNull();
    });

    it("schedules task when concurrency allows", async () => {
      const entry = fakeEntry({ entryId: "e-1", priority: 50, position: 0 });
      mockRepo.listSchedulable.mockResolvedValueOnce([entry]);
      mockRepo.countExecuting.mockResolvedValueOnce(0);
      mockRepo.areAllDepsResolved.mockResolvedValueOnce(true);

      const result = await scheduler.decideNext("t-1", "s-1");
      expect(result.decision.immediate).toBe(true);
      expect(result.candidate!.entryId).toBe("e-1");
    });

    it("respects concurrency limit", async () => {
      const entry = fakeEntry();
      mockRepo.listSchedulable.mockResolvedValueOnce([entry]);
      mockRepo.countExecuting.mockResolvedValueOnce(3);
      mockRepo.areAllDepsResolved.mockResolvedValueOnce(true);
      // Also need to mock for preemption check
      mockRepo.listActiveEntries.mockResolvedValueOnce([]);

      const result = await scheduler.decideNext("t-1", "s-1", {
        maxConcurrent: 3,
        preemptionEnabled: false,
      });

      expect(result.decision.immediate).toBe(false);
      expect(result.decision.reason).toBe("concurrency_limit");
    });

    it("selects by priority when strategy is priority", async () => {
      const highPri = fakeEntry({ entryId: "e-high", priority: 10, position: 1 });
      const lowPri = fakeEntry({ entryId: "e-low", priority: 90, position: 0 });
      mockRepo.listSchedulable.mockResolvedValueOnce([lowPri, highPri]);
      mockRepo.countExecuting.mockResolvedValueOnce(0);
      mockRepo.areAllDepsResolved.mockResolvedValueOnce(true);

      const result = await scheduler.decideNext("t-1", "s-1", {
        strategy: "priority",
      });

      expect(result.candidate!.entryId).toBe("e-high");
    });

    it("selects by SJF (shortest job first) when configured", async () => {
      const longJob = fakeEntry({ entryId: "e-long", estimatedDurationMs: 60000, position: 0 });
      const shortJob = fakeEntry({ entryId: "e-short", estimatedDurationMs: 5000, position: 1 });
      mockRepo.listSchedulable.mockResolvedValueOnce([longJob, shortJob]);
      mockRepo.countExecuting.mockResolvedValueOnce(0);
      mockRepo.areAllDepsResolved.mockResolvedValueOnce(true);

      const result = await scheduler.decideNext("t-1", "s-1", {
        strategy: "sjf",
      });

      expect(result.candidate!.entryId).toBe("e-short");
    });

    it("blocks task with unresolved dependencies", async () => {
      const entry1 = fakeEntry({ entryId: "e-1" });
      const entry2 = fakeEntry({ entryId: "e-2" });
      mockRepo.listSchedulable.mockResolvedValueOnce([entry1, entry2]);
      mockRepo.countExecuting.mockResolvedValueOnce(0);
      mockRepo.areAllDepsResolved
        .mockResolvedValueOnce(false)  // e-1 blocked
        .mockResolvedValueOnce(true);  // e-2 ready

      const result = await scheduler.decideNext("t-1", "s-1");
      expect(result.candidate!.entryId).toBe("e-2");
    });

    it("returns all_blocked when all tasks have unresolved deps", async () => {
      const entry = fakeEntry();
      mockRepo.listSchedulable.mockResolvedValueOnce([entry]);
      mockRepo.countExecuting.mockResolvedValueOnce(0);
      mockRepo.areAllDepsResolved.mockResolvedValueOnce(false);

      const result = await scheduler.decideNext("t-1", "s-1");
      expect(result.decision.immediate).toBe(false);
      expect(result.decision.reason).toBe("all_tasks_blocked_by_dependencies");
    });
  });

  describe("getSessionConfig / updateSessionConfig", () => {
    it("returns default config for unknown tenant", () => {
      const cfg = getSessionConfig("new-tenant");
      expect(cfg.maxConcurrent).toBeNull();
      expect(cfg.strategy).toBe("dependency_aware");
    });

    it("persists config updates", () => {
      updateSessionConfig("t-1", { maxConcurrent: 5, strategy: "sjf" });
      const cfg = getSessionConfig("t-1");
      expect(cfg.maxConcurrent).toBe(5);
      expect(cfg.strategy).toBe("sjf");
    });
  });
});

/* ================================================================== */
/*  调度器指标 (P3-11)                                                  */
/* ================================================================== */

describe("schedulerMetrics", () => {
  beforeEach(() => {
    resetSchedulerMetrics();
  });

  it("starts with zero counters", () => {
    const m = getSchedulerMetrics();
    expect(m.totalDecisions).toBe(0);
    expect(m.immediateSchedules).toBe(0);
    expect(m.avgWaitMs).toBeNull();
  });

  it("records schedule metrics correctly", () => {
    recordScheduleMetric("immediate");
    recordScheduleMetric("immediate");
    recordScheduleMetric("dep_blocked");
    recordScheduleMetric("concurrency_blocked", 5000);

    const m = getSchedulerMetrics();
    expect(m.totalDecisions).toBe(4);
    expect(m.immediateSchedules).toBe(2);
    expect(m.dependencyBlocks).toBe(1);
    expect(m.concurrencyBlocks).toBe(1);
    expect(m.avgWaitMs).toBe(5000);
  });

  it("records starvation boosts", () => {
    recordStarvationBoost(3);
    recordStarvationBoost(2);

    const m = getSchedulerMetrics();
    expect(m.starvationBoosts).toBe(5);
  });

  it("reset clears all counters", () => {
    recordScheduleMetric("immediate");
    recordStarvationBoost(1);
    resetSchedulerMetrics();

    const m = getSchedulerMetrics();
    expect(m.totalDecisions).toBe(0);
    expect(m.starvationBoosts).toBe(0);
  });
});
