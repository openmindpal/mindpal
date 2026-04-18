/**
 * loopCacheConfig.ts — Agent Loop 准备阶段缓存配置与工具
 *
 * 从 agentLoop.ts 提取，环境变量已注册到 @openslin/shared configRegistry。
 * 提供：
 * - CACHE_CONFIG      — 缓存 TTL / 容量 / 开关
 * - LIGHT_ITERATION_CONFIG — 轻迭代模式配置
 * - cacheGet / cacheSet / prepareCacheKey — LRU 缓存操作
 * - isLightIteration  — 轻迭代判断
 */

/* ================================================================== */
/*  P1-8/P1-9: 准备阶段缓存分层 + 会话级缓存                              */
/* ================================================================== */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const _prepareCache = new Map<string, CacheEntry<any>>();

/** P1-8: 缓存配置（环境变量已注册到 configRegistry.data.json） */
export const CACHE_CONFIG = {
  /** 工具发现缓存 TTL (ms)，默认 30s */
  TOOL_DISCOVERY_TTL_MS: parseInt(process.env.CACHE_TOOL_DISCOVERY_TTL_MS ?? "30000", 10),
  /** 记忆召回缓存 TTL (ms)，默认 60s */
  MEMORY_RECALL_TTL_MS: parseInt(process.env.CACHE_MEMORY_RECALL_TTL_MS ?? "60000", 10),
  /** 策略召回缓存 TTL (ms)，默认 120s */
  STRATEGY_RECALL_TTL_MS: parseInt(process.env.CACHE_STRATEGY_RECALL_TTL_MS ?? "120000", 10),
  /** 启用缓存 */
  ENABLED: (process.env.AGENT_PREPARE_CACHE_ENABLED ?? "1") === "1",
  /** P0-4: 缓存最大条目数，超出后淘汰最旧条目 */
  MAX_SIZE: parseInt(process.env.AGENT_PREPARE_CACHE_MAX_SIZE ?? "500", 10),
  /** P0-4: 过期清理间隔 (ms)，默认 60s */
  PURGE_INTERVAL_MS: parseInt(process.env.AGENT_PREPARE_CACHE_PURGE_MS ?? "60000", 10),
};

/** P0-4: 定期清理过期条目 */
let _purgeCacheTimer: ReturnType<typeof setInterval> | null = null;
function _ensurePurgeCacheTimer(): void {
  if (_purgeCacheTimer) return;
  _purgeCacheTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _prepareCache) {
      if (now > v.expiresAt) _prepareCache.delete(k);
    }
  }, CACHE_CONFIG.PURGE_INTERVAL_MS);
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
  while (_prepareCache.size > CACHE_CONFIG.MAX_SIZE) {
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

export const LIGHT_ITERATION_CONFIG = {
  /** 启用轻迭代模式 */
  ENABLED: (process.env.AGENT_LIGHT_ITERATION ?? "1") === "1",
  /** 前 N 轮为轻迭代 */
  LIGHT_ROUNDS: parseInt(process.env.AGENT_LIGHT_ROUNDS ?? "2", 10),
  /** 轻迭代模式下最大并行工具调用数 */
  MAX_PARALLEL_TOOLS_LIGHT: parseInt(process.env.AGENT_LIGHT_MAX_TOOLS ?? "2", 10),
};

/** P1-11: 判断当前迭代是否为轻迭代模式 */
export function isLightIteration(iteration: number): boolean {
  return LIGHT_ITERATION_CONFIG.ENABLED && iteration <= LIGHT_ITERATION_CONFIG.LIGHT_ROUNDS;
}
