/**
 * Lightweight LRU Cache with TTL support.
 *
 * - Evicts least-recently-used entries when capacity is exceeded
 * - Automatically expires entries after TTL
 * - SSR-safe: instantiate only in client-side modules
 */

export interface LRUCacheOptions {
  /** Maximum number of entries. Default 100 */
  maxSize: number;
  /** Time-to-live in milliseconds. Default 30 minutes */
  ttlMs: number;
}

interface CacheEntry<V> {
  value: V;
  createdAt: number;
  lastAccessedAt: number;
}

export class LRUCache<K, V> {
  private readonly cache = new Map<K, CacheEntry<V>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: LRUCacheOptions) {
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL — lazy eviction
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Promote to most-recently-used (Map iteration order = insertion order)
    entry.lastAccessedAt = Date.now();
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V): void {
    // Remove first so re-insertion moves it to the end
    this.cache.delete(key);

    // Evict oldest entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Purge all expired entries. Call periodically if you want proactive cleanup
   * instead of relying solely on lazy eviction in `get()`.
   */
  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.ttlMs) {
        this.cache.delete(key);
        purged++;
      }
    }
    return purged;
  }
}
