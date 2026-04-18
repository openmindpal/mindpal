/**
 * columnEncryption — 通用列级 AES-256-GCM 加密 / 解密
 *
 * 为数据库敏感字段提供应用层加密能力。
 * 此模块是纯算法实现，零数据库/外部依赖，可在 API / Worker / Runner 任意端使用。
 *
 * ── 设计要点 ──
 * 1. 加密格式：ColumnEncryptedV1 = { _enc: "col.v1", kRef, iv, tag, ct }
 * 2. 自动检测：decryptColumn 自动检测明文 vs 密文，实现渐进式迁移
 * 3. 多密钥支持：kRef 标识使用了哪个密钥版本，支持轮换后旧密文仍可解密
 * 4. 批量操作：提供 batch encrypt/decrypt 减少密钥解析开销
 * 5. 安全降级：解密失败时可选返回 placeholder 而非抛出异常
 */
import * as crypto from "node:crypto";

// ── 类型定义 ─────────────────────────────────────────────

export interface ColumnEncryptedV1 {
  _enc: "col.v1";
  kRef: {
    scopeType: string;
    scopeId: string;
    keyVersion: number;
  };
  iv: string;
  tag: string;
  ct: string;
}

export interface ColumnKeyMaterial {
  keyBytes: Buffer;
  kRef: {
    scopeType: string;
    scopeId: string;
    keyVersion: number;
  };
}

export interface ColumnDecryptOptions {
  onFailure?: "throw" | "placeholder" | "raw";
  placeholderText?: string;
}

// ── 常量 ──────────────────────────────────────────────────

const ENC_FORMAT = "col.v1" as const;
const DEFAULT_PLACEHOLDER = "[encrypted:unable_to_decrypt]";

// ── 检测函数 ──────────────────────────────────────────────

export function isColumnEncrypted(value: unknown): value is ColumnEncryptedV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v._enc === ENC_FORMAT
    && typeof v.iv === "string"
    && typeof v.tag === "string"
    && typeof v.ct === "string"
    && typeof v.kRef === "object"
    && v.kRef !== null;
}

export function isColumnEncryptedString(value: string): boolean {
  if (!value.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value);
    return isColumnEncrypted(parsed);
  } catch {
    return false;
  }
}

// ── 加密 ──────────────────────────────────────────────────

export function encryptColumn(
  plaintext: string,
  keyMaterial: ColumnKeyMaterial,
): ColumnEncryptedV1 {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial.keyBytes, iv);
  const plaintextBuf = Buffer.from(plaintext, "utf8");
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    _enc: ENC_FORMAT,
    kRef: { ...keyMaterial.kRef },
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function encryptColumns(
  entries: Array<{ key: string; plaintext: string }>,
  keyMaterial: ColumnKeyMaterial,
): Map<string, ColumnEncryptedV1> {
  const result = new Map<string, ColumnEncryptedV1>();
  for (const entry of entries) {
    result.set(entry.key, encryptColumn(entry.plaintext, keyMaterial));
  }
  return result;
}

// ── 解密 ──────────────────────────────────────────────────

export function decryptColumnPayload(
  encrypted: ColumnEncryptedV1,
  keyBytes: Buffer,
): string {
  const iv = Buffer.from(encrypted.iv, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const ct = Buffer.from(encrypted.ct, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}

export async function decryptColumn(
  value: unknown,
  keyResolver: (kRef: ColumnEncryptedV1["kRef"]) => Promise<Buffer>,
  options: ColumnDecryptOptions = {},
): Promise<string> {
  const { onFailure = "throw", placeholderText = DEFAULT_PLACEHOLDER } = options;
  if (value == null) return "";
  if (isColumnEncrypted(value)) {
    return decryptWithFallback(value, keyResolver, onFailure, placeholderText);
  }
  if (typeof value === "string") {
    if (value.startsWith("{") && value.includes('"_enc"')) {
      try {
        const parsed = JSON.parse(value);
        if (isColumnEncrypted(parsed)) {
          return decryptWithFallback(parsed, keyResolver, onFailure, placeholderText);
        }
      } catch { /* plain text */ }
    }
    return value;
  }
  return String(value);
}

export async function decryptColumns(
  entries: Array<{ key: string; value: unknown }>,
  keyResolver: (kRef: ColumnEncryptedV1["kRef"]) => Promise<Buffer>,
  options: ColumnDecryptOptions = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const keyCache = new Map<string, Buffer>();
  for (const entry of entries) {
    const decrypted = await decryptColumnWithCache(entry.value, keyResolver, options, keyCache);
    result.set(entry.key, decrypted);
  }
  return result;
}

// ── 内部工具函数 ──────────────────────────────────────────

async function decryptWithFallback(
  encrypted: ColumnEncryptedV1,
  keyResolver: (kRef: ColumnEncryptedV1["kRef"]) => Promise<Buffer>,
  onFailure: "throw" | "placeholder" | "raw",
  placeholderText: string,
): Promise<string> {
  try {
    const keyBytes = await keyResolver(encrypted.kRef);
    return decryptColumnPayload(encrypted, keyBytes);
  } catch (err) {
    switch (onFailure) {
      case "placeholder": return placeholderText;
      case "raw": return JSON.stringify(encrypted);
      case "throw": default: throw err;
    }
  }
}

async function decryptColumnWithCache(
  value: unknown,
  keyResolver: (kRef: ColumnEncryptedV1["kRef"]) => Promise<Buffer>,
  options: ColumnDecryptOptions,
  keyCache: Map<string, Buffer>,
): Promise<string> {
  const { onFailure = "throw", placeholderText = DEFAULT_PLACEHOLDER } = options;
  if (value == null) return "";
  let encrypted: ColumnEncryptedV1 | null = null;
  if (isColumnEncrypted(value)) {
    encrypted = value;
  } else if (typeof value === "string") {
    if (value.startsWith("{") && value.includes('"_enc"')) {
      try {
        const parsed = JSON.parse(value);
        if (isColumnEncrypted(parsed)) encrypted = parsed;
      } catch { /* plain text */ }
    }
    if (!encrypted) return value;
  } else {
    return String(value);
  }
  const cacheKey = `${encrypted.kRef.scopeType}:${encrypted.kRef.scopeId}:${encrypted.kRef.keyVersion}`;
  let keyBytes = keyCache.get(cacheKey);
  if (!keyBytes) {
    try {
      keyBytes = await keyResolver(encrypted.kRef);
      keyCache.set(cacheKey, keyBytes);
    } catch (err) {
      if (onFailure === "placeholder") return placeholderText;
      if (onFailure === "raw") return JSON.stringify(encrypted);
      throw err;
    }
  }
  try {
    return decryptColumnPayload(encrypted, keyBytes);
  } catch (err) {
    if (onFailure === "placeholder") return placeholderText;
    if (onFailure === "raw") return JSON.stringify(encrypted);
    throw err;
  }
}

// ── Re-encryption 工具 ───────────────────────────────────

export async function reencryptColumn(
  value: unknown,
  oldKeyResolver: (kRef: ColumnEncryptedV1["kRef"]) => Promise<Buffer>,
  newKeyMaterial: ColumnKeyMaterial,
): Promise<ColumnEncryptedV1> {
  const plaintext = await decryptColumn(value, oldKeyResolver, { onFailure: "throw" });
  return encryptColumn(plaintext, newKeyMaterial);
}

// ── 迁移工具 ─────────────────────────────────────────────

export function needsEncryptionMigration(value: unknown): boolean {
  if (value == null) return false;
  if (isColumnEncrypted(value)) return false;
  if (typeof value === "string") {
    if (isColumnEncryptedString(value)) return false;
    return value.length > 0;
  }
  return false;
}
