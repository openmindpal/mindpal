/**
 * Session Scheduler — 会话级智能调度器
 *
 * 策略层：在 TaskQueueManager 之上提供可配置的调度策略。
 * 与 priorityScheduler（全局级）协同：
 * - priorityScheduler 控制全局 Agent Loop 并发上限
 * - sessionScheduler 控制会话内任务的执行顺序和时机
 *
 * P3-01: 策略模式（FIFO / Priority / DependencyAware / SJF）
 * P3-02: 动态并发配置（无硬编码上限）
 * P3-03: LLM 驱动优先级推断
 * P3-04: 会话级抢占
 * P3-05: 会话级饥饿检测
 * P3-06: 前台/后台事件优先级
 */
import type { Pool } from "pg";
import type {
  TaskQueueEntry,
  ScheduleDecision,
} from "./taskQueue.types";
import { TERMINAL_QUEUE_STATUSES, ACTIVE_STATUSES } from "./taskQueue.types";
import * as repo from "./taskQueueRepo";
import { StructuredLogger } from "@openslin/shared";

/* ================================================================== */
/*  日志                                                               */
/* ================================================================== */

const _logger = new StructuredLogger({ module: "sessionScheduler" });

function log(level: "info" | "warn" | "error", msg: string, ctx?: Record<string, unknown>) {
  _logger[level](msg, ctx);
}

/* ================================================================== */
/*  调度策略                                                            */
/* ================================================================== */

/** 调度策略类型 */
export type SchedulingStrategy =
  | "fifo"               // 先入先出
  | "priority"           // 按优先级（数值越低优先级越高）
  | "dependency_aware"   // 依赖感知（先调度无依赖或依赖已就绪的任务）
  | "sjf";               // 最短作业优先（按预估执行时间）

/** 调度策略排序函数签名 */
type SortFn = (a: TaskQueueEntry, b: TaskQueueEntry) => number;

/** 各策略排序函数 */
const STRATEGY_SORT: Record<SchedulingStrategy, SortFn> = {
  fifo: (a, b) => a.position - b.position,
  priority: (a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority; // 低值高优先
    return a.position - b.position; // 同优先级 FIFO
  },
  dependency_aware: (a, b) => {
    // 依赖已就绪（readyAt 非空）的任务优先调度
    const aReady = a.readyAt != null ? 1 : 0;
    const bReady = b.readyAt != null ? 1 : 0;
    if (aReady !== bReady) return bReady - aReady; // readyAt 非空的排前
    // 同等就绪状态下按优先级排序
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.position - b.position;
  },
  sjf: (a, b) => {
    const aDur = a.estimatedDurationMs ?? Number.MAX_SAFE_INTEGER;
    const bDur = b.estimatedDurationMs ?? Number.MAX_SAFE_INTEGER;
    if (aDur !== bDur) return aDur - bDur;
    return a.position - b.position;
  },
};

/* ================================================================== */
/*  P3-02: 动态并发配置                                                 */
/* ================================================================== */

/** 会话级并发配置 */
export interface SessionConcurrencyConfig {
  /** 会话最大并发执行任务数（null = 不限） */
  maxConcurrent: number | null;
  /** 调度策略 */
  strategy: SchedulingStrategy;
  /** 是否启用 LLM 优先级推断 */
  llmPriorityEnabled: boolean;
  /** 是否启用会话级抢占 */
  preemptionEnabled: boolean;
  /** 抢占优先级差阈值 */
  preemptionThreshold: number;
  /** 饥饿检测阈值 MS */
  starvationThresholdMs: number;
  /** 饥饿时优先级提升量 */
  starvationBoost: number;
}

/** 默认配置（无硬编码上限） */
const DEFAULT_CONFIG: SessionConcurrencyConfig = {
  maxConcurrent: null,           // 不限并发
  strategy: "dependency_aware",
  llmPriorityEnabled: false,
  preemptionEnabled: true,
  preemptionThreshold: 3,
  starvationThresholdMs: 120_000,  // 2 min
  starvationBoost: 2,
};

/** 租户级配置覆盖（内存缓存） */
const tenantConfigCache = new Map<string, SessionConcurrencyConfig>();

/** 获取会话并发配置（可由租户等级/系统负载/资源可用性动态决定） */
export function getSessionConfig(tenantId: string): SessionConcurrencyConfig {
  const cached = tenantConfigCache.get(tenantId);
  if (cached) return cached;
  return { ...DEFAULT_CONFIG };
}

/** 更新租户级配置（供管理后台或系统自适应调用） */
export function updateSessionConfig(tenantId: string, partial: Partial<SessionConcurrencyConfig>): SessionConcurrencyConfig {
  const current = getSessionConfig(tenantId);
  const updated = { ...current, ...partial };
  tenantConfigCache.set(tenantId, updated);
  log("info", `Session config updated`, { tenantId, config: updated });
  return updated;
}

/* ================================================================== */
/*  P3-01: 核心调度逻辑                                                 */
/* ================================================================== */

export class SessionScheduler {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * 决定下一个应该执行的任务。
   * 调度流程：
   * 1. 获取所有可调度任务
   * 2. 检查并发限制
   * 3. 按策略排序
   * 4. 检查依赖就绪状态
   * 5. 如果超并发限制且启用抢占，尝试抢占
   * 6. 返回调度决策
   */
  async decideNext(
    tenantId: string,
    sessionId: string,
    config?: Partial<SessionConcurrencyConfig>,
  ): Promise<{
    decision: ScheduleDecision;
    candidate: TaskQueueEntry | null;
    preemptTarget: TaskQueueEntry | null;
  }> {
    const cfg = { ...getSessionConfig(tenantId), ...config };

    // 获取可调度任务（queued + ready）
    const schedulable = await repo.listSchedulable(this.pool, tenantId, sessionId);
    if (schedulable.length === 0) {
      return {
        decision: { immediate: false, reason: "no_schedulable_tasks" },
        candidate: null,
        preemptTarget: null,
      };
    }

    // 检查当前并发数
    const activeCount = await repo.countExecuting(this.pool, tenantId, sessionId);

    // P3-02: 动态并发限制（null = 不限）
    const concurrencyOk = cfg.maxConcurrent === null || activeCount < cfg.maxConcurrent;

    // 按策略排序
    const sortFn = STRATEGY_SORT[cfg.strategy] ?? STRATEGY_SORT.fifo;
    const sorted = [...schedulable].sort(sortFn);

    // 逐个检查依赖就绪
    let bestCandidate: TaskQueueEntry | null = null;
    for (const candidate of sorted) {
      const ready = await repo.areAllDepsResolved(this.pool, candidate.entryId);
      if (ready) {
        bestCandidate = candidate;
        break;
      }
    }

    if (!bestCandidate) {
      recordScheduleMetric("dep_blocked");
      return {
        decision: { immediate: false, reason: "all_tasks_blocked_by_dependencies" },
        candidate: null,
        preemptTarget: null,
      };
    }

    // 并发槽位可用 → 直接调度
    if (concurrencyOk) {
      recordScheduleMetric("immediate");
      return {
        decision: { immediate: true, reason: "slot_available" },
        candidate: bestCandidate,
        preemptTarget: null,
      };
    }

    // P3-04: 尝试抢占
    if (cfg.preemptionEnabled) {
      const preemptResult = await this.tryPreempt(tenantId, sessionId, bestCandidate, cfg);
      if (preemptResult) {
        recordScheduleMetric("preemption");
        return {
          decision: {
            immediate: true,
            reason: "preemption",
            preemptEntryId: preemptResult.entryId,
          },
          candidate: bestCandidate,
          preemptTarget: preemptResult,
        };
      }
    }

    // 无法调度
    const estimated = this.estimateWait(schedulable, activeCount);
    recordScheduleMetric("concurrency_blocked", estimated);
    return {
      decision: {
        immediate: false,
        estimatedWaitMs: estimated,
        reason: "concurrency_limit",
      },
      candidate: bestCandidate,
      preemptTarget: null,
    };
  }

  /* ── P3-04: 会话级抢占 ────────────────────────────────────── */

  /**
   * 尝试抢占：找到当前执行中优先级最低的任务，
   * 如果候选任务的优先级高出阈值，则抢占之。
   */
  private async tryPreempt(
    tenantId: string,
    sessionId: string,
    candidate: TaskQueueEntry,
    cfg: SessionConcurrencyConfig,
  ): Promise<TaskQueueEntry | null> {
    const executing = await repo.listActiveEntries(this.pool, tenantId, sessionId);
    const runningTasks = executing.filter((e) => e.status === "executing");

    if (runningTasks.length === 0) return null;

    // 找优先级最低（数值最大）的非前台任务
    const sortedByPriority = runningTasks
      .filter((e) => !e.foreground)  // 不抢占前台任务
      .sort((a, b) => b.priority - a.priority);  // 按优先级降序

    const victim = sortedByPriority[0];
    if (!victim) return null;

    // 检查优先级差
    const diff = victim.priority - candidate.priority;
    if (diff >= cfg.preemptionThreshold) {
      log("info", `Preemption candidate found`, {
        victim: victim.entryId,
        victimPriority: victim.priority,
        candidate: candidate.entryId,
        candidatePriority: candidate.priority,
        diff,
      });
      return victim;
    }

    return null;
  }

  /* ── P3-05: 饥饿检测 ──────────────────────────────────────── */

  /**
   * 检测并提升饥饿任务的优先级。
   * 应由定时器周期调用。
   */
  async detectAndBoostStarved(
    tenantId: string,
    sessionId: string,
    config?: Partial<SessionConcurrencyConfig>,
  ): Promise<{ boosted: Array<{ entryId: string; oldPriority: number; newPriority: number }> }> {
    const cfg = { ...getSessionConfig(tenantId), ...config };
    const thresholdMs = cfg.starvationThresholdMs;
    const boost = cfg.starvationBoost;
    const now = Date.now();

    const entries = await repo.listActiveEntries(this.pool, tenantId, sessionId);
    const starved = entries.filter((e) => {
      if (e.status !== "queued" && e.status !== "ready") return false;
      const waitMs = now - new Date(e.enqueuedAt).getTime();
      return waitMs >= thresholdMs && e.priority > 0;
    });

    const boosted: Array<{ entryId: string; oldPriority: number; newPriority: number }> = [];

    for (const entry of starved) {
      const newPriority = Math.max(0, entry.priority - boost);
      if (newPriority !== entry.priority) {
        const { updatePriority } = await import("./taskQueueRepo");
        await updatePriority(this.pool, entry.entryId, newPriority);
        boosted.push({
          entryId: entry.entryId,
          oldPriority: entry.priority,
          newPriority,
        });
      }
    }

    if (boosted.length > 0) {
      recordStarvationBoost(boosted.length);
      log("info", `Boosted ${boosted.length} starved tasks`, { tenantId, sessionId, boosted });
    }

    return { boosted };
  }

  /* ── P3-03: LLM 驱动优先级推断 ────────────────────────────── */

  /**
   * 为新任务推断优先级权重。
   * 分析任务内容/紧急程度/上下文推算优先级。
   */
  async inferPriority(params: {
    app: any;
    subject: any;
    locale: string;
    authorization: string | null;
    traceId: string | null;
    goal: string;
    mode: string;
    existingEntries: TaskQueueEntry[];
  }): Promise<{ priority: number; reasoning: string }> {
    const { goal, mode, existingEntries } = params;

    // 简单启发式（LLM 推断可选启用）
    let basePriority = 50;

    // 模式权重
    if (mode === "answer") basePriority = 30;      // 问答通常快速，优先
    if (mode === "execute") basePriority = 50;      // 执行标准
    if (mode === "collab") basePriority = 40;       // 协作稍高

    // 目标复杂度启发
    const goalLen = goal.length;
    if (goalLen < 50) basePriority -= 5;           // 短目标可能简单
    if (goalLen > 500) basePriority += 5;          // 长目标可能复杂

    // 队列深度调整
    const activeNonTerminal = existingEntries.filter((e) => !TERMINAL_QUEUE_STATUSES.has(e.status));
    if (activeNonTerminal.length > 5) basePriority += 2;  // 队列深时新任务稍降

    // 紧急关键词检测
    const urgentKeywords = /紧急|urgent|asap|immediately|立即|马上|critical/i;
    if (urgentKeywords.test(goal)) {
      basePriority = Math.max(0, basePriority - 20);
    }

    const priority = Math.max(0, Math.min(100, basePriority));

    return {
      priority,
      reasoning: `Heuristic: mode=${mode}, goalLen=${goalLen}, queueDepth=${activeNonTerminal.length} → priority=${priority}`,
    };
  }

  /* ── P3-06: 前台/后台事件优先级 ────────────────────────────── */

  /**
   * 获取任务的事件推送优先级。
   * 前台任务获得更高优先级，后台任务的事件可延迟批量推送。
   */
  getEventPriority(entry: TaskQueueEntry): "high" | "normal" | "low" {
    if (entry.foreground) return "high";
    if (ACTIVE_STATUSES.has(entry.status)) return "normal";
    return "low";
  }

  /**
   * 判断任务是否应该接收实时事件推送。
   * 前台任务始终实时，后台任务可根据策略延迟。
   */
  shouldPushRealtime(entry: TaskQueueEntry): boolean {
    return entry.foreground || entry.status === "executing";
  }

  /* ── 工具 ─────────────────────────────────────────────────── */

  private estimateWait(schedulable: TaskQueueEntry[], activeCount: number): number {
    if (activeCount === 0) return 0;
    // 简单估算：取活跃任务的平均预估时间
    const avgDuration = 30_000; // 默认 30s
    return avgDuration;
  }
}

/* ================================================================== */
/*  工厂函数                                                            */
/* ================================================================== */

export function createSessionScheduler(pool: Pool): SessionScheduler {
  return new SessionScheduler(pool);
}

/* ================================================================== */
/*  饥饿检测定时器                                                       */
/* ================================================================== */

let starvationTimer: ReturnType<typeof setInterval> | null = null;
const STARVATION_CHECK_INTERVAL_MS = 60_000; // 每分钟检查一次

/**
 * 启动全局饥饿检测定时器。
 * 遍历所有活跃会话，检测长时间排队的任务并提升优先级。
 */
export function startStarvationDetector(pool: Pool): void {
  if (starvationTimer) return;

  const scheduler = createSessionScheduler(pool);

  starvationTimer = setInterval(async () => {
    try {
      // 查询所有有排队任务的会话
      const res = await pool.query<{ tenant_id: string; session_id: string }>(
        `SELECT DISTINCT tenant_id, session_id FROM session_task_queue
         WHERE status IN ('queued', 'ready')`,
      );

      for (const row of res.rows) {
        await scheduler.detectAndBoostStarved(row.tenant_id, row.session_id);
      }
    } catch (err) {
      log("error", `Starvation detection error`, { error: String(err) });
    }
  }, STARVATION_CHECK_INTERVAL_MS);

  // 不阻止进程退出
  if (starvationTimer && typeof starvationTimer === "object" && "unref" in starvationTimer) {
    (starvationTimer as any).unref();
  }

  log("info", `Starvation detector started`, { intervalMs: STARVATION_CHECK_INTERVAL_MS });
}

/** 停止饥饿检测定时器 */
export function stopStarvationDetector(): void {
  if (starvationTimer) {
    clearInterval(starvationTimer);
    starvationTimer = null;
    log("info", `Starvation detector stopped`);
  }
}

/* ================================================================== */
/*  P3-11: 调度器指标导出                                                */
/* ================================================================== */

/** 调度器运行时指标（内存累加器） */
const schedulerMetrics = {
  /** 调度决策总次数 */
  totalDecisions: 0,
  /** 立即调度次数 */
  immediateSchedules: 0,
  /** 因依赖阻塞延迟的次数 */
  dependencyBlocks: 0,
  /** 因并发限制延迟的次数 */
  concurrencyBlocks: 0,
  /** 抢占次数 */
  preemptions: 0,
  /** 饥饿提升次数 */
  starvationBoosts: 0,
  /** 平均等待时间累加 MS */
  totalWaitMs: 0,
  /** 等待时间样本数 */
  waitSamples: 0,
  /** 最后一次决策时间 */
  lastDecisionAt: null as string | null,
};

/** 记录调度决策指标 */
export function recordScheduleMetric(kind: "immediate" | "dep_blocked" | "concurrency_blocked" | "preemption", waitMs?: number): void {
  schedulerMetrics.totalDecisions++;
  schedulerMetrics.lastDecisionAt = new Date().toISOString();
  if (kind === "immediate") schedulerMetrics.immediateSchedules++;
  else if (kind === "dep_blocked") schedulerMetrics.dependencyBlocks++;
  else if (kind === "concurrency_blocked") schedulerMetrics.concurrencyBlocks++;
  else if (kind === "preemption") schedulerMetrics.preemptions++;
  if (waitMs !== undefined && waitMs > 0) {
    schedulerMetrics.totalWaitMs += waitMs;
    schedulerMetrics.waitSamples++;
  }
}

/** 记录饥饿提升指标 */
export function recordStarvationBoost(count: number): void {
  schedulerMetrics.starvationBoosts += count;
}

/** 获取调度器指标快照 */
export function getSchedulerMetrics(): {
  totalDecisions: number;
  immediateSchedules: number;
  dependencyBlocks: number;
  concurrencyBlocks: number;
  preemptions: number;
  starvationBoosts: number;
  avgWaitMs: number | null;
  lastDecisionAt: string | null;
} {
  return {
    ...schedulerMetrics,
    avgWaitMs: schedulerMetrics.waitSamples > 0
      ? Math.round(schedulerMetrics.totalWaitMs / schedulerMetrics.waitSamples)
      : null,
  };
}

/** 重置指标（测试用） */
export function resetSchedulerMetrics(): void {
  schedulerMetrics.totalDecisions = 0;
  schedulerMetrics.immediateSchedules = 0;
  schedulerMetrics.dependencyBlocks = 0;
  schedulerMetrics.concurrencyBlocks = 0;
  schedulerMetrics.preemptions = 0;
  schedulerMetrics.starvationBoosts = 0;
  schedulerMetrics.totalWaitMs = 0;
  schedulerMetrics.waitSamples = 0;
  schedulerMetrics.lastDecisionAt = null;
}

/* ================================================================== */
/*  P2-G7: 调度指标持久化                                                */
/* ================================================================== */

/**
 * 将当前调度器指标快照写入数据库。
 * 单行 UPSERT + 追加历史记录。
 * 由 taskQueueSupervisor tick 附带调用。
 */
export async function persistSchedulerMetrics(pool: Pool): Promise<void> {
  const snapshot = getSchedulerMetrics();
  const jsonStr = JSON.stringify(snapshot);

  try {
    // UPSERT 最新快照
    await pool.query(
      `INSERT INTO scheduler_metrics_snapshots (snapshot_id, metrics, snapshot_at)
       VALUES ('singleton', $1::jsonb, now())
       ON CONFLICT (snapshot_id) DO UPDATE
         SET metrics = $1::jsonb, snapshot_at = now()`,
      [jsonStr],
    );

    // 追加历史快照
    await pool.query(
      `INSERT INTO scheduler_metrics_history (metrics, snapshot_at) VALUES ($1::jsonb, now())`,
      [jsonStr],
    );

    // 清理 7 天前的历史快照
    await pool.query(
      `DELETE FROM scheduler_metrics_history WHERE snapshot_at < now() - interval '7 days'`,
    );
  } catch (err: any) {
    log("warn", `Failed to persist scheduler metrics`, { error: err?.message });
  }
}
