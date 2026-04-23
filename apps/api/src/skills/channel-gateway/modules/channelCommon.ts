import crypto from "node:crypto";

export function pickI18nText(locale: string, v: unknown): string {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  const o: any = v as any;
  const direct = typeof o[locale] === "string" ? o[locale] : "";
  if (direct) return direct;
  const zh = typeof o["zh-CN"] === "string" ? o["zh-CN"] : "";
  if (zh) return zh;
  const vals = Object.values(o).filter((x) => typeof x === "string") as string[];
  return vals[0] ?? "";
}

export function toReplyText(locale: string, out: any): string {
  if (out && typeof out === "object") return pickI18nText(locale, (out as any).replyText);
  return "";
}

export function pickSecret(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === "string" ? String(v) : "";
}

/** 时序安全的 token 字符串比较，防止时序攻击 */
export function timingSafeTokenCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
