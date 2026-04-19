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
