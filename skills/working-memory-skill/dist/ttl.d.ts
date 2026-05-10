/**
 * TTL (Time-To-Live) Management for Working Memory
 *
 * Provides preset TTL values and auto-TTL based on importance scoring.
 * Memory entries with higher importance get longer TTL or no expiry.
 */
/** Preset TTL values (milliseconds) */
export declare const TTL_PRESETS: {
    /** Sensor observations: expire quickly (30s) */
    readonly SENSOR: 30000;
    /** Decision context: moderate lifetime (2min) */
    readonly CONTEXT: 120000;
    /** Episode-level state: longer lifetime (5min) */
    readonly EPISODE: 300000;
    /** Important data: no auto-expiry, awaits manual promote */
    readonly IMPORTANT: 0;
};
export type TtlPreset = keyof typeof TTL_PRESETS;
/**
 * Automatically determine TTL based on importance score.
 *
 * @param importance - Importance score between 0 and 1
 * @returns TTL in milliseconds (0 = no expiry)
 *
 * Mapping:
 * - importance >= 0.8 → IMPORTANT (no expiry)
 * - importance >= 0.5 → EPISODE (5 min)
 * - importance >= 0.3 → CONTEXT (2 min)
 * - importance < 0.3  → SENSOR (30 sec)
 */
export declare function autoTtl(importance: number): number;
/**
 * Check if a TTL value means "no expiry"
 */
export declare function isNoExpiry(ttlMs: number): boolean;
/**
 * Calculate remaining TTL for an entry
 * @returns remaining ms, 0 if expired, -1 if no expiry
 */
export declare function remainingTtl(createdAt: number, ttlMs: number): number;
//# sourceMappingURL=ttl.d.ts.map