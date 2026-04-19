import {
  afterAll,
  beforeAll,
  crypto,
  describe,
  expect,
  it,
  pool,
  getTestContext,
  releaseTestContext,
  type TestContext,
} from "./setup";
import * as repo from "../../kernel/taskQueueRepo";
import type { CheckpointData } from "../../kernel/taskQueueRepo";
import { TaskQueueManager } from "../../kernel/taskQueueManager";

describe.sequential("e2e:taskQueue", { timeout: 120_000 }, () => {
  let ctx: TestContext;
  let mgr: TaskQueueManager;
  const tenantId = "tenant_dev";
  const sessionId = `sess-tq-${Date.now()}`;

  beforeAll(async () => {
    ctx = await getTestContext();
    mgr = new TaskQueueManager(pool);
  });

  afterAll(async () => {
    await releaseTestContext();
  });

  it("基础入队 — enqueue 后 entry 状态为 queued 或 ready", async () => {
    if (!ctx.canRun) return;
    const result = await mgr.enqueue({
      tenantId,
      sessionId,
      goal: `test-enqueue-${crypto.randomUUID()}`,
      mode: "execute",
      priority: 50,
      createdBySubjectId: "admin",
    });
    expect(result.entry).toBeDefined();
    expect(result.entry.entryId).toBeTruthy();
    expect(["queued", "ready", "executing"]).toContain(result.entry.status);
    expect(result.entry.tenantId).toBe(tenantId);
    expect(result.entry.sessionId).toBe(sessionId);
    expect(result.position).toBeGreaterThanOrEqual(0);
  });

  it("优先级调度 — 高优先级任务排序靠前", async () => {
    if (!ctx.canRun) return;
    const sess = `sess-prio-${crypto.randomUUID()}`;

    // priority 数值越小优先级越高
    const low = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "low-priority",
      mode: "execute",
      priority: 90,
      createdBySubjectId: "admin",
    });
    const high = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "high-priority",
      mode: "execute",
      priority: 10,
      createdBySubjectId: "admin",
    });

    const schedulable = await repo.listSchedulable(pool, tenantId, sess);
    expect(schedulable.length).toBeGreaterThanOrEqual(2);
    // listSchedulable 按 priority ASC, enqueued_at ASC 排序
    const highIdx = schedulable.findIndex((e) => e.entryId === high.entryId);
    const lowIdx = schedulable.findIndex((e) => e.entryId === low.entryId);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it("并发限制 — countExecuting 正确统计", async () => {
    if (!ctx.canRun) return;
    const sess = `sess-conc-${crypto.randomUUID()}`;

    const e1 = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "task-1",
      mode: "execute",
      createdBySubjectId: "admin",
    });
    await repo.updateEntryStatus(pool, { entryId: e1.entryId, status: "executing" });

    const e2 = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "task-2",
      mode: "execute",
      createdBySubjectId: "admin",
    });
    await repo.updateEntryStatus(pool, { entryId: e2.entryId, status: "executing" });

    const count = await repo.countExecuting(pool, tenantId, sess);
    expect(count).toBe(2);
  });

  it("状态转换 — queued → ready → executing → completed 完整流转", async () => {
    if (!ctx.canRun) return;
    const sess = `sess-flow-${crypto.randomUUID()}`;

    const entry = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "lifecycle-test",
      mode: "execute",
      createdBySubjectId: "admin",
    });
    expect(entry.status).toBe("queued");

    const ready = await repo.updateEntryStatus(pool, { entryId: entry.entryId, status: "ready" });
    expect(ready?.status).toBe("ready");
    expect(ready?.readyAt).toBeTruthy();

    const executing = await repo.updateEntryStatus(pool, { entryId: entry.entryId, status: "executing" });
    expect(executing?.status).toBe("executing");
    expect(executing?.startedAt).toBeTruthy();

    const completed = await repo.updateEntryStatus(pool, { entryId: entry.entryId, status: "completed" });
    expect(completed?.status).toBe("completed");
    expect(completed?.completedAt).toBeTruthy();
  });

  it("markFailed + retry — 失败任务可重试", async () => {
    if (!ctx.canRun) return;
    const sess = `sess-retry-${crypto.randomUUID()}`;

    const entry = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "retry-test",
      mode: "execute",
      createdBySubjectId: "admin",
    });
    await repo.updateEntryStatus(pool, { entryId: entry.entryId, status: "executing" });

    // markFailed via manager
    await mgr.markFailed(entry.entryId, "simulated error");

    const failed = await repo.getEntry(pool, entry.entryId);
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("simulated error");

    // retry via repo
    const retried = await repo.incrementRetry(pool, entry.entryId, "simulated error", tenantId);
    expect(retried).not.toBeNull();
    expect(retried!.status).toBe("queued");
    expect(retried!.retryCount).toBeGreaterThanOrEqual(1);
  });

  it("cancel — 取消任务状态正确更新", async () => {
    if (!ctx.canRun) return;
    const sess = `sess-cancel-${crypto.randomUUID()}`;

    const entry = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "cancel-test",
      mode: "execute",
      createdBySubjectId: "admin",
    });

    const cancelled = await mgr.cancel(entry.entryId);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");

    // 终态不可再取消
    const againResult = await mgr.cancel(entry.entryId);
    expect(againResult).toBeNull();
  });

  it("检查点保存与恢复 — saveCheckpoint/restoreFromCheckpoint 完整性", async () => {
    if (!ctx.canRun) return;
    const sess = `sess-ckpt-${crypto.randomUUID()}`;

    const entry = await repo.insertQueueEntry(pool, {
      tenantId,
      sessionId: sess,
      goal: "checkpoint-test",
      mode: "execute",
      createdBySubjectId: "admin",
    });
    await repo.updateEntryStatus(pool, { entryId: entry.entryId, status: "executing" });

    const checkpointData: Omit<CheckpointData, "savedAt"> = {
      currentStep: 3,
      intermediateResults: [{ stepIdx: 0, out: "a" }, { stepIdx: 1, out: "b" }],
      context: { runId: "run-123", sessionId: sess },
    };

    await mgr.saveCheckpoint(entry.entryId, checkpointData, tenantId);

    // restoreFromCheckpoint reads from DB (no Redis in test env)
    const restored = await mgr.restoreFromCheckpoint(entry.entryId);
    expect(restored).not.toBeNull();
    expect(restored!.currentStep).toBe(3);
    expect(restored!.intermediateResults).toHaveLength(2);
    expect(restored!.context.runId).toBe("run-123");
    expect(restored!.savedAt).toBeTruthy();

    // clearCheckpoint after completion
    await mgr.clearCheckpoint(entry.entryId);
    const afterClear = await mgr.restoreFromCheckpoint(entry.entryId);
    // checkpoint_ref still exists on entry, but checkpoint_data is deleted
    const entryAfter = await repo.getEntry(pool, entry.entryId);
    const dbCkpt = await repo.loadCheckpoint(pool, entry.entryId);
    expect(dbCkpt).toBeNull();
  });
});
