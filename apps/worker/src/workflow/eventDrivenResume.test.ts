import { describe, expect, it, vi } from "vitest";
import { dispatchResumeEvent } from "./eventDrivenResume";

describe("eventDrivenResume", () => {
  it("从 needs_approval 恢复时可选中阻塞态 step 并重新入队", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT status, run_id FROM runs")) {
        return { rowCount: 1, rows: [{ status: "needs_approval", run_id: "run-1" }] };
      }
      if (sql.includes("SELECT s.step_id, j.job_id")) {
        return { rowCount: 1, rows: [{ step_id: "step-1", job_id: "job-1" }] };
      }
      if (sql.includes("INSERT INTO resume_events")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO audit_events")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE runs SET status = $3")) {
        expect(params).toEqual(["tenant-1", "run-1", "queued"]);
      }
      if (sql.includes("UPDATE steps SET status = 'pending'")) {
        expect(sql).toContain("'needs_approval'");
      }
      if (sql.includes("UPDATE jobs SET status = 'queued'")) {
        expect(sql).toContain("'needs_approval'");
      }
      return { rowCount: 1, rows: [] };
    });
    const pool = { query } as any;
    const enqueueJob = vi.fn(async () => undefined);

    const result = await dispatchResumeEvent(
      {
        type: "approval.resolved",
        sourceId: "approval-1",
        tenantId: "tenant-1",
        spaceId: "space-1",
        runId: "run-1",
        subjectId: "user-1",
        approvalDecision: "approved",
      },
      pool,
      enqueueJob,
    );

    expect(result.ok).toBe(true);
    expect(result.newStatus).toBe("queued");
    expect(result.resumedStepId).toBe("step-1");
    expect(result.queuedJobId).toBe("job-1");
    expect(enqueueJob).toHaveBeenCalledWith({ runId: "run-1", stepId: "step-1", jobId: "job-1" });
  });
});
