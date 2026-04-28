/**
 * P0-1: Agent Loop Checkpoint — 持久化自治调度器核心模块
 *
 * 职责：
 * 1. Checkpoint Writer — 每次迭代结束后 UPSERT 循环快照到 DB
 * 2. Heartbeat — 周期性更新 heartbeat_at，Supervisor 据此判断存活
 * 3. Restore — 从 checkpoint 反序列化循环状态，恢复主循环
 * 4. Process Table — 注册/更新/查询 Agent 进程
 *
 * 设计原则：
 * - 所有写操作幂等（UPSERT + ON CONFLICT）
 * - 状态序列化/反序列化完全自包含，不依赖进程内闭包
 * - 心跳间隔、超时阈值均通过环境变量动态配置，零硬编码
 */
import type { Pool } from "pg";
import type { StepObservation, AgentDecision, AgentLoopParams } from "./agentLoop";
import { resolveNumber } from "@openslin/shared";

/* ================================================================== */
/*  通用检查点接口                                                       */
/* ================================================================== */

/**
 * 通用检查点服务接口 — 统一 Agent Loop / 任务级 / 未来扩展场景的检查点访问契约。
 * 不强制底层存储方式：实现方可自由选择 DB 表、metadata 字段、Redis 等。
 */
export interface CheckpointService<T> {
  /** 写入（UPSERT 语义） */
  write(id: string, data: T): Promise<void>;
  /** 加载（返回 null 表示不存在） */
  load(id: string): Promise<T | null>;
  /** 启动心跳（不需要时可为空操作） */
  startHeartbeat(id: string, intervalMs?: number): void;
  /** 停止心跳 */
  stopHeartbeat(id: string): void;
  /** 尝试获取恢复锁（CAS 语义，返回是否成功） */
  acquireLock(id: string): Promise<boolean>;
}

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface CheckpointRow {
  loopId: string;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  jobId: string;
  taskId: string | null;
  iteration: number;
  currentSeq: number;
  succeededSteps: number;
  failedSteps: number;
  observationsDigest: StepObservation[];
  lastDecision: AgentDecision | null;
  decisionContext: Record<string, unknown>;
  goal: string;
  maxIterations: number;
  maxWallTimeMs: number;
  subjectPayload: Record<string, unknown>;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  defaultModelRef: string | null;
  toolDiscoveryCache: Record<string, unknown> | null;
  memoryContext: string | null;
  taskHistory: string | null;
  knowledgeContext: string | null;
  nodeId: string | null;
  status: CheckpointStatus;
  heartbeatAt: string;
  startedAt: string;
  finishedAt: string | null;
  resumedFrom: string | null;
  resumeCount: number;
}

export type CheckpointStatus =
  | "running"
  | "paused"
  | "resuming"
  | "succeeded"
  | "failed"
  | "interrupted"
  | "expired";

export interface ProcessRow {
  processId: string;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  loopId: string | null;
  priority: number;
  resourceQuota: Record<string, unknown>;
  parentProcessId: string | null;
  nodeId: string | null;
  status: string;
  heartbeatAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, unknown>;
}

/* ================================================================== */
/*  Config — 动态可配，零硬编码                                          */
/* ================================================================== */

/** 心跳间隔（毫秒），默认 10 秒 */
export function heartbeatIntervalMs(): number {
  return Math.max(3_000, resolveNumber("AGENT_LOOP_HEARTBEAT_INTERVAL_MS", undefined, undefined, 10_000).value);
}

/** Supervisor 判定超时阈值（毫秒），默认 60 秒 */
export function heartbeatTimeoutMs(): number {
  return Math.max(15_000, resolveNumber("AGENT_LOOP_HEARTBEAT_TIMEOUT_MS", undefined, undefined, 60_000).value);
}

/** 当前节点 ID（用于标识哪个进程持有循环） */
function currentNodeId(): string {
  return process.env.NODE_ID || process.env.HOSTNAME || `node-${process.pid}`;
}

/** full checkpoint 写入间隔（每 N 次迭代写一次完整检查点），默认 5 */
export const AGENT_LOOP_FULL_CHECKPOINT_INTERVAL = Math.max(1,
  parseInt(process.env.AGENT_LOOP_FULL_CHECKPOINT_INTERVAL || "5", 10) || 5);

/* ================================================================== */
/*  1. Checkpoint Writer                                                */
/* ================================================================== */

export interface WriteCheckpointParams {
  pool: Pool;
  loopId: string;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  jobId: string;
  taskId: string | null;
  iteration: number;
  currentSeq: number;
  succeededSteps: number;
  failedSteps: number;
  observations: StepObservation[];
  lastDecision: AgentDecision | null;
  goal: string;
  maxIterations: number;
  maxWallTimeMs: number;
  subjectPayload: Record<string, unknown>;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  defaultModelRef: string | null;
  decisionContext?: Record<string, unknown>;
  toolDiscoveryCache?: Record<string, unknown> | null;
  memoryContext?: string | null;
  taskHistory?: string | null;
  knowledgeContext?: string | null;
  status?: CheckpointStatus;
}

/**
 * UPSERT 检查点到 DB（幂等，同一 loopId 重复写入只更新）。
 * 每次迭代结束后调用，序列化当前循环全量状态。
 *
 * @param tier - "fast" 仅更新轻量计数字段（减少 IO）；"full" 完整 UPSERT（默认）
 */
export async function writeCheckpoint(
  params: WriteCheckpointParams,
  tier: "fast" | "full" = "full",
): Promise<void> {
  const status = params.status ?? "running";

  /* ── fast tier：轻量 UPDATE，仅刷新计数/状态/心跳 ── */
  if (tier === "fast") {
    await params.pool.query(
      `UPDATE agent_loop_checkpoints
       SET iteration = $2, current_seq = $3, succeeded_steps = $4, failed_steps = $5,
           status = $6, heartbeat_at = now(), updated_at = now()
       WHERE loop_id = $1`,
      [
        params.loopId, params.iteration, params.currentSeq,
        params.succeededSteps, params.failedSteps, status,
      ],
    );
    return;
  }

  /* ── full tier：完整 UPSERT ── */
  const nodeId = currentNodeId();

  // 裁剪 observations 为摘要（保留最近 50 条，避免 JSONB 过大）
  const maxObsToStore = Math.max(10, resolveNumber("AGENT_LOOP_MAX_OBS_CHECKPOINT", undefined, undefined, 50).value);
  const obsDigest = params.observations.length > maxObsToStore
    ? params.observations.slice(-maxObsToStore)
    : params.observations;

  await params.pool.query(
    `INSERT INTO agent_loop_checkpoints (
      loop_id, tenant_id, space_id, run_id, job_id, task_id,
      iteration, current_seq, succeeded_steps, failed_steps,
      observations_digest, last_decision, decision_context,
      goal, max_iterations, max_wall_time_ms,
      subject_payload, locale, "authorization", trace_id, default_model_ref,
      tool_discovery_cache, memory_context, task_history, knowledge_context,
      node_id, status, heartbeat_at, updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,
      $11,$12,$13,
      $14,$15,$16,
      $17,$18,$19,$20,$21,
      $22,$23,$24,$25,
      $26,$27,now(),now()
    )
    ON CONFLICT (loop_id) DO UPDATE SET
      iteration = EXCLUDED.iteration,
      current_seq = EXCLUDED.current_seq,
      succeeded_steps = EXCLUDED.succeeded_steps,
      failed_steps = EXCLUDED.failed_steps,
      observations_digest = EXCLUDED.observations_digest,
      last_decision = EXCLUDED.last_decision,
      decision_context = EXCLUDED.decision_context,
      tool_discovery_cache = EXCLUDED.tool_discovery_cache,
      memory_context = EXCLUDED.memory_context,
      task_history = EXCLUDED.task_history,
      knowledge_context = EXCLUDED.knowledge_context,
      node_id = EXCLUDED.node_id,
      status = EXCLUDED.status,
      heartbeat_at = now(),
      updated_at = now()`,
    [
      params.loopId, params.tenantId, params.spaceId, params.runId, params.jobId, params.taskId,
      params.iteration, params.currentSeq, params.succeededSteps, params.failedSteps,
      JSON.stringify(obsDigest), params.lastDecision ? JSON.stringify(params.lastDecision) : null, JSON.stringify(params.decisionContext ?? {}),
      params.goal, params.maxIterations, params.maxWallTimeMs,
      JSON.stringify(params.subjectPayload), params.locale, params.authorization, params.traceId, params.defaultModelRef,
      params.toolDiscoveryCache ? JSON.stringify(params.toolDiscoveryCache) : null,
      params.memoryContext ?? null, params.taskHistory ?? null, params.knowledgeContext ?? null,
      nodeId, status,
    ],
  );
}

/**
 * 更新检查点状态（终止时调用：succeeded / failed / interrupted）。
 */
export async function finalizeCheckpoint(
  pool: Pool,
  loopId: string,
  status: CheckpointStatus,
): Promise<void> {
  await pool.query(
    `UPDATE agent_loop_checkpoints
     SET status = $2, finished_at = now(), heartbeat_at = now(), updated_at = now()
     WHERE loop_id = $1`,
    [loopId, status],
  );
}

/* ================================================================== */
/*  2. Heartbeat                                                        */
/* ================================================================== */

/**
 * 启动心跳定时器，返回 stop 函数。
 * Agent Loop 在主循环中调用 start，循环结束时调用 stop。
 */
export function startHeartbeat(pool: Pool, loopId: string): { stop: () => void } {
  const intervalMs = heartbeatIntervalMs();
  const timer = setInterval(() => {
    pool.query(
      "UPDATE agent_loop_checkpoints SET heartbeat_at = now(), updated_at = now() WHERE loop_id = $1 AND status IN ('running','resuming')",
      [loopId],
    ).catch(() => { /* 心跳写入失败不阻塞主循环 */ });
  }, intervalMs);
  timer.unref(); // 不阻止进程退出

  return {
    stop: () => clearInterval(timer),
  };
}

/* ================================================================== */
/*  3. Restore — 从 checkpoint 恢复循环状态                              */
/* ================================================================== */

/**
 * 从 DB 加载指定 loopId 的检查点。
 */
export async function loadCheckpoint(pool: Pool, loopId: string): Promise<CheckpointRow | null> {
  const res = await pool.query<{
    loop_id: string;
    tenant_id: string;
    space_id: string | null;
    run_id: string;
    job_id: string;
    task_id: string | null;
    iteration: number;
    current_seq: number;
    succeeded_steps: number;
    failed_steps: number;
    observations_digest: any;
    last_decision: any;
    decision_context: any;
    goal: string;
    max_iterations: number;
    max_wall_time_ms: string; /* BIGINT → string in pg */
    subject_payload: any;
    locale: string;
    authorization: string | null;
    trace_id: string | null;
    default_model_ref: string | null;
    tool_discovery_cache: any;
    memory_context: string | null;
    task_history: string | null;
    knowledge_context: string | null;
    node_id: string | null;
    status: string;
    heartbeat_at: string;
    started_at: string;
    finished_at: string | null;
    resumed_from: string | null;
    resume_count: number;
  }>(
    "SELECT * FROM agent_loop_checkpoints WHERE loop_id = $1",
    [loopId],
  );

  if (!res.rowCount || !res.rows[0]) return null;
  const r = res.rows[0];
  return {
    loopId: r.loop_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    runId: r.run_id,
    jobId: r.job_id,
    taskId: r.task_id,
    iteration: r.iteration,
    currentSeq: r.current_seq,
    succeededSteps: r.succeeded_steps,
    failedSteps: r.failed_steps,
    observationsDigest: Array.isArray(r.observations_digest) ? r.observations_digest : [],
    lastDecision: r.last_decision ?? null,
    decisionContext: r.decision_context ?? {},
    goal: r.goal,
    maxIterations: r.max_iterations,
    maxWallTimeMs: Number(r.max_wall_time_ms),
    subjectPayload: r.subject_payload ?? {},
    locale: r.locale,
    authorization: r.authorization,
    traceId: r.trace_id,
    defaultModelRef: r.default_model_ref,
    toolDiscoveryCache: r.tool_discovery_cache ?? null,
    memoryContext: r.memory_context,
    taskHistory: r.task_history,
    knowledgeContext: r.knowledge_context,
    nodeId: r.node_id,
    status: r.status as CheckpointStatus,
    heartbeatAt: r.heartbeat_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    resumedFrom: r.resumed_from,
    resumeCount: r.resume_count,
  };
}

/**
 * 将检查点标记为 resuming，增加 resume_count，更新 node_id。
 * 返回是否成功获取恢复锁（通过 CAS 防止两个 Supervisor 并发恢复同一循环）。
 */
export async function acquireResumeLock(
  pool: Pool,
  loopId: string,
  expectedStatus: CheckpointStatus = "running",
): Promise<boolean> {
  const maxRetries = Math.max(1, resolveNumber("AGENT_LOOP_RESUME_LOCK_RETRIES", undefined, undefined, 3).value);
  const nodeId = currentNodeId();
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.min(500 * Math.pow(2, attempt - 1), 4000)));
    }
    const res = await pool.query(
      `UPDATE agent_loop_checkpoints
       SET status = 'resuming',
           node_id = $2,
           resume_count = resume_count + 1,
           heartbeat_at = now(),
           updated_at = now()
       WHERE loop_id = $1
         AND status = $3
       RETURNING loop_id`,
      [loopId, nodeId, expectedStatus],
    );
    if ((res.rowCount ?? 0) > 0) return true;
  }
  return false;
}

/**
 * 查找所有心跳超时的活跃检查点（Supervisor 扫描用）。
 */
export async function findExpiredCheckpoints(pool: Pool): Promise<Array<{ loopId: string; runId: string; tenantId: string; resumeCount: number }>> {
  const timeoutMs = heartbeatTimeoutMs();
  const maxResumes = Math.max(1, resolveNumber("AGENT_LOOP_MAX_RESUMES", undefined, undefined, 3).value);
  const res = await pool.query<{
    loop_id: string;
    run_id: string;
    tenant_id: string;
    resume_count: number;
  }>(
    `SELECT loop_id, run_id, tenant_id, resume_count
     FROM agent_loop_checkpoints
     WHERE status IN ('running', 'resuming')
       AND heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
       AND resume_count < $2
     ORDER BY heartbeat_at ASC
     LIMIT 20`,
    [timeoutMs, maxResumes],
  );
  return res.rows.map(r => ({
    loopId: r.loop_id,
    runId: r.run_id,
    tenantId: r.tenant_id,
    resumeCount: r.resume_count,
  }));
}

/**
 * 将超过最大恢复次数的检查点标记为 expired（永久终止）。
 */
export async function expireStaleCheckpoints(pool: Pool): Promise<number> {
  const maxResumes = Math.max(1, resolveNumber("AGENT_LOOP_MAX_RESUMES", undefined, undefined, 3).value);
  const timeoutMs = heartbeatTimeoutMs();
  const res = await pool.query(
    `UPDATE agent_loop_checkpoints
     SET status = 'expired', finished_at = now(), updated_at = now()
     WHERE status IN ('running', 'resuming')
       AND heartbeat_at < now() - ($1::bigint * interval '1 millisecond')
       AND resume_count >= $2
     RETURNING loop_id`,
    [timeoutMs, maxResumes],
  );
  return res.rowCount ?? 0;
}

/* ================================================================== */
/*  4. Agent Process Table                                              */
/* ================================================================== */

export interface RegisterProcessParams {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  runId: string;
  loopId: string | null;
  priority?: number;
  resourceQuota?: Record<string, unknown>;
  parentProcessId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * 注册新的 Agent 进程。
 */
export async function registerProcess(params: RegisterProcessParams): Promise<string> {
  const nodeId = currentNodeId();
  const priority = params.priority ?? 5;
  const res = await params.pool.query<{ process_id: string }>(
    `INSERT INTO agent_processes (
      tenant_id, space_id, run_id, loop_id,
      priority, resource_quota, parent_process_id,
      node_id, status, started_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',now())
    RETURNING process_id`,
    [
      params.tenantId, params.spaceId, params.runId, params.loopId,
      priority, JSON.stringify(params.resourceQuota ?? {}),
      params.parentProcessId ?? null, nodeId,
    ],
  );
  return res.rows[0].process_id;
}

/**
 * 更新进程状态。
 */
export async function updateProcessStatus(
  pool: Pool,
  processId: string,
  status: string,
): Promise<void> {
  const finishedClause = ["succeeded", "failed", "interrupted", "preempted"].includes(status)
    ? ", finished_at = now()"
    : "";
  await pool.query(
    `UPDATE agent_processes SET status = $2, heartbeat_at = now(), updated_at = now()${finishedClause} WHERE process_id = $1`,
    [processId, status],
  );
}

/**
 * 查询指定 run 的活跃进程。
 */
/* ================================================================== */
/*  5. Agent Process Table                                              */
/* ================================================================== */

export async function findActiveProcess(pool: Pool, runId: string): Promise<ProcessRow | null> {
  const res = await pool.query<{
    process_id: string; tenant_id: string; space_id: string | null;
    run_id: string; loop_id: string | null; priority: number;
    resource_quota: any; parent_process_id: string | null;
    node_id: string | null; status: string; heartbeat_at: string;
    started_at: string | null; finished_at: string | null; metadata: any;
  }>(
    `SELECT * FROM agent_processes
     WHERE run_id = $1 AND status IN ('pending','running','paused')
     ORDER BY created_at DESC LIMIT 1`,
    [runId],
  );
  if (!res.rowCount || !res.rows[0]) return null;
  const r = res.rows[0];
  return {
    processId: r.process_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id,
    runId: r.run_id,
    loopId: r.loop_id,
    priority: r.priority,
    resourceQuota: r.resource_quota ?? {},
    parentProcessId: r.parent_process_id,
    nodeId: r.node_id,
    status: r.status,
    heartbeatAt: r.heartbeat_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    metadata: r.metadata ?? {},
  };
}
