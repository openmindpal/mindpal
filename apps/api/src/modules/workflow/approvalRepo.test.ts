import { describe, expect, it } from "vitest";
import { addDecision, createApproval } from "./approvalRepo";

function createApprovalRow(status: string, inputDigest: any) {
  return {
    approval_id: "approval-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    run_id: "run-1",
    step_id: "step-1",
    status,
    requested_by_subject_id: "requester-1",
    tool_ref: "tool@1.0.0",
    policy_snapshot_ref: null,
    input_digest: inputDigest,
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
}

function createDecisionRow(decision: "approve" | "reject", decidedBySubjectId: string) {
  return {
    decision_id: `${decision}-${decidedBySubjectId}`,
    approval_id: "approval-1",
    tenant_id: "tenant-1",
    decision,
    reason: null,
    decided_by_subject_id: decidedBySubjectId,
    decided_at: "2026-01-01T00:00:00.000Z",
  };
}

function createPool() {
  const state = {
    approval: createApprovalRow("pending", { approvalPolicy: { requiredApprovals: 2 } }),
    decisions: [] as Array<{ decision: "approve" | "reject"; decidedBySubjectId: string }>,
  };

  return {
    state,
    query: async (sql: string, params: any[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();

      if (normalized.includes("SELECT * FROM approvals") && normalized.includes("FOR UPDATE")) {
        return { rowCount: 1, rows: [state.approval] };
      }

      if (normalized.includes("SELECT 1 FROM approval_decisions")) {
        const exists = state.decisions.some((item) => item.decision === "approve" && item.decidedBySubjectId === params[2]);
        return { rowCount: exists ? 1 : 0, rows: exists ? [{ exists: 1 }] : [] };
      }

      if (normalized.includes("INSERT INTO approval_decisions")) {
        state.decisions.push({ decision: params[2], decidedBySubjectId: params[4] });
        return { rowCount: 1, rows: [createDecisionRow(params[2], params[4])] };
      }

      if (normalized.includes("COUNT(DISTINCT decided_by_subject_id)::int AS approvals_collected")) {
        const approvalsCollected = new Set(
          state.decisions.filter((item) => item.decision === "approve").map((item) => item.decidedBySubjectId),
        ).size;
        return { rowCount: 1, rows: [{ approvals_collected: approvalsCollected }] };
      }

      if (normalized.includes("UPDATE approvals SET status")) {
        state.approval = createApprovalRow(params[2], state.approval.input_digest);
        return { rowCount: 1, rows: [state.approval] };
      }

      throw new Error(`Unhandled SQL: ${normalized}`);
    },
  };
}

describe("addDecision", () => {
  it("双人审批首个 approve 仅记录决定，不立即完成审批", async () => {
    const pool = createPool();

    const result = await addDecision({
      pool: pool as any,
      tenantId: "tenant-1",
      approvalId: "approval-1",
      decision: "approve",
      decidedBySubjectId: "approver-1",
    });

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;
    expect(result.finalized).toBe(false);
    expect(result.approvalsCollected).toBe(1);
    expect(result.approvalsRemaining).toBe(1);
    expect(result.approval.status).toBe("pending");
  });

  it("双人审批禁止同一审批人重复批准", async () => {
    const pool = createPool();

    await addDecision({
      pool: pool as any,
      tenantId: "tenant-1",
      approvalId: "approval-1",
      decision: "approve",
      decidedBySubjectId: "approver-1",
    });

    const result = await addDecision({
      pool: pool as any,
      tenantId: "tenant-1",
      approvalId: "approval-1",
      decision: "approve",
      decidedBySubjectId: "approver-1",
    });

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result && "reason" in result ? result.reason : null).toBe("duplicate_approver");
  });

  it("双人审批在第二个不同审批人批准后完成审批", async () => {
    const pool = createPool();

    await addDecision({
      pool: pool as any,
      tenantId: "tenant-1",
      approvalId: "approval-1",
      decision: "approve",
      decidedBySubjectId: "approver-1",
    });

    const result = await addDecision({
      pool: pool as any,
      tenantId: "tenant-1",
      approvalId: "approval-1",
      decision: "approve",
      decidedBySubjectId: "approver-2",
    });

    expect(result).not.toBeNull();
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;
    expect(result.finalized).toBe(true);
    expect(result.approvalsCollected).toBe(2);
    expect(result.approvalsRemaining).toBe(0);
    expect(result.approval.status).toBe("approved");
  });
});

describe("createApproval", () => {
  it("同一步骤已有 pending 审批时复用现有审批", async () => {
    const existing = createApprovalRow("pending", { foo: "bar" });
    const pool = {
      query: async (sql: string) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (normalized.includes("FROM approvals") && normalized.includes("step_id = $2") && normalized.includes("status = 'pending'")) {
          return { rowCount: 1, rows: [existing] };
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
      },
    };

    const result = await createApproval({
      pool: pool as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      runId: "run-1",
      stepId: "step-1",
      requestedBySubjectId: "requester-1",
      toolRef: "tool@1.0.0",
      inputDigest: { foo: "bar" },
    });

    expect(result.approvalId).toBe("approval-1");
    expect(result.status).toBe("pending");
  });

  it("已存在历史审批但无 pending 审批时创建新审批记录", async () => {
    const inserted = {
      ...createApprovalRow("pending", { foo: "next" }),
      approval_id: "approval-2",
      step_id: "step-2",
      input_digest: { foo: "next" },
    };
    const query = async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM approvals") && normalized.includes("status = 'pending'")) {
        return { rowCount: 0, rows: [] };
      }
      if (normalized.includes("INSERT INTO approvals")) {
        return { rowCount: 1, rows: [inserted] };
      }
      throw new Error(`Unexpected SQL: ${normalized}`);
    };

    const result = await createApproval({
      pool: { query } as any,
      tenantId: "tenant-1",
      spaceId: "space-1",
      runId: "run-1",
      stepId: "step-2",
      requestedBySubjectId: "requester-1",
      toolRef: "tool@1.0.0",
      inputDigest: { foo: "next" },
    });

    expect(result.approvalId).toBe("approval-2");
    expect(result.stepId).toBe("step-2");
  });
});
