import type { Pool, PoolClient } from "pg";
import { createHmac } from "node:crypto";

type Q = Pool | PoolClient;

const HMAC_ALGO = "sha256";

let _signingKeyWarnEmitted = false;
function warnIfDefaultSigningKey() {
  if (!_signingKeyWarnEmitted && !process.env.APPROVAL_SIGNING_KEY) {
    console.warn("[SECURITY] APPROVAL_SIGNING_KEY not set in approvalRepo, using insecure default. Set this in production!");
    _signingKeyWarnEmitted = true;
  }
}

function computeInputSignature(inputDigest: unknown, secretKey: string): string {
  const payload = typeof inputDigest === "string" ? inputDigest : JSON.stringify(inputDigest ?? {});
  return createHmac(HMAC_ALGO, secretKey).update(payload).digest("hex");
}

export type ApprovalRow = {
  approvalId: string;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  stepId: string | null;
  status: string;
  requestedBySubjectId: string;
  toolRef: string | null;
  policySnapshotRef: string | null;
  inputDigest: any;
  inputSignature: string | null;
  /** 规则引擎评估上下文（matchedRules/humanSummary/riskLevel 等，完全动态） */
  assessmentContext: any;
  decision: "approve" | "reject" | null;
  reason: string | null;
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  escalatedAt: string | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ApprovalDecisionRow = {
  decisionId: string;
  approvalId: string;
  tenantId: string;
  decision: string;
  reason: string | null;
  decidedBySubjectId: string;
  decidedAt: string;
};

type ApprovalDecisionState = {
  requiredApprovals: number;
  approvalsCollected: number;
  approvalsRemaining: number;
  finalized: boolean;
};

function getRequiredApprovals(inputDigest: Record<string, unknown> | null | undefined): number {
  const policy = (inputDigest as any)?.approvalPolicy;
  if (!policy) return 1;
  // 优先读取显式数字配置
  if (typeof policy.requiredApprovals === "number" && policy.requiredApprovals >= 1) {
    return policy.requiredApprovals;
  }
  // 向后兼容 boolean
  return policy.requireDualApproval ? 2 : 1;
}

function toApproval(r: any): ApprovalRow {
  return {
    approvalId: r.approval_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    runId: r.run_id,
    stepId: r.step_id ?? null,
    status: r.status,
    requestedBySubjectId: r.requested_by_subject_id,
    toolRef: r.tool_ref ?? null,
    policySnapshotRef: r.policy_snapshot_ref ?? null,
    inputDigest: r.input_digest ?? null,
    inputSignature: r.input_signature ?? null,
    assessmentContext: r.assessment_context ?? null,
    decision: r.decision ?? null,
    reason: r.reason ?? null,
    decidedBySubjectId: r.decided_by_subject_id ?? null,
    decidedAt: r.decided_at ?? null,
    expiresAt: r.expires_at ?? null,
    escalatedAt: r.escalated_at ?? null,
    requestedAt: r.requested_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDecision(r: any): ApprovalDecisionRow {
  return {
    decisionId: r.decision_id,
    approvalId: r.approval_id,
    tenantId: r.tenant_id,
    decision: r.decision,
    reason: r.reason ?? null,
    decidedBySubjectId: r.decided_by_subject_id,
    decidedAt: r.decided_at,
  };
}

export async function createApproval(params: {
  pool: Q;
  tenantId: string;
  spaceId?: string | null;
  runId: string;
  stepId?: string | null;
  requestedBySubjectId: string;
  toolRef?: string | null;
  policySnapshotRef?: string | null;
  inputDigest?: any;
  inputSignature?: string | null;
  expiresAt?: string | null;
  /** 规则引擎评估上下文（完全动态，由规则引擎生成） */
  assessmentContext?: any;
  approvalType?: "tool_execution" | "changeset_gate" | "eval_admission";
  escalationMinutes?: number;
  escalationTarget?: string;
  autoRejectOnExpiry?: boolean;
}) {
  const existingPending = params.stepId
    ? await params.pool.query(
        `
          SELECT *
          FROM approvals
          WHERE tenant_id = $1
            AND step_id = $2
            AND status = 'pending'
          ORDER BY requested_at DESC
          LIMIT 1
        `,
        [params.tenantId, params.stepId],
      )
    : await params.pool.query(
        `
          SELECT *
          FROM approvals
          WHERE tenant_id = $1
            AND run_id = $2
            AND step_id IS NULL
            AND status = 'pending'
          ORDER BY requested_at DESC
          LIMIT 1
        `,
        [params.tenantId, params.runId],
      );
  if (existingPending.rowCount) {
    return toApproval(existingPending.rows[0]);
  }

  // --- HMAC Binding: 计算 input_signature（签名密钥从环境变量读取，元数据驱动） ---
  warnIfDefaultSigningKey();
  const signingKey = process.env.APPROVAL_SIGNING_KEY ?? "";
  const inputSignature = params.inputSignature ?? computeInputSignature(params.inputDigest ?? null, signingKey);

  const res = await params.pool.query(
    `
      INSERT INTO approvals (
        tenant_id, space_id, run_id, step_id, status, requested_by_subject_id,
        tool_ref, policy_snapshot_ref, input_digest, input_signature, assessment_context, expires_at,
        approval_type, escalation_minutes, escalation_target, auto_reject_on_expiry
      )
      VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId ?? null,
      params.runId,
      params.stepId ?? null,
      params.requestedBySubjectId,
      params.toolRef ?? null,
      params.policySnapshotRef ?? null,
      params.inputDigest ?? null,
      inputSignature,
      params.assessmentContext ? JSON.stringify(params.assessmentContext) : null,
      params.expiresAt ?? null,
      params.approvalType ?? "tool_execution",
      params.escalationMinutes ?? null,
      params.escalationTarget ?? null,
      params.autoRejectOnExpiry ?? true,
    ],
  );
  return toApproval(res.rows[0]);
}

export async function listApprovals(params: { pool: Pool; tenantId: string; spaceId?: string; status?: string; limit: number }) {
  const where: string[] = ["tenant_id = $1"];
  const args: any[] = [params.tenantId];
  if (params.spaceId) {
    args.push(params.spaceId);
    where.push(`space_id = $${args.length}`);
  }
  if (params.status) {
    args.push(params.status);
    where.push(`status = $${args.length}`);
  }
  args.push(params.limit);
  const res = await params.pool.query(
    `
      SELECT *
      FROM approvals
      WHERE ${where.join(" AND ")}
      ORDER BY requested_at DESC
      LIMIT $${args.length}
    `,
    args,
  );
  return res.rows.map(toApproval);
}

export async function getApproval(params: { pool: Pool; tenantId: string; approvalId: string }) {
  const res = await params.pool.query("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 LIMIT 1", [
    params.tenantId,
    params.approvalId,
  ]);
  if (!res.rowCount) return null;
  return toApproval(res.rows[0]);
}

export async function addDecision(params: {
  pool: Q;
  tenantId: string;
  approvalId: string;
  decision: "approve" | "reject";
  reason?: string | null;
  decidedBySubjectId: string;
}) {
  const existing = await params.pool.query("SELECT * FROM approvals WHERE tenant_id = $1 AND approval_id = $2 FOR UPDATE", [params.tenantId, params.approvalId]);
  if (!existing.rowCount) return null;
  const approval = toApproval(existing.rows[0]);
  if (approval.status !== "pending") return { ok: false as const, approval };

  const requiredApprovals = getRequiredApprovals(approval.inputDigest);

  if (params.decision === "approve" && requiredApprovals > 1) {
    const duplicateApproverRes = await params.pool.query(
      `
        SELECT 1
        FROM approval_decisions
        WHERE tenant_id = $1
          AND approval_id = $2
          AND decision = 'approve'
          AND decided_by_subject_id = $3
        LIMIT 1
      `,
      [params.tenantId, params.approvalId, params.decidedBySubjectId],
    );
    if (duplicateApproverRes.rowCount) {
      return { ok: false as const, approval, reason: "duplicate_approver" as const };
    }
  }

  const decisionRes = await params.pool.query(
    `
      INSERT INTO approval_decisions (approval_id, tenant_id, decision, reason, decided_by_subject_id)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *
    `,
    [approval.approvalId, params.tenantId, params.decision, params.reason ?? null, params.decidedBySubjectId],
  );

  const progress: ApprovalDecisionState =
    params.decision === "approve"
      ? await (async () => {
          const countRes = await params.pool.query<{ approvals_collected: string }>(
            `
              SELECT COUNT(DISTINCT decided_by_subject_id)::int AS approvals_collected
              FROM approval_decisions
              WHERE tenant_id = $1
                AND approval_id = $2
                AND decision = 'approve'
            `,
            [params.tenantId, params.approvalId],
          );
          const approvalsCollected = Number(countRes.rows[0]?.approvals_collected ?? 0);
          const approvalsRemaining = Math.max(requiredApprovals - approvalsCollected, 0);
          return {
            requiredApprovals,
            approvalsCollected,
            approvalsRemaining,
            finalized: approvalsRemaining === 0,
          };
        })()
      : {
          requiredApprovals,
          approvalsCollected: 0,
          approvalsRemaining: 0,
          finalized: true,
        };

  const nextStatus =
    params.decision === "approve"
      ? progress.finalized
        ? "approved"
        : "pending"
      : "rejected";
  const updated = await params.pool.query(
    "UPDATE approvals SET status = $3, updated_at = now() WHERE tenant_id = $1 AND approval_id = $2 RETURNING *",
    [params.tenantId, params.approvalId, nextStatus],
  );
  return {
    ok: true as const,
    approval: toApproval(updated.rows[0]),
    decision: toDecision(decisionRes.rows[0]),
    ...progress,
  };
}
