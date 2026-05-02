/**
 * Shared digest & serialization utilities.
 *
 * Extracted from modules/channels/ingressDigest.ts and modules/notifications/digest.ts
 * so that core modules (governance, metadata, workflow, tools) do not depend on
 * Skill-level modules (channels, notifications).
 */
import { sha256Hex, stableStringifyValue } from "@mindpal/shared";
export { sha256Hex, stableStringify } from "@mindpal/shared";

/* ------------------------------------------------------------------ */
/*  digestParams / digestInputV1 – audit & idempotency helpers         */
/* ------------------------------------------------------------------ */

export function digestParams(params: any) {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return { keyCount: 0, keys: [] as string[], sha256_8: sha256Hex("null").slice(0, 8) };
  const keys = Object.keys(params).slice(0, 50);
  const h = sha256Hex(JSON.stringify(stableStringifyValue(params)));
  return { keyCount: Object.keys(params).length, keys, sha256_8: h.slice(0, 8) };
}

const OMIT_KEYS = new Set(["traceId", "trace_id", "requestId", "request_id", "idempotencyKey", "idempotency_key"]);

function sanitizeForDigest(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sanitizeForDigest);
  const out: any = {};
  for (const k of Object.keys(v)) {
    if (OMIT_KEYS.has(k)) continue;
    out[k] = sanitizeForDigest(v[k]);
  }
  return out;
}

export function digestInputV1(input: any) {
  return digestParams(sanitizeForDigest(input));
}
