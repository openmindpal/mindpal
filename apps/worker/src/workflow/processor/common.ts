export { isPlainObject, sha256Hex, stableStringify, stableStringifyValue } from "@openslin/shared";
import { isPlainObject } from "@openslin/shared";

export function digestObject(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}

export function jsonByteLength(v: unknown) {
  try {
    const s = JSON.stringify(v);
    return Buffer.byteLength(s, "utf8");
  } catch {
    return 0;
  }
}

export function checkType(type: string, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "datetime":
      return typeof value === "string";
    case "json":
      return true;
    case "reference":
      return typeof value === "string";
    default:
      return false;
  }
}

export function scrubBySchema(schema: any, value: any) {
  const fields = schema?.fields;
  if (!fields) return value;
  if (!isPlainObject(value)) return value;
  const out: any = {};
  for (const k of Object.keys(fields)) {
    if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = (value as any)[k];
  }
  return out;
}

export function validateBySchema(kind: "input" | "output", schema: any, value: any) {
  const fields = schema?.fields;
  if (!fields) return;
  if (!isPlainObject(value)) throw new Error(`${kind}_schema:must_be_object`);
  for (const [fieldName, def] of Object.entries<any>(fields)) {
    const v = (value as any)[fieldName];
    if (def.required && (v === undefined || v === null)) throw new Error(`${kind}_schema:missing_required:${fieldName}`);
    if (v !== undefined && !checkType(def.type, v)) throw new Error(`${kind}_schema:type_mismatch:${fieldName}`);
  }
}
