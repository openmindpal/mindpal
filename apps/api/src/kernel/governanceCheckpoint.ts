/**
 * P3-4: 运行时治理检查点
 * 
 * 在关键执行节点插入治理检查：
 * - 执行前检查（权限、策略、安全）
 * - 执行中监控（超时、资源、异常）
 * - 执行后审计（结果、证据、合规）
 * - 架构不变式检查
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import { StructuredLogger } from "@mindpal/shared";

/* ── Re-export 拆分模块，保持外部引用兼容 ── */
export { checkPermission, checkPolicy, checkSafety, checkToolAvailability } from "./governancePreChecks";
export { checkAuditCompleteness, checkOutputSafety, checkInvariants, checkTimeout, checkResourceUsage } from "./governanceChecks";

import { checkPermission, checkPolicy, checkSafety, checkToolAvailability } from "./governancePreChecks";
import { checkAuditCompleteness, checkOutputSafety, checkInvariants, checkTimeout, checkResourceUsage } from "./governanceChecks";
import { turboSkipPolicySafety, isTurboAllowedForTenant } from "./loopTurboMode";

const logger = new StructuredLogger({ module: "governance" });

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type CheckpointPhase = "pre_execution" | "during_execution" | "post_execution";

export type CheckpointType = 
  | "permission"      // 权限检查
  | "policy"          // 策略检查
  | "safety"          // 安全检查
  | "timeout"         // 超时检查
  | "resource"        // 资源检查
  | "audit"           // 审计检查
  | "invariant";      // 不变式检查

export type CheckResult = {
  passed: boolean;
  checkType: CheckpointType;
  phase: CheckpointPhase;
  message: string;
  severity: "info" | "warning" | "error" | "critical";
  /** 是否阻止执行 */
  blocking: boolean;
  /** 建议的补救措施 */
  remediation?: string;
  /** 检查耗时 (ms) */
  durationMs: number;
  metadata?: Record<string, unknown>;
};

export interface CheckpointContext {
  tenantId: string;
  spaceId: string | null;
  subjectId: string;
  runId: string;
  stepId?: string;
  toolRef: string;
  input?: Record<string, unknown>;
  traceId?: string;
}

export interface GovernanceCheckpoint {
  checkpointId: string;
  phase: CheckpointPhase;
  context: CheckpointContext;
  results: CheckResult[];
  overallPassed: boolean;
  blockingFailures: number;
  startedAt: string;
  completedAt: string;
}

function normalizeUuidOrNull(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
    ? normalized
    : null;
}

/* ================================================================== */
/*  Pre-Execution Checks                                                 */
/* ================================================================== */

/**
 * 执行前检查
 */
export async function runPreExecutionChecks(params: {
  pool: Pool;
  app?: FastifyInstance | null;
  context: CheckpointContext;
}): Promise<GovernanceCheckpoint> {
  const { pool, app, context } = params;
  const startedAt = new Date().toISOString();
  const results: CheckResult[] = [];

  if (turboSkipPolicySafety() && isTurboAllowedForTenant(context.tenantId)) {
    // 加速模式：仅执行 permission + availability
    const [permResult, availResult] = await Promise.all([
      checkPermission({ pool, context }),
      checkToolAvailability({ pool, context }),
    ]);
    results.push(permResult, availResult);
  } else {
    const [permResult, policyResult, safetyResult, availResult] = await Promise.all([
      checkPermission({ pool, context }),
      checkPolicy({ pool, context }),
      checkSafety({ pool, context }),
      checkToolAvailability({ pool, context }),
    ]);
    results.push(permResult, policyResult, safetyResult, availResult);
  }

  const blockingFailures = results.filter(r => !r.passed && r.blocking).length;

  const checkpoint: GovernanceCheckpoint = {
    checkpointId: `pre_${context.runId}_${Date.now()}`,
    phase: "pre_execution",
    context,
    results,
    overallPassed: blockingFailures === 0,
    blockingFailures,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  await recordCheckpoint({ pool, checkpoint });
  return checkpoint;
}

/* ================================================================== */
/*  During-Execution Checks                                              */
/* ================================================================== */

/**
 * 执行中检查
 */
export async function runDuringExecutionChecks(params: {
  pool: Pool;
  context: CheckpointContext;
  executionStartedAt: string;
  timeoutMs: number;
}): Promise<CheckResult[]> {
  const { pool, context, executionStartedAt, timeoutMs } = params;
  const results: CheckResult[] = [];

  results.push(checkTimeout({ executionStartedAt, timeoutMs }));
  results.push(await checkResourceUsage({ pool, context }));

  return results;
}

/* ================================================================== */
/*  Post-Execution Checks                                                */
/* ================================================================== */

/**
 * 执行后检查
 */
export async function runPostExecutionChecks(params: {
  pool: Pool;
  context: CheckpointContext;
  executionResult: {
    success: boolean;
    output?: Record<string, unknown>;
    error?: string;
    durationMs: number;
  };
}): Promise<GovernanceCheckpoint> {
  const { pool, context, executionResult } = params;
  const startedAt = new Date().toISOString();
  const results: CheckResult[] = [];

  results.push(await checkAuditCompleteness({ pool, context, executionResult }));
  if (executionResult.output) {
    results.push(checkOutputSafety({ output: executionResult.output }));
  }
  results.push(await checkInvariants({ pool, context }));

  const blockingFailures = results.filter(r => !r.passed && r.blocking).length;

  const checkpoint: GovernanceCheckpoint = {
    checkpointId: `post_${context.runId}_${Date.now()}`,
    phase: "post_execution",
    context,
    results,
    overallPassed: blockingFailures === 0,
    blockingFailures,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  await recordCheckpoint({ pool, checkpoint });
  return checkpoint;
}

/* ================================================================== */
/*  Checkpoint Recording                                                 */
/* ================================================================== */

/**
 * 记录检查点
 */
async function recordCheckpoint(params: {
  pool: Pool;
  checkpoint: GovernanceCheckpoint;
}): Promise<void> {
  try {
    const { pool, checkpoint } = params;
    const runId = normalizeUuidOrNull(checkpoint.context.runId);
    const stepId = typeof checkpoint.context.stepId === "string" && checkpoint.context.stepId.trim()
      ? normalizeUuidOrNull(checkpoint.context.stepId)
      : null;
    if (!runId) return;
    
    await pool.query(
      `INSERT INTO governance_checkpoints 
       (checkpoint_id, tenant_id, run_id, step_id, phase, results, overall_passed, 
        blocking_failures, started_at, completed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [
        checkpoint.checkpointId,
        checkpoint.context.tenantId,
        runId,
        stepId,
        checkpoint.phase,
        JSON.stringify(checkpoint.results),
        checkpoint.overallPassed,
        checkpoint.blockingFailures,
        checkpoint.startedAt,
        checkpoint.completedAt,
      ]
    );
  } catch (err: any) {
    // 检查点记录失败不阻塞业务，但记录警告
    logger.warn(`recordCheckpoint failed: ${err?.message}`);
  }
}

/**
 * 获取检查点历史
 */
export async function getCheckpointHistory(params: {
  pool: Pool;
  tenantId: string;
  runId: string;
  stepId?: string;
}): Promise<GovernanceCheckpoint[]> {
  const { pool, tenantId, runId, stepId } = params;
  
  try {
    const res = await pool.query<{
      checkpoint_id: string;
      phase: string;
      results: any;
      overall_passed: boolean;
      blocking_failures: number;
      started_at: string;
      completed_at: string;
    }>(
      `SELECT checkpoint_id, phase, results, overall_passed, blocking_failures, 
              started_at, completed_at
       FROM governance_checkpoints 
       WHERE tenant_id = $1 AND run_id = $2
         AND ($3::UUID IS NULL OR step_id = $3)
       ORDER BY started_at ASC`,
      [tenantId, runId, stepId ?? null]
    );
    
    return res.rows.map(row => ({
      checkpointId: row.checkpoint_id,
      phase: row.phase as CheckpointPhase,
      context: { tenantId, runId, stepId } as any,
      results: row.results ?? [],
      overallPassed: row.overall_passed,
      blockingFailures: row.blocking_failures,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  } catch (err: any) {
    logger.warn(`getCheckpointHistory failed: ${err?.message}`);
    return [];
  }
}
