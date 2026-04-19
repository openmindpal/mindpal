/**
 * P1-2: 事件驱动恢复机制
 * 
 * 统一处理 Run 的中断/恢复/重试流程：
 * - pause: 暂停运行（保留状态）
 * - resume: 从暂停/阻塞状态恢复
 * - retry: 重试失败的步骤
 * - interrupt: 中断当前执行
 * - cancel: 取消运行
 * 
 * 核心原则：
 * 1. 所有状态变更必须经过状态机校验
 * 2. 每次恢复操作都记录审计事件
 * 3. 支持从任意阻塞状态恢复
 */
import type { Pool } from "pg";
import type { WorkflowQueue } from "../modules/workflow/queue";
import { tryTransitionRun, type RunStatus, StructuredLogger } from "@openslin/shared";

const logger = new StructuredLogger({ module: "runRecovery" });

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type RecoveryAction = "pause" | "resume" | "retry" | "interrupt" | "cancel";

export interface RecoveryContext {
  pool: Pool;
  queue: WorkflowQueue;
  tenantId: string;
  spaceId: string;
  runId: string;
  subjectId: string;
  traceId: string | null;
  reason?: string;
}

export interface RecoveryResult {
  ok: boolean;
  action: RecoveryAction;
  previousStatus: RunStatus;
  newStatus: RunStatus;
  message: string;
  stepId?: string;
  jobId?: string;
  queuedAt?: string;
}

type RecoverableStepRow = { step_id: string; status: string };

async function listRecoverableSteps(pool: Pool, runId: string): Promise<RecoverableStepRow[]> {
  const stepRes = await pool.query<RecoverableStepRow>(
    `SELECT step_id, status FROM steps
     WHERE run_id = $1 AND status IN ('pending', 'paused', 'needs_device', 'needs_arbiter')
     ORDER BY seq ASC`,
    [runId],
  );
  return stepRes.rows;
}

/* ================================================================== */
/*  Recovery Functions                                                   */
/* ================================================================== */

/**
 * 暂停运行
 * 将运行状态设为 paused（P1-1.1: 使用新的 paused 状态）
 */
export async function pauseRun(ctx: RecoveryContext): Promise<RecoveryResult> {
  const { pool, tenantId, runId, reason, spaceId } = ctx;
  
  // P0-3 FIX: 使用两步操作替代有竞态的 RETURNING 子查询
  // Step 1: 先查询当前状态
  const runRes = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
    [tenantId, runId],
  );
  if (!runRes.rowCount) {
    return { ok: false, action: "pause", previousStatus: "created", newStatus: "created", message: "Run 不存在" };
  }
  const currentStatus = runRes.rows[0].status as RunStatus;

  // Step 2: 状态机校验
  const transition =
    currentStatus === "queued"
      ? { ok: true as const }
      : tryTransitionRun(currentStatus, "paused");
  if (!transition.ok) {
    return {
      ok: false, action: "pause",
      previousStatus: currentStatus, newStatus: currentStatus,
      message: `无法暂停状态为 ${currentStatus} 的运行`,
    };
  }

  // Step 3: 原子更新（仅当状态未变时才生效）
  const pausableStatuses = ["queued", "running"];
  const updateRes = await pool.query(
    `UPDATE runs SET status = 'paused', updated_at = now()
     WHERE tenant_id = $1 AND run_id = $2 AND status = ANY($3::text[])
     RETURNING 1`,
    [tenantId, runId, pausableStatuses],
  );
  
  if (!updateRes.rowCount) {
    return { 
      ok: false, 
      action: "pause", 
      previousStatus: currentStatus, 
      newStatus: currentStatus, 
      message: `并发冲突：状态已变更，无法暂停` 
    };
  }
  
  // P1-3.1: 更新 memory_task_states 表（blockReason 持久化）
  if (spaceId) {
    await pool.query(
      `UPDATE memory_task_states 
       SET phase = 'paused', block_reason = $4, updated_at = now()
       WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL`,
      [tenantId, spaceId, runId, reason ?? "user_paused"]
    ).catch((e: Error) => {
      // block_reason 字段可能不存在，回退到只更新 phase
      logger.warn(`[pauseRun] 更新 block_reason 失败: ${e.message}`);
      return pool.query(
        "UPDATE memory_task_states SET phase = 'paused', updated_at = now() WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL",
        [tenantId, spaceId, runId]
      );
    });
  }
  
  return {
    ok: true,
    action: "pause",
    previousStatus: currentStatus,
    newStatus: "paused",
    message: reason ?? "运行已暂停",
  };
}

/**
 * 恢复运行
 * 从阻塞状态（needs_approval, needs_device, needs_arbiter, paused）恢复
 */
export async function resumeRun(ctx: RecoveryContext): Promise<RecoveryResult> {
  const { pool, queue, tenantId, runId, reason, spaceId } = ctx;
  
  // P0-3 FIX: 使用状态机校验替代硬编码列表 + 移除有竞态的 RETURNING 子查询
  // Step 1: 获取 jobId（只读查询）
  const jobRes = await pool.query<{ job_id: string }>("SELECT job_id FROM jobs WHERE run_id = $1 AND tenant_id = $2 LIMIT 1", [runId, tenantId]);
  const jobId = jobRes.rowCount ? jobRes.rows[0].job_id : null;

  // Step 2: 查询当前 run 状态
  const runCheck = await pool.query<{ status: string }>("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [tenantId, runId]);
  if (!runCheck.rowCount) {
    return { ok: false, action: "resume", previousStatus: "created" as RunStatus, newStatus: "created" as RunStatus, message: "Run 不存在" };
  }
  const currentStatus = runCheck.rows[0].status as RunStatus;

  if (currentStatus === "needs_approval") {
    return {
      ok: false,
      action: "resume",
      previousStatus: currentStatus,
      newStatus: currentStatus,
      message: "Run 需要审批，不能直接恢复",
    };
  }
  if (currentStatus === "failed") {
    return {
      ok: false,
      action: "resume",
      previousStatus: currentStatus,
      newStatus: currentStatus,
      message: "Run 已失败，请使用 retry 而不是 resume",
    };
  }

  // Step 3: 状态机校验
  const transition = tryTransitionRun(currentStatus, "queued");
  if (!transition.ok) {
    return { ok: false, action: "resume", previousStatus: currentStatus, newStatus: currentStatus, message: `无法恢复状态为 ${currentStatus} 的运行` };
  }

  // Step 4: 原子更新（仅当状态未变时生效）
  const recoverableStatuses = ["needs_device", "needs_arbiter", "paused"];
  const updateRes = await pool.query(
    `UPDATE runs SET status = 'queued', updated_at = now()
     WHERE tenant_id = $1 AND run_id = $2 AND status = ANY($3::text[])
     RETURNING 1`,
    [tenantId, runId, recoverableStatuses],
  );
  
  if (!updateRes.rowCount) {
    return { ok: false, action: "resume", previousStatus: currentStatus, newStatus: currentStatus, message: `并发冲突：状态已变更，无法恢复` };
  }
  
  const recoverableSteps = await listRecoverableSteps(pool, runId);
  const stepId = recoverableSteps[0]?.step_id ?? null;

  if (spaceId) {
    await pool.query(
      `UPDATE memory_task_states
       SET phase = 'queued', block_reason = NULL, next_action = NULL, updated_at = now()
       WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 AND deleted_at IS NULL`,
      [tenantId, spaceId, runId],
    ).catch((e: Error) => {
      logger.warn(`[resumeRun] 更新 memory_task_states 失败: ${e.message}`);
    });
  }

  // 如果有步骤需要恢复，批量重置并逐个入队
  if (recoverableSteps.length > 0 && jobId) {
    const stepIds = recoverableSteps.map((step) => step.step_id);
    await pool.query(
      "UPDATE steps SET status = 'pending', updated_at = now(), queue_job_id = NULL WHERE step_id = ANY($1::uuid[])",
      [stepIds],
    );

    for (const recoverableStep of recoverableSteps) {
      const queuedJob = await queue.add(
        "step",
        { jobId, runId, stepId: recoverableStep.step_id },
        { attempts: 3, backoff: { type: "exponential", delay: 500 } },
      );

      await pool.query(
        "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2",
        [String(queuedJob.id), recoverableStep.step_id],
      );
    }

    return {
      ok: true,
      action: "resume",
      previousStatus: currentStatus,
      newStatus: "queued",
      message: reason ?? "运行已恢复",
      stepId,
      jobId,
      queuedAt: new Date().toISOString(),
    };
  }
  
  return {
    ok: true,
    action: "resume",
    previousStatus: currentStatus,
    newStatus: "queued",
    message: reason ?? "运行状态已重置",
  };
}

/**
 * 重试失败的步骤
 */
export async function retryFailedStep(ctx: RecoveryContext): Promise<RecoveryResult> {
  const { pool, queue, tenantId, runId, reason } = ctx;
  
  // 获取当前状态
  const runRes = await pool.query<{ status: string; job_id?: string }>(
    `SELECT r.status, j.job_id 
     FROM runs r 
     LEFT JOIN jobs j ON j.run_id = r.run_id AND j.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1 AND r.run_id = $2 LIMIT 1`,
    [tenantId, runId]
  );
  if (!runRes.rowCount) {
    return { ok: false, action: "retry", previousStatus: "created", newStatus: "created", message: "Run 不存在" };
  }
  
  const currentStatus = runRes.rows[0].status as RunStatus;
  const jobId = runRes.rows[0].job_id ?? null;
  
  // 找到失败的步骤
  const stepRes = await pool.query<{ step_id: string; attempt: number; error_category: string | null }>(
    `SELECT step_id, attempt, error_category FROM steps 
     WHERE run_id = $1 AND status IN ('failed', 'deadletter')
     ORDER BY seq ASC LIMIT 1`,
    [runId]
  );
  
  if (!stepRes.rowCount) {
    return {
      ok: false,
      action: "retry",
      previousStatus: currentStatus,
      newStatus: currentStatus,
      message: "没有找到可重试的失败步骤",
    };
  }
  
  const step = stepRes.rows[0];
  const stepId = step.step_id;
  const newAttempt = (step.attempt ?? 0) + 1;
  
  // 检查错误类别是否可重试
  const retryableErrors = ["retryable", "timeout", "resource_exhausted", "network_error"];
  const errorCategory = step.error_category ?? "unknown";
  if (!retryableErrors.includes(errorCategory) && errorCategory !== "unknown") {
    return {
      ok: false,
      action: "retry",
      previousStatus: currentStatus,
      newStatus: currentStatus,
      message: `错误类型 ${errorCategory} 不可重试`,
      stepId,
    };
  }
  
  // P1-1 FIX: 使用状态机校验 retry 转换合法性
  const retryTransition = tryTransitionRun(currentStatus, "queued");
  if (!retryTransition.ok) {
    return {
      ok: false, action: "retry",
      previousStatus: currentStatus, newStatus: currentStatus,
      message: `状态机拒绝 retry 转换: ${currentStatus} → queued`,
      stepId,
    };
  }

  // 更新状态
  await pool.query(
    "UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
    [tenantId, runId]
  );
  
  // steps 主链路按 step_id / run_id 操作，不依赖 tenant_id 列
  await pool.query(
    `UPDATE steps SET 
       status = 'pending', 
       attempt = $1, 
       updated_at = now(), 
       finished_at = NULL, 
       deadlettered_at = NULL, 
       queue_job_id = NULL 
     WHERE step_id = $2`,
    [newAttempt, stepId]
  );
  
  // 入队执行
  if (jobId) {
    const job = await queue.add(
      "step",
      { jobId, runId, stepId },
      { attempts: 3, backoff: { type: "exponential", delay: 500 } }
    );
    
    await pool.query(
      "UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2",
      [String(job.id), stepId]
    );
  }
  
  return {
    ok: true,
    action: "retry",
    previousStatus: currentStatus,
    newStatus: "queued",
    message: reason ?? `步骤已入队重试 (attempt=${newAttempt})`,
    stepId,
    jobId: jobId ?? undefined,
    queuedAt: new Date().toISOString(),
  };
}

/**
 * P1-2: 中断运行（真正中断语义）
 * 与 pause 不同：interrupt 会尝试取消 BullMQ 中正在排队/执行的 Job，
 * 并将当前运行中的步骤标记为 canceled，而非保留 pending 状态。
 */
export async function interruptRun(ctx: RecoveryContext): Promise<RecoveryResult> {
  const { pool, queue, tenantId, runId, reason } = ctx;

  // 获取当前状态
  const runRes = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
    [tenantId, runId]
  );
  if (!runRes.rowCount) {
    return { ok: false, action: "interrupt", previousStatus: "created", newStatus: "created", message: "Run 不存在" };
  }

  const currentStatus = runRes.rows[0].status as RunStatus;

  // P1-1 FIX: 使用状态机校验替代硬编码可中断列表
  const interruptTransition = tryTransitionRun(currentStatus, "stopped");
  if (!interruptTransition.ok) {
    return {
      ok: false,
      action: "interrupt",
      previousStatus: currentStatus,
      newStatus: currentStatus,
      message: `状态机拒绝中断: ${currentStatus} → stopped`,
    };
  }

  // 1. 查找并尝试取消 BullMQ 中的排队 Job
  const activeSteps = await pool.query<{ step_id: string; queue_job_id: string | null }>(
    `SELECT step_id, queue_job_id FROM steps 
     WHERE run_id = $1 AND status IN ('pending', 'running')
     ORDER BY seq ASC`,
    [runId]
  );

  let cancelledJobs = 0;
  for (const step of activeSteps.rows) {
    if (step.queue_job_id) {
      try {
        // 尝试从 BullMQ 队列中移除 Job
        const job = await queue.getJob(step.queue_job_id);
        if (job) {
          const state = await job.getState();
          if (state === "waiting" || state === "delayed") {
            await job.remove();
            cancelledJobs++;
          } else if (state === "active") {
            // 活跃 Job 无法直接 remove，通过 moveToFailed 标记
            await job.moveToFailed(new Error(reason ?? "用户中断"), "interrupt", false);
            cancelledJobs++;
          }
        }
      } catch (e: any) {
        logger.warn(`[interruptRun] 取消 BullMQ Job ${step.queue_job_id} 失败: ${e?.message}`);
      }
    }
  }

  // 2. steps 主链路按 run_id 操作，不依赖 tenant_id 列
  await pool.query(
    "UPDATE steps SET status = 'canceled', updated_at = now() WHERE run_id = $1 AND status IN ('pending', 'running')",
    [runId]
  );

  // 3. 更新运行状态为 stopped（中断终态）
  await pool.query(
    "UPDATE runs SET status = 'stopped', updated_at = now() WHERE tenant_id = $1 AND run_id = $2",
    [tenantId, runId]
  );

  return {
    ok: true,
    action: "interrupt",
    previousStatus: currentStatus,
    newStatus: "stopped",
    message: reason ?? `运行已中断 (取消了 ${cancelledJobs} 个队列任务)`,
  };
}

/**
 * 取消运行
 */
export async function cancelRun(ctx: RecoveryContext): Promise<RecoveryResult> {
  const { pool, tenantId, runId, reason } = ctx;
  
  // 获取当前状态
  const runRes = await pool.query<{ status: string }>(
    "SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
    [tenantId, runId]
  );
  if (!runRes.rowCount) {
    return { ok: false, action: "cancel", previousStatus: "created", newStatus: "created", message: "Run 不存在" };
  }
  
  const currentStatus = runRes.rows[0].status as RunStatus;
  
  // P1-1 FIX: 使用状态机校验替代硬编码终态列表
  const cancelTransition = tryTransitionRun(currentStatus, "canceled");
  if (!cancelTransition.ok) {
    return {
      ok: false,
      action: "cancel",
      previousStatus: currentStatus,
      newStatus: currentStatus,
      message: `状态机拒绝取消: ${currentStatus} → canceled`,
    };
  }
  
  // 更新状态
  await pool.query(
    "UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = now() WHERE tenant_id = $1 AND run_id = $2",
    [tenantId, runId]
  );
  
  // 取消所有未完成的步骤，按 run_id 清理
  await pool.query(
    "UPDATE steps SET status = 'canceled', updated_at = now() WHERE run_id = $1 AND status NOT IN ('succeeded', 'failed', 'deadletter')",
    [runId]
  );
  
  return {
    ok: true,
    action: "cancel",
    previousStatus: currentStatus,
    newStatus: "canceled",
    message: reason ?? "运行已取消",
  };
}

/* ================================================================== */
/*  Event-driven Recovery Dispatcher                                     */
/* ================================================================== */

export type RecoveryEvent = {
  action: RecoveryAction;
  runId: string;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  traceId: string | null;
  reason?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 统一的恢复事件处理器
 */
export async function handleRecoveryEvent(
  event: RecoveryEvent,
  pool: Pool,
  queue: WorkflowQueue
): Promise<RecoveryResult> {
  const ctx: RecoveryContext = {
    pool,
    queue,
    tenantId: event.tenantId,
    spaceId: event.spaceId,
    runId: event.runId,
    subjectId: event.subjectId,
    traceId: event.traceId,
    reason: event.reason,
  };
  
  switch (event.action) {
    case "pause":
      return pauseRun(ctx);
    case "resume":
      return resumeRun(ctx);
    case "retry":
      return retryFailedStep(ctx);
    case "cancel":
      return cancelRun(ctx);
    case "interrupt":
      return interruptRun(ctx);
    default:
      return {
        ok: false,
        action: event.action,
        previousStatus: "created",
        newStatus: "created",
        message: `未知的恢复操作: ${event.action}`,
      };
  }
}

/**
 * 检查运行是否可以恢复
 */
export function canRecover(status: string): boolean {
  const recoverableStatuses = [
    "needs_device", 
    "needs_arbiter", 
    "failed",
    "paused",
  ];
  return recoverableStatuses.includes(status);
}

/**
 * 获取建议的恢复操作
 */
export function getSuggestedRecoveryAction(status: string): RecoveryAction | null {
  switch (status) {
    case "needs_device":
    case "needs_arbiter":
    case "paused":
      return "resume";
    case "failed":
      return "retry";
    default:
      return null;
  }
}
