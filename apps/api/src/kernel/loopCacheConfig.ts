/**
 * loopCacheConfig.ts — Agent Loop 准备阶段缓存配置与工具
 *
 * 从 agentLoop.ts 提取，环境变量已注册到 @openslin/shared configRegistry。
 * 提供：
 * - getCacheConfig()      — 缓存 TTL / 容量 / 开关
 * - getLightIterationConfig() — 轻迭代模式配置
 * - cacheGet / cacheSet / prepareCacheKey — LRU 缓存操作
 * - isLightIteration  — 轻迭代判断
 */

import { resolveNumber, resolveBoolean, createMemoryCacheManager, type CacheManager, type CacheStats } from "@openslin/shared";

/* ================================================================== */
/*  P1-8/P1-9: 准备阶段缓存分层 + 会话级缓存                              */
/* ================================================================== */

/** 缓存配置显式类型 */
export interface CacheConfig {
  TOOL_DISCOVERY_TTL_MS: number;
  MEMORY_RECALL_TTL_MS: number;
  STRATEGY_RECALL_TTL_MS: number;
  ENABLED: boolean;
  MAX_SIZE: number;
  PURGE_INTERVAL_MS: number;
}

/** 缓存 getCacheConfig 结果 */
let _cacheConfigCache: CacheConfig | null = null;

/** P1-8: 缓存配置（环境变量已注册到 configRegistry.data.json） */
export function getCacheConfig() {
  if (_cacheConfigCache) return _cacheConfigCache;
  _cacheConfigCache = {
    /** 工具发现缓存 TTL (ms)，默认 30s */
    TOOL_DISCOVERY_TTL_MS: resolveNumber("CACHE_TOOL_DISCOVERY_TTL_MS", undefined, undefined, 30000).value,
    /** 记忆召回缓存 TTL (ms)，默认 60s */
    MEMORY_RECALL_TTL_MS: resolveNumber("CACHE_MEMORY_RECALL_TTL_MS", undefined, undefined, 60000).value,
    /** 策略召回缓存 TTL (ms)，默认 120s */
    STRATEGY_RECALL_TTL_MS: resolveNumber("CACHE_STRATEGY_RECALL_TTL_MS", undefined, undefined, 120000).value,
    /** 启用缓存 */
    ENABLED: resolveBoolean("AGENT_PREPARE_CACHE_ENABLED", undefined, undefined, true).value,
    /** P0-4: 缓存最大条目数，超出后淘汰最旧条目 */
    MAX_SIZE: resolveNumber("AGENT_PREPARE_CACHE_MAX_SIZE", undefined, undefined, 500).value,
    /** P0-4: 过期清理间隔 (ms)，默认 60s */
    PURGE_INTERVAL_MS: resolveNumber("AGENT_PREPARE_CACHE_PURGE_MS", undefined, undefined, 60000).value,
  };
  return _cacheConfigCache;
}

/** 内部 CacheManager 单例（懒初始化） */
let _cacheManager: CacheManager | null = null;
function getCacheManager(): CacheManager {
  if (!_cacheManager) {
    const config = getCacheConfig();
    _cacheManager = createMemoryCacheManager({
      maxSize: config.MAX_SIZE,
      defaultTtlMs: config.MEMORY_RECALL_TTL_MS,
      purgeIntervalMs: config.PURGE_INTERVAL_MS,
    });
  }
  return _cacheManager;
}

export function cacheGet<T>(key: string): T | undefined {
  return getCacheManager().get<T>("session", key);
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  getCacheManager().set<T>("session", key, value, ttlMs);
}

/** 获取缓存统计信息 */
export function getCacheStats(): CacheStats {
  return getCacheManager().stats();
}

/** P1-9: 会话级缓存 key 生成（基于 tenant+space，短时间窗口复用） */
export function prepareCacheKey(prefix: string, tenantId: string, spaceId: string): string {
  return `${prefix}:${tenantId}:${spaceId}`;
}

/* ================================================================== */
/*  P1-11: 轻迭代模式配置                                                */
/* ================================================================== */

/** 轻迭代配置显式类型 */
export interface LightIterationConfig {
  ENABLED: boolean;
  LIGHT_ROUNDS: number;
  MAX_PARALLEL_TOOLS_LIGHT: number;
}

/** 缓存 getLightIterationConfig 结果 */
let _lightIterationConfigCache: LightIterationConfig | null = null;

export function getLightIterationConfig() {
  if (_lightIterationConfigCache) return _lightIterationConfigCache;
  _lightIterationConfigCache = {
    /** 启用轻迭代模式 */
    ENABLED: resolveBoolean("AGENT_LIGHT_ITERATION", undefined, undefined, true).value,
    /** 前 N 轮为轻迭代 */
    LIGHT_ROUNDS: resolveNumber("AGENT_LIGHT_ROUNDS", undefined, undefined, 2).value,
    /** 轻迭代模式下最大并行工具调用数 */
    MAX_PARALLEL_TOOLS_LIGHT: resolveNumber("AGENT_LIGHT_MAX_TOOLS", undefined, undefined, 2).value,
  };
  return _lightIterationConfigCache;
}

/** P1-11: 判断当前迭代是否为轻迭代模式 */
export function isLightIteration(iteration: number): boolean {
  const cfg = getLightIterationConfig();
  return cfg.ENABLED && iteration <= cfg.LIGHT_ROUNDS;
}

/* ================================================================== */
/*  配置热更新：缓存配置自动重载                                          */
/* ================================================================== */

/**
 * 订阅缓存相关配置的热更新事件。
 * 当 CACHE_* 或 AGENT_PREPARE_CACHE_* 配置变更时，自动重置缓存管理器，
 * 下次调用 getCacheManager() 时使用新配置重新构建。
 */
export function subscribeCacheConfigUpdates(
  subscribe: (channel: string, handler: (event: any) => void) => Promise<unknown>,
  log?: { warn?: (...a: unknown[]) => void },
): void {
  subscribe("config.updated.*", (event) => {
    const key = event?.payload?.key as string;
    if (key && (key.startsWith("CACHE_") || key.startsWith("AGENT_PREPARE_CACHE_"))) {
      resetCacheManager();
    }
  }).catch((err) => {
    (log?.warn ?? console.warn)("[loopCacheConfig] subscribe config.updated.* failed (non-fatal)", err);
  });
}

/** 重置缓存管理器，释放资源并置空单例 */
function resetCacheManager(): void {
  if (_cacheManager) {
    _cacheManager.shutdown();
    _cacheManager = null;
  }
  // 同时重置配置缓存，确保热更新生效
  _cacheConfigCache = null;
  _lightIterationConfigCache = null;
}
