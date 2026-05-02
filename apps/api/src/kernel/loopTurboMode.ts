/**
 * loopTurboMode — Agent Loop 加速模式配置
 *
 * 通过 AGENT_LOOP_TURBO_MODE=true 启用，在牺牲部分治理完整性的前提下
 * 显著降低单次迭代延迟。适用于开发环境、低合规要求场景。
 *
 * 加速策略：
 * - 检查点写入：跳过 fast tier，仅保留 full tier
 * - 治理预检查：仅执行 permission + availability（跳过 policy/safety）
 * - 意图漂移检测：仅奇数迭代执行
 * - 决策质量重试：禁用（直接接受首次决策）
 * - 动态策略检索：仅第 1 次迭代执行
 */
import { resolveBoolean } from "@mindpal/shared";

let _turboMode: boolean | null = null;

/** 是否启用加速模式 */
export function isTurboMode(): boolean {
  if (_turboMode === null) {
    _turboMode = resolveBoolean("AGENT_LOOP_TURBO_MODE", undefined, undefined, false).value;
  }
  return _turboMode;
}

/** 加速模式下是否应跳过 fast tier 检查点写入 */
export function turboSkipFastCheckpoint(): boolean {
  return isTurboMode();
}

/** 加速模式下是否应跳过治理中的 policy/safety 检查 */
export function turboSkipPolicySafety(): boolean {
  return isTurboMode();
}

/** 加速模式下是否应跳过当前迭代的意图漂移检测 */
export function turboSkipIntentDrift(iteration: number): boolean {
  return isTurboMode() && iteration % 2 === 0; // 仅奇数迭代执行
}

/** 加速模式下是否应跳过决策质量重试 */
export function turboSkipDecisionRetry(): boolean {
  return isTurboMode();
}

/** 加速模式下是否应跳过当前迭代的动态策略检索 */
export function turboSkipStrategyRecall(iteration: number): boolean {
  return isTurboMode() && iteration > 1; // 仅第 1 次迭代执行
}

// 允许 turbo 模式的租户白名单（仅开发/沙盒租户）
const TURBO_ALLOWED_TENANTS = new Set(
  (process.env.AGENT_LOOP_TURBO_ALLOWED_TENANTS || 'tenant_dev').split(',').map(s => s.trim())
);

/**
 * 检查指定租户是否允许使用 Turbo 模式
 * 即使全局 AGENT_LOOP_TURBO_MODE=true，也只有白名单内的租户才能启用
 */
export function isTurboAllowedForTenant(tenantId: string): boolean {
  return isTurboMode() && TURBO_ALLOWED_TENANTS.has(tenantId);
}

/** 重置缓存（用于测试或配置热更新） */
export function resetTurboModeCache(): void {
  _turboMode = null;
}
