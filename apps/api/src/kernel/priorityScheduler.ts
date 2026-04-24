/**
 * Priority Scheduler — 基于 Agent Process Table 的优先级调度
 *
 * P2-6.6 + P1-05: OS 级优先级队列：
 * - 全局 MAX_CONCURRENT_AGENT_LOOPS 硬上限（防 OOM）
 * - 高优先级 Agent 可抢占低优先级的模型调用配额
 * - 配额继承：子 Agent 配额不超过父 Agent
 * - 公平调度：同优先级进程按等待时间排序（FIFO）
 * - 并发控制：限制每个租户/空间的并行 Agent 数
 * - P1-05: 饥饿检测：低优先级任务等待超阈自动提升优先级
 */
import type { Pool } from "pg";
import { StructuredLogger, resolveNumber } from "@openslin/shared";

const logger = new StructuredLogger({ module: "priorityScheduler" });

// ── 类型 ────────────────────────────────────────────────────

export interface SchedulerConfig {
  /** 每个租户最大并发 Agent 数，默认 20 */
  maxConcurrentPerTenant?: number;
  /** 每个空间最大并发 Agent 数，默认 10 */
  maxConcurrentPerSpace?: number;
  /** 抢占阈值：优先级差 >= 该值时允许抢占，默认 3 */
  preemptionThreshold?: number;
  /** P1-05: 全局 Agent Loop 硬上限（所有租户总和） */
  maxGlobalConcurrent?: number;
}

export interface ScheduleResult {
  granted: boolean;
  processId: string;
  /** 如果被阻塞，原因 */
  reason?: string;
  /** 被抢占的进程 ID（如果发生抢占） */
  preemptedProcessId?: string | null;
}

export interface ProcessQuota {
  /** 模型调用配额上限 */
  maxModelCalls: number;
  /** 最大并行步骤数 */
  maxParallelSteps: number;
  /** 最大执行时间 MS */
  maxWallTimeMs: number;
}

const DEFAULT_QUOTA: ProcessQuota = {
  maxModelCalls: 100,
  maxParallelSteps: 5,
  maxWallTimeMs: 600_000,
};

// ── 优先级调度决策 ──────────────────────────────────────────

/**
 * 尝试调度一个 Agent 进程。
 * 检查并发限制，必要时执行优先级抢占。
 */
export async function tryScheduleProcess(params: {
  pool: Pool;
  processId: string;
  tenantId: string;
  spaceId: string | null;
  priority: number;
  config?: SchedulerConfig;
}): Promise<ScheduleResult> {
  const { pool, processId, tenantId, spaceId, priority } = params;
  const cfg = params.config ?? {};
  const maxPerTenant = cfg.maxConcurrentPerTenant
    ?? resolveNumber("SCHEDULER_MAX_CONCURRENT_PER_TENANT", undefined, undefined, 20).value;
  const maxPerSpace = cfg.maxConcurrentPerSpace
    ?? resolveNumber("SCHEDULER_MAX_CONCURRENT_PER_SPACE", undefined, undefined, 10).value;
  const preemptThreshold = cfg.preemptionThreshold
    ?? resolveNumber("SCHEDULER_PREEMPTION_THRESHOLD", undefined, undefined, 3).value;
  const maxGlobal = cfg.maxGlobalConcurrent ?? getMaxConcurrentAgentLoops();

  // 1. 检查租户级并发
  const tenantRunning = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM agent_processes
     WHERE tenant_id = $1 AND status = 'running'`,
    [tenantId],
  );
  const tenantCount = Number(tenantRunning.rows[0]?.cnt ?? 0);

  // 2. 检查空间级并发
  let spaceCount = 0;
  if (spaceId) {
    const spaceRunning = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM agent_processes
       WHERE tenant_id = $1 AND space_id = $2 AND status = 'running'`,
      [tenantId, spaceId],
    );
    spaceCount = Number(spaceRunning.rows[0]?.cnt ?? 0);
  }

  // 3. 如果未超限，直接授权
  const tenantFull = tenantCount >= maxPerTenant;
  const spaceFull = spaceId ? spaceCount >= maxPerSpace : false;

  /* P1-05: 全局并发检查 */
  let globalFull = false;
  if (!tenantFull && !spaceFull) {
    const globalRes = await pool.query<{ cnt: string }>(
      "SELECT COUNT(*) AS cnt FROM agent_processes WHERE status = 'running'",
    );
    const globalCount = Number(globalRes.rows[0]?.cnt ?? 0);
    globalFull = globalCount >= maxGlobal;
  }

  if (!tenantFull && !spaceFull && !globalFull) {
    await pool.query(
      `UPDATE agent_processes SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now(), updated_at = now()
       WHERE process_id = $1`,
      [processId],
    );
    return { granted: true, processId };
  }

  // 4. 超限 → 尝试优先级抢占
  // 查找当前运行中优先级最低的进程
  const scopeCondition = spaceFull && spaceId
    ? `AND space_id = '${spaceId}'`
    : "";

  const lowestRes = await pool.query<{ process_id: string; priority: number }>(
    `SELECT process_id, priority FROM agent_processes
     WHERE tenant_id = $1 AND status = 'running' ${scopeCondition}
     ORDER BY priority ASC, started_at ASC
     LIMIT 1`,
    [tenantId],
  );

  if (lowestRes.rowCount && lowestRes.rows[0]) {
    const lowest = lowestRes.rows[0];
    const diff = priority - lowest.priority;

    if (diff >= preemptThreshold) {
      // 抢占：将低优先级进程标记为 preempted
      await pool.query(
        `UPDATE agent_processes SET status = 'preempted', finished_at = now(), updated_at = now()
         WHERE process_id = $1`,
        [lowest.process_id],
      );
      // 授权当前进程
      await pool.query(
        `UPDATE agent_processes SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now(), updated_at = now()
         WHERE process_id = $1`,
        [processId],
      );
      return {
        granted: true,
        processId,
        preemptedProcessId: lowest.process_id,
      };
    }
  }

  // 5. 无法抢占，排队等待
  return {
    granted: false,
    processId,
    reason: globalFull ? "global_concurrency_limit" : spaceFull ? "space_concurrency_limit" : "tenant_concurrency_limit",
  };
}

/**
 * 获取下一批待调度的进程（按优先级降序 + 等待时间升序）。
 */
export async function getNextPendingProcesses(params: {
  pool: Pool;
  tenantId: string;
  limit?: number;
}): Promise<Array<{ processId: string; priority: number; runId: string; parentProcessId: string | null }>> {
  const { pool, tenantId } = params;
  const limit = params.limit ?? 10;

  const res = await pool.query<{
    process_id: string; priority: number; run_id: string; parent_process_id: string | null;
  }>(
    `SELECT process_id, priority, run_id, parent_process_id FROM agent_processes
     WHERE tenant_id = $1 AND status = 'pending'
     ORDER BY priority DESC, created_at ASC
     LIMIT $2`,
    [tenantId, limit],
  );

  return res.rows.map((r) => ({
    processId: r.process_id,
    priority: r.priority,
    runId: r.run_id,
    parentProcessId: r.parent_process_id,
  }));
}

// ── 配额继承 ────────────────────────────────────────────────

/**
 * 解析进程的有效配额（考虑父进程配额继承）。
 * 子 Agent 配额取 min(自身配额, 父进程剩余配额)。
 */
export async function resolveEffectiveQuota(params: {
  pool: Pool;
  processId: string;
}): Promise<ProcessQuota> {
  const { pool, processId } = params;

  const res = await pool.query<{
    resource_quota: any; parent_process_id: string | null;
  }>(
    `SELECT resource_quota, parent_process_id FROM agent_processes WHERE process_id = $1`,
    [processId],
  );
  if (!res.rowCount || !res.rows[0]) return { ...DEFAULT_QUOTA };

  const row = res.rows[0];
  const selfQuota = parseQuota(row.resource_quota);

  if (!row.parent_process_id) return selfQuota;

  // 递归查询父进程配额
  const parentQuota = await resolveEffectiveQuota({ pool, processId: row.parent_process_id });

  // 子 Agent 配额 = min(自身, 父进程)
  return {
    maxModelCalls: Math.min(selfQuota.maxModelCalls, parentQuota.maxModelCalls),
    maxParallelSteps: Math.min(selfQuota.maxParallelSteps, parentQuota.maxParallelSteps),
    maxWallTimeMs: Math.min(selfQuota.maxWallTimeMs, parentQuota.maxWallTimeMs),
  };
}

function parseQuota(raw: any): ProcessQuota {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_QUOTA };
  return {
    maxModelCalls: typeof raw.maxModelCalls === "number" ? raw.maxModelCalls : DEFAULT_QUOTA.maxModelCalls,
    maxParallelSteps: typeof raw.maxParallelSteps === "number" ? raw.maxParallelSteps : DEFAULT_QUOTA.maxParallelSteps,
    maxWallTimeMs: typeof raw.maxWallTimeMs === "number" ? raw.maxWallTimeMs : DEFAULT_QUOTA.maxWallTimeMs,
  };
}

// ── 公平调度统计 ────────────────────────────────────────────

/**
 * 获取租户级调度统计信息。
 */
export async function getSchedulerStats(params: {
  pool: Pool;
  tenantId: string;
}): Promise<{
  running: number;
  pending: number;
  paused: number;
  avgPriority: number;
  avgWaitTimeMs: number;
}> {
  const { pool, tenantId } = params;

  const res = await pool.query<{
    status: string; cnt: string; avg_priority: string; avg_wait_ms: string;
  }>(
    `SELECT status,
            COUNT(*) AS cnt,
            AVG(priority) AS avg_priority,
            AVG(EXTRACT(EPOCH FROM (now() - created_at)) * 1000) AS avg_wait_ms
     FROM agent_processes
     WHERE tenant_id = $1 AND status IN ('running', 'pending', 'paused')
     GROUP BY status`,
    [tenantId],
  );

  let running = 0, pending = 0, paused = 0, totalPriority = 0, totalWait = 0, totalCount = 0;
  for (const r of res.rows) {
    const cnt = Number(r.cnt);
    totalPriority += Number(r.avg_priority) * cnt;
    totalWait += Number(r.avg_wait_ms) * cnt;
    totalCount += cnt;
    if (r.status === "running") running = cnt;
    else if (r.status === "pending") pending = cnt;
    else if (r.status === "paused") paused = cnt;
  }

  return {
    running,
    pending,
    paused,
    avgPriority: totalCount > 0 ? Math.round((totalPriority / totalCount) * 100) / 100 : 0,
    avgWaitTimeMs: totalCount > 0 ? Math.round(totalWait / totalCount) : 0,
  };
}

// ── P1-05: 全局并发 Agent Loop 限制 + 进程入口门 ──────────────────

export function getMaxConcurrentAgentLoops(): number {
  return Math.max(1, resolveNumber("MAX_CONCURRENT_AGENT_LOOPS", undefined, undefined, 50).value);
}

let _activeLoops = 0;
const _waitQueue: Array<{ resolve: () => void; priority: number; enqueuedAt: number }> = [];

/**
 * 入口门：在开始 Agent Loop 前调用，确保全局并发不超限。
 * 超限时按优先级排队等待，超时抛出异常。
 */
export async function acquireLoopSlot(params: { priority?: number; timeoutMs?: number } = {}): Promise<() => void> {
  const priority = params.priority ?? 5;
  const timeoutMs = params.timeoutMs ?? 60_000;

  if (_activeLoops < getMaxConcurrentAgentLoops()) {
    _activeLoops++;
    return () => releaseLoopSlot();
  }

  // 超限 → 排队等待
  return new Promise<() => void>((resolve, reject) => {
    const entry = {
      resolve: () => {
        _activeLoops++;
        resolve(() => releaseLoopSlot());
      },
      priority,
      enqueuedAt: Date.now(),
    };

    // 按优先级插入（高优先级在前）
    const idx = _waitQueue.findIndex((e) => e.priority < priority);
    if (idx < 0) _waitQueue.push(entry);
    else _waitQueue.splice(idx, 0, entry);

    const timer = setTimeout(() => {
      const pos = _waitQueue.indexOf(entry);
      if (pos >= 0) _waitQueue.splice(pos, 1);
      reject(new Error(`agent_loop_admission_timeout: waited ${timeoutMs}ms, global slots=${getMaxConcurrentAgentLoops()}, active=${_activeLoops}, queued=${_waitQueue.length}`));
    }, timeoutMs);

    // 清理 timer 引用 — 通过替换 resolve
    const origResolve = entry.resolve;
    entry.resolve = () => {
      clearTimeout(timer);
      origResolve();
    };
  });
}

function releaseLoopSlot() {
  _activeLoops = Math.max(0, _activeLoops - 1);

  // 唤醒队列中等待的下一个
  if (_waitQueue.length > 0 && _activeLoops < getMaxConcurrentAgentLoops()) {
    const next = _waitQueue.shift();
    next?.resolve();
  }
}

/** 获取当前全局 Agent Loop 并发状态 */
export function getGlobalLoopConcurrency(): { active: number; queued: number; max: number } {
  return { active: _activeLoops, queued: _waitQueue.length, max: getMaxConcurrentAgentLoops() };
}

// ── P1-05: 饥饿检测与优先级自动提升 ───────────────────

function getStarvationThresholdMs(): number {
  return resolveNumber("SCHEDULER_STARVATION_THRESHOLD_MS", undefined, undefined, 120_000).value;
}
function getStarvationPriorityBoost(): number {
  return resolveNumber("SCHEDULER_STARVATION_BOOST", undefined, undefined, 2).value;
}

/**
 * P1-05: 检测等待时间超阈的 pending 进程，自动提升优先级以防饥饿。
 * 应在 Worker ticker 或定时器中周期调用。
 */
export async function detectAndBoostStarvedProcesses(params: {
  pool: Pool;
}): Promise<{ boosted: number }> {
  const { pool } = params;
  const res = await pool.query(
    `UPDATE agent_processes
     SET priority = LEAST(priority + $1, 10),
         updated_at = now()
     WHERE status = 'pending'
       AND created_at < now() - ($2::bigint * interval '1 millisecond')
       AND priority < 10
     RETURNING process_id, priority`,
    [getStarvationPriorityBoost(), getStarvationThresholdMs()],
  );
  const boosted = res.rowCount ?? 0;
  if (boosted > 0) {
    logger.info(`Boosted ${boosted} starved processes by +${getStarvationPriorityBoost()} priority`);
  }
  return { boosted };
}
