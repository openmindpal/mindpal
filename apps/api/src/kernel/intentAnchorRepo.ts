/**
 * intentAnchorRepo.ts — 意图锚点 CRUD 操作
 *
 * 提供 intent_anchors / boundary_violations 两张表的持久化操作，
 * 包含创建、查询、停用、违例记录。
 *
 * @module intentAnchorRepo
 */
import type { Pool } from "pg";
import crypto from "node:crypto";
import type {
  IntentAnchor,
  AnchorInput,
  BoundaryViolation,
  ViolationInput,
} from "./intentAnchoringService";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** 计算指令的 SHA256 摘要（用于幂等去重） */
function computeInstructionDigest(instruction: string): string {
  return crypto.createHash("sha256").update(instruction, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/*  Anchor CRUD                                                        */
/* ------------------------------------------------------------------ */

/**
 * 创建意图锚点
 * @returns 新创建的 anchor，如果已存在则返回已有记录（幂等）
 */
export async function createIntentAnchor(
  pool: Pool,
  input: AnchorInput,
): Promise<IntentAnchor | null> {
  const digest = computeInstructionDigest(input.instruction);

  // 检查是否已存在（幂等）
  const existing = await pool.query<IntentAnchor>(
    `SELECT * FROM intent_anchors WHERE tenant_id = $1 AND instruction_digest = $2 LIMIT 1`,
    [input.tenantId, digest],
  );

  if ((existing.rowCount ?? 0) > 0) {
    return existing.rows[0];
  }

  const result = await pool.query<IntentAnchor>(
    `INSERT INTO intent_anchors (
      tenant_id, space_id, subject_id,
      original_instruction, instruction_digest, instruction_type,
      run_id, task_id, conversation_id,
      priority, is_active, expires_at, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11,$12)
    RETURNING *`,
    [
      input.tenantId,
      input.spaceId ?? null,
      input.subjectId,
      input.instruction,
      digest,
      input.instructionType,
      input.runId ?? null,
      input.taskId ?? null,
      input.conversationId ?? null,
      input.priority ?? 100,
      input.expiresAt ?? null,
      input.createdBy ?? null,
    ],
  );

  return result.rows[0];
}

/**
 * 批量创建意图锚点（用于解析复杂指令）
 */
export async function createIntentAnchorsBatch(
  pool: Pool,
  inputs: AnchorInput[],
): Promise<IntentAnchor[]> {
  const results: IntentAnchor[] = [];
  for (const input of inputs) {
    const anchor = await createIntentAnchor(pool, input);
    if (anchor) results.push(anchor);
  }
  return results;
}

/**
 * 查询活跃意图锚点（按优先级排序）
 */
export async function listActiveIntentAnchors(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  subjectId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  limit?: number;
}): Promise<IntentAnchor[]> {
  const { pool, tenantId, spaceId, subjectId, runId, taskId, limit = 50 } = params;

  const conditions: string[] = ["is_active = true"];
  const values: any[] = [tenantId];
  let paramIndex = 2;

  if (spaceId !== undefined) {
    if (spaceId === null) {
      conditions.push("space_id IS NULL");
    } else {
      conditions.push(`space_id = $${paramIndex}`);
      values.push(spaceId);
      paramIndex++;
    }
  }

  if (subjectId) {
    conditions.push(`subject_id = $${paramIndex}`);
    values.push(subjectId);
    paramIndex++;
  }

  if (runId) {
    conditions.push(`(run_id = $${paramIndex} OR run_id IS NULL)`);
    values.push(runId);
    paramIndex++;
  }

  if (taskId) {
    conditions.push(`(task_id = $${paramIndex} OR task_id IS NULL)`);
    values.push(taskId);
    paramIndex++;
  }

  // 排除已过期的
  conditions.push("(expires_at IS NULL OR expires_at > now())");

  const sql = `
    SELECT * FROM intent_anchors
    WHERE ${conditions.join(" AND ")}
    ORDER BY priority ASC, created_at DESC
    LIMIT $${paramIndex}
  `;
  values.push(limit);

  const result = await pool.query<IntentAnchor>(sql, values);
  return result.rows;
}

/**
 * 停用意图锚点
 */
export async function deactivateIntentAnchor(
  pool: Pool,
  anchorId: string,
  tenantId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE intent_anchors SET is_active = false, updated_at = now()
     WHERE anchor_id = $1 AND tenant_id = $2`,
    [anchorId, tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 记录边界违例事件
 */
export async function recordBoundaryViolation(
  pool: Pool,
  input: ViolationInput,
): Promise<BoundaryViolation> {
  const result = await pool.query<BoundaryViolation>(
    `INSERT INTO boundary_violations (
      tenant_id, space_id,
      violation_type, severity, anchor_id,
      run_id, step_id, agent_action, user_intent,
      action_taken, remediation_details, resolved_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      input.tenantId,
      input.spaceId ?? null,
      input.violationType,
      input.severity ?? "high",
      input.anchorId ?? null,
      input.runId,
      input.stepId ?? null,
      input.agentAction,
      input.userIntent,
      input.actionTaken,
      input.remediationDetails ?? null,
      input.resolvedBy ?? null,
    ],
  );

  return result.rows[0];
}
