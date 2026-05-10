"use strict";
/**
 * Layered Working Memory Store
 *
 * Two-tier storage engine for high-speed working memory:
 * - L1: In-process Map (zero latency, process lifecycle)
 * - L2: Redis (millisecond latency, cross-process, TTL auto-expiry)
 *
 * Read strategy: L1 hit → return; L1 miss → L2 query → backfill L1
 * Write strategy: Write-through (L1 + L2 simultaneously)
 *
 * Redis key format: wm:{namespace}:{key}
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkingMemoryStore = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const ttl_1 = require("./ttl");
const REDIS_KEY_PREFIX = 'wm';
const L1_SWEEP_INTERVAL = 10_000; // 10 seconds
const L1_MAX_SIZE = 10_000; // Max L1 entries before eviction
class WorkingMemoryStore {
    redisUrl;
    l1 = new Map();
    redis = null;
    redisAvailable = false;
    sweepTimer = null;
    stats = {
        l1Size: 0,
        l1Hits: 0,
        l1Misses: 0,
        l2Hits: 0,
        l2Misses: 0,
        totalSets: 0,
        totalGets: 0,
    };
    constructor(redisUrl) {
        this.redisUrl = redisUrl;
    }
    /** Initialize store (connect to Redis if available) */
    async init() {
        try {
            const url = this.redisUrl || process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}`;
            this.redis = new ioredis_1.default(url, {
                maxRetriesPerRequest: 2,
                retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
                lazyConnect: true,
            });
            await this.redis.connect();
            this.redisAvailable = true;
        }
        catch {
            // Redis unavailable, L1-only mode
            this.redisAvailable = false;
            this.redis = null;
        }
        this.startTtlSweep();
    }
    /** Store a value in working memory */
    async set(namespace, key, value, opts) {
        const importance = opts?.importance ?? 0;
        const ttlMs = opts?.ttlMs ?? (0, ttl_1.autoTtl)(importance);
        const entry = {
            key,
            value,
            namespace,
            createdAt: Date.now(),
            accessedAt: Date.now(),
            accessCount: 0,
            ttlMs,
            tags: opts?.tags,
            importance,
        };
        // L1 write
        const fullKey = this.buildKey(namespace, key);
        this.l1.set(fullKey, entry);
        this.stats.totalSets++;
        // Evict if L1 too large
        if (this.l1.size > L1_MAX_SIZE) {
            this.evictL1();
        }
        // L2 write (Redis)
        if (this.redisAvailable && this.redis) {
            try {
                const serialized = JSON.stringify(entry);
                if ((0, ttl_1.isNoExpiry)(ttlMs)) {
                    await this.redis.set(this.redisKey(namespace, key), serialized);
                }
                else {
                    await this.redis.set(this.redisKey(namespace, key), serialized, 'PX', ttlMs);
                }
                // Store tags index for scan
                if (opts?.tags && opts.tags.length > 0) {
                    for (const tag of opts.tags) {
                        await this.redis.sadd(this.tagIndexKey(namespace, tag), key);
                        if (!(0, ttl_1.isNoExpiry)(ttlMs)) {
                            await this.redis.pexpire(this.tagIndexKey(namespace, tag), ttlMs + 60_000);
                        }
                    }
                }
            }
            catch {
                // Redis write failed, L1-only for this entry
            }
        }
        this.stats.l1Size = this.l1.size;
    }
    /** Retrieve a value from working memory */
    async get(namespace, key) {
        this.stats.totalGets++;
        const fullKey = this.buildKey(namespace, key);
        // L1 lookup
        const l1Entry = this.l1.get(fullKey);
        if (l1Entry) {
            // Check if expired in L1
            if (!(0, ttl_1.isNoExpiry)(l1Entry.ttlMs) && (0, ttl_1.remainingTtl)(l1Entry.createdAt, l1Entry.ttlMs) === 0) {
                this.l1.delete(fullKey);
            }
            else {
                l1Entry.accessedAt = Date.now();
                l1Entry.accessCount++;
                this.stats.l1Hits++;
                return l1Entry.value;
            }
        }
        this.stats.l1Misses++;
        // L2 lookup (Redis fallback)
        if (this.redisAvailable && this.redis) {
            try {
                const data = await this.redis.get(this.redisKey(namespace, key));
                if (data) {
                    const entry = JSON.parse(data);
                    entry.accessedAt = Date.now();
                    entry.accessCount++;
                    // Backfill L1
                    this.l1.set(fullKey, entry);
                    this.stats.l2Hits++;
                    return entry.value;
                }
                this.stats.l2Misses++;
            }
            catch {
                this.stats.l2Misses++;
            }
        }
        return null;
    }
    /** Retrieve multiple values at once */
    async getMany(namespace, keys) {
        const result = {};
        for (const key of keys) {
            const value = await this.get(namespace, key);
            if (value !== null) {
                result[key] = value;
            }
        }
        return result;
    }
    /** Scan entries by tags or prefix */
    async scan(namespace, opts) {
        const results = [];
        const prefix = opts?.prefix ? this.buildKey(namespace, opts.prefix) : this.buildKey(namespace, '');
        // Scan L1
        for (const [fullKey, entry] of this.l1.entries()) {
            if (!fullKey.startsWith(prefix))
                continue;
            if (!(0, ttl_1.isNoExpiry)(entry.ttlMs) && (0, ttl_1.remainingTtl)(entry.createdAt, entry.ttlMs) === 0)
                continue;
            if (opts?.tags && opts.tags.length > 0) {
                if (!entry.tags || !opts.tags.some(t => entry.tags.includes(t)))
                    continue;
            }
            if (opts?.minImportance !== undefined && (entry.importance ?? 0) < opts.minImportance)
                continue;
            results.push(entry);
        }
        return results;
    }
    /** Delete a single entry */
    async delete(namespace, key) {
        const fullKey = this.buildKey(namespace, key);
        const existed = this.l1.delete(fullKey);
        if (this.redisAvailable && this.redis) {
            try {
                await this.redis.del(this.redisKey(namespace, key));
            }
            catch { /* ignore */ }
        }
        this.stats.l1Size = this.l1.size;
        return existed;
    }
    /** Flush all entries in a namespace */
    async flush(namespace) {
        let count = 0;
        const prefix = this.buildKey(namespace, '');
        // Flush L1
        for (const key of this.l1.keys()) {
            if (key.startsWith(prefix)) {
                this.l1.delete(key);
                count++;
            }
        }
        // Flush L2
        if (this.redisAvailable && this.redis) {
            try {
                const pattern = `${REDIS_KEY_PREFIX}:${namespace}:*`;
                const keys = await this.redis.keys(pattern);
                if (keys.length > 0) {
                    await this.redis.del(...keys);
                    count = Math.max(count, keys.length);
                }
            }
            catch { /* ignore */ }
        }
        this.stats.l1Size = this.l1.size;
        return count;
    }
    /** Promote an entry to long-term memory */
    async promote(namespace, key, targetType) {
        const fullKey = this.buildKey(namespace, key);
        const entry = this.l1.get(fullKey);
        if (!entry) {
            // Try Redis
            if (this.redisAvailable && this.redis) {
                const data = await this.redis.get(this.redisKey(namespace, key));
                if (data) {
                    const redisEntry = JSON.parse(data);
                    // Return entry for the caller to persist to long-term memory
                    // Clean up from working memory
                    await this.delete(namespace, key);
                    return { promoted: true, entry: { ...redisEntry, tags: [...(redisEntry.tags || []), `promoted:${targetType}`] } };
                }
            }
            return { promoted: false };
        }
        // Remove from working memory
        await this.delete(namespace, key);
        // Return entry with promotion metadata for caller to persist
        return {
            promoted: true,
            entry: { ...entry, tags: [...(entry.tags || []), `promoted:${targetType}`] },
        };
    }
    /** Get store statistics */
    getStats() {
        return { ...this.stats, l1Size: this.l1.size };
    }
    /** Shutdown store */
    async dispose() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
        this.l1.clear();
    }
    // --- Private helpers ---
    buildKey(namespace, key) {
        return `${namespace}:${key}`;
    }
    redisKey(namespace, key) {
        return `${REDIS_KEY_PREFIX}:${namespace}:${key}`;
    }
    tagIndexKey(namespace, tag) {
        return `${REDIS_KEY_PREFIX}:idx:${namespace}:tag:${tag}`;
    }
    startTtlSweep() {
        this.sweepTimer = setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.l1.entries()) {
                if (!(0, ttl_1.isNoExpiry)(entry.ttlMs) && (0, ttl_1.remainingTtl)(entry.createdAt, entry.ttlMs) === 0) {
                    this.l1.delete(key);
                }
            }
            this.stats.l1Size = this.l1.size;
        }, L1_SWEEP_INTERVAL);
    }
    evictL1() {
        // Evict least recently accessed entries until under limit
        const entries = Array.from(this.l1.entries())
            .sort(([, a], [, b]) => a.accessedAt - b.accessedAt);
        const toRemove = entries.slice(0, Math.floor(L1_MAX_SIZE * 0.2)); // Remove 20%
        for (const [key] of toRemove) {
            this.l1.delete(key);
        }
    }
}
exports.WorkingMemoryStore = WorkingMemoryStore;
//# sourceMappingURL=store.js.map