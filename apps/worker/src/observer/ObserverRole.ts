/**
 * P2-6: Observer 角色
 *
 * 被动监控协作过程，不参与执行但记录关键指标：
 *   - 角色间通信延迟
 *   - 步骤执行时长
 *   - 异常模式检测（连续失败、循环依赖、死锁）
 *   - SLA 违规预警
 *
 * Observer 以独立进程运行，通过轮询或事件订阅获取状态变更。
 */

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface ObserverConfig {
  /** 轮询间隔 (ms) */
  pollIntervalMs: number;
  /** SLA: 单步最大执行时间 (ms) */
  stepSlaMs: number;
  /** SLA: 协作总时间上限 (ms) */
  collabSlaMs: number;
  /** 连续失败触发告警的阈值 */
  consecutiveFailureThreshold: number;
  /** 是否启用死锁检测 */
  enableDeadlockDetection: boolean;
}

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  pollIntervalMs: 5000,
  stepSlaMs: 60_000,
  collabSlaMs: 600_000,
  consecutiveFailureThreshold: 3,
  enableDeadlockDetection: true,
};

export type ObserverAlert = {
  alertId: string;
  collabRunId: string;
  severity: "info" | "warning" | "critical";
  category: "sla_violation" | "consecutive_failure" | "deadlock" | "anomaly" | "stale";
  message: string;
  metadata: Record<string, unknown>;
  detectedAt: string;
  acknowledged: boolean;
};

export type ObserverMetrics = {
  collabRunId: string;
  /** 从创建到当前的经过时间 (ms) */
  elapsedMs: number;
  /** 各角色执行时间 */
  roleLatencies: Record<string, { totalMs: number; count: number; avgMs: number }>;
  /** 步骤统计 */
  stepStats: {
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    running: number;
  };
  /** 重规划次数 */
  replanCount: number;
  /** 回退次数 */
  rollbackCount: number;
  /** SLA 状态 */
  slaStatus: "ok" | "warning" | "violated";
  /** 健康评分 0~1 */
  healthScore: number;
  collectedAt: string;
};

/* ================================================================== */
/*  Observer Role Implementation                                        */
/* ================================================================== */

export class ObserverRole {
  private config: ObserverConfig;
  private alerts: ObserverAlert[] = [];
  private metricsCache = new Map<string, ObserverMetrics>();

  constructor(config?: Partial<ObserverConfig>) {
    this.config = { ...DEFAULT_OBSERVER_CONFIG, ...config };
  }

  /**
   * 收集协作运行的指标
   */
  collectMetrics(params: {
    collabRunId: string;
    createdAt: string;
    turns: Array<{
      turnNumber: number;
      actorRole: string;
      status: string;
      startedAt?: string;
      completedAt?: string;
    }>;
    steps: Array<{ stepId: string; status: string; actorRole: string }>;
    replanCount: number;
    rollbackCount: number;
  }): ObserverMetrics {
    const { collabRunId, createdAt, turns, steps, replanCount, rollbackCount } = params;

    const now = Date.now();
    const elapsedMs = now - new Date(createdAt).getTime();

    // 计算角色延迟
    const roleLatencies: Record<string, { totalMs: number; count: number; avgMs: number }> = {};
    for (const turn of turns) {
      if (turn.startedAt && turn.completedAt) {
        const duration = new Date(turn.completedAt).getTime() - new Date(turn.startedAt).getTime();
        if (!roleLatencies[turn.actorRole]) {
          roleLatencies[turn.actorRole] = { totalMs: 0, count: 0, avgMs: 0 };
        }
        roleLatencies[turn.actorRole].totalMs += duration;
        roleLatencies[turn.actorRole].count += 1;
        roleLatencies[turn.actorRole].avgMs =
          roleLatencies[turn.actorRole].totalMs / roleLatencies[turn.actorRole].count;
      }
    }

    // 步骤统计
    const stepStats = {
      total: steps.length,
      succeeded: steps.filter((s) => s.status === "succeeded").length,
      failed: steps.filter((s) => s.status === "failed").length,
      pending: steps.filter((s) => s.status === "pending").length,
      running: steps.filter((s) => s.status === "running").length,
    };

    // SLA 状态
    let slaStatus: "ok" | "warning" | "violated" = "ok";
    if (elapsedMs > this.config.collabSlaMs) {
      slaStatus = "violated";
    } else if (elapsedMs > this.config.collabSlaMs * 0.8) {
      slaStatus = "warning";
    }

    // 健康评分
    const successRate = stepStats.total > 0 ? stepStats.succeeded / stepStats.total : 1;
    const slaFactor = slaStatus === "ok" ? 1 : slaStatus === "warning" ? 0.7 : 0.3;
    const replanPenalty = Math.max(0, 1 - replanCount * 0.15);
    const healthScore = Math.max(0, Math.min(1, successRate * slaFactor * replanPenalty));

    const metrics: ObserverMetrics = {
      collabRunId,
      elapsedMs,
      roleLatencies,
      stepStats,
      replanCount,
      rollbackCount,
      slaStatus,
      healthScore,
      collectedAt: new Date().toISOString(),
    };

    this.metricsCache.set(collabRunId, metrics);
    return metrics;
  }

  /**
   * 检测异常模式
   */
  detectAnomalies(metrics: ObserverMetrics): ObserverAlert[] {
    const alerts: ObserverAlert[] = [];
    const now = new Date().toISOString();

    // SLA 违规
    if (metrics.slaStatus === "violated") {
      alerts.push({
        alertId: `sla-${metrics.collabRunId}-${Date.now()}`,
        collabRunId: metrics.collabRunId,
        severity: "critical",
        category: "sla_violation",
        message: `协作运行超过 SLA 时间限制 (${Math.round(metrics.elapsedMs / 1000)}s / ${this.config.collabSlaMs / 1000}s)`,
        metadata: { elapsedMs: metrics.elapsedMs, slaMs: this.config.collabSlaMs },
        detectedAt: now,
        acknowledged: false,
      });
    }

    // 连续失败
    if (metrics.stepStats.failed >= this.config.consecutiveFailureThreshold) {
      alerts.push({
        alertId: `fail-${metrics.collabRunId}-${Date.now()}`,
        collabRunId: metrics.collabRunId,
        severity: "warning",
        category: "consecutive_failure",
        message: `已有 ${metrics.stepStats.failed} 个步骤失败，超过告警阈值 ${this.config.consecutiveFailureThreshold}`,
        metadata: { failedCount: metrics.stepStats.failed },
        detectedAt: now,
        acknowledged: false,
      });
    }

    // 停滞检测（有运行中步骤但长时间无进展）
    if (metrics.stepStats.running > 0 && metrics.healthScore < 0.3) {
      alerts.push({
        alertId: `stale-${metrics.collabRunId}-${Date.now()}`,
        collabRunId: metrics.collabRunId,
        severity: "warning",
        category: "stale",
        message: `协作运行可能已停滞 (健康评分: ${(metrics.healthScore * 100).toFixed(0)}%)`,
        metadata: { healthScore: metrics.healthScore },
        detectedAt: now,
        acknowledged: false,
      });
    }

    this.alerts.push(...alerts);
    return alerts;
  }

  /**
   * 获取缓存的指标
   */
  getMetrics(collabRunId: string): ObserverMetrics | undefined {
    return this.metricsCache.get(collabRunId);
  }

  /**
   * 获取所有未确认的告警
   */
  getUnacknowledgedAlerts(): ObserverAlert[] {
    return this.alerts.filter((a) => !a.acknowledged);
  }

  /**
   * 确认告警
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.alertId === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }
    return false;
  }
}
