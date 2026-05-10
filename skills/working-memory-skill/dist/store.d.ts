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
export interface MemoryEntry {
    key: string;
    value: unknown;
    namespace: string;
    createdAt: number;
    accessedAt: number;
    accessCount: number;
    ttlMs: number;
    tags?: string[];
    importance?: number;
}
export interface SetOptions {
    ttlMs?: number;
    tags?: string[];
    importance?: number;
}
export interface ScanOptions {
    tags?: string[];
    prefix?: string;
    minImportance?: number;
}
export interface StoreStats {
    l1Size: number;
    l1Hits: number;
    l1Misses: number;
    l2Hits: number;
    l2Misses: number;
    totalSets: number;
    totalGets: number;
}
export declare class WorkingMemoryStore {
    private redisUrl?;
    private l1;
    private redis;
    private redisAvailable;
    private sweepTimer;
    private stats;
    constructor(redisUrl?: string | undefined);
    /** Initialize store (connect to Redis if available) */
    init(): Promise<void>;
    /** Store a value in working memory */
    set(namespace: string, key: string, value: unknown, opts?: SetOptions): Promise<void>;
    /** Retrieve a value from working memory */
    get(namespace: string, key: string): Promise<unknown | null>;
    /** Retrieve multiple values at once */
    getMany(namespace: string, keys: string[]): Promise<Record<string, unknown>>;
    /** Scan entries by tags or prefix */
    scan(namespace: string, opts?: ScanOptions): Promise<MemoryEntry[]>;
    /** Delete a single entry */
    delete(namespace: string, key: string): Promise<boolean>;
    /** Flush all entries in a namespace */
    flush(namespace: string): Promise<number>;
    /** Promote an entry to long-term memory */
    promote(namespace: string, key: string, targetType: 'episodic' | 'semantic' | 'procedural'): Promise<{
        promoted: boolean;
        entry?: MemoryEntry;
    }>;
    /** Get store statistics */
    getStats(): StoreStats;
    /** Shutdown store */
    dispose(): Promise<void>;
    private buildKey;
    private redisKey;
    private tagIndexKey;
    private startTtlSweep;
    private evictL1;
}
//# sourceMappingURL=store.d.ts.map