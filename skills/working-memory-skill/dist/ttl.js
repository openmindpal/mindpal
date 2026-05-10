"use strict";
/**
 * TTL (Time-To-Live) Management for Working Memory
 *
 * Provides preset TTL values and auto-TTL based on importance scoring.
 * Memory entries with higher importance get longer TTL or no expiry.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTL_PRESETS = void 0;
exports.autoTtl = autoTtl;
exports.isNoExpiry = isNoExpiry;
exports.remainingTtl = remainingTtl;
/** Preset TTL values (milliseconds) */
exports.TTL_PRESETS = {
    /** Sensor observations: expire quickly (30s) */
    SENSOR: 30_000,
    /** Decision context: moderate lifetime (2min) */
    CONTEXT: 120_000,
    /** Episode-level state: longer lifetime (5min) */
    EPISODE: 300_000,
    /** Important data: no auto-expiry, awaits manual promote */
    IMPORTANT: 0,
};
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
function autoTtl(importance) {
    if (importance >= 0.8)
        return exports.TTL_PRESETS.IMPORTANT;
    if (importance >= 0.5)
        return exports.TTL_PRESETS.EPISODE;
    if (importance >= 0.3)
        return exports.TTL_PRESETS.CONTEXT;
    return exports.TTL_PRESETS.SENSOR;
}
/**
 * Check if a TTL value means "no expiry"
 */
function isNoExpiry(ttlMs) {
    return ttlMs <= 0;
}
/**
 * Calculate remaining TTL for an entry
 * @returns remaining ms, 0 if expired, -1 if no expiry
 */
function remainingTtl(createdAt, ttlMs) {
    if (isNoExpiry(ttlMs))
        return -1;
    const elapsed = Date.now() - createdAt;
    const remaining = ttlMs - elapsed;
    return remaining > 0 ? remaining : 0;
}
//# sourceMappingURL=ttl.js.map