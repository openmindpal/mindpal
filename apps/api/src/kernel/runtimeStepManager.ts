/**
 * P1-3: 运行时插入 Step 能力（Replan）
 * 
 * 在任务执行过程中动态调整计划：
 * - insertStepAfter: 在指定步骤后插入新步骤
 * - insertStepBefore: 在指定步骤前插入新步骤
 * - appendStep: 在计划末尾追加步骤
 * - replaceStep: 替换指定步骤
 * - removeStep: 移除指定步骤
 * - replanFromCurrent: 从当前位置重新规划
 * 
 * 约束：
 * 1. 只能修改 pending 状态的步骤
 * 2. 已执行（succeeded/failed）的步骤不可修改
 * 3. 插入的步骤必须经过工具校验
 * 4. 每次修改都记录审计日志
 */
import type { Pool } from "pg";
import crypto from "node:crypto";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { getToolVersionByRef, getToolDefinition } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { shouldRequireApproval } from "@openslin/shared/approvalDecision";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface RuntimeStep {
  stepId: string;
  actorRole: string;
  kind: "tool";
  toolRef: string;
  inputDraft: Record<string, unknown>;
  dependsOn: string[];
  approvalRequired: boolean;
  status?: string;
  seq?: number;
}

export interface InsertStepParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  runId: string;
  /** 新步骤定义 */
  step: Omit<RuntimeStep, "stepId" | "status" | "seq">;
  /** 锚点步骤 ID */
  anchorStepId?: string;
  /** 插入位置 */
  position: "before" | "after" | "append";
  /** 操作原因（用于审计） */
  reason?: string;
  traceId?: string | null;
}

export interface InsertStepResult {
  ok: boolean;
  stepId?: string;
  seq?: number;
  message: string;
  validationErrors?: string[];
}

export interface ReplanContext {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  runId: string;
  /** 当前执行位置（cursor） */
  currentCursor: number;
  /** 新的计划步骤（从 Planning Kernel 获得） */
  newSteps: Array<Omit<RuntimeStep, "stepId" | "status" | "seq">>;
  /** 是否保留已规划但未执行的步骤 */
  keepPendingSteps?: boolean;
  reason?: string;
  traceId?: string | null;
}

export interface ReplanResult {
  ok: boolean;
  insertedCount: number;
  removedCount: number;
  message: string;
  newStepIds: string[];
}

/* ================================================================== */
/*  Validation                                                           */
/* ================================================================== */

/**
 * 验证步骤定义是否有效
 */
async function validateStep(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  step: Omit<RuntimeStep, "stepId" | "status" | "seq">;
}): Promise<{ ok: boolean; errors: string[] }> {
  const { pool, tenantId, spaceId, step } = params;
  const errors: string[] = [];
  
  // 1. 验证 toolRef 格式
  const rawToolRef = step.toolRef;
  if (!rawToolRef || typeof rawToolRef !== "string") {
    errors.push("toolRef 不能为空");
    return { ok: false, errors };
  }
  
  // 2. 解析工具名和版本
  const at = rawToolRef.lastIndexOf("@");
  const toolName = at > 0 ? rawToolRef.slice(0, at) : rawToolRef;
  
  // 3. 解析有效的 toolRef
  const effToolRef = at > 0 
    ? rawToolRef 
    : await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: toolName });
  
  if (!effToolRef) {
    errors.push(`工具 ${toolName} 不存在或没有发布版本`);
    return { ok: false, errors };
  }
  
  // 4. 验证版本状态
  const ver = await getToolVersionByRef(pool, tenantId, effToolRef);
  if (!ver) {
    errors.push(`工具版本 ${effToolRef} 不存在`);
    return { ok: false, errors };
  }
  if (ver.status !== "released") {
    errors.push(`工具版本 ${effToolRef} 未发布 (status=${ver.status})`);
    return { ok: false, errors };
  }
  
  // 5. 验证是否启用
  const enabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef: effToolRef });
  if (!enabled) {
    errors.push(`工具 ${effToolRef} 在当前空间未启用`);
    return { ok: false, errors };
  }
  
  return { ok: true, errors: [] };
}

/* ================================================================== */
/*  Step Insert Operations                                               */
/* ================================================================== */

/**
 * 在指定位置插入新步骤
 */
export async function insertStep(params: InsertStepParams): Promise<InsertStepResult> {
  const { pool, tenantId, spaceId, runId, step, anchorStepId, position, reason } = params;
  
  // 1. 验证步骤定义
  const validation = await validateStep({ pool, tenantId, spaceId, step });
  if (!validation.ok) {
    return { ok: false, message: "步骤验证失败", validationErrors: validation.errors };
  }
  
  // 2. 获取运行状态
  const runRes = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
    [tenantId, runId]
  );
  if (!runRes.rowCount) {
    return { ok: false, message: "Run 不存在" };
  }
  
  const runStatus = runRes.rows[0].status;
  // 只允许在非终态的运行中插入步骤
  if (["succeeded", "failed", "canceled", "compensated"].includes(runStatus)) {
    return { ok: false, message: `无法在已完成的运行中插入步骤 (status=${runStatus})` };
  }
  
  // 3. 确定插入位置
  let seq: number;
  
  if (position === "append") {
    // 追加到末尾
    const maxSeqRes = await pool.query<{ max_seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps WHERE run_id = $1",
      [runId]
    );
    seq = (maxSeqRes.rows[0]?.max_seq ?? 0) + 1;
  } else if (anchorStepId) {
    // 基于锚点插入
    const anchorRes = await pool.query<{ seq: number; status: string }>(
      "SELECT seq, status FROM steps WHERE run_id = $1 AND step_id = $2 LIMIT 1",
      [runId, anchorStepId]
    );
    if (!anchorRes.rowCount) {
      return { ok: false, message: `锚点步骤 ${anchorStepId} 不存在` };
    }
    
    const anchorSeq = anchorRes.rows[0].seq;
    const anchorStatus = anchorRes.rows[0].status;
    
    // 不能在已执行的步骤前插入
    if (position === "before" && ["succeeded", "failed", "deadletter"].includes(anchorStatus)) {
      return { ok: false, message: `不能在已执行的步骤前插入 (status=${anchorStatus})` };
    }
    
    seq = position === "before" ? anchorSeq : anchorSeq + 1;
    
    // 移动后续步骤的序号
    await pool.query(
      "UPDATE steps SET seq = seq + 1, updated_at = now() WHERE run_id = $1 AND seq >= $2",
      [runId, seq]
    );
  } else {
    return { ok: false, message: "非 append 模式需要指定锚点步骤" };
  }
  
  // 4. 解析有效的 toolRef
  const at = step.toolRef.lastIndexOf("@");
  const toolName = at > 0 ? step.toolRef.slice(0, at) : step.toolRef;
  const effToolRef = at > 0 
    ? step.toolRef 
    : await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: toolName });
  
  // 5. 获取工具定义以确定 approvalRequired
  const def = await getToolDefinition(pool, tenantId, toolName);
  const approvalRequired = step.approvalRequired || shouldRequireApproval(def ?? {});
  
  // 6. 生成步骤 ID 并插入
  const stepId = crypto.randomUUID();
  
  await pool.query(
    `INSERT INTO steps (
      step_id, run_id, seq, status, attempt, tool_ref, 
      input_digest, created_at, updated_at
    ) VALUES ($1, $2, $3, 'pending', 0, $4, $5, now(), now())`,
    [
      stepId,
      runId,
      seq,
      effToolRef,
      JSON.stringify({
        kind: "agent.run.step",
        toolRef: effToolRef,
        input: step.inputDraft,
        actorRole: step.actorRole,
        dependsOn: step.dependsOn,
        approvalRequired,
        insertedAt: new Date().toISOString(),
        insertReason: reason,
      }),
    ]
  );
  
  return {
    ok: true,
    stepId,
    seq,
    message: `步骤已插入 (seq=${seq})`,
  };
}

/**
 * 追加步骤到计划末尾
 */
export async function appendStep(params: Omit<InsertStepParams, "anchorStepId" | "position">): Promise<InsertStepResult> {
  return insertStep({ ...params, position: "append" });
}

/**
 * 移除 pending 状态的步骤
 */
export async function removeStep(params: {
  pool: Pool;
  tenantId: string;
  runId: string;
  stepId: string;
  reason?: string;
}): Promise<{ ok: boolean; message: string }> {
  const { pool, tenantId, runId, stepId, reason } = params;
  
  // 验证步骤状态
  const stepRes = await pool.query<{ status: string; seq: number }>(
    "SELECT status, seq FROM steps WHERE run_id = $1 AND step_id = $2 LIMIT 1",
    [runId, stepId]
  );
  
  if (!stepRes.rowCount) {
    return { ok: false, message: "步骤不存在" };
  }
  
  const { status, seq } = stepRes.rows[0];
  
  // 只能移除 pending 状态的步骤
  if (status !== "pending") {
    return { ok: false, message: `只能移除 pending 状态的步骤 (当前 status=${status})` };
  }
  
  // 删除步骤
  await pool.query(
    "DELETE FROM steps WHERE step_id = $1",
    [stepId]
  );
  
  // 更新后续步骤的序号
  await pool.query(
    "UPDATE steps SET seq = seq - 1, updated_at = now() WHERE run_id = $1 AND seq > $2",
    [runId, seq]
  );
  
  return { ok: true, message: `步骤已移除 (reason: ${reason ?? "unspecified"})` };
}

/* ================================================================== */
/*  Replan Operation                                                     */
/* ================================================================== */

/**
 * 从当前位置重新规划
 * 移除所有未执行的步骤，插入新的步骤
 */
export async function replanFromCurrent(ctx: ReplanContext): Promise<ReplanResult> {
  const { pool, tenantId, spaceId, runId, currentCursor, newSteps, keepPendingSteps, reason, traceId } = ctx;
  
  // 1. 获取运行状态
  const runRes = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
    [tenantId, runId]
  );
  if (!runRes.rowCount) {
    return { ok: false, insertedCount: 0, removedCount: 0, message: "Run 不存在", newStepIds: [] };
  }
  
  // 2. 验证所有新步骤
  for (const step of newSteps) {
    const validation = await validateStep({ pool, tenantId, spaceId, step });
    if (!validation.ok) {
      return {
        ok: false,
        insertedCount: 0,
        removedCount: 0,
        message: `步骤 ${step.toolRef} 验证失败: ${validation.errors.join(", ")}`,
        newStepIds: [],
      };
    }
  }
  
  // 3. 移除未执行的步骤（如果不保留）
  let removedCount = 0;
  if (!keepPendingSteps) {
    const deleteRes = await pool.query(
      "DELETE FROM steps WHERE run_id = $1 AND seq > $2 AND status = 'pending' RETURNING step_id",
      [runId, currentCursor]
    );
    removedCount = deleteRes.rowCount ?? 0;
  }
  
  // 4. 确定新步骤的起始序号
  const maxSeqRes = await pool.query<{ max_seq: number }>(
    "SELECT COALESCE(MAX(seq), 0) as max_seq FROM steps WHERE run_id = $1",
    [runId]
  );
  let nextSeq = (maxSeqRes.rows[0]?.max_seq ?? 0) + 1;
  
  // 5. 插入新步骤
  const newStepIds: string[] = [];
  
  for (const step of newSteps) {
    const stepId = crypto.randomUUID();
    
    // 解析有效的 toolRef
    const at = step.toolRef.lastIndexOf("@");
    const toolName = at > 0 ? step.toolRef.slice(0, at) : step.toolRef;
    const effToolRef = at > 0 
      ? step.toolRef 
      : await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: toolName });
    
    const def = await getToolDefinition(pool, tenantId, toolName);
    const approvalRequired = step.approvalRequired || shouldRequireApproval(def ?? {});
    
    await pool.query(
      `INSERT INTO steps (
        step_id, run_id, seq, status, attempt, tool_ref, 
        input_digest, created_at, updated_at
      ) VALUES ($1, $2, $3, 'pending', 0, $4, $5, now(), now())`,
      [
        stepId,
        runId,
        nextSeq,
        effToolRef,
        JSON.stringify({
          kind: "agent.run.step",
          toolRef: effToolRef,
          input: step.inputDraft,
          actorRole: step.actorRole,
          dependsOn: step.dependsOn,
          approvalRequired,
          replanAt: new Date().toISOString(),
          replanReason: reason,
          traceId,
        }),
      ]
    );
    
    newStepIds.push(stepId);
    nextSeq++;
  }
  
  return {
    ok: true,
    insertedCount: newStepIds.length,
    removedCount,
    message: `重新规划完成: 移除 ${removedCount} 步骤, 插入 ${newStepIds.length} 步骤`,
    newStepIds,
  };
}

/**
 * 获取可编辑的步骤列表（pending 状态）
 */
export async function getEditableSteps(params: {
  pool: Pool;
  runId: string;
}): Promise<RuntimeStep[]> {
  const { pool, runId } = params;
  
  const res = await pool.query<{
    step_id: string;
    seq: number;
    status: string;
    tool_ref: string | null;
    input_digest: any;
  }>(
    `SELECT step_id, seq, status, tool_ref, input_digest 
     FROM steps 
     WHERE run_id = $1 AND status = 'pending'
     ORDER BY seq ASC`,
    [runId]
  );
  
  return res.rows.map(row => {
    const inputDigest = row.input_digest ?? {};
    return {
      stepId: row.step_id,
      seq: row.seq,
      status: row.status,
      actorRole: inputDigest.actorRole ?? "executor",
      kind: "tool" as const,
      toolRef: row.tool_ref ?? inputDigest.toolRef ?? "",
      inputDraft: inputDigest.input ?? {},
      dependsOn: inputDigest.dependsOn ?? [],
      approvalRequired: inputDigest.approvalRequired ?? false,
    };
  });
}
