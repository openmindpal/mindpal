/**
 * memoryEncryption.ts — API 侧 Memory 列级加密桥接层
 *
 * 与 Worker 侧 memoryEncryption.ts 对等实现，使 API 写入通道
 * （REST API / InlineToolExecutor）获得与 Worker 一致的加密能力。
 *
 * 底层调用链：
 *   shared/columnEncryption (纯算法) → API keyringRepo (密钥管理) → 加密/解密
 *
 * ── 环境变量 ──
 * - MEMORY_ENCRYPTION_ENABLED=true  启用列级加密（默认 false）
 * - MEMORY_ENCRYPTION_SCOPE_TYPE    加密 scope 类型（默认 "tenant"）
 */

import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:memoryEncryption" });

import type { Pool, PoolClient } from "pg";
import {
  encryptColumn,
  decryptColumn,
  decryptColumns,
  type ColumnKeyMaterial,
  type ColumnEncryptedV1,
  type ColumnDecryptOptions,
} from "@openslin/shared";
import { getActivePartitionKey, getPartitionKey, decryptPartitionKeyMaterial } from "../keyring/keyringRepo";

type Q = Pool | PoolClient;

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
 * 从 keyring 获取 active 分区密钥材料，用于加密操作
 */
async function getActiveKeyMaterial(params: {
  pool: Q;
  tenantId: string;
  scopeId?: string;
}): Promise<ColumnKeyMaterial | null> {
  const scopeType = getEncryptionScopeType();
  const scopeId = params.scopeId ?? params.tenantId;
  const masterKey = getMasterKey();
  if (!masterKey) return null;

  try {
    const pk = await getActivePartitionKey({
      pool: params.pool,
      tenantId: params.tenantId,
      scopeType,
      scopeId,
    });
    if (!pk) return null;

    const keyBytes = decryptPartitionKeyMaterial({
      masterKey,
      encryptedKey: pk.encryptedKey,
    });

    return {
      keyBytes,
      kRef: { scopeType, scopeId, keyVersion: pk.keyVersion },
    };
  } catch (err) {
    _logger.warn("getActiveKeyMaterial failed", { err: (err as Error)?.message });
    return null;
  }
}

/**
 * 创建密钥解析器（用于解密操作，按 kRef 查找密钥）
 */
function createMemoryKeyResolver(params: { pool: Q; tenantId: string }) {
  const masterKey = getMasterKey();
  const cache = new Map<string, Buffer>();

  return async (kRef: ColumnEncryptedV1["kRef"]): Promise<Buffer> => {
    const cacheKey = `${kRef.scopeType}:${kRef.scopeId}:${kRef.keyVersion}`;
    let keyBytes = cache.get(cacheKey);
    if (keyBytes) return keyBytes;

    const pk = await getPartitionKey({
      pool: params.pool,
      tenantId: params.tenantId,
      scopeType: kRef.scopeType,
      scopeId: kRef.scopeId,
      keyVersion: kRef.keyVersion,
    });
    if (!pk) throw new Error(`partition_key_not_found: ${cacheKey}`);
    if (pk.status === "disabled") throw new Error(`partition_key_disabled: ${cacheKey}`);

    keyBytes = decryptPartitionKeyMaterial({
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
  pool: Q;
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
    _logger.warn("No active key, storing plaintext", { tenantId: params.tenantId });
    return params.plaintext;
  }

  const encrypted = encryptColumn(params.plaintext, keyMaterial);
  return JSON.stringify(encrypted);
}

// ── 解密操作 ──────────────────────────────────────────────

/**
 * 解密 memory content_text（自动检测明文/密文）
 */
export async function decryptMemoryContent(params: {
  pool: Q;
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
 * 批量解密 memory content_text 列表（带密钥缓存）
 */
export async function decryptMemoryContents(params: {
  pool: Q;
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
