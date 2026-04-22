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

import { resolveNumber, resolveBoolean } from "@openslin/shared";

/* ================================================================== */
/*  P1-8/P1-9: 准备阶段缓存分层 + 会话级缓存                              */
/* ================================================================== */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const _prepareCache = new Map<string, CacheEntry<any>>();

/** P1-8: 缓存配置（环境变量已注册到 configRegistry.data.json） */
export function getCacheConfig() {
  return {
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
}

/** P0-4: 定期清理过期条目 */
let _purgeCacheTimer: ReturnType<typeof setInterval> | null = null;
function _ensurePurgeCacheTimer(): void {
  if (_purgeCacheTimer) return;
  _purgeCacheTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _prepareCache) {
      if (now > v.expiresAt) _prepareCache.delete(k);
    }
  }, getCacheConfig().PURGE_INTERVAL_MS);
  if (typeof _purgeCacheTimer === 'object' && 'unref' in _purgeCacheTimer) {
    (_purgeCacheTimer as any).unref();
  }
}

export function cacheGet<T>(key: string): T | undefined {
  const entry = _prepareCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    _prepareCache.delete(key);
    return undefined;
  }
  // LRU touch: 重新插入使其排在 Map 迭代尾部（最近使用）
  _prepareCache.delete(key);
  _prepareCache.set(key, entry);
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  _ensurePurgeCacheTimer();
  // 如果已存在则先删除（保持 LRU 顺序）
  _prepareCache.delete(key);
  _prepareCache.set(key, { value, expiresAt: Date.now() + ttlMs });
  // P0-4: 超过 maxSize 时淘汰最旧条目（Map 迭代顺序 = 插入顺序）
  while (_prepareCache.size > getCacheConfig().MAX_SIZE) {
    const oldest = _prepareCache.keys().next().value;
    if (oldest !== undefined) _prepareCache.delete(oldest);
    else break;
  }
}

/** P1-9: 会话级缓存 key 生成（基于 tenant+space，短时间窗口复用） */
export function prepareCacheKey(prefix: string, tenantId: string, spaceId: string): string {
  return `${prefix}:${tenantId}:${spaceId}`;
}

/* ================================================================== */
/*  P1-11: 轻迭代模式配置                                                */
/* ================================================================== */

export function getLightIterationConfig() {
  return {
    /** 启用轻迭代模式 */
    ENABLED: resolveBoolean("AGENT_LIGHT_ITERATION", undefined, undefined, true).value,
    /** 前 N 轮为轻迭代 */
    LIGHT_ROUNDS: resolveNumber("AGENT_LIGHT_ROUNDS", undefined, undefined, 2).value,
    /** 轻迭代模式下最大并行工具调用数 */
    MAX_PARALLEL_TOOLS_LIGHT: resolveNumber("AGENT_LIGHT_MAX_TOOLS", undefined, undefined, 2).value,
  };
}

/** P1-11: 判断当前迭代是否为轻迭代模式 */
export function isLightIteration(iteration: number): boolean {
  const cfg = getLightIterationConfig();
  return cfg.ENABLED && iteration <= cfg.LIGHT_ROUNDS;
}
