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

import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:memoryEncryption" });

import type { Pool, PoolClient } from "pg";
import {
  encryptColumn,
  decryptColumn,
  decryptColumns,
  type ColumnKeyMaterial,
  type ColumnEncryptedV1,
  type ColumnDecryptOptions,
} from "@mindpal/shared";
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

// ── 辅助函数 ─────────────────────────────────────────────

/**
 * 从加密 JSON 值中解析 kRef（密钥引用），用于预加载密钥
 */
function parseEncryptedKRef(value: unknown): { scopeType: string; scopeId: string; keyVersion: number } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.v === 1 && parsed?.kRef) return parsed.kRef;
  } catch { /* not encrypted */ }
  return null;
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
 * @param prefilled - 可选的预填充缓存，用于批量解密时避免串行密钥查询
 */
function createMemoryKeyResolver(params: { pool: Q; tenantId: string; prefilled?: Map<string, Buffer> }) {
  const masterKey = getMasterKey();
  const cache = params.prefilled ?? new Map<string, Buffer>();

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
 * 批量解密 memory content_text 列表（带密钥预加载 + 缓存）
 *
 * 当多条记录使用不同密钥版本时，预先批量加载所有版本，
 * 避免 decryptColumns 内部逐条串行查询密钥。
 */
export async function decryptMemoryContents(params: {
  pool: Q;
  tenantId: string;
  entries: Array<{ key: string; value: unknown }>;
  options?: ColumnDecryptOptions;
}): Promise<Map<string, string>> {
  // ── 密钥预加载 ──────────────────────────────────────────
  let prefilled: Map<string, Buffer> | undefined;
  try {
    // 1. 扫描 entries，提取不同密钥版本集合（去重）
    const kRefSet = new Map<string, { scopeType: string; scopeId: string; keyVersion: number }>();
    for (const entry of params.entries) {
      const kRef = parseEncryptedKRef(entry.value);
      if (kRef) {
        const k = `${kRef.scopeType}:${kRef.scopeId}:${kRef.keyVersion}`;
        if (!kRefSet.has(k)) kRefSet.set(k, kRef);
      }
    }

    // 2. 仅当版本数 > 1 时才预加载（单版本场景缓存自然命中，无需额外开销）
    if (kRefSet.size > 1) {
      const masterKey = getMasterKey();
      if (masterKey) {
        // 批量查询所有需要的密钥版本
        const versions = Array.from(kRefSet.values());
        const conditions = versions.map((_, i) => `(scope_type = $${i * 3 + 2} AND scope_id = $${i * 3 + 3} AND key_version = $${i * 3 + 4})`);
        const sqlParams: Array<string | number> = [params.tenantId];
        for (const v of versions) {
          sqlParams.push(v.scopeType, v.scopeId, v.keyVersion);
        }
        const sql = `SELECT scope_type, scope_id, key_version, status, encrypted_key FROM partition_keys WHERE tenant_id = $1 AND (${conditions.join(" OR ")})`;
        const res = await params.pool.query(sql, sqlParams);

        prefilled = new Map<string, Buffer>();
        for (const row of res.rows as any[]) {
          if (row.status === "disabled") continue;
          const cacheKey = `${row.scope_type}:${row.scope_id}:${row.key_version}`;
          try {
            const keyBytes = decryptPartitionKeyMaterial({ masterKey, encryptedKey: row.encrypted_key });
            prefilled.set(cacheKey, keyBytes);
          } catch { /* skip corrupted key */ }
        }
      }
    }
  } catch (err) {
    // 预加载失败 → 降级到逐条查询（现有行为）
    _logger.warn("preloadKeys failed, falling back to sequential", { err: (err as Error)?.message });
    prefilled = undefined;
  }

  // ── 正常解密流程 ────────────────────────────────────────
  const keyResolver = createMemoryKeyResolver({
    pool: params.pool,
    tenantId: params.tenantId,
    prefilled,
  });

  return decryptColumns(
    params.entries,
    keyResolver,
    params.options ?? { onFailure: "placeholder" },
  );
}
