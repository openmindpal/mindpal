/**
 * CacheManager — 统一缓存抽象层
 *
 * 收敛 loopCacheConfig（LRU Map）、sessionScheduler（bare Map）等散布的缓存实现。
 * 支持 L1（内存）/ L2（Redis）分层、事件驱动失效、缓存统计。
 */

/* ================================================================== */
/*  类型定义                                                            */
/* ================================================================== */

/** 缓存分层 */
export type CacheTier = "request" | "session" | "computed" | "metadata";

/** 缓存统计信息 */
export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: Record<CacheTier, number>;
}

/** 统一缓存管理器接口 */
export interface CacheManager {
  /** 按 tier + key 获取缓存值 */
  get<T>(tier: CacheTier, key: string): T | undefined;
  /** 按 tier + key 写入缓存值，可指定 TTL（毫秒） */
  set<T>(tier: CacheTier, key: string, value: T, ttlMs?: number): void;
  /** 按 tier + key 删除缓存条目 */
  invalidate(tier: CacheTier, key: string): void;
  /** 按 tier + pattern 删除匹配的缓存条目（子串匹配） */
  invalidateByPattern(tier: CacheTier, pattern: string): void;
  /** 获取缓存统计快照 */
  stats(): CacheStats;
  /** 清空指定 tier 或全部缓存 */
  clear(tier?: CacheTier): void;
  /** 优雅关闭（清理定时器等） */
  shutdown(): void;
}

/** 内存缓存配置 */
export interface MemoryCacheOpts {
  /** 每个 tier 的最大条目数，默认 500 */
  maxSize?: number;
  /** 默认 TTL（毫秒），默认 60000 */
  defaultTtlMs?: number;
  /** 过期清理间隔（毫秒），默认 60000 */
  purgeIntervalMs?: number;
}

/** L1 + L2 分层缓存配置 */
export interface LayeredCacheOpts extends MemoryCacheOpts {
  /** Redis 客户端（可选，不可用时降级到纯内存） */
  redis?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
    del(key: string | string[]): Promise<unknown>;
    keys(pattern: string): Promise<string[]>;
  } | null;
  /** Redis key 前缀，默认 "cache:" */
  redisPrefix?: string;
  /** 哪些 tier 使用 L2 Redis，默认 ["computed", "metadata"] */
  l2Tiers?: CacheTier[];
}

/** 缓存条目 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/* ================================================================== */
/*  所有 CacheTier 常量                                                 */
/* ================================================================== */

const ALL_TIERS: readonly CacheTier[] = ["request", "session", "computed", "metadata"];

/* ================================================================== */
/*  createMemoryCacheManager                                            */
/* ================================================================== */

/**
 * 创建纯内存缓存管理器。
 * 为每个 CacheTier 维护独立的 LRU Map，支持 TTL 过期与定期清理。
 */
export function createMemoryCacheManager(opts?: MemoryCacheOpts): CacheManager {
  const maxSize = opts?.maxSize ?? 500;
  const defaultTtlMs = opts?.defaultTtlMs ?? 60_000;
  const purgeIntervalMs = opts?.purgeIntervalMs ?? 60_000;

  /** 每个 tier 独立的 Map */
  const stores = new Map<CacheTier, Map<string, CacheEntry<any>>>();
  for (const tier of ALL_TIERS) {
    stores.set(tier, new Map());
  }

  /** 统计计数器 */
  let hits = 0;
  let misses = 0;
  let evictions = 0;

  /** 获取 tier 的 Map（保证非空） */
  function getStore(tier: CacheTier): Map<string, CacheEntry<any>> {
    let s = stores.get(tier);
    if (!s) {
      s = new Map();
      stores.set(tier, s);
    }
    return s;
  }

  /** 清理所有 tier 中过期条目 */
  function purgeExpired(): void {
    const now = Date.now();
    for (const tier of ALL_TIERS) {
      const store = getStore(tier);
      for (const [k, v] of store) {
        if (now > v.expiresAt) store.delete(k);
      }
    }
  }

  /** 启动定期清理 */
  const purgeTimer = setInterval(purgeExpired, purgeIntervalMs);
  if (typeof purgeTimer === "object" && "unref" in purgeTimer) {
    (purgeTimer as any).unref();
  }

  const manager: CacheManager = {
    get<T>(tier: CacheTier, key: string): T | undefined {
      const store = getStore(tier);
      const entry = store.get(key);
      if (!entry) {
        misses++;
        return undefined;
      }
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        misses++;
        return undefined;
      }
      // LRU touch: delete + re-insert 使其排在 Map 迭代尾部
      store.delete(key);
      store.set(key, entry);
      hits++;
      return entry.value as T;
    },

    set<T>(tier: CacheTier, key: string, value: T, ttlMs?: number): void {
      const store = getStore(tier);
      const ttl = ttlMs ?? defaultTtlMs;
      // LRU: 先删后插保持顺序
      store.delete(key);
      store.set(key, { value, expiresAt: Date.now() + ttl });
      // 超过 maxSize 淘汰最旧条目
      while (store.size > maxSize) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) {
          store.delete(oldest);
          evictions++;
        } else {
          break;
        }
      }
    },

    invalidate(tier: CacheTier, key: string): void {
      getStore(tier).delete(key);
    },

    invalidateByPattern(tier: CacheTier, pattern: string): void {
      const store = getStore(tier);
      for (const k of [...store.keys()]) {
        if (k.includes(pattern)) store.delete(k);
      }
    },

    stats(): CacheStats {
      const size = {} as Record<CacheTier, number>;
      for (const tier of ALL_TIERS) {
        size[tier] = getStore(tier).size;
      }
      return { hits, misses, evictions, size };
    },

    clear(tier?: CacheTier): void {
      if (tier) {
        getStore(tier).clear();
      } else {
        for (const t of ALL_TIERS) getStore(t).clear();
      }
    },

    shutdown(): void {
      clearInterval(purgeTimer);
    },
  };

  return manager;
}

/* ================================================================== */
/*  createLayeredCacheManager                                           */
/* ================================================================== */

/**
 * 创建 L1（内存）+ L2（Redis）分层缓存管理器。
 * L2 不可用时自动降级到纯 L1（不抛异常，仅 warn 日志）。
 */
export function createLayeredCacheManager(opts: LayeredCacheOpts): CacheManager {
  const redis = opts.redis ?? null;
  const redisPrefix = opts.redisPrefix ?? "cache:";
  const l2Tiers = new Set<CacheTier>(opts.l2Tiers ?? ["computed", "metadata"]);

  /** L1 内存层 */
  const l1 = createMemoryCacheManager({
    maxSize: opts.maxSize,
    defaultTtlMs: opts.defaultTtlMs,
    purgeIntervalMs: opts.purgeIntervalMs,
  });

  /** 构造 Redis key */
  function rKey(tier: CacheTier, key: string): string {
    return `${redisPrefix}${tier}:${key}`;
  }

  /** 是否为 L2 tier */
  function isL2(tier: CacheTier): boolean {
    return l2Tiers.has(tier) && redis != null;
  }

  /** 安全执行 Redis 操作，失败不阻塞 */
  function safeRedis(fn: () => Promise<unknown>): void {
    fn().catch((err) => {
      if (typeof console !== "undefined") {
        console.warn("[CacheManager] Redis operation failed, degraded to L1:", String(err));
      }
    });
  }

  const manager: CacheManager = {
    get<T>(tier: CacheTier, key: string): T | undefined {
      // 同步只查 L1（L2 为异步，需调用方自行处理异步场景）
      return l1.get<T>(tier, key);
    },

    set<T>(tier: CacheTier, key: string, value: T, ttlMs?: number): void {
      l1.set<T>(tier, key, value, ttlMs);
      if (isL2(tier)) {
        const ttlSec = Math.ceil((ttlMs ?? opts.defaultTtlMs ?? 60_000) / 1000);
        safeRedis(() => redis!.set(rKey(tier, key), JSON.stringify(value), { EX: ttlSec }));
      }
    },

    invalidate(tier: CacheTier, key: string): void {
      l1.invalidate(tier, key);
      if (isL2(tier)) {
        safeRedis(() => redis!.del(rKey(tier, key)));
      }
    },

    invalidateByPattern(tier: CacheTier, pattern: string): void {
      l1.invalidateByPattern(tier, pattern);
      if (isL2(tier)) {
        safeRedis(async () => {
          const keys = await redis!.keys(`${redisPrefix}${tier}:*${pattern}*`);
          if (keys.length > 0) await redis!.del(keys);
        });
      }
    },

    stats(): CacheStats {
      return l1.stats();
    },

    clear(tier?: CacheTier): void {
      l1.clear(tier);
      // Redis clear 不做（避免误删其他服务数据）
    },

    shutdown(): void {
      l1.shutdown();
    },
  };

  return manager;
}
