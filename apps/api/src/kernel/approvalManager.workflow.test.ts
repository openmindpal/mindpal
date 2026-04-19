import { describe, expect, it, vi } from "vitest";
import { processBatchApproval, processExpiredApprovals } from "./approvalManager";

describe("approvalManager workflow consistency", () => {
  it("批量 approve 时联动更新 runs/jobs/steps", async () => {
    const approvalRow = {
      approval_id: "ap-1",
      tenant_id: "tenant-1",
      space_id: "space-1",
      run_id: "run-1",
      step_id: "step-1",
      status: "pending",
      requested_by_subject_id: "requester-1",
      tool_ref: "tool@1.0.0",
      policy_snapshot_ref: null,
      input_digest: {},
      assessment_context: null,
      decision: null,
      reason: null,
      decided_by_subject_id: null,
      decided_at: null,
      expires_at: null,
      escalated_at: null,
      requested_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 LIMIT 1")) {
        return {
          rowCount: 1,
          rows: [approvalRow],
        };
      }
      if (normalized.includes("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 FOR UPDATE")) {
        return {
          rowCount: 1,
          rows: [approvalRow],
        };
      }
      if (normalized.includes("INSERT INTO approval_decisions")) {
        return {
          rowCount: 1,
          rows: [{
            decision_id: "decision-1",
            approval_id: "ap-1",
            tenant_id: "tenant-1",
            decision: "approve",
            reason: null,
            decided_by_subject_id: "user-b",
            decided_at: "2026-01-01T00:00:00.000Z",
          }],
        };
      }
      if (normalized.includes("COUNT(DISTINCT decided_by_subject_id)::int AS approvals_collected")) {
        return {
          rowCount: 1,
          rows: [{ approvals_collected: 1 }],
        };
      }
      if (normalized.includes("UPDATE approvals SET status")) {
        return {
          rowCount: 1,
          rows: [{ ...approvalRow, status: "approved" }],
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

  it("双人审批在未最终完成前仅记录决定，不提前恢复 run/job/step", async () => {
    const approvalRow = {
      approval_id: "ap-dual-1",
      tenant_id: "tenant-1",
      space_id: "space-1",
      run_id: "run-dual-1",
      step_id: "step-dual-1",
      status: "pending",
      requested_by_subject_id: "requester-1",
      tool_ref: "tool@1.0.0",
      policy_snapshot_ref: null,
      input_digest: { approvalPolicy: { requireDualApproval: true } },
      assessment_context: null,
      decision: null,
      reason: null,
      decided_by_subject_id: null,
      decided_at: null,
      expires_at: null,
      escalated_at: null,
      requested_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 LIMIT 1")) {
        return { rowCount: 1, rows: [approvalRow] };
      }
      if (normalized.includes("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 FOR UPDATE")) {
        return { rowCount: 1, rows: [approvalRow] };
      }
      if (normalized.includes("SELECT 1 FROM approval_decisions")) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes("INSERT INTO approval_decisions")) {
        return {
          rowCount: 1,
          rows: [{
            decision_id: "decision-dual-1",
            approval_id: "ap-dual-1",
            tenant_id: "tenant-1",
            decision: "approve",
            reason: null,
            decided_by_subject_id: "approver-1",
            decided_at: "2026-01-01T00:00:00.000Z",
          }],
        };
      }
      if (normalized.includes("COUNT(DISTINCT decided_by_subject_id)::int AS approvals_collected")) {
        return { rowCount: 1, rows: [{ approvals_collected: 1 }] };
      }
      if (normalized.includes("UPDATE approvals SET status")) {
        return { rowCount: 1, rows: [approvalRow] };
      }
      return { rowCount: 1, rows: [] };
    });

    const result = await processBatchApproval({
      pool: { query } as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      approvalIds: ["ap-dual-1"],
      decision: "approve",
      reason: null,
      decidedBySubjectId: "approver-1",
      traceId: "trace-1",
    });

    expect(result.approved).toBe(1);
    expect(result.failed).toBe(0);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("UPDATE runs SET status = 'queued'")),
    ).toBe(false);
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
