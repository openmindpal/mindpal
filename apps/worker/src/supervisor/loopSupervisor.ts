/**
 * P0-1: Loop Supervisor — Agent Loop 持久化调度器
 *
 * 职责：
 * - 定期扫描心跳超时的 agent_loop_checkpoints
 * - 超时但未超过最大恢复次数 → 通过 BullMQ 发送恢复任务
 * - 超时且已超过最大恢复次数 → 标记为 expired，同时标记 run 为 failed
 *
 * 运行在 Worker 进程中，作为独立定时任务，与现有 tickXxx 模式一致。
 * 自包含 DB 查询逻辑，不依赖 API 层 import。
 */
import type { Pool } from "pg";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:loopSupervisor" });

/* ───── 动态配置，零硬编码 ───── */

function heartbeatTimeoutMs(): number {
  return Math.max(15_000, Number(process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS) || 60_000);
}

function maxResumes(): number {
  return Math.max(1, Number(process.env.AGENT_LOOP_MAX_RESUMES) || 3);
}

/* ───── Types ───── */

export interface LoopSupervisorDeps {
  pool: Pool;
  /** 可选：BullMQ Queue，用于发送恢复任务到执行队列 */
  queue?: { add: (name: string, data: any, opts?: any) => Promise<any> };
}

interface ExpiredCheckpoint {
  loopId: string;
  runId: string;
  tenantId: string;
  resumeCount: number;
}

interface CheckpointPayload {
  loopId: string;
  runId: string;
  jobId: string;
  taskId: string | null;
  tenantId: string;
  spaceId: string | null;
  goal: string;
  maxIterations: number;
  maxWallTimeMs: number;
  subjectPayload: Record<string, unknown>;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  defaultModelRef: string | null;
  decisionContext: Record<string, unknown>;
  iteration: number;
  currentSeq: number;
  succeededSteps: number;
  failedSteps: number;
  observationsDigest: any;
  lastDecision: any;
  toolDiscoveryCache: any;
  memoryContext: string | null;
  taskHistory: string | null;
  knowledgeContext: string | null;
  resumeCount: number;
}

/* ───── DB 操作（自包含，不依赖 API 层） ───── */

async function findExpiredCheckpoints(pool: Pool): Promise<ExpiredCheckpoint[]> {
  const timeoutMs = heartbeatTimeoutMs();
  const maxR = maxResumes();
  const res = await pool.query<{
    loop_id: string; run_id: string; tenant_id: string; resume_count: number;
  }>(
    `SELECT loop_id, run_id, tenant_id, resume_count
     FROM agent_loop_checkpoints
     WHERE status IN ('running', 'resuming')
       AND heartbeat_at < now() - ($1 || ' milliseconds')::interval
       AND resume_count < $2
     ORDER BY heartbeat_at ASC
     LIMIT 20`,
    [timeoutMs, maxR],
  );
  return res.rows.map(r => ({
    loopId: r.loop_id, runId: r.run_id, tenantId: r.tenant_id, resumeCount: r.resume_count,
  }));
}

async function expireStaleCheckpoints(pool: Pool): Promise<number> {
  const timeoutMs = heartbeatTimeoutMs();
  const maxR = maxResumes();
  const res = await pool.query(
    `UPDATE agent_loop_checkpoints
     SET status = 'expired', finished_at = now(), updated_at = now()
     WHERE status IN ('running', 'resuming')
       AND heartbeat_at < now() - ($1 || ' milliseconds')::interval
       AND resume_count >= $2
     RETURNING loop_id`,
    [timeoutMs, maxR],
  );
  return res.rowCount ?? 0;
}

async function acquireResumeLock(pool: Pool, loopId: string): Promise<boolean> {
  const nodeId = process.env.NODE_ID || process.env.HOSTNAME || `node-${process.pid}`;
  const res = await pool.query(
    `UPDATE agent_loop_checkpoints
     SET status = 'resuming', node_id = $2, resume_count = resume_count + 1, heartbeat_at = now(), updated_at = now()
     WHERE loop_id = $1 AND status = 'running'
     RETURNING loop_id`,
    [loopId, nodeId],
  );
  return (res.rowCount ?? 0) > 0;
}

async function loadCheckpoint(pool: Pool, loopId: string): Promise<CheckpointPayload | null> {
  const res = await pool.query(
    "SELECT * FROM agent_loop_checkpoints WHERE loop_id = $1",
    [loopId],
  );
  if (!res.rowCount || !res.rows[0]) return null;
  const r = res.rows[0] as any;
  return {
    loopId: r.loop_id,
    runId: r.run_id,
    jobId: r.job_id,
    taskId: r.task_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    goal: r.goal,
    maxIterations: r.max_iterations,
    maxWallTimeMs: Number(r.max_wall_time_ms),
    subjectPayload: r.subject_payload ?? {},
    locale: r.locale,
    authorization: r.authorization,
    traceId: r.trace_id,
    defaultModelRef: r.default_model_ref,
    decisionContext: r.decision_context ?? {},
    iteration: r.iteration,
    currentSeq: r.current_seq,
    succeededSteps: r.succeeded_steps,
    failedSteps: r.failed_steps,
    observationsDigest: r.observations_digest ?? [],
    lastDecision: r.last_decision,
    toolDiscoveryCache: r.tool_discovery_cache,
    memoryContext: r.memory_context,
    taskHistory: r.task_history,
    knowledgeContext: r.knowledge_context,
    resumeCount: r.resume_count,
  };
}

/* ───── Supervisor Tick ───── */

/**
 * 单次 Supervisor tick。
 * Worker 的 setInterval 会周期性调用此函数。
 */
export async function tickLoopSupervisor(deps: LoopSupervisorDeps): Promise<void> {
  const { pool, queue } = deps;

  // 1. 清理超过最大恢复次数的过期检查点
  const expiredCount = await expireStaleCheckpoints(pool);
  if (expiredCount > 0) {
    _logger.info("expired stale checkpoints", { count: expiredCount });
    // 同步标记对应 runs 为 failed
    await pool.query(
      `UPDATE runs SET status = 'failed', finished_at = COALESCE(finished_at, now()), updated_at = now()
       WHERE run_id IN (
         SELECT run_id FROM agent_loop_checkpoints WHERE status = 'expired' AND finished_at > now() - interval '1 minute'
       ) AND status NOT IN ('succeeded','failed','stopped','canceled')`,
    ).catch((e) => _logger.error("update expired runs failed", { err: (e as Error)?.message ?? e }));
  }

  // 2. 查找心跳超时但可恢复的检查点
  const expired = await findExpiredCheckpoints(pool);
  if (expired.length === 0) return;

  _logger.info("found heartbeat-expired checkpoints", { count: expired.length });

  for (const { loopId, runId, resumeCount } of expired) {
    // CAS 获取恢复锁（防止多个 Supervisor 并发恢复同一循环）
    const acquired = await acquireResumeLock(pool, loopId);
    if (!acquired) continue;

    _logger.info("resuming loop", { loopId, runId, resumeCount: resumeCount + 1 });

    // 加载完整 checkpoint
    const cp = await loadCheckpoint(pool, loopId);
    if (!cp) {
      _logger.error("checkpoint load failed, marking as failed", { loopId });
      await pool.query(
        "UPDATE agent_loop_checkpoints SET status = 'failed', finished_at = now(), updated_at = now() WHERE loop_id = $1",
        [loopId],
      ).catch(() => {});
      continue;
    }

    if (queue) {
      // 通过 BullMQ 队列分发恢复任务
      try {
        await queue.add("loop_resume", {
          loopId: cp.loopId,
          runId: cp.runId,
          jobId: cp.jobId,
          taskId: cp.taskId,
          tenantId: cp.tenantId,
          spaceId: cp.spaceId,
          goal: cp.goal,
          maxIterations: cp.maxIterations,
          maxWallTimeMs: cp.maxWallTimeMs,
          subjectPayload: cp.subjectPayload,
          locale: cp.locale,
          authorization: cp.authorization,
          traceId: cp.traceId,
          defaultModelRef: cp.defaultModelRef,
          executionConstraints: (cp.decisionContext as any)?.executionConstraints ?? null,
          resumeState: {
            iteration: cp.iteration,
            currentSeq: cp.currentSeq,
            succeededSteps: cp.succeededSteps,
            failedSteps: cp.failedSteps,
            observations: cp.observationsDigest,
            lastDecision: cp.lastDecision,
            toolDiscoveryCache: cp.toolDiscoveryCache,
            memoryContext: cp.memoryContext,
            taskHistory: cp.taskHistory,
            knowledgeContext: cp.knowledgeContext,
          },
        }, {
          jobId: `loop_resume:${loopId}:${cp.resumeCount}`,
          removeOnComplete: true,
          removeOnFail: 3,
        });
        _logger.info("resume job enqueued", { loopId });
      } catch (e: any) {
        _logger.error("resume job enqueue failed", { loopId, err: e?.message });
        // 回退状态，让下次 tick 重试
        await pool.query(
          "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1",
          [loopId],
        ).catch(() => {});
      }
    } else {
      _logger.warn("no queue available, cannot resume", { loopId });
      await pool.query(
        "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1",
        [loopId],
      ).catch(() => {});
    }
  }
}
