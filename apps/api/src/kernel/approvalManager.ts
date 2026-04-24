/**
 * P1-5: 高风险操作审批流程完善
 * 
 * 增强审批流程：
 * - 批量审批处理
 * - 审批超时自动处理
 * - 审批请求升级机制
 * - 审批决策通知
 * - 完整审计链路
 */
import type { Pool } from "pg";
import { notifyApprovalRequired } from "./completionNotifier";
import { assessToolExecutionRisk, type ToolExecutionAssessment } from "./approvalRuleEngine";
import { addDecision, createApproval, getApproval } from "../modules/workflow/approvalRepo";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface ApprovalRequest {
  approvalId: string;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  stepId: string | null;
  toolRef: string;
  requestedBySubjectId: string;
  policySnapshotRef: string | null;
  inputDigest: any;
  status: "pending" | "approved" | "rejected" | "expired" | "escalated";
  createdAt: string;
  expiresAt: string | null;
  escalatedAt: string | null;
  decidedAt: string | null;
  decidedBySubjectId: string | null;
  decision: "approve" | "reject" | null;
  reason: string | null;
}

export interface ApprovalPolicy {
  /** 自动过期时间（分钟），0 表示不过期 */
  expirationMinutes: number;
  /** 自动升级时间（分钟），0 表示不升级 */
  escalationMinutes: number;
  /** 升级目标（角色或主体 ID） */
  escalationTarget: string | null;
  /** 是否允许批量审批 */
  allowBatchApproval: boolean;
  /** 高风险操作是否需要双人审批 */
  requireDualApproval: boolean;
  /** 自动拒绝过期的审批请求 */
  autoRejectOnExpiry: boolean;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  expirationMinutes: 1440, // 24 小时
  escalationMinutes: 240, // 4 小时
  escalationTarget: null,
  allowBatchApproval: true,
  requireDualApproval: false,
  autoRejectOnExpiry: true,
};

export interface BatchApprovalResult {
  total: number;
  approved: number;
  rejected: number;
  failed: number;
  errors: Array<{ approvalId: string; error: string }>;
}

/* ================================================================== */
/*  Approval Processing                                                  */
/* ================================================================== */

/**
 * 批量审批处理
 */
export async function processBatchApproval(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  approvalIds: string[];
  decision: "approve" | "reject";
  reason: string | null;
  decidedBySubjectId: string;
  traceId: string | null;
}): Promise<BatchApprovalResult> {
  const { pool, tenantId, spaceId, approvalIds, decision, reason, decidedBySubjectId } = params;
  
  const result: BatchApprovalResult = {
    total: approvalIds.length,
    approved: 0,
    rejected: 0,
    failed: 0,
    errors: [],
  };
  
  for (const approvalId of approvalIds) {
    try {
      const approval = await getApproval({ pool, tenantId, approvalId });
      if (!approval) {
        result.failed++;
        result.errors.push({ approvalId, error: "审批请求不存在" });
        continue;
      }

      // 检查空间权限
      if (approval.spaceId && spaceId && approval.spaceId !== spaceId) {
        result.failed++;
        result.errors.push({ approvalId, error: "无权访问此审批请求" });
        continue;
      }

      // 检查状态
      if (approval.status !== "pending") {
        result.failed++;
        result.errors.push({ approvalId, error: `审批请求已处理 (status=${approval.status})` });
        continue;
      }

      const decided = await addDecision({
        pool,
        tenantId,
        approvalId,
        decision,
        reason,
        decidedBySubjectId,
      });
      if (!decided) {
        result.failed++;
        result.errors.push({ approvalId, error: "审批请求不存在" });
        continue;
      }
      if (!decided.ok) {
        result.failed++;
        const errMsg =
          "reason" in decided && decided.reason === "duplicate_approver"
            ? "双人审批需要不同审批人"
            : `审批请求已处理 (status=${approval.status})`;
        result.errors.push({ approvalId, error: errMsg });
        continue;
      }

      if (decision === "approve" && !decided.finalized) {
        result.approved++;
        continue;
      }

      if (decision === "approve") {
        await pool.query(
          "UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2 AND status = 'needs_approval'",
          [tenantId, approval.runId]
        );
        await pool.query(
          "UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2 AND status = 'needs_approval'",
          [tenantId, approval.runId]
        );
        if (approval.stepId) {
          await pool.query(
            "UPDATE steps SET status = 'pending', updated_at = now(), queue_job_id = NULL WHERE step_id = $1 AND status IN ('pending', 'needs_approval', 'paused')",
            [approval.stepId]
          );
        }
        result.approved++;
      } else {
        await pool.query(
          "UPDATE runs SET status = 'canceled', finished_at = now(), updated_at = now() WHERE tenant_id = $1 AND run_id = $2 AND status = 'needs_approval'",
          [tenantId, approval.runId]
        );
        await pool.query(
          "UPDATE jobs SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND run_id = $2 AND status IN ('needs_approval', 'queued', 'pending', 'running')",
          [tenantId, approval.runId]
        );
        if (approval.stepId) {
          await pool.query(
            "UPDATE steps SET status = 'canceled', finished_at = now(), updated_at = now() WHERE step_id = $1 AND status IN ('needs_approval', 'pending', 'running', 'paused')",
            [approval.stepId]
          );
        }
        result.rejected++;
      }
    } catch (err: any) {
      result.failed++;
      result.errors.push({ approvalId, error: err?.message ?? "Unknown error" });
    }
  }
  
  return result;
}

/**
 * 处理过期的审批请求（元数据驱动）
 *
 * 分级处理流程：
 * 1. 升级检测：根据各行 escalation_minutes 字段判断是否需要升级
 * 2. 过期自动拒绝：根据各行 auto_reject_on_expiry + expires_at 判断是否自动拒绝
 */
export async function processExpiredApprovals(params: {
  pool: Pool;
  policy?: Partial<ApprovalPolicy>;
  limit?: number;
}): Promise<{ processed: number; expired: number; escalated: number }> {
  const { pool, limit = 100 } = params;
  
  let processed = 0;
  let expired = 0;
  let escalated = 0;
  
  // ── Step 1: 升级检测（元数据驱动） ─────────────────────────
  // 查询单行 escalation_minutes 已过、尚未升级的审批
  try {
    const toEscalate = await pool.query<{
      approval_id: string;
      tenant_id: string;
      run_id: string;
      step_id: string | null;
      space_id: string | null;
      tool_ref: string | null;
      escalation_target: string | null;
    }>(
      `SELECT approval_id, tenant_id, run_id, step_id, space_id, tool_ref, escalation_target
       FROM approvals
       WHERE status = 'pending'
         AND escalation_minutes IS NOT NULL
         AND escalated_at IS NULL
         AND created_at + interval '1 minute' * escalation_minutes < now()
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );

    for (const row of toEscalate.rows) {
      await pool.query(
        "UPDATE approvals SET escalated_at = now(), updated_at = now() WHERE approval_id = $1",
        [row.approval_id],
      );
      // 如果配置了升级目标，发送通知
      if (row.escalation_target) {
        try {
          await notifyApprovalRequired({
            pool,
            tenantId: row.tenant_id,
            spaceId: row.space_id ?? null,
            subjectId: row.escalation_target,
            runId: row.run_id,
            stepId: row.step_id ?? "",
            toolRef: row.tool_ref ?? "unknown",
            approvalId: row.approval_id,
          });
        } catch (notifyErr: any) {
          // 通知失败不阻塞升级流程
        }
      }
      escalated++;
      processed++;
    }
  } catch (e: any) {
    // 升级查询失败不应影响后续过期处理
  }

  // ── Step 2: 过期自动拒绝（元数据驱动） ───────────────────
  // 查询单行 auto_reject_on_expiry = true 且 expires_at 已过的审批
  try {
    const toExpire = await pool.query<{ approval_id: string; tenant_id: string; run_id: string; step_id: string | null }>(
      `SELECT approval_id, tenant_id, run_id, step_id
       FROM approvals
       WHERE status = 'pending'
         AND auto_reject_on_expiry = true
         AND expires_at IS NOT NULL
         AND expires_at < now()
       ORDER BY created_at ASC
       LIMIT $1`,
      [Math.max(limit - processed, 1)],
    );

    for (const row of toExpire.rows) {
      await pool.query(
        `UPDATE approvals
         SET status = 'rejected', reason = 'auto_expired', decided_at = now(), updated_at = now()
         WHERE approval_id = $1 AND status = 'pending'`,
        [row.approval_id],
      );

      // 取消对应的运行
      await pool.query(
        "UPDATE runs SET status = 'canceled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE run_id = $1 AND status = 'needs_approval'",
        [row.run_id],
      );
      await pool.query(
        "UPDATE jobs SET status = 'canceled', updated_at = now() WHERE run_id = $1 AND status IN ('needs_approval', 'queued', 'pending', 'running')",
        [row.run_id],
      );
      if (row.step_id) {
        await pool.query(
          "UPDATE steps SET status = 'canceled', finished_at = COALESCE(finished_at, now()), updated_at = now() WHERE step_id = $1 AND status IN ('needs_approval', 'pending', 'running')",
          [row.step_id],
        );
      }

      expired++;
      processed++;
    }
  } catch (e: any) {
    // 过期查询失败记录但不抛异常
  }

  return { processed, expired, escalated };
}

/**
 * 获取待审批统计
 */
export async function getApprovalStats(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
}): Promise<{
  pending: number;
  escalated: number;
  expiringSoon: number;
  todayApproved: number;
  todayRejected: number;
}> {
  const { pool, tenantId, spaceId } = params;
  
  const spaceFilter = spaceId ? "AND space_id = $2" : "";
  const params2 = spaceId ? [tenantId, spaceId] : [tenantId];
  
  // 待审批数量
  const pendingRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM approvals WHERE tenant_id = $1 ${spaceFilter} AND status = 'pending'`,
    params2
  );
  const pending = parseInt(pendingRes.rows[0]?.count ?? "0", 10);
  
  // 已升级数量
  const escalatedRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM approvals WHERE tenant_id = $1 ${spaceFilter} AND status = 'pending' AND escalated_at IS NOT NULL`,
    params2
  );
  const escalated = parseInt(escalatedRes.rows[0]?.count ?? "0", 10);
  
  // 即将过期（1小时内）
  const expiringThreshold = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const expiringRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM approvals 
     WHERE tenant_id = $1 ${spaceFilter} 
       AND status = 'pending' 
       AND expires_at IS NOT NULL 
       AND expires_at < $${spaceId ? 3 : 2}`,
    [...params2, expiringThreshold]
  );
  const expiringSoon = parseInt(expiringRes.rows[0]?.count ?? "0", 10);
  
  // 今日已处理
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  
  const todayApprovedRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM approvals 
     WHERE tenant_id = $1 ${spaceFilter} 
       AND status = 'approved' 
       AND decided_at >= $${spaceId ? 3 : 2}`,
    [...params2, todayStart.toISOString()]
  );
  const todayApproved = parseInt(todayApprovedRes.rows[0]?.count ?? "0", 10);
  
  const todayRejectedRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM approvals 
     WHERE tenant_id = $1 ${spaceFilter} 
       AND status IN ('rejected', 'expired') 
       AND decided_at >= $${spaceId ? 3 : 2}`,
    [...params2, todayStart.toISOString()]
  );
  const todayRejected = parseInt(todayRejectedRes.rows[0]?.count ?? "0", 10);
  
  return { pending, escalated, expiringSoon, todayApproved, todayRejected };
}

/* ================================================================== */
/*  Risk Assessment                                                      */
/* ================================================================== */

/**
 * 评估操作风险等级（纯数据驱动）。
 *
 * 从 approval_rules 表动态加载规则进行匹配，所有审批逻辑均来自数据库。
 * 工具自身的 riskLevel/approvalRequired 声明作为基准。
 * 返回值包含 matchedRules 和 humanSummary 用于审批自描述。
 */
export async function assessOperationRisk(params: {
  pool: Pool;
  tenantId: string;
  toolRef: string;
  inputDraft: Record<string, unknown>;
  toolDefinition?: {
    riskLevel?: "low" | "medium" | "high";
    approvalRequired?: boolean;
    scope?: string;
  };
}): Promise<{
  riskLevel: "low" | "medium" | "high";
  approvalRequired: boolean;
  riskFactors: string[];
  matchedRules?: ToolExecutionAssessment["matchedRules"];
  humanSummary?: string;
}> {
  const result = await assessToolExecutionRisk({
    pool: params.pool,
    tenantId: params.tenantId,
    toolRef: params.toolRef,
    inputDraft: params.inputDraft,
    toolDefinition: params.toolDefinition,
  });
  return {
    riskLevel: result.riskLevel,
    approvalRequired: result.approvalRequired,
    riskFactors: result.riskFactors,
    matchedRules: result.matchedRules,
    humanSummary: result.humanSummary,
  };
}

/**
 * 创建审批请求并发送通知
 */
export async function createApprovalWithNotification(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  runId: string;
  stepId: string;
  toolRef: string;
  policySnapshotRef: string | null;
  inputDigest: any;
  requestedBySubjectId: string;
  policy?: Partial<ApprovalPolicy>;
  traceId?: string | null;
}): Promise<{ approvalId: string; notificationsSent: number }> {
  const { pool, tenantId, spaceId, subjectId, runId, stepId, toolRef, policySnapshotRef, inputDigest, requestedBySubjectId, traceId } = params;
  const policy = { ...DEFAULT_APPROVAL_POLICY, ...params.policy };
  
  // 计算过期时间
  const expiresAt = policy.expirationMinutes > 0
    ? new Date(Date.now() + policy.expirationMinutes * 60 * 1000).toISOString()
    : null;
  
  const approval = await createApproval({
    pool,
    tenantId,
    spaceId,
    runId,
    stepId,
    requestedBySubjectId,
    toolRef,
    policySnapshotRef,
    inputDigest,
    expiresAt,
  });
  const approvalId = approval.approvalId;
  
  // 发送通知
  const notifications = await notifyApprovalRequired({
    pool,
    tenantId,
    spaceId,
    subjectId,
    runId,
    stepId,
    toolRef,
    approvalId,
    traceId,
  });
  
  return { approvalId, notificationsSent: notifications.length };
}
