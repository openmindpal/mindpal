/**
 * Device-OS 内核：端侧工具执行指标采集器
 *
 * 采集维度：
 * - 成功率（success_rate）
 * - 平均延迟 / P99 延迟（avg_latency / p99_latency）
 * - 策略拒绝率（policy_denied_rate）
 * - 用户拒绝率（user_denied_rate）
 * - 插件异常率（plugin_exception_rate）
 * - 灰度禁用次数（feature_disabled_count）
 *
 * 指标按工具名聚合，支持滑动窗口（默认 5 分钟）。
 * 本地诊断 + 随心跳上报至 API 层。
 *
 * @layer kernel
 */

// ── 类型定义 ──────────────────────────────────────────────────

export interface ToolMetricsSample {
  toolName: string;
  timestamp: number;
  durationMs: number;
  outcome: "succeeded" | "failed" | "policy_denied" | "user_denied" | "feature_disabled" | "plugin_exception" | "unsupported";
}

export interface ToolMetricsSummary {
  toolName: string;
  /** 采样窗口内总调用次数 */
  totalCount: number;
  /** 成功次数 */
  successCount: number;
  /** 成功率 (0-1) */
  successRate: number;
  /** 平均延迟 (ms) */
  avgLatencyMs: number;
  /** P99 延迟 (ms) */
  p99LatencyMs: number;
  /** 策略拒绝次数 */
  policyDeniedCount: number;
  /** 用户拒绝次数 */
  userDeniedCount: number;
  /** 插件异常次数 */
  pluginExceptionCount: number;
  /** 灰度禁用次数 */
  featureDisabledCount: number;
  /** 不支持工具次数 */
  unsupportedCount: number;
  /** 窗口起始时间 */
  windowStartMs: number;
  /** 窗口结束时间 */
  windowEndMs: number;
}

// ── 内部状态 ──────────────────────────────────────────────────

/** 滑动窗口大小（ms） */
let _windowMs = 5 * 60 * 1000; // 默认 5 分钟
/** 最大保留样本数（每工具） */
const MAX_SAMPLES_PER_TOOL = 500;
/** 工具 → 采样列表 */
const _samples = new Map<string, ToolMetricsSample[]>();

// ── 采集 API ─────────────────────────────────────────────────

/** 配置采集窗口 */
export function setMetricsWindow(windowMs: number): void {
  _windowMs = windowMs;
}

/** 记录一次工具执行指标 */
export function recordToolMetric(sample: ToolMetricsSample): void {
  let list = _samples.get(sample.toolName);
  if (!list) {
    list = [];
    _samples.set(sample.toolName, list);
  }
  list.push(sample);
  // 淘汰过旧样本
  const cutoff = Date.now() - _windowMs * 2;
  while (list.length > MAX_SAMPLES_PER_TOOL || (list.length > 0 && list[0].timestamp < cutoff)) {
    list.shift();
  }
}

/** 便捷记录：从执行结果自动推断 outcome */
export function recordFromExecution(toolName: string, durationMs: number, errorCategory?: string): void {
  let outcome: ToolMetricsSample["outcome"] = "succeeded";
  if (errorCategory) {
    if (errorCategory === "policy_violation" || errorCategory === "access_denied") outcome = "policy_denied";
    else if (errorCategory === "user_denied") outcome = "user_denied";
    else if (errorCategory === "feature_disabled") outcome = "feature_disabled";
    else if (errorCategory === "plugin_exception") outcome = "plugin_exception";
    else if (errorCategory === "unsupported_tool") outcome = "unsupported";
    else outcome = "failed";
  }
  recordToolMetric({ toolName, timestamp: Date.now(), durationMs, outcome });
}

// ── 查询 API ─────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, idx)];
}

/** 获取单个工具的指标摘要 */
export function getToolMetrics(toolName: string): ToolMetricsSummary | null {
  const list = _samples.get(toolName);
  if (!list || list.length === 0) return null;

  const now = Date.now();
  const windowStart = now - _windowMs;
  const inWindow = list.filter(s => s.timestamp >= windowStart);
  if (inWindow.length === 0) return null;

  const successSamples = inWindow.filter(s => s.outcome === "succeeded");
  const latencies = successSamples.map(s => s.durationMs).sort((a, b) => a - b);

  return {
    toolName,
    totalCount: inWindow.length,
    successCount: successSamples.length,
    successRate: inWindow.length > 0 ? successSamples.length / inWindow.length : 0,
    avgLatencyMs: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    p99LatencyMs: percentile(latencies, 0.99),
    policyDeniedCount: inWindow.filter(s => s.outcome === "policy_denied").length,
    userDeniedCount: inWindow.filter(s => s.outcome === "user_denied").length,
    pluginExceptionCount: inWindow.filter(s => s.outcome === "plugin_exception").length,
    featureDisabledCount: inWindow.filter(s => s.outcome === "feature_disabled").length,
    unsupportedCount: inWindow.filter(s => s.outcome === "unsupported").length,
    windowStartMs: windowStart,
    windowEndMs: now,
  };
}

/** 获取所有工具的指标摘要 */
export function getToolMetricsSummary(): ToolMetricsSummary[] {
  const summaries: ToolMetricsSummary[] = [];
  for (const toolName of _samples.keys()) {
    const summary = getToolMetrics(toolName);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

/** 导出指标快照（供心跳上报） */
export function exportMetricsSnapshot(): ToolMetricsSummary[] {
  return getToolMetricsSummary();
}

/** 重置所有指标（仅用于测试） */
export function resetMetrics(): void {
  _samples.clear();
}
