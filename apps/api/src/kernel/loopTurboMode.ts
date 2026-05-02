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

/* ================================================================== */
/*  TurboPolicy — 统一配置对象                                          */
/* ================================================================== */

export interface TurboPolicy {
  /** 是否跳过 fast tier 检查点写入 */
  skipFastCheckpoint: boolean;
  /** 是否跳过治理中的 policy/safety 检查 */
  skipPolicySafety: boolean;
  /** 是否跳过意图漂移检测（需结合 iteration 判断） */
  skipIntentDrift: boolean;
  /** 是否跳过决策质量重试 */
  skipDecisionRetry: boolean;
  /** 是否跳过动态策略检索（需结合 iteration 判断） */
  skipStrategyRecall: boolean;
}

let _cachedPolicy: TurboPolicy | null = null;

/** 获取 Turbo 策略配置（单例缓存，避免重复读取环境变量） */
export function getTurboPolicy(): TurboPolicy {
  if (!_cachedPolicy) {
    const turboEnabled = resolveBoolean("AGENT_LOOP_TURBO_MODE", undefined, undefined, false).value;
    _cachedPolicy = {
      skipFastCheckpoint: turboEnabled,
      skipPolicySafety: turboEnabled,
      skipIntentDrift: turboEnabled,
      skipDecisionRetry: turboEnabled,
      skipStrategyRecall: turboEnabled,
    };
  }
  return _cachedPolicy;
}

/** 重置缓存（用于测试或配置热更新） */
export function invalidateTurboCache(): void {
  _cachedPolicy = null;
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
  return getTurboPolicy().skipFastCheckpoint && TURBO_ALLOWED_TENANTS.has(tenantId);
}
