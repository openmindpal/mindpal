/**
 * P1-2: 事件驱动恢复调度器
 *
 * 监听外部事件（审批完成、设备上线、Webhook 回调、定时恢复等），
 * 自动将对应的 run 从阻塞状态恢复到可执行状态。
 *
 * 调度流程:
 *   1. 外部事件通过 dispatchResumeEvent() 进入
 *   2. 根据事件类型匹配待恢复的 run
 *   3. 执行状态转换 + 审计记录
 *   4. 将恢复后的 step 重新入队执行
 *
 * 支持的事件类型:
 *   - approval.resolved   → needs_approval 恢复
 *   - device.online       → needs_device 恢复
 *   - arbiter.decided     → needs_arbiter 恢复
 *   - webhook.callback    → 任意阻塞态恢复
 *   - timer.expired       → paused 超时恢复
 *   - manual.resume       → 手动恢复
 */
import type { Pool } from "pg";
import type Redis from "ioredis";
import { safeTransitionRun, type RunStatus, StructuredLogger } from "@mindpal/shared";
import { acquireLock } from "../lib/distributedLock";

const _logger = new StructuredLogger({ module: 'worker:eventDrivenResume' });
import { writeAudit } from "./processor/audit";
import { 
  handleEmergencyStop, 
  handleSensorThreshold, 
  handleObstacleDetected, 
  handleForceAnomaly 
} from './fastEventHandlers';

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type ResumeEventType =
  | "approval.resolved"
  | "device.online"
  | "arbiter.decided"
  | "webhook.callback"
  | "timer.expired"
  | "manual.resume"
  // P0-3: 快速事件类型（<10ms 响应）
  | "sensor.threshold_exceeded"
  | "obstacle.detected"
  | "force.anomaly"
  | "emergency.stop";

export interface ResumeEvent {
  type: ResumeEventType;
  /** 事件来源标识（如 approvalId、deviceId、webhookId） */
  sourceId: string;
  /** 关联的 tenantId */
  tenantId: string;
  /** 关联的 spaceId */
  spaceId: string;
  /** 关联的 runId（可选，如果已知直接指定） */
  runId?: string;
  /** 关联的 stepId（可选） */
  stepId?: string;
  /** 触发者 */
  subjectId: string;
  /** 事件元数据 */
  payload?: Record<string, unknown>;
  /** 审批结果（仅 approval.resolved） */
  approvalDecision?: "approved" | "rejected" | "withdrawn";
  /** 追踪ID */
  traceId?: string;
}

export interface ResumeResult {
  ok: boolean;
  type: ResumeEventType;
  runId: string | null;
  previousStatus: string;
  newStatus: string;
  message: string;
  resumedStepId?: string;
  queuedJobId?: string;
}

/* ================================================================== */
/*  Status mapping: which event types can resume which run statuses     */
/* ================================================================== */

const EVENT_STATUS_MAP: Record<ResumeEventType, string[]> = {
  "approval.resolved": ["needs_approval", "paused"],
  "device.online": ["needs_device"],
  "arbiter.decided": ["needs_arbiter"],
  "webhook.callback": ["needs_approval", "needs_device", "needs_arbiter", "paused"],
  "timer.expired": ["paused"],
  "manual.resume": ["paused", "needs_approval", "needs_device", "needs_arbiter", "stopped"],
  // P0-3: 快速事件可以恢复的状态
  "sensor.threshold_exceeded": ["streaming", "running"],
  "obstacle.detected": ["streaming", "running", "needs_device"],
  "force.anomaly": ["streaming", "running"],
  "emergency.stop": ["streaming", "running", "paused"], // 紧急停止可以中断任何状态
};

/* ================================================================== */
/*  Core dispatcher                                                     */
/* ================================================================== */

/**
 * 主入口：处理恢复事件
 */
export async function dispatchResumeEvent(
  event: ResumeEvent,
  pool: Pool,
  enqueueJob: (params: { runId: string; stepId: string; jobId: string }) => Promise<void>,
  redis?: Redis,
): Promise<ResumeResult> {
  const { type, tenantId, spaceId, runId: explicitRunId, traceId } = event;

  // --- 幂等性检查 ---
  const idempotencyKey = `${type}:${event.sourceId ?? "none"}:${explicitRunId ?? "auto"}`;
  const targetRunId = explicitRunId ?? await findBlockedRunByEvent(pool, event);
  if (!targetRunId) {
    return {
      ok: false, type, runId: null,
      previousStatus: "", newStatus: "",
      message: "no_matching_run",
    };
  }

  const idempRes = await pool.query(
    `INSERT INTO resume_events (tenant_id, run_id, event_type, idempotency_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [tenantId, targetRunId, type, idempotencyKey],
  );
  if (idempRes.rowCount === 0) {
    return {
      ok: true, type, runId: targetRunId,
      previousStatus: "", newStatus: "",
      message: "duplicate_event_ignored",
    };
  }

  // 2. 获取当前状态
  const runRes = await pool.query<{ status: string; run_id: string }>(
    "SELECT status, run_id FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1",
    [tenantId, targetRunId],
  );
  if (!runRes.rowCount) {
    return {
      ok: false, type, runId: targetRunId,
      previousStatus: "unknown", newStatus: "unknown",
      message: `Run ${targetRunId} 不存在`,
    };
  }

  const currentStatus = String(runRes.rows[0].status);

  // 3. 校验事件类型是否匹配当前状态
  const allowedStatuses = EVENT_STATUS_MAP[type] ?? [];
  if (!allowedStatuses.includes(currentStatus)) {
    return {
      ok: false, type, runId: targetRunId,
      previousStatus: currentStatus, newStatus: currentStatus,
      message: `事件 ${type} 不能恢复状态为 ${currentStatus} 的 run`,
    };
  }

  // 4. 特殊处理：审批被拒绝
  if (type === "approval.resolved" && event.approvalDecision === "rejected") {
    await pool.query(
      "UPDATE runs SET status = 'failed', updated_at = now(), finished_at = now() WHERE tenant_id = $1 AND run_id = $2",
      [tenantId, targetRunId],
    );
    await writeResumeAudit(pool, event, targetRunId, currentStatus, "failed", "审批被拒绝，运行终止");
    return {
      ok: true, type, runId: targetRunId,
      previousStatus: currentStatus, newStatus: "failed",
      message: "审批被拒绝，运行已终止",
    };
  }

  // P0-3: 快速事件特殊处理 - 紧急停止
  if (type === "emergency.stop") {
    return handleEmergencyStop(pool, event, targetRunId, currentStatus);
  }

  // P0-3: 快速事件特殊处理 - 传感器阈值超限
  if (type === "sensor.threshold_exceeded") {
    return handleSensorThreshold(pool, event, targetRunId, currentStatus);
  }

  // P0-3: 快速事件特殊处理 - 障碍物检测
  if (type === "obstacle.detected") {
    return handleObstacleDetected(pool, event, targetRunId, currentStatus);
  }

  // P0-3: 快速事件特殊处理 - 力控异常
  if (type === "force.anomaly") {
    return handleForceAnomaly(pool, event, targetRunId, currentStatus);
  }

  // --- 分布式锁 ---
  const lockKey = `resume:${targetRunId}`;
  const lockValue = traceId ?? idempotencyKey;

  if (redis) {
    const lock = await acquireLock(redis, { lockKey, ttlMs: 30_000, acquireTimeoutMs: 0 });
    if (!lock) {
      return {
        ok: false, type, runId: targetRunId,
        previousStatus: currentStatus, newStatus: "",
        message: "concurrent_resume_blocked",
      };
    }
    try {
      return await executeResume(pool, event, targetRunId, currentStatus, enqueueJob);
    } finally {
      await lock.release();
    }
  }

  // 无 redis 时直接执行（向后兼容）
  return executeResume(pool, event, targetRunId, currentStatus, enqueueJob);
}

/**
 * 状态转换 + step 恢复 + 入队（提取为内部函数以便锁包裹）
 */
async function executeResume(
  pool: Pool,
  event: ResumeEvent,
  targetRunId: string,
  currentStatus: string,
  enqueueJob: (params: { runId: string; stepId: string; jobId: string }) => Promise<void>,
): Promise<ResumeResult> {
  const { type, tenantId } = event;

  // 5. P0-2 FIX: 恢复必须经过状态机校验，统一调用 safeTransitionRun
  const currentRunStatus = currentStatus as RunStatus;
  const targetStatus: RunStatus = "queued";
  const transitioned = await safeTransitionRun(pool, targetRunId, targetStatus, {
    tenantId,
    fromStatus: currentRunStatus,
    log: _logger,
  });
  if (!transitioned) {
    return {
      ok: false, type, runId: targetRunId,
      previousStatus: currentStatus, newStatus: currentStatus,
      message: `状态机拒绝转换: ${currentStatus} → ${targetStatus}`,
    };
  }

  // 6. 找到下一个待执行的 step 并入队
  const nextStep = await findNextPendingStep(pool, targetRunId);
  let resumedStepId: string | undefined;
  let queuedJobId: string | undefined;

  if (nextStep) {
    // 恢复 step 状态
    await pool.query(
      "UPDATE steps SET status = 'pending', updated_at = now() WHERE step_id = $1 AND status IN ('pending', 'paused', 'needs_approval', 'needs_device', 'needs_arbiter')",
      [nextStep.stepId],
    );
    // 恢复 job 状态
    if (nextStep.jobId) {
      await pool.query(
        "UPDATE jobs SET status = 'queued', updated_at = now() WHERE job_id = $1 AND status IN ('paused', 'needs_approval', 'needs_device', 'needs_arbiter')",
        [nextStep.jobId],
      );
      // 入队执行
      await enqueueJob({ runId: targetRunId, stepId: nextStep.stepId, jobId: nextStep.jobId });
      resumedStepId = nextStep.stepId;
      queuedJobId = nextStep.jobId;
    }
  }

  // 7. 审计记录
  await writeResumeAudit(pool, event, targetRunId, currentStatus, targetStatus, `恢复成功 (event: ${type})`);

  return {
    ok: true, type, runId: targetRunId,
    previousStatus: currentStatus, newStatus: targetStatus,
    message: `Run ${targetRunId} 已从 ${currentStatus} 恢复为 ${targetStatus}`,
    resumedStepId,
    queuedJobId,
  };
}

/* ================================================================== */
/*  Helpers                                                              */
/* ================================================================== */

/**
 * 根据事件信息查找被阻塞的 run
 */
async function findBlockedRunByEvent(pool: Pool, event: ResumeEvent): Promise<string | null> {
  const { type, tenantId, spaceId, sourceId } = event;

  if (type === "approval.resolved") {
    // P2-3 FIX: 通过 approvals 表关联查找，避免 LIKE 注入风险
    const res = await pool.query<{ run_id: string }>(
      `SELECT a.run_id FROM approvals a
       JOIN runs r ON r.run_id = a.run_id AND r.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1 AND a.approval_id = $2 AND r.status = 'needs_approval'
       LIMIT 1`,
      [tenantId, sourceId],
    );
    return res.rows[0]?.run_id ?? null;
  }

  if (type === "device.online") {
    // 查找等待该设备的 run
    const res = await pool.query<{ run_id: string }>(
      `SELECT run_id FROM runs
       WHERE tenant_id = $1 AND status = 'needs_device'
       ORDER BY updated_at ASC LIMIT 1`,
      [tenantId],
    );
    return res.rows[0]?.run_id ?? null;
  }

  if (type === "arbiter.decided") {
    const res = await pool.query<{ run_id: string }>(
      `SELECT run_id FROM runs
       WHERE tenant_id = $1 AND status = 'needs_arbiter'
       ORDER BY updated_at ASC LIMIT 1`,
      [tenantId],
    );
    return res.rows[0]?.run_id ?? null;
  }

  // webhook/timer/manual: 必须指定 runId
  return null;
}

/**
 * 找到 run 中下一个待执行的 step
 */
async function findNextPendingStep(
  pool: Pool,
  runId: string,
): Promise<{ stepId: string; jobId: string | null } | null> {
  const res = await pool.query<{ step_id: string; job_id: string | null }>(
    `SELECT s.step_id, j.job_id
     FROM steps s
     LEFT JOIN jobs j ON j.run_id = s.run_id AND j.step_id = s.step_id
     WHERE s.run_id = $1 AND s.status IN ('pending', 'paused', 'needs_approval', 'needs_device', 'needs_arbiter')
     ORDER BY s.seq ASC LIMIT 1`,
    [runId],
  );
  if (!res.rowCount) return null;
  return { stepId: res.rows[0].step_id, jobId: res.rows[0].job_id };
}

/**
 * 写入恢复操作审计事件
 */
async function writeResumeAudit(
  pool: Pool,
  event: ResumeEvent,
  runId: string,
  previousStatus: string,
  newStatus: string,
  message: string,
): Promise<void> {
  try {
    await writeAudit(pool, {
      traceId: event.traceId ?? `workflow.resume:${event.tenantId}:${runId}:${Date.now()}`,
      tenantId: event.tenantId,
      spaceId: event.spaceId ?? null,
      subjectId: event.subjectId,
      runId,
      stepId: event.stepId,
      resourceType: "workflow",
      action: "recovery.resume",
      result: "success",
      inputDigest: {
        eventType: event.type,
        sourceId: event.sourceId,
        runId,
        previousStatus,
        approvalDecision: event.approvalDecision ?? null,
      },
      outputDigest: { newStatus, message },
    });
  } catch (e) {
    _logger.warn("audit write failed", { err: (e as Error)?.message ?? e });
  }
}
