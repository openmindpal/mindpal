/**
 * Device-OS 内核：工具级灰度开关 + 熔断器
 *
 * 双渠道加载：
 * 1. 环境变量：FF_TOOL_<toolName>=1/0（"_" 转 "."）
 * 2. 策略下发：CachedPolicy.toolFeatureFlags
 *
 * 熔断逻辑委托给 @openslin/shared CircuitBreaker 实现，
 * 避免与平台底座的重复实现。灰度开关 + 降级规则仍由本模块管理。
 *
 * @layer kernel
 */

import {
  getOrCreateBreaker, clearBreakerRegistry,
  type CircuitBreakerState as SharedCircuitState,
} from "@openslin/shared";

// ── 类型定义 ──────────────────────────────────────────────────

export interface ToolFeatureFlag {
  /** 工具名（标准名，如 device.browser.open） */
  toolName: string;
  /** 是否启用（灰度开关） */
  enabled: boolean;
  /** 来源：env=环境变量 / policy=策略下发 / circuit=熔断器自动禁用 */
  source: "env" | "policy" | "circuit";
}

export interface CircuitBreakerConfig {
  /** 连续失败阈值（默认 5） */
  failureThreshold: number;
  /** 半开窗口（ms），超过此时间后尝试恢复（默认 60_000） */
  halfOpenWindowMs: number;
  /** 半开窗口内允许的试探请求数（默认 1） */
  halfOpenMaxAttempts: number;
}

/** 复用 shared CircuitBreakerState（"closed" | "open" | "half_open"） */
export type CircuitState = SharedCircuitState;

export interface DegradationRule {
  /** 降级到的替代工具名（可选） */
  fallbackTool?: string;
  /** 降级时返回的错误类别 */
  errorCategory: string;
  /** 降级消息 */
  message?: string;
}

// ── 内部状态 ──────────────────────────────────────────────────

/** 工具级灰度开关（true=已启用） */
const _featureFlags = new Map<string, ToolFeatureFlag>();
/** 工具级降级规则 */
const _degradationRules = new Map<string, DegradationRule>();
/** 全局熔断配置（创建新熔断器时使用） */
let _circuitConfig: CircuitBreakerConfig = {
  failureThreshold: 5,
  halfOpenWindowMs: 60_000,
  halfOpenMaxAttempts: 1,
};

/** 获取（或创建）工具级熔断器，委托给 shared CircuitBreaker */
function _getToolBreaker(toolName: string) {
  return getOrCreateBreaker(`device-tool:${toolName}`, {
    failureThreshold: _circuitConfig.failureThreshold,
    resetTimeoutMs: _circuitConfig.halfOpenWindowMs,
    halfOpenMaxAttempts: _circuitConfig.halfOpenMaxAttempts,
  });
}

// ── 灰度开关 API ─────────────────────────────────────────────

/** 从环境变量加载灰度开关。约定：FF_TOOL_<TOOLNAME>=1/0（"_"转"."） */
export function loadFeatureFlagsFromEnv(): number {
  const PREFIX = "FF_TOOL_";
  let count = 0;
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(PREFIX) && value !== undefined) {
      const toolName = key.slice(PREFIX.length).replace(/_/g, ".").toLowerCase();
      const enabled = value === "1" || value.toLowerCase() === "true";
      _featureFlags.set(toolName, { toolName, enabled, source: "env" });
      count++;
    }
  }
  return count;
}

/** 从策略下发更新灰度开关 */
export function syncFeatureFlagsFromPolicy(flags: Record<string, boolean>): void {
  for (const [toolName, enabled] of Object.entries(flags)) {
    const existing = _featureFlags.get(toolName);
    // 环境变量优先级高于策略
    if (existing && existing.source === "env") continue;
    _featureFlags.set(toolName, { toolName, enabled, source: "policy" });
  }
}

/** 从策略下发更新降级规则 */
export function syncDegradationRules(rules: Record<string, DegradationRule>): void {
  for (const [toolName, rule] of Object.entries(rules)) {
    _degradationRules.set(toolName, rule);
  }
}

/** 更新熔断器全局配置 */
export function setCircuitBreakerConfig(config: Partial<CircuitBreakerConfig>): void {
  _circuitConfig = { ..._circuitConfig, ...config };
}

/** 判断工具是否被灰度启用（综合灰度开关 + 熔断器状态） */
export function isToolFeatureEnabled(toolName: string): { enabled: boolean; reason?: string } {
  // 1. 检查灰度开关
  const flag = _featureFlags.get(toolName);
  if (flag && !flag.enabled && flag.source !== "circuit") {
    return { enabled: false, reason: `feature_disabled_by_${flag.source}` };
  }

  // 2. 检查熔断器（委托 shared CircuitBreaker，自动处理 open→half_open 过渡）
  const breaker = _getToolBreaker(toolName);
  const state = breaker.getState();
  if (state === "open") {
    return { enabled: false, reason: "circuit_breaker_open" };
  }

  return { enabled: true };
}

/** 获取工具的降级规则（如果有） */
export function getDegradationRule(toolName: string): DegradationRule | null {
  return _degradationRules.get(toolName) ?? null;
}

// ── 熔断器 API（委托 shared CircuitBreaker）─────────────────

/** 记录工具执行成功（重置熔断器） */
export function recordToolSuccess(toolName: string): void {
  const breaker = _getToolBreaker(toolName);
  breaker.recordSuccess();
  // 如果之前是熔断器自动禁用的，恢复灰度开关
  const flag = _featureFlags.get(toolName);
  if (flag && flag.source === "circuit") {
    _featureFlags.delete(toolName);
  }
}

/** 记录工具执行失败（推进熔断器状态） */
export function recordToolFailure(toolName: string): void {
  const breaker = _getToolBreaker(toolName);
  const prevState = breaker.getState();
  breaker.recordFailure();
  const newState = breaker.getState();
  // 熔断器从非 open → open 时，自动禁用灰度开关
  if (newState === "open" && prevState !== "open") {
    _featureFlags.set(toolName, { toolName, enabled: false, source: "circuit" });
  }
}

/** 获取熔断器状态 */
export function getCircuitBreakerState(toolName: string): { state: CircuitState; consecutiveFailures: number } | null {
  const breaker = _getToolBreaker(toolName);
  const metrics = breaker.getMetrics();
  return { state: metrics.state, consecutiveFailures: metrics.consecutiveFailures };
}

/** 列出所有灰度开关 */
export function listFeatureFlags(): ToolFeatureFlag[] {
  return Array.from(_featureFlags.values());
}

/** 重置所有状态（仅用于测试） */
export function resetFeatureFlags(): void {
  _featureFlags.clear();
  clearBreakerRegistry();
  _degradationRules.clear();
}

/** 初始化灰度控制：加载环境变量 + 可选策略 */
export function initFeatureFlags(policyFlags?: Record<string, boolean>, degradation?: Record<string, DegradationRule>, circuitConfig?: Partial<CircuitBreakerConfig>): void {
  loadFeatureFlagsFromEnv();
  if (policyFlags) syncFeatureFlagsFromPolicy(policyFlags);
  if (degradation) syncDegradationRules(degradation);
  if (circuitConfig) setCircuitBreakerConfig(circuitConfig);
}
