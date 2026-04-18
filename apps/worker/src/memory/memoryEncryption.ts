/**
 * P2-03b: Memory 列级加密桥接层
 *
 * 将 keyring 基础设施与 @openslin/shared 的列级加密工具连接起来，
 * 为 memory_entries.content_text 提供透明的加密/解密能力。
 *
 * ── 使用方式 ──
 * - 写入时：调用 encryptMemoryContent() 加密明文后存入 DB
 * - 读取时：调用 decryptMemoryContent() 自动检测并解密
 * - 批量读取：调用 decryptMemoryContents() 带密钥缓存
 *
 * ── 环境变量 ──
 * - MEMORY_ENCRYPTION_ENABLED=true  启用列级加密（默认 false）
 * - MEMORY_ENCRYPTION_SCOPE_TYPE    加密使用的 scope 类型（默认 "tenant"）
 */

import type { Pool } from "pg";
import {
  encryptColumn,
  decryptColumn,
  decryptColumns,
  isColumnEncrypted,
  needsEncryptionMigration,
  type ColumnKeyMaterial,
  type ColumnEncryptedV1,
  type ColumnDecryptOptions,
} from "@openslin/shared";
import { decryptPartitionKeyMaterial, getPartitionKey } from "../keyring/keyringRepo";
import { decryptJson, type EncryptedPayload } from "../secrets/crypto";

// ── 配置 ──────────────────────────────────────────────────

/** 是否启用 memory 列级加密 */
export function isMemoryEncryptionEnabled(): boolean {
  return String(process.env.MEMORY_ENCRYPTION_ENABLED ?? "").toLowerCase() === "true";
}

/** 加密 scope 类型 */
function getEncryptionScopeType(): string {
  return String(process.env.MEMORY_ENCRYPTION_SCOPE_TYPE ?? "tenant");
}

/** 获取 master key */
function getMasterKey(): string {
  const key = String(process.env.API_MASTER_KEY ?? "").trim()
    || (process.env.NODE_ENV === "production" ? "" : "dev-master-key-change-me");
  return key;
}

// ── 密钥解析 ──────────────────────────────────────────────

/**
 * 从 keyring 获取 active 分区密钥的材料，用于加密操作
 */
export async function getActiveKeyMaterial(params: {
  pool: Pool;
  tenantId: string;
  scopeId?: string;
}): Promise<ColumnKeyMaterial | null> {
  const scopeType = getEncryptionScopeType();
  const scopeId = params.scopeId ?? params.tenantId;
  const masterKey = getMasterKey();
  if (!masterKey) return null;

  try {
    // 查询活跃密钥
    const res = await params.pool.query(
      `SELECT key_version, encrypted_key
       FROM partition_keys
       WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'active'
       ORDER BY key_version DESC LIMIT 1`,
      [params.tenantId, scopeType, scopeId],
    );
    if (!res.rowCount) return null;

    const row = res.rows[0] as any;
    const keyVersion = Number(row.key_version);
    const encryptedKey = row.encrypted_key as EncryptedPayload;

    const keyBytes = decryptPartitionKeyMaterial({ masterKey, encryptedKey });

    return {
      keyBytes,
      kRef: { scopeType, scopeId, keyVersion },
    };
  } catch (err) {
    console.error("[memory-encryption] getActiveKeyMaterial failed", err);
    return null;
  }
}

/**
 * 创建密钥解析器（用于解密操作），支持按 kRef 查找任意版本密钥
 */
export function createMemoryKeyResolver(params: {
  pool: Pool;
  tenantId: string;
}): (kRef: ColumnEncryptedV1["kRef"]) => Promise<Buffer> {
  const masterKey = getMasterKey();

  // 密钥缓存（按版本）
  const cache = new Map<string, Buffer>();

  return async (kRef) => {
    const cacheKey = `${kRef.scopeType}:${kRef.scopeId}:${kRef.keyVersion}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const pk = await getPartitionKey({
      pool: params.pool,
      tenantId: params.tenantId,
      scopeType: kRef.scopeType,
      scopeId: kRef.scopeId,
      keyVersion: kRef.keyVersion,
    });

    if (!pk) throw new Error(`partition_key_not_found: ${cacheKey}`);
    if (pk.status === "disabled") throw new Error(`partition_key_disabled: ${cacheKey}`);

    const keyBytes = decryptPartitionKeyMaterial({
      masterKey,
      encryptedKey: pk.encryptedKey,
    });

    cache.set(cacheKey, keyBytes);
    return keyBytes;
  };
}

// ── 加密操作 ──────────────────────────────────────────────

/**
 * 加密 memory content_text（如果启用了列级加密）
 *
 * @returns 加密后的 JSON 字符串（启用时）或原始明文（未启用时）
 */
export async function encryptMemoryContent(params: {
  pool: Pool;
  tenantId: string;
  plaintext: string;
  scopeId?: string;
}): Promise<string> {
  if (!isMemoryEncryptionEnabled()) return params.plaintext;

  const keyMaterial = await getActiveKeyMaterial({
    pool: params.pool,
    tenantId: params.tenantId,
    scopeId: params.scopeId,
  });

  if (!keyMaterial) {
    // 无可用密钥 → 回退到明文存储并告警
    console.warn(
      `[memory-encryption] No active key for tenant=${params.tenantId}, storing plaintext`,
    );
    return params.plaintext;
  }

  const encrypted = encryptColumn(params.plaintext, keyMaterial);
  return JSON.stringify(encrypted);
}

// ── 解密操作 ──────────────────────────────────────────────

/**
 * 解密 memory content_text（自动检测明文/密文）
 *
 * @param value - 从 DB 读取的 content_text 值
 * @returns 明文字符串
 */
export async function decryptMemoryContent(params: {
  pool: Pool;
  tenantId: string;
  value: unknown;
  options?: ColumnDecryptOptions;
}): Promise<string> {
  const keyResolver = createMemoryKeyResolver({
    pool: params.pool,
    tenantId: params.tenantId,
  });

  return decryptColumn(
    params.value,
    keyResolver,
    params.options ?? { onFailure: "placeholder" },
  );
}

/**
 * 批量解密 memory content_text 列表（带密钥缓存，减少密钥查询）
 */
export async function decryptMemoryContents(params: {
  pool: Pool;
  tenantId: string;
  entries: Array<{ key: string; value: unknown }>;
  options?: ColumnDecryptOptions;
}): Promise<Map<string, string>> {
  const keyResolver = createMemoryKeyResolver({
    pool: params.pool,
    tenantId: params.tenantId,
  });

  return decryptColumns(
    params.entries,
    keyResolver,
    params.options ?? { onFailure: "placeholder" },
  );
}

// ── 迁移工具 ─────────────────────────────────────────────

/**
 * 批量加密迁移：将指定租户的明文 memory_entries 加密
 *
 * 适合在后台 worker ticker 中周期性调用。
 *
 * @returns 成功加密和失败的计数
 */
export async function migrateMemoryEncryption(params: {
  pool: Pool;
  tenantId: string;
  limit?: number;
  scopeId?: string;
}): Promise<{ encrypted: number; failed: number; skipped: number }> {
  if (!isMemoryEncryptionEnabled()) {
    return { encrypted: 0, failed: 0, skipped: 0 };
  }

  const limit = params.limit ?? 200;
  const keyMaterial = await getActiveKeyMaterial({
    pool: params.pool,
    tenantId: params.tenantId,
    scopeId: params.scopeId,
  });

  if (!keyMaterial) {
    console.warn(`[memory-encryption] migration: no active key for tenant=${params.tenantId}`);
    return { encrypted: 0, failed: 0, skipped: 0 };
  }

  // 查找明文条目（content_text 不以 {"_enc" 开头的都是明文）
  const rows = await params.pool.query(
    `SELECT id, content_text
     FROM memory_entries
     WHERE tenant_id = $1
       AND deleted_at IS NULL
       AND content_text IS NOT NULL
       AND content_text NOT LIKE '{"_enc"%'
     ORDER BY updated_at ASC
     LIMIT $2`,
    [params.tenantId, limit],
  );

  let encrypted = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows.rows as any[]) {
    const id = String(row.id);
    const contentText = String(row.content_text ?? "");

    if (!needsEncryptionMigration(contentText)) {
      skipped++;
      continue;
    }

    try {
      const enc = encryptColumn(contentText, keyMaterial);
      await params.pool.query(
        `UPDATE memory_entries
         SET content_text = $2, updated_at = now()
         WHERE id = $1 AND tenant_id = $3`,
        [id, JSON.stringify(enc), params.tenantId],
      );
      encrypted++;
    } catch {
      failed++;
    }
  }

  return { encrypted, failed, skipped };
}
