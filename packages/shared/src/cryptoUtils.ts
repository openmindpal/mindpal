/**
 * cryptoUtils.ts — 统一的密码学工具函数与稳定序列化，消除跨模块重复定义
 */
import crypto from "node:crypto";

/* ------------------------------------------------------------------ */
/*  SHA-256 哈希系列                                                    */
/* ------------------------------------------------------------------ */

/** SHA-256 哈希（字符串 → 完整 hex） */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** SHA-256 哈希（Buffer / 二进制 → 完整 hex） */
export function sha256HexBytes(input: Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/** SHA-256 哈希（字符串 → 前 8 位 hex，用于日志摘要） */
export function sha256_8(input: string): string {
  return sha256Hex(input).slice(0, 8);
}

/* ------------------------------------------------------------------ */
/*  确定性序列化 — 递归排序 object key 保证 JSON 稳定性                   */
/* ------------------------------------------------------------------ */

/** 递归排序 object key，返回深层排序后的值（可传给 JSON.stringify） */
export function stableStringifyValue(v: any): any {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stableStringifyValue);
  const keys = Object.keys(v).sort();
  const out: any = {};
  for (const k of keys) out[k] = stableStringifyValue(v[k]);
  return out;
}

/** 确定性 JSON.stringify — 保证相同数据生成相同字符串 */
export function stableStringify(v: any): string {
  return JSON.stringify(stableStringifyValue(v));
}

/* ------------------------------------------------------------------ */
/*  确定性规范化 — 支持 Date/Buffer 等扩展类型                           */
/* ------------------------------------------------------------------ */

/**
 * 递归规范化值，支持 Date→ISO / Buffer→base64 / object key 排序。
 * 用于审计哈希链等需要确定性序列化的场景。
 */
export function canonicalize(value: any): any {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) out[k] = canonicalize((value as any)[k]);
  return out;
}

/** 基于 canonicalize 的确定性 JSON.stringify */
export function canonicalStringify(value: any): string {
  return JSON.stringify(canonicalize(value));
}

/* ------------------------------------------------------------------ */
/*  审计哈希链核心函数                                                   */
/* ------------------------------------------------------------------ */

/** 计算审计事件哈希 — 保证 prevHash→normalized 链式完整性 */
export function computeEventHash(params: { prevHash: string | null; normalized: any }): string {
  const input = stableStringify({ prevHash: params.prevHash ?? null, event: params.normalized });
  return sha256Hex(input);
}

/* ------------------------------------------------------------------ */
/*  通用摘要函数                                                         */
/* ------------------------------------------------------------------ */

/** 将 object 压缩为键名摘要（审计/日志场景，防止 payload 过大） */
export function digestObject(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}
