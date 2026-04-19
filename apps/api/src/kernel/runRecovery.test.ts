/**
 * runRecovery.ts 单元测试
 * 测试导出的纯函数：canRecover() 和 getSuggestedRecoveryAction()
 */
import { describe, it, expect, vi } from "vitest";
import { canRecover, getSuggestedRecoveryAction, resumeRun, retryFailedStep } from "./runRecovery";

/* ================================================================== */
/*  canRecover                                                          */
/* ================================================================== */

describe("canRecover", () => {
  it("needs_approval 不可恢复（需审批，不能直接恢复）", () => {
    expect(canRecover("needs_approval")).toBe(false);
  });

  it("needs_device 可恢复", () => {
    expect(canRecover("needs_device")).toBe(true);
  });

  it("needs_arbiter 可恢复", () => {
    expect(canRecover("needs_arbiter")).toBe(true);
  });

  it("stopped 不可恢复（终态）", () => {
    expect(canRecover("stopped")).toBe(false);
  });

  it("failed 可恢复", () => {
    expect(canRecover("failed")).toBe(true);
  });

  it("paused 可恢复 (P1-1.1)", () => {
    expect(canRecover("paused")).toBe(true);
  });

  it("running 不可恢复（正在运行无需恢复）", () => {
    expect(canRecover("running")).toBe(false);
  });

  it("succeeded 不可恢复（已完成）", () => {
    expect(canRecover("succeeded")).toBe(false);
  });

  it("canceled 不可恢复", () => {
    expect(canRecover("canceled")).toBe(false);
  });

  it("created 不可恢复", () => {
    expect(canRecover("created")).toBe(false);
  });

  it("queued 不可恢复", () => {
    expect(canRecover("queued")).toBe(false);
  });

  it("空字符串不可恢复", () => {
    expect(canRecover("")).toBe(false);
  });

  it("未知状态不可恢复", () => {
    expect(canRecover("some_random_status")).toBe(false);
  });
});

/* ================================================================== */
/*  getSuggestedRecoveryAction                                          */
/* ================================================================== */

describe("getSuggestedRecoveryAction", () => {
  it("needs_approval 无建议（需审批）", () => {
    expect(getSuggestedRecoveryAction("needs_approval")).toBeNull();
  });

  it("needs_device 建议 resume", () => {
    expect(getSuggestedRecoveryAction("needs_device")).toBe("resume");
  });

  it("needs_arbiter 建议 resume", () => {
    expect(getSuggestedRecoveryAction("needs_arbiter")).toBe("resume");
  });

  it("paused 建议 resume (P1-1.1)", () => {
    expect(getSuggestedRecoveryAction("paused")).toBe("resume");
  });

  it("stopped 无建议", () => {
    expect(getSuggestedRecoveryAction("stopped")).toBeNull();
  });

  it("failed 建议 retry", () => {
    expect(getSuggestedRecoveryAction("failed")).toBe("retry");
  });

  it("running 无建议", () => {
    expect(getSuggestedRecoveryAction("running")).toBeNull();
  });

  it("succeeded 无建议", () => {
    expect(getSuggestedRecoveryAction("succeeded")).toBeNull();
  });

  it("canceled 无建议", () => {
    expect(getSuggestedRecoveryAction("canceled")).toBeNull();
  });

  it("created 无建议", () => {
    expect(getSuggestedRecoveryAction("created")).toBeNull();
  });

  it("未知状态无建议", () => {
    expect(getSuggestedRecoveryAction("unknown")).toBeNull();
  });

  it("空字符串无建议", () => {
    expect(getSuggestedRecoveryAction("")).toBeNull();
  });
});

describe("retryFailedStep", () => {
  it("按 step_id 重置失败步骤，不依赖 steps.tenant_id 列", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM runs r")) {
          return { rowCount: 1, rows: [{ status: "failed", job_id: "job-1" }] };
        }
        if (sql.includes("SELECT step_id, attempt, error_category FROM steps")) {
          return { rowCount: 1, rows: [{ step_id: "step-1", attempt: 1, error_category: "retryable" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;
    const queue = {
      add: vi.fn(async () => ({ id: "queue-step-1" })),
    } as any;

    const result = await retryFailedStep({
      pool,
      queue,
      tenantId: "tenant-1",
      spaceId: "space-1",
      runId: "run-1",
      subjectId: "subject-1",
      traceId: "trace-1",
    });

    expect(result.ok).toBe(true);
    expect(
      queries.some(
        ({ sql, params }) =>
          sql.includes("WHERE step_id = $2") &&
          !sql.includes("tenant_id") &&
          JSON.stringify(params) === JSON.stringify([2, "step-1"]),
      ),
    ).toBe(true);
  });

  it("重试时选择实际失败的步骤，而不是固定第一步", async () => {
    const queue = {
      add: vi.fn(async () => ({ id: "queue-step-2" })),
    } as any;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM runs r")) {
          return { rowCount: 1, rows: [{ status: "failed", job_id: "job-1" }] };
        }
        if (sql.includes("SELECT step_id, attempt, error_category FROM steps")) {
          return { rowCount: 1, rows: [{ step_id: "step-2", attempt: 0, error_category: "retryable" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;

    const result = await retryFailedStep({
      pool,
      queue,
      tenantId: "tenant-1",
      spaceId: "space-1",
      runId: "run-1",
      subjectId: "subject-1",
      traceId: "trace-1",
    });

    expect(result.ok).toBe(true);
    expect(result.stepId).toBe("step-2");
    expect(queue.add).toHaveBeenCalledWith(
      "step",
      expect.objectContaining({ stepId: "step-2" }),
      expect.any(Object),
    );
  });
});

describe("resumeRun", () => {
  it("恢复并行阻塞步骤时会批量重置并逐个入队", async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const queue = {
      add: vi
        .fn()
        .mockResolvedValueOnce({ id: "queue-step-1" })
        .mockResolvedValueOnce({ id: "queue-step-2" }),
    } as any;
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("SELECT job_id FROM jobs")) {
          return { rowCount: 1, rows: [{ job_id: "job-1" }] };
        }
        if (sql.includes("SELECT status FROM runs")) {
          return { rowCount: 1, rows: [{ status: "paused" }] };
        }
        if (sql.includes("UPDATE runs SET status = 'queued'")) {
          return { rowCount: 1, rows: [{ ok: true }] };
        }
        if (sql.includes("SELECT step_id, status FROM steps")) {
          return {
            rowCount: 2,
            rows: [
              { step_id: "step-1", status: "paused" },
              { step_id: "step-2", status: "needs_device" },
            ],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;

    const result = await resumeRun({
      pool,
      queue,
      tenantId: "tenant-1",
      spaceId: "space-1",
      runId: "run-1",
      subjectId: "subject-1",
      traceId: "trace-1",
    });

    expect(result.ok).toBe(true);
    expect(result.stepId).toBe("step-1");
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      "step",
      expect.objectContaining({ stepId: "step-1" }),
      expect.any(Object),
    );
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "step",
      expect.objectContaining({ stepId: "step-2" }),
      expect.any(Object),
    );
    expect(
      queries.some(
        ({ sql, params }) =>
          sql.includes("UPDATE steps SET status = 'pending'") &&
          JSON.stringify(params) === JSON.stringify([["step-1", "step-2"]]),
      ),
    ).toBe(true);
  });

  it("failed 运行不能通过 resume 直接重置失败步骤", async () => {
    const queue = {
      add: vi.fn(),
    } as any;
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT job_id FROM jobs")) {
          return { rowCount: 1, rows: [{ job_id: "job-1" }] };
        }
        if (sql.includes("SELECT status FROM runs")) {
          return { rowCount: 1, rows: [{ status: "failed" }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as any;

    const result = await resumeRun({
      pool,
      queue,
      tenantId: "tenant-1",
      spaceId: "space-1",
      runId: "run-1",
      subjectId: "subject-1",
      traceId: "trace-1",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("请使用 retry");
    expect(queue.add).not.toHaveBeenCalled();
  });
});
