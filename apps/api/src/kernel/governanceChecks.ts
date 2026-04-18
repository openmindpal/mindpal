/**
 * Governance Post-Execution Checks
 *
 * 执行后检查：审计完整性、输出安全、架构不变式
 */
import type { Pool } from "pg";
import type { CheckResult, CheckpointContext } from "./governanceCheckpoint";

/* ================================================================== */
/*  Audit Completeness Check                                             */
/* ================================================================== */

function normalizeUuidOrNull(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

export async function checkAuditCompleteness(params: {
  pool: Pool;
  context: CheckpointContext;
  executionResult: { success: boolean; durationMs: number };
}): Promise<CheckResult> {
  const start = Date.now();
  const { pool, context, executionResult } = params;

  try {
    const stepId = normalizeUuidOrNull(context.stepId);
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM audit_events
       WHERE tenant_id = $1 AND run_id = $2
         AND ($3::UUID IS NULL OR step_id = $3::TEXT)`,
      [context.tenantId, context.runId, stepId]
    );

    const auditCount = parseInt(res.rows[0]?.count ?? "0", 10);

    if (auditCount === 0) {
      return {
        passed: false,
        checkType: "audit",
        phase: "post_execution",
        message: "缺少审计记录",
        severity: "warning",
        blocking: false,
        remediation: "请检查审计模块是否正常工作",
        durationMs: Date.now() - start,
      };
    }

    return {
      passed: true,
      checkType: "audit",
      phase: "post_execution",
      message: `审计记录完整 (${auditCount} 条)`,
      severity: "info",
      blocking: false,
      durationMs: Date.now() - start,
      metadata: { auditCount, executionDurationMs: executionResult.durationMs },
    };
  } catch (err: any) {
    return {
      passed: false,
      checkType: "audit",
      phase: "post_execution",
      message: `审计检查异常: ${err?.message}`,
      severity: "error",
      blocking: false,
      remediation: "请检查数据库连接及 audit_events 表状态",
      durationMs: Date.now() - start,
    };
  }
}

/* ================================================================== */
/*  Output Safety Check                                                  */
/* ================================================================== */

export function checkOutputSafety(params: {
  output: Record<string, unknown>;
}): CheckResult {
  const start = Date.now();
  const { output } = params;
  const outputStr = JSON.stringify(output);

  const sizeBytes = Buffer.byteLength(outputStr, "utf8");
  const maxSizeBytes = 10 * 1024 * 1024; // 10MB

  if (sizeBytes > maxSizeBytes) {
    return {
      passed: false,
      checkType: "safety",
      phase: "post_execution",
      message: `输出过大：${(sizeBytes / 1024 / 1024).toFixed(2)}MB，限制 ${maxSizeBytes / 1024 / 1024}MB`,
      severity: "warning",
      blocking: false,
      durationMs: Date.now() - start,
      metadata: { sizeBytes, maxSizeBytes },
    };
  }

  return {
    passed: true,
    checkType: "safety",
    phase: "post_execution",
    message: "输出安全检查通过",
    severity: "info",
    blocking: false,
    durationMs: Date.now() - start,
    metadata: { sizeBytes },
  };
}

/* ================================================================== */
/*  Invariant Check                                                      */
/* ================================================================== */

export async function checkInvariants(params: {
  pool: Pool;
  context: CheckpointContext;
}): Promise<CheckResult> {
  const start = Date.now();
  const { pool, context } = params;

  try {
    const violations: string[] = [];

    const runRes = await pool.query<{ status: string; step_count: string }>(
      `SELECT r.status, COUNT(s.step_id) as step_count
       FROM runs r
       LEFT JOIN steps s ON r.run_id = s.run_id
       WHERE r.run_id = $1
       GROUP BY r.run_id`,
      [context.runId]
    );

    if (runRes.rowCount) {
      const run = runRes.rows[0];
      const stepCount = parseInt(run.step_count, 10);

      if ((run.status === "completed" || run.status === "failed") && stepCount === 0) {
        violations.push(`Run ${context.runId} 状态为 ${run.status} 但无 step 记录`);
      }
    }

    if (violations.length > 0) {
      return {
        passed: false,
        checkType: "invariant",
        phase: "post_execution",
        message: `架构不变式违规: ${violations.join("; ")}`,
        severity: "error",
        blocking: false,
        durationMs: Date.now() - start,
        metadata: { violations },
      };
    }

    return {
      passed: true,
      checkType: "invariant",
      phase: "post_execution",
      message: "架构不变式检查通过",
      severity: "info",
      blocking: false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      passed: false,
      checkType: "invariant",
      phase: "post_execution",
      message: `不变式检查异常: ${err?.message}`,
      severity: "error",
      blocking: false,
      remediation: "请检查数据库连接及 runs/steps 表状态",
      durationMs: Date.now() - start,
    };
  }
}

/* ================================================================== */
/*  During-Execution Checks                                              */
/* ================================================================== */

export function checkTimeout(params: {
  executionStartedAt: string;
  timeoutMs: number;
}): CheckResult {
  const { executionStartedAt, timeoutMs } = params;
  const elapsed = Date.now() - new Date(executionStartedAt).getTime();
  const remaining = timeoutMs - elapsed;

  if (remaining <= 0) {
    return {
      passed: false,
      checkType: "timeout",
      phase: "during_execution",
      message: `执行超时：已运行 ${Math.round(elapsed / 1000)}s，限制 ${Math.round(timeoutMs / 1000)}s`,
      severity: "error",
      blocking: true,
      durationMs: 0,
      metadata: { elapsed, timeoutMs },
    };
  }

  if (remaining < 10000) {
    return {
      passed: true,
      checkType: "timeout",
      phase: "during_execution",
      message: `即将超时：剩余 ${Math.round(remaining / 1000)}s`,
      severity: "warning",
      blocking: false,
      durationMs: 0,
      metadata: { elapsed, timeoutMs, remaining },
    };
  }

  return {
    passed: true,
    checkType: "timeout",
    phase: "during_execution",
    message: `执行时间正常：${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s`,
    severity: "info",
    blocking: false,
    durationMs: 0,
    metadata: { elapsed, timeoutMs },
  };
}

export async function checkResourceUsage(params: {
  pool: Pool;
  context: CheckpointContext;
}): Promise<CheckResult> {
  const start = Date.now();
  const { pool, context } = params;

  try {
    const res = await pool.query<{ count: string }>(
      "SELECT COUNT(*) as count FROM steps WHERE run_id = $1",
      [context.runId]
    );

    const stepCount = parseInt(res.rows[0]?.count ?? "0", 10);
    const maxSteps = 100;

    if (stepCount >= maxSteps) {
      return {
        passed: false,
        checkType: "resource",
        phase: "during_execution",
        message: `步骤数过多：${stepCount}/${maxSteps}`,
        severity: "warning",
        blocking: false,
        remediation: "请检查是否存在无限循环",
        durationMs: Date.now() - start,
        metadata: { stepCount, maxSteps },
      };
    }

    return {
      passed: true,
      checkType: "resource",
      phase: "during_execution",
      message: `资源使用正常：${stepCount} 步骤`,
      severity: "info",
      blocking: false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      passed: false,
      checkType: "resource",
      phase: "during_execution",
      message: `资源检查异常: ${err?.message}`,
      severity: "error",
      blocking: false,
      remediation: "请检查数据库连接及 steps 表状态",
      durationMs: Date.now() - start,
    };
  }
}
