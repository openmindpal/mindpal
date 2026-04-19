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
 * 处理过期的审批请求
 */
export async function processExpiredApprovals(params: {
  pool: Pool;
  policy?: Partial<ApprovalPolicy>;
  limit?: number;
}): Promise<{ processed: number; expired: number; escalated: number }> {
  const { pool, limit = 100 } = params;
  const policy = { ...DEFAULT_APPROVAL_POLICY, ...params.policy };
  
  let processed = 0;
  let expired = 0;
  let escalated = 0;
  
  // 查找过期的审批请求
  const now = new Date();
  const expirationThreshold = new Date(now.getTime() - policy.expirationMinutes * 60 * 1000);
  const escalationThreshold = new Date(now.getTime() - policy.escalationMinutes * 60 * 1000);
  
  // 先处理需要升级的
  if (policy.escalationMinutes > 0 && policy.escalationTarget) {
    const toEscalate = await pool.query<{ approval_id: string; tenant_id: string; run_id: string }>(
      `SELECT approval_id, tenant_id, run_id FROM approvals
       WHERE status = 'pending'
         AND escalated_at IS NULL
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [escalationThreshold.toISOString(), limit]
    );
    
    for (const row of toEscalate.rows) {
      await pool.query(
        "UPDATE approvals SET escalated_at = now(), updated_at = now() WHERE approval_id = $1",
        [row.approval_id]
      );
      escalated++;
      processed++;
    }
  }
  
  // 处理过期的
  if (policy.expirationMinutes > 0 && policy.autoRejectOnExpiry) {
    const toExpire = await pool.query<{ approval_id: string; tenant_id: string; run_id: string }>(
      `SELECT approval_id, tenant_id, run_id FROM approvals
       WHERE status = 'pending'
         AND created_at < $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [expirationThreshold.toISOString(), limit - processed]
    );
    
    for (const row of toExpire.rows) {
      await pool.query(
        `UPDATE approvals 
         SET status = 'expired', decision = 'reject', reason = 'auto_expired', decided_at = now(), updated_at = now()
         WHERE approval_id = $1`,
        [row.approval_id]
      );
      
      // 取消对应的运行
      await pool.query(
        "UPDATE runs SET status = 'canceled', finished_at = now(), updated_at = now() WHERE run_id = $1 AND status = 'needs_approval'",
        [row.run_id]
      );
      await pool.query(
        "UPDATE jobs SET status = 'canceled', updated_at = now() WHERE run_id = $1 AND status IN ('needs_approval', 'queued', 'pending', 'running')",
        [row.run_id]
      );
      await pool.query(
        "UPDATE steps SET status = 'canceled', finished_at = now(), updated_at = now() WHERE run_id = $1 AND status IN ('needs_approval', 'pending', 'running')",
        [row.run_id]
      );
      
      expired++;
      processed++;
    }
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
