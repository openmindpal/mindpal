/**
 * MetricsSchema — Agent 可观测性指标元数据定义
 * 统一 agent.{domain}.{metric} 命名规范
 * 供 Prometheus 注册和 Grafana 面板消费
 */

/** 指标类型 */
export type MetricType = "counter" | "histogram" | "gauge";

/** 指标元数据定义 */
export interface MetricDefinition {
  /** 指标类型：counter / histogram / gauge */
  type: MetricType;
  /** 指标单位（Prometheus 惯例："1" 表示无量纲） */
  unit: string;
  /** 指标描述（HELP 行） */
  desc: string;
  /** 可选标签名列表 */
  labels?: string[];
  /** 直方图桶边界（仅 histogram 类型） */
  buckets?: number[];
}

/**
 * Agent 核心指标定义（标准化命名）
 *
 * 命名规范：agent.{domain}.{metric}
 * - domain: loop / iteration / tool / decision / phase / cache / config
 * - metric: 具体度量含义
 */
export const AGENT_METRICS: Record<string, MetricDefinition> = {
  // ── 计数器 ──────────────────────────────────────
  "agent.loop.total": {
    type: "counter",
    unit: "1",
    desc: "Agent Loop total executions",
  },
  "agent.loop.errors": {
    type: "counter",
    unit: "1",
    desc: "Agent Loop failures",
  },
  "agent.iteration.total": {
    type: "counter",
    unit: "1",
    desc: "Total iterations across all loops",
  },
  "agent.tool.calls": {
    type: "counter",
    unit: "1",
    desc: "Total tool invocations",
    labels: ["tool"],
  },
  "agent.tool.errors": {
    type: "counter",
    unit: "1",
    desc: "Tool invocation failures",
    labels: ["tool"],
  },
  "agent.decision.total": {
    type: "counter",
    unit: "1",
    desc: "Agent decisions made",
    labels: ["decision_type"],
  },

  // ── 直方图 ──────────────────────────────────────
  "agent.loop.duration_ms": {
    type: "histogram",
    unit: "ms",
    desc: "Agent Loop total duration",
    buckets: [100, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000],
  },
  "agent.iteration.duration_ms": {
    type: "histogram",
    unit: "ms",
    desc: "Single iteration duration",
    buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
  },
  "agent.phase.duration_ms": {
    type: "histogram",
    unit: "ms",
    desc: "Single phase duration",
    labels: ["phase"],
    buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000],
  },
  "agent.tool.duration_ms": {
    type: "histogram",
    unit: "ms",
    desc: "Tool call duration",
    labels: ["tool"],
    buckets: [10, 50, 100, 250, 500, 1000, 2000, 5000, 10000],
  },

  // ── 仪表 ────────────────────────────────────────
  "agent.loop.active": {
    type: "gauge",
    unit: "1",
    desc: "Currently active Agent Loops",
  },
  "agent.cache.hit_ratio": {
    type: "gauge",
    unit: "ratio",
    desc: "Cache hit ratio (hits / (hits + misses))",
  },
  "agent.cache.size": {
    type: "gauge",
    unit: "1",
    desc: "Cache entry count",
    labels: ["tier"],
  },
  "agent.cache.evictions": {
    type: "counter",
    unit: "1",
    desc: "Cache eviction count",
    labels: ["tier"],
  },
  "agent.config.version": {
    type: "gauge",
    unit: "1",
    desc: "Current config version (for monitoring hot updates)",
    labels: ["key"],
  },

  // ── 阶段内细粒度指标 ──────────────────────────────
  "agent.think.llm_duration_ms": {
    type: "histogram",
    unit: "ms",
    desc: "LLM single call latency",
    buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
  },
  "agent.think.retry_count": {
    type: "counter",
    unit: "1",
    desc: "Decision quality retry total",
  },
  "agent.think.confidence": {
    type: "gauge",
    unit: "1",
    desc: "Decision confidence score",
  },
  "agent.observe.db_duration_ms": {
    type: "histogram",
    unit: "ms",
    desc: "Observe phase DB query latency",
    buckets: [1, 5, 10, 25, 50, 100, 250],
  },
  "agent.drift.score": {
    type: "gauge",
    unit: "1",
    desc: "Intent drift score",
  },
  "agent.drift.detection_method": {
    type: "counter",
    unit: "1",
    desc: "Drift detection method distribution",
    labels: ["method"],
  },
} as const;

/**
 * 获取指标的 Prometheus 风格名称
 * agent.loop.total → agent_loop_total
 */
export function toPrometheusName(metricName: string): string {
  return metricName.replace(/\./g, "_");
}

/**
 * 获取所有指标名称列表
 */
export function listMetricNames(): string[] {
  return Object.keys(AGENT_METRICS);
}

/**
 * 查询指标定义
 */
export function getMetricDefinition(name: string): MetricDefinition | undefined {
  return AGENT_METRICS[name];
}
