/**
 * Governance Pre-Execution Checks
 *
 * 执行前检查：权限、策略（tool_rollouts + tool_governance）、安全（DLP）、工具可用性
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";
import { authorize } from "../modules/auth/authz";
import type { CheckResult, CheckpointContext } from "./governanceCheckpoint";

const logger = new StructuredLogger({ module: "governance.pre" });

/* ================================================================== */
/*  Permission Check                                                     */
/* ================================================================== */

export async function checkPermission(params: {
  pool: Pool;
  context: CheckpointContext;
}): Promise<CheckResult> {
  const start = Date.now();
  const { pool, context } = params;

  try {
    const decision = await authorize({
      pool,
      subjectId: context.subjectId,
      tenantId: context.tenantId,
      spaceId: context.spaceId ?? undefined,
      resourceType: "tool",
      action: "execute",
    });

    const allowed = decision.decision === "allow";

    return {
      passed: allowed,
      checkType: "permission",
      phase: "pre_execution",
      message: allowed ? "权限检查通过" : `无权执行工具 ${context.toolRef.split("@")[0] ?? context.toolRef} (${decision.reason ?? "permission_denied"})`,
      severity: allowed ? "info" : "error",
      blocking: !allowed,
      remediation: allowed ? undefined : "请联系管理员授予工具执行权限",
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      passed: false,
      checkType: "permission",
      phase: "pre_execution",
      message: `权限检查异常: ${err?.message}`,
      severity: "error",
      blocking: false,
      remediation: "请检查数据库连接及 role_bindings/permissions 表状态",
      durationMs: Date.now() - start,
    };
  }
}

/* ================================================================== */
/*  Policy Check                                                         */
/* ================================================================== */

export async function checkPolicy(params: {
  pool: Pool;
  context: CheckpointContext;
}): Promise<CheckResult> {
  const start = Date.now();
  const { pool, context } = params;

  try {
    const toolName = context.toolRef.split("@")[0] ?? context.toolRef;

    // ── 1. 查询 tool_rollouts（权威启用状态源） ──
    const rolloutRes = await pool.query<{ enabled: boolean; disable_mode: string; grace_deadline: string | null }>(
      `SELECT enabled, disable_mode, grace_deadline FROM tool_rollouts
       WHERE tenant_id = $1
         AND ((scope_type = 'space' AND scope_id = $2) OR (scope_type = 'tenant' AND scope_id = $1))
         AND tool_ref = $3
       ORDER BY CASE WHEN scope_type = 'space' THEN 0 ELSE 1 END
       LIMIT 1`,
      [context.tenantId, context.spaceId, toolName]
    );

    const rolloutRow = rolloutRes.rowCount ? rolloutRes.rows[0] : null;
    let rolloutEnabled = rolloutRow ? Boolean(rolloutRow.enabled) : null;

    // ── Graceful-disable grace period ──
    if (
      rolloutRow &&
      !rolloutRow.enabled &&
      rolloutRow.disable_mode === "graceful" &&
      rolloutRow.grace_deadline
    ) {
      const deadline = new Date(rolloutRow.grace_deadline);
      if (deadline > new Date() && context.runId) {
        try {
          const runRes = await pool.query<{ created_at: string }>(
            `SELECT created_at FROM runs WHERE run_id = $1 LIMIT 1`,
            [context.runId]
          );
          if (runRes.rowCount) {
            const runCreatedAt = new Date(runRes.rows[0].created_at);
            if (runCreatedAt < deadline) {
              rolloutEnabled = true;
              logger.info(
                `checkPolicy: graceful grace period active for tool=${toolName} run=${context.runId} deadline=${deadline.toISOString()}`
              );
            }
          }
        } catch (err: any) {
          logger.warn(`checkPolicy: grace period run lookup failed: ${err?.message}`);
        }
      }
    }

    // ── 2. 查询 tool_governance（仅用于附加策略：requires_approval 等） ──
    const govRes = await pool.query<{
      requires_approval: boolean;
    }>(
      `SELECT tg.requires_approval
       FROM tool_governance tg
       WHERE tg.tenant_id = $1
         AND (tg.space_id IS NULL OR tg.space_id = $2)
         AND tg.tool_ref = $3
       ORDER BY tg.space_id NULLS LAST
       LIMIT 1`,
      [context.tenantId, context.spaceId, toolName]
    );

    const govRow = govRes.rowCount ? govRes.rows[0] : null;

    // ── 3. 判定启用状态 ──
    const effectiveEnabled = rolloutEnabled;

    if (effectiveEnabled === null) {
      return {
        passed: true,
        checkType: "policy",
        phase: "pre_execution",
        message: "无特定策略限制",
        severity: "info",
        blocking: false,
        durationMs: Date.now() - start,
      };
    }

    if (!effectiveEnabled) {
      return {
        passed: false,
        checkType: "policy",
        phase: "pre_execution",
        message: `工具 ${toolName} 已被策略禁用`,
        severity: "error",
        blocking: true,
        remediation: "请联系管理员启用该工具",
        durationMs: Date.now() - start,
        metadata: { source: "tool_rollouts" },
      };
    }

    // ── 5. 附加策略检查 ──
    if (govRow?.requires_approval) {
      return {
        passed: false,
        checkType: "policy",
        phase: "pre_execution",
        message: `工具 ${toolName} 需要审批后执行`,
        severity: "warning",
        blocking: true,
        remediation: "请提交审批申请",
        durationMs: Date.now() - start,
        metadata: { requiresApproval: true },
      };
    }

    return {
      passed: true,
      checkType: "policy",
      phase: "pre_execution",
      message: "策略检查通过",
      severity: "info",
      blocking: false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      passed: false,
      checkType: "policy",
      phase: "pre_execution",
      message: `策略检查异常: ${err?.message}`,
      severity: "error",
      blocking: false,
      remediation: "请检查数据库连接及 tool_rollouts 表状态",
      durationMs: Date.now() - start,
    };
  }
}

/* ================================================================== */
/*  Safety Check (DLP)                                                   */
/* ================================================================== */

export async function checkSafety(params: {
  pool: Pool;
  context: CheckpointContext;
}): Promise<CheckResult> {
  const start = Date.now();
  const { context } = params;

  const input = context.input ?? {};
  const inputStr = JSON.stringify(input);

  const sensitivePatterns = [
    { pattern: /\b\d{16,19}\b/, name: "信用卡号" },
    { pattern: /\b\d{18}\b/, name: "身份证号" },
    { pattern: /password\s*[:=]\s*['"][^'"]+['"]/i, name: "密码明文" },
    { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i, name: "API密钥" },
  ];

  const detectedRisks: string[] = [];
  for (const { pattern, name } of sensitivePatterns) {
    if (pattern.test(inputStr)) {
      detectedRisks.push(name);
    }
  }

  if (detectedRisks.length > 0) {
    return {
      passed: false,
      checkType: "safety",
      phase: "pre_execution",
      message: `检测到敏感信息: ${detectedRisks.join(", ")}`,
      severity: "critical",
      blocking: true,
      remediation: "请移除或加密敏感信息后重试",
      durationMs: Date.now() - start,
      metadata: { detectedRisks },
    };
  }

  return {
    passed: true,
    checkType: "safety",
    phase: "pre_execution",
    message: "安全检查通过",
    severity: "info",
    blocking: false,
    durationMs: Date.now() - start,
  };
}

/* ================================================================== */
/*  Tool Availability Check                                              */
/* ================================================================== */

export async function checkToolAvailability(params: {
  pool: Pool;
  context: CheckpointContext;
}): Promise<CheckResult> {
  const start = Date.now();
  const { pool, context } = params;

  try {
    const [toolName, version] = context.toolRef.split("@");

    const res = await pool.query<{ status: string; released_at: string | null }>(
      `SELECT tv.status, tv.released_at
       FROM tool_versions tv
       JOIN tool_definitions td ON tv.tool_definition_id = td.tool_definition_id
       WHERE td.tenant_id = $1 AND td.name = $2
         AND ($3::TEXT IS NULL OR tv.version = $3)
       ORDER BY tv.released_at DESC NULLS LAST
       LIMIT 1`,
      [context.tenantId, toolName, version ?? null]
    );

    if (!res.rowCount) {
      return {
        passed: false,
        checkType: "invariant",
        phase: "pre_execution",
        message: `工具 ${context.toolRef} 不存在`,
        severity: "error",
        blocking: true,
        durationMs: Date.now() - start,
      };
    }

    const tool = res.rows[0];

    if (tool.status !== "released" && tool.status !== "active") {
      return {
        passed: false,
        checkType: "invariant",
        phase: "pre_execution",
        message: `工具 ${context.toolRef} 状态为 ${tool.status}，无法执行`,
        severity: "error",
        blocking: true,
        durationMs: Date.now() - start,
      };
    }

    return {
      passed: true,
      checkType: "invariant",
      phase: "pre_execution",
      message: "工具可用性检查通过",
      severity: "info",
      blocking: false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      passed: true,
      checkType: "invariant",
      phase: "pre_execution",
      message: `工具可用性检查异常: ${err?.message}`,
      severity: "warning",
      blocking: false,
      durationMs: Date.now() - start,
    };
  }
}
