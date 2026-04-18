import { describe, expect, it, vi } from "vitest";
import { processBatchApproval, processExpiredApprovals } from "./approvalManager";

describe("approvalManager workflow consistency", () => {
  it("批量 approve 时联动更新 runs/jobs/steps", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status, run_id, step_id, space_id FROM approvals")) {
        return {
          rowCount: 1,
          rows: [{ run_id: "run-1", step_id: "step-1", status: "pending", space_id: "space-1" }],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const result = await processBatchApproval({
      pool: { query } as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      approvalIds: ["ap-1"],
      decision: "approve",
      reason: null,
      decidedBySubjectId: "user-b",
      traceId: "trace-1",
    });

    expect(result.total).toBe(1);
    expect(result.approved).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE jobs SET status = 'queued'"),
      ["tenant-1", "run-1"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE steps SET status = 'pending'"),
      ["step-1"],
    );
  });

  it("审批过期处理会联动取消 runs/jobs/steps", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT approval_id, tenant_id, run_id FROM approvals")) {
        return {
          rowCount: 1,
          rows: [{ approval_id: "ap-exp-1", tenant_id: "tenant-1", run_id: "run-exp-1" }],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const result = await processExpiredApprovals({
      pool: { query } as any,
      policy: { expirationMinutes: 1, escalationMinutes: 0, autoRejectOnExpiry: true },
      limit: 10,
    });

    expect(result.expired).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.escalated).toBe(0);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE jobs SET status = 'canceled'"),
      ["run-exp-1"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE steps SET status = 'canceled'"),
      ["run-exp-1"],
    );
  });
});
