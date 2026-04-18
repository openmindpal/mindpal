/**
 * Task Queue Repository — 数据库 CRUD 操作层
 *
 * 纯数据库操作，不含业务逻辑。
 * 所有方法均接受 Pool 参数，支持事务注入。
 */
import type { Pool, PoolClient } from "pg";
import {
  type TaskQueueEntry, type TaskDependency, type QueueEntryStatus, type DepType, type DepSource,
  rowToQueueEntry, rowToDependency, TERMINAL_QUEUE_STATUSES,
} from "./taskQueue.types";

type DbConn = Pool | PoolClient;
export type QueueEntryScope = {
  tenantId: string;
  spaceId?: string | null;
  sessionId?: string | null;
};

function appendQueueEntryScope(
  clauses: string[],
  params: unknown[],
  scope?: QueueEntryScope,
  alias = "",
) {
  if (!scope) return;
  const prefix = alias ? `${alias}.` : "";
  params.push(scope.tenantId);
  clauses.push(`${prefix}tenant_id = $${params.length}`);
  if (Object.prototype.hasOwnProperty.call(scope, "spaceId")) {
    params.push(scope.spaceId ?? null);
    clauses.push(`((${prefix}space_id = $${params.length}) OR (${prefix}space_id IS NULL AND $${params.length} IS NULL))`);
  }
  if (Object.prototype.hasOwnProperty.call(scope, "sessionId")) {
    params.push(scope.sessionId ?? null);
    clauses.push(`((${prefix}session_id = $${params.length}) OR (${prefix}session_id IS NULL AND $${params.length} IS NULL))`);
  }
}

/* ================================================================== */
/*  入队 / 出队                                                         */
/* ================================================================== */

/** 入队：插入新条目，position 自动取当前会话最大值 +1 */
export async function insertQueueEntry(db: DbConn, params: {
  tenantId: string;
  spaceId?: string | null;
  sessionId: string;
  goal: string;
  mode: string;
  priority?: number;
  foreground?: boolean;
  createdBySubjectId: string;
  taskId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  estimatedDurationMs?: number | null;
  metadata?: Record<string, unknown> | null;
}): Promise<TaskQueueEntry> {
  const {
    tenantId, spaceId, sessionId, goal, mode,
    priority = 50, foreground = true, createdBySubjectId,
    taskId, runId, jobId, estimatedDurationMs, metadata,
  } = params;

  const res = await db.query(
    `INSERT INTO session_task_queue
       (tenant_id, space_id, session_id, goal, mode, priority, foreground,
        created_by_subject_id, task_id, run_id, job_id, estimated_duration_ms, metadata,
        position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
       COALESCE((SELECT MAX(position) + 1 FROM session_task_queue
                 WHERE tenant_id = $1 AND session_id = $3
                   AND status NOT IN ('completed','failed','cancelled')), 0))
     RETURNING *`,
    [tenantId, spaceId || null, sessionId, goal, mode, priority, foreground,
     createdBySubjectId, taskId || null, runId || null, jobId || null,
     estimatedDurationMs || null, metadata ? JSON.stringify(metadata) : null],
  );
  return rowToQueueEntry(res.rows[0]);
}

/* ================================================================== */
/*  状态更新                                                            */
/* ================================================================== */

/** 更新队列条目状态（动态参数编号，避免 $N 错位） */
export async function updateEntryStatus(db: DbConn, params: {
  entryId: string;
  status: QueueEntryStatus;
  lastError?: string | null;
  checkpointRef?: string | null;
  scope?: QueueEntryScope;
}): Promise<TaskQueueEntry | null> {
  const { entryId, status, lastError, checkpointRef, scope } = params;

  // 根据状态自动设置时间戳
  let tsField = "";
  if (status === "ready") tsField = ", ready_at = now()";
  else if (status === "executing") tsField = ", started_at = now()";
  else if (TERMINAL_QUEUE_STATUSES.has(status)) tsField = ", completed_at = now()";

  // 动态构建参数列表，避免 $3/$4 硬编码导致参数错位
  const queryParams: unknown[] = [entryId, status];
  let extras = tsField;
  if (lastError !== undefined) {
    queryParams.push(lastError);
    extras += `, last_error = $${queryParams.length}`;
  }
  if (checkpointRef !== undefined) {
    queryParams.push(checkpointRef);
    extras += `, checkpoint_ref = $${queryParams.length}`;
  }

  const whereClauses = ["entry_id = $1"];
  appendQueueEntryScope(whereClauses, queryParams, scope);
  const res = await db.query(
    `UPDATE session_task_queue
     SET status = $2
         ${extras}
     WHERE ${whereClauses.join(" AND ")}
     RETURNING *`,
    queryParams,
  );
  return res.rowCount ? rowToQueueEntry(res.rows[0]) : null;
}

/** 更新 task_id 和 run_id（任务创建后回填） */

/** 增加重试次数 */
export async function incrementRetry(db: DbConn, entryId: string, lastError: string): Promise<TaskQueueEntry | null> {
  const res = await db.query(
    `UPDATE session_task_queue
     SET retry_count = retry_count + 1, last_error = $2, status = 'queued'
     WHERE entry_id = $1
     RETURNING *`,
    [entryId, lastError],
  );
  return res.rowCount ? rowToQueueEntry(res.rows[0]) : null;
}

/** 设置前台/后台 */
export async function updateForeground(db: DbConn, entryId: string, foreground: boolean, scope?: QueueEntryScope): Promise<TaskQueueEntry | null> {
  const queryParams: unknown[] = [entryId, foreground];
  const whereClauses = ["entry_id = $1"];
  appendQueueEntryScope(whereClauses, queryParams, scope);
  const res = await db.query(
    `UPDATE session_task_queue SET foreground = $2 WHERE ${whereClauses.join(" AND ")} RETURNING *`,
    queryParams,
  );
  return res.rowCount ? rowToQueueEntry(res.rows[0]) : null;
}

/** 更新优先级 */
export async function updatePriority(db: DbConn, entryId: string, priority: number, scope?: QueueEntryScope): Promise<TaskQueueEntry | null> {
  const queryParams: unknown[] = [priority, entryId];
  const whereClauses = ["entry_id = $2"];
  appendQueueEntryScope(whereClauses, queryParams, scope);
  const res = await db.query(
    `UPDATE session_task_queue SET priority = $1 WHERE ${whereClauses.join(" AND ")} RETURNING *`,
    queryParams,
  );
  return res.rowCount ? rowToQueueEntry(res.rows[0]) : null;
}

/* ================================================================== */
/*  查询                                                               */
/* ================================================================== */

/** 获取单个条目 */
export async function getEntry(db: DbConn, entryId: string, scope?: QueueEntryScope): Promise<TaskQueueEntry | null> {
  const queryParams: unknown[] = [entryId];
  const whereClauses = ["entry_id = $1"];
  appendQueueEntryScope(whereClauses, queryParams, scope);
  const res = await db.query(
    `SELECT * FROM session_task_queue WHERE ${whereClauses.join(" AND ")}`,
    queryParams,
  );
  return res.rowCount ? rowToQueueEntry(res.rows[0]) : null;
}


/** 获取会话的全部非终态队列条目（按 position 排序） */
export async function listActiveEntries(db: DbConn, tenantId: string, sessionId: string): Promise<TaskQueueEntry[]> {
  const res = await db.query(
    `SELECT * FROM session_task_queue
     WHERE tenant_id = $1 AND session_id = $2
       AND status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY position ASC`,
    [tenantId, sessionId],
  );
  return res.rows.map(rowToQueueEntry);
}


/** 获取会话中正在执行的任务数 */
export async function countExecuting(db: DbConn, tenantId: string, sessionId: string): Promise<number> {
  const res = await db.query(
    `SELECT COUNT(*) AS cnt FROM session_task_queue
     WHERE tenant_id = $1 AND session_id = $2 AND status = 'executing'`,
    [tenantId, sessionId],
  );
  return Number(res.rows[0].cnt);
}


/** 获取会话中所有可调度的条目 */
export async function listSchedulable(db: DbConn, tenantId: string, sessionId: string): Promise<TaskQueueEntry[]> {
  const res = await db.query(
    `SELECT * FROM session_task_queue
     WHERE tenant_id = $1 AND session_id = $2
       AND status IN ('queued', 'ready')
     ORDER BY priority ASC, enqueued_at ASC`,
    [tenantId, sessionId],
  );
  return res.rows.map(rowToQueueEntry);
}

/* ================================================================== */
/*  Reorder（手动排序）                                                  */
/* ================================================================== */

/** 将条目移动到指定位置 */
export async function reorderEntry(db: DbConn, entryId: string, newPosition: number, scope?: QueueEntryScope): Promise<void> {
  // 获取当前条目信息
  const entry = await getEntry(db, entryId, scope);
  if (!entry) return;

  const oldPos = entry.position;
  if (oldPos === newPosition) return;

  if (newPosition > oldPos) {
    // 向后移动：中间条目 position -1
    await db.query(
      `UPDATE session_task_queue
       SET position = position - 1
       WHERE tenant_id = $1 AND session_id = $2
         AND position > $3 AND position <= $4
         AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [entry.tenantId, entry.sessionId, oldPos, newPosition],
    );
  } else {
    // 向前移动：中间条目 position +1
    await db.query(
      `UPDATE session_task_queue
       SET position = position + 1
       WHERE tenant_id = $1 AND session_id = $2
         AND position >= $3 AND position < $4
         AND status NOT IN ('completed', 'failed', 'cancelled')`,
      [entry.tenantId, entry.sessionId, newPosition, oldPos],
    );
  }

  const queryParams: unknown[] = [entryId, newPosition];
  const whereClauses = ["entry_id = $1"];
  appendQueueEntryScope(whereClauses, queryParams, scope);
  await db.query(
    `UPDATE session_task_queue SET position = $2 WHERE ${whereClauses.join(" AND ")}`,
    queryParams,
  );
}

/* ================================================================== */
/*  批量操作                                                            */
/* ================================================================== */

/** 批量取消会话中所有非终态任务 */
export async function cancelAllActive(db: DbConn, tenantId: string, sessionId: string): Promise<number> {
  const res = await db.query(
    `UPDATE session_task_queue
     SET status = 'cancelled', completed_at = now()
     WHERE tenant_id = $1 AND session_id = $2
       AND status NOT IN ('completed', 'failed', 'cancelled')
     RETURNING entry_id`,
    [tenantId, sessionId],
  );
  return res.rowCount || 0;
}

/**
 * P3-15: 获取全局所有正在执行的任务（优雅关闭用）
 * 不限制租户或会话，返回所有 executing + ready 状态的条目。
 */
export async function listGlobalActiveEntries(db: DbConn): Promise<TaskQueueEntry[]> {
  const res = await db.query(
    `SELECT * FROM session_task_queue
     WHERE status IN ('executing', 'ready', 'queued')
     ORDER BY tenant_id, session_id, position`,
  );
  return res.rows.map(rowToQueueEntry);
}

/**
 * P3-15: 批量暂停并写入 checkpoint（优雅关闭用）
 * 将所有非终态任务设为 paused 状态并写入 checkpoint_ref。
 * 返回被暂停的任务数。
 */
export async function batchPauseForShutdown(db: DbConn, checkpointRef: string): Promise<number> {
  const res = await db.query(
    `UPDATE session_task_queue
     SET status = 'paused', checkpoint_ref = $1
     WHERE status IN ('executing', 'ready', 'queued')
     RETURNING entry_id`,
    [checkpointRef],
  );
  return res.rowCount || 0;
}

/* ================================================================== */
/*  依赖关系 CRUD                                                       */
/* ================================================================== */

/** 创建依赖关系 */
export async function insertDependency(db: DbConn, params: {
  tenantId: string;
  sessionId: string;
  fromEntryId: string;
  toEntryId: string;
  depType: DepType;
  source?: DepSource;
  outputMapping?: Record<string, string> | null;
}): Promise<TaskDependency> {
  const { tenantId, sessionId, fromEntryId, toEntryId, depType, source = "auto", outputMapping } = params;
  const res = await db.query(
    `INSERT INTO task_dependencies
       (tenant_id, session_id, from_entry_id, to_entry_id, dep_type, source, output_mapping)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (from_entry_id, to_entry_id) DO UPDATE
       SET dep_type = EXCLUDED.dep_type, source = EXCLUDED.source,
           output_mapping = EXCLUDED.output_mapping, updated_at = now()
     RETURNING *`,
    [tenantId, sessionId, fromEntryId, toEntryId, depType, source,
     outputMapping ? JSON.stringify(outputMapping) : null],
  );
  return rowToDependency(res.rows[0]);
}

/** 获取条目的所有前置依赖（"我依赖谁"） */
export async function getDependenciesOf(db: DbConn, entryId: string): Promise<TaskDependency[]> {
  const res = await db.query(
    `SELECT * FROM task_dependencies WHERE from_entry_id = $1 ORDER BY created_at`,
    [entryId],
  );
  return res.rows.map(rowToDependency);
}

/** 获取条目的所有后继依赖（"谁依赖我"） */
export async function getDependentsOf(db: DbConn, entryId: string): Promise<TaskDependency[]> {
  const res = await db.query(
    `SELECT * FROM task_dependencies WHERE to_entry_id = $1 ORDER BY created_at`,
    [entryId],
  );
  return res.rows.map(rowToDependency);
}

/** 获取会话的所有依赖关系（DAG 可视化） */
export async function listSessionDependencies(db: DbConn, tenantId: string, sessionId: string): Promise<TaskDependency[]> {
  const res = await db.query(
    `SELECT * FROM task_dependencies WHERE tenant_id = $1 AND session_id = $2 ORDER BY created_at`,
    [tenantId, sessionId],
  );
  return res.rows.map(rowToDependency);
}

/** 更新依赖状态 */
export async function updateDependencyStatus(db: DbConn, depId: string, status: "pending" | "resolved" | "blocked" | "overridden"): Promise<TaskDependency | null> {
  const res = await db.query(
    `UPDATE task_dependencies
     SET status = $2 ${status === "resolved" ? ", resolved_at = now()" : ""}
     WHERE dep_id = $1
     RETURNING *`,
    [depId, status],
  );
  return res.rowCount ? rowToDependency(res.rows[0]) : null;
}

/** 删除依赖关系 */
export async function deleteDependency(db: DbConn, depId: string): Promise<boolean> {
  const res = await db.query(
    `DELETE FROM task_dependencies WHERE dep_id = $1`, [depId],
  );
  return (res.rowCount || 0) > 0;
}

/** 检查条目的所有前置依赖是否已满足 */
export async function areAllDepsResolved(db: DbConn, entryId: string): Promise<boolean> {
  const res = await db.query(
    `SELECT COUNT(*) AS cnt FROM task_dependencies
     WHERE from_entry_id = $1 AND status = 'pending'`,
    [entryId],
  );
  return Number(res.rows[0].cnt) === 0;
}

/** 批量解析依赖（当上游任务完成时） */
export async function resolveUpstreamDeps(db: DbConn, completedEntryId: string): Promise<TaskDependency[]> {
  const res = await db.query(
    `UPDATE task_dependencies
     SET status = 'resolved', resolved_at = now()
     WHERE to_entry_id = $1 AND status = 'pending'
       AND dep_type IN ('finish_to_start', 'output_to_input')
     RETURNING *`,
    [completedEntryId],
  );
  return res.rows.map(rowToDependency);
}

/** 批量阻塞依赖（当上游任务失败/取消时） */
export async function blockUpstreamDeps(db: DbConn, failedEntryId: string): Promise<TaskDependency[]> {
  const res = await db.query(
    `UPDATE task_dependencies
     SET status = 'blocked'
     WHERE to_entry_id = $1 AND status = 'pending'
     RETURNING *`,
    [failedEntryId],
  );
  return res.rows.map(rowToDependency);
}

/** 获取级联取消的下游 entryIds */
export async function getCascadeCancelTargets(db: DbConn, cancelledEntryId: string): Promise<string[]> {
  const res = await db.query(
    `SELECT from_entry_id FROM task_dependencies
     WHERE to_entry_id = $1 AND dep_type = 'cancel_cascade' AND status = 'pending'`,
    [cancelledEntryId],
  );
  return res.rows.map((r: any) => r.from_entry_id as string);
}

/**
 * P3-14: 修复因上游失败导致的阻塞依赖。
 * 将指定上游任务关联的所有 blocked 依赖改为 overridden，
 * 使下游任务可以继续执行。
 * 返回被修复的依赖列表。
 */
export async function repairBlockedDeps(
  db: DbConn,
  failedEntryId: string,
): Promise<TaskDependency[]> {
  const res = await db.query(
    `UPDATE task_dependencies
     SET status = 'overridden', updated_at = now()
     WHERE to_entry_id = $1 AND status = 'blocked'
     RETURNING *`,
    [failedEntryId],
  );
  return res.rows.map(rowToDependency);
}

/**
 * P3-14: 获取因指定上游任务失败而被阻塞的下游条目。
 * 返回拥有 blocked 依赖且被 failedEntryId 阻塞的唯一下游 entryId 集合。
 */
export async function getBlockedDownstreamEntries(
  db: DbConn,
  failedEntryId: string,
): Promise<string[]> {
  const res = await db.query(
    `SELECT DISTINCT from_entry_id
     FROM task_dependencies
     WHERE to_entry_id = $1 AND status = 'blocked'`,
    [failedEntryId],
  );
  return res.rows.map((r: any) => r.from_entry_id as string);
}

/* ================================================================== */
/*  P3-10: 历史查询 + 会话恢复                                           */
/* ================================================================== */

/** 分页查询会话任务队列历史（包含已完成任务） */
export async function listHistoryEntries(db: DbConn, params: {
  tenantId: string;
  sessionId: string;
  limit: number;
  offset: number;
  statusFilter?: QueueEntryStatus[] | null;
}): Promise<{ entries: TaskQueueEntry[]; total: number }> {
  const { tenantId, sessionId, limit, offset, statusFilter } = params;

  let whereClause = "tenant_id = $1 AND session_id = $2";
  const queryParams: unknown[] = [tenantId, sessionId];

  if (statusFilter && statusFilter.length > 0) {
    whereClause += ` AND status = ANY($${queryParams.length + 1})`;
    queryParams.push(statusFilter);
  }

  const countRes = await db.query(
    `SELECT COUNT(*) AS cnt FROM session_task_queue WHERE ${whereClause}`,
    queryParams,
  );
  const total = Number(countRes.rows[0].cnt);

  const dataRes = await db.query(
    `SELECT * FROM session_task_queue
     WHERE ${whereClause}
     ORDER BY enqueued_at DESC
     LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
    [...queryParams, limit, offset],
  );

  return { entries: dataRes.rows.map(rowToQueueEntry), total };
}

/** 获取会话中可恢复的任务（未完成 + 非终态） */
export async function listResumableEntries(db: DbConn, tenantId: string, sessionId: string): Promise<TaskQueueEntry[]> {
  const res = await db.query(
    `SELECT * FROM session_task_queue
     WHERE tenant_id = $1 AND session_id = $2
       AND status NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY position ASC`,
    [tenantId, sessionId],
  );
  return res.rows.map(rowToQueueEntry);
}

/** 获取租户所有有未完成任务的会话 */
export async function listSessionsWithPendingTasks(db: DbConn, tenantId: string): Promise<Array<{ sessionId: string; count: number }>> {
  const res = await db.query(
    `SELECT session_id, COUNT(*) AS cnt
     FROM session_task_queue
     WHERE tenant_id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')
     GROUP BY session_id
     ORDER BY cnt DESC`,
    [tenantId],
  );
  return res.rows.map((r: any) => ({ sessionId: r.session_id as string, count: Number(r.cnt) }));
}

/** 获取会话任务队列概要统计 */
export async function getSessionQueueStats(db: DbConn, tenantId: string, sessionId: string): Promise<{
  total: number;
  queued: number;
  executing: number;
  completed: number;
  failed: number;
  cancelled: number;
  avgDurationMs: number | null;
}> {
  const res = await db.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE status IN ('queued','ready')) AS queued,
       COUNT(*) FILTER (WHERE status = 'executing') AS executing,
       COUNT(*) FILTER (WHERE status = 'completed') AS completed,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
       AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)
         FILTER (WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL) AS avg_duration_ms
     FROM session_task_queue
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId],
  );
  const row = res.rows[0] as any;
  return {
    total: Number(row.total),
    queued: Number(row.queued),
    executing: Number(row.executing),
    completed: Number(row.completed),
    failed: Number(row.failed),
    cancelled: Number(row.cancelled),
    avgDurationMs: row.avg_duration_ms ? Number(row.avg_duration_ms) : null,
  };
}

/* ================================================================== */
/*  P1-G6: Metadata 更新 + Supervisor 查询 + 启动恢复                     */
/* ================================================================== */

/** 更新队列条目的 metadata（合并模式，不覆盖已有字段） */
export async function updateEntryMetadata(
  db: DbConn,
  entryId: string,
  patch: Record<string, unknown>,
): Promise<TaskQueueEntry | null> {
  const res = await db.query(
    `UPDATE session_task_queue
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE entry_id = $1
     RETURNING *`,
    [entryId, JSON.stringify(patch)],
  );
  return res.rowCount ? rowToQueueEntry(res.rows[0]) : null;
}

/**
 * 查找因 shutdown 暂停的任务（用于启动恢复）。
 * 条件：status=paused 且 checkpoint_ref 以 'shutdown:' 开头。
 */
export async function listShutdownPausedEntries(db: DbConn): Promise<TaskQueueEntry[]> {
  const res = await db.query(
    `SELECT * FROM session_task_queue
     WHERE status = 'paused'
       AND checkpoint_ref LIKE 'shutdown:%'
     ORDER BY tenant_id, session_id, position`,
  );
  return res.rows.map(rowToQueueEntry);
}

/**
 * 查找僵尸执行中的任务（Supervisor 用）。
 * 条件：status=executing 且 started_at 超过阈值，且无对应活跃 agent_loop_checkpoint。
 * @param staleThresholdMs 认定为僵尸的超时时长（毫秒）
 */
export async function listZombieExecutingEntries(
  db: DbConn,
  staleThresholdMs: number,
): Promise<TaskQueueEntry[]> {
  const res = await db.query(
    `SELECT q.*
     FROM session_task_queue q
     WHERE q.status = 'executing'
       AND q.started_at < now() - ($1 || ' milliseconds')::interval
       AND NOT EXISTS (
         SELECT 1 FROM agent_loop_checkpoints c
         WHERE c.run_id = q.run_id
           AND c.status IN ('running', 'resuming')
           AND c.heartbeat_at > now() - ($1 || ' milliseconds')::interval
       )
     ORDER BY q.started_at ASC
     LIMIT 50`,
    [staleThresholdMs],
  );
  return res.rows.map(rowToQueueEntry);
}
