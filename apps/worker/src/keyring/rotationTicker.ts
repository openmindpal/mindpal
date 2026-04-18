/**
 * P2-03a: 密钥自动轮换调度器
 *
 * Worker ticker 定期扫描 partition_keys 中即将过期的活跃密钥，
 * 自动发起轮换（双密钥过渡期），并入队 re-encryption 作业。
 *
 * ── 设计要点 ──
 * 1. 轮换策略：活跃密钥超过 KEY_MAX_AGE_DAYS（默认 90 天）自动轮换
 * 2. 双密钥过渡：旧密钥 → retired 状态，仍可解密；新密钥 → active
 * 3. 入队 re-encryption：轮换后自动提交 keyring.reencrypt 作业
 * 4. 防风暴：每次 tick 最多轮换 MAX_ROTATIONS_PER_TICK 个密钥
 * 5. 预警：即将到期（距离过期 < WARN_BEFORE_DAYS）但未达轮换阈值时记录审计
 * 6. 幂等：同一个 tick 周期内，同一 scope 不会被重复轮换
 */

import crypto from "node:crypto";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { encryptJson } from "../secrets/crypto";

// ── 配置常量 ─────────────────────────────────────────────

/** 密钥最大存活天数，超过此值自动轮换（默认 90 天） */
const KEY_MAX_AGE_DAYS = Math.max(
  1,
  Number(process.env.KEY_MAX_AGE_DAYS) || 90,
);

/** 预警阈值：距过期不足此天数时写入审计告警（默认 14 天） */
const WARN_BEFORE_DAYS = Math.max(
  1,
  Number(process.env.KEY_WARN_BEFORE_DAYS) || 14,
);

/** 每次 tick 最多轮换的密钥数量（防风暴） */
const MAX_ROTATIONS_PER_TICK = Math.max(
  1,
  Number(process.env.KEY_MAX_ROTATIONS_PER_TICK) || 10,
);

/** re-encryption 单批次处理上限 */
const REENCRYPT_BATCH_LIMIT = Math.max(
  100,
  Number(process.env.KEY_REENCRYPT_BATCH_LIMIT) || 1000,
);

// ── 类型 ─────────────────────────────────────────────────

export interface KeyRotationTickResult {
  /** 本次 tick 检查的活跃密钥总数 */
  scanned: number;
  /** 实际执行轮换的密钥数 */
  rotated: number;
  /** 发出预警的密钥数 */
  warned: number;
  /** 入队的 re-encryption 作业数 */
  reencryptJobsEnqueued: number;
  /** 轮换失败数 */
  failed: number;
  /** 本次 tick 的详细日志 */
  details: RotationDetail[];
}

interface RotationDetail {
  tenantId: string;
  scopeType: string;
  scopeId: string;
  keyVersion: number;
  ageDays: number;
  action: "rotated" | "warned" | "skipped" | "failed" | "reencrypt_queued";
  newKeyVersion?: number;
  error?: string;
}

function scopeKey(tenantId: string, scopeType: string, scopeId: string) {
  return `${tenantId}:${scopeType}:${scopeId}`;
}

async function enqueueReencryptJob(params: {
  queue: Queue;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  keyVersion?: number;
}) {
  return params.queue.add(
    "step",
    {
      kind: "keyring.reencrypt",
      tenantId: params.tenantId,
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      limit: REENCRYPT_BATCH_LIMIT,
    },
    {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      jobId: `keyring-reencrypt:${params.tenantId}:${params.scopeType}:${params.scopeId}:${params.keyVersion ?? "latest"}`,
    },
  );
}

async function listPendingReencryptScopes(params: {
  pool: Pool;
  limit: number;
  excludeScopeKeys?: Set<string>;
}) {
  const res = await params.pool.query(
    `
      SELECT
        s.tenant_id,
        s.scope_type,
        s.scope_id,
        active.key_version AS active_key_version
      FROM secret_records s
      JOIN LATERAL (
        SELECT key_version
        FROM partition_keys
        WHERE tenant_id = s.tenant_id
          AND scope_type = s.scope_type
          AND scope_id = s.scope_id
          AND status = 'active'
        ORDER BY key_version DESC
        LIMIT 1
      ) active ON TRUE
      WHERE s.status = 'active'
        AND s.enc_format = 'envelope.v1'
        AND s.key_version <> active.key_version
      GROUP BY s.tenant_id, s.scope_type, s.scope_id, active.key_version
      ORDER BY MIN(s.updated_at) ASC
      LIMIT $1
    `,
    [params.limit],
  );
  const exclude = params.excludeScopeKeys ?? new Set<string>();
  return (res.rows as any[])
    .map((row) => ({
      tenantId: String(row.tenant_id),
      scopeType: String(row.scope_type),
      scopeId: String(row.scope_id),
      activeKeyVersion: Number(row.active_key_version),
    }))
    .filter((row) => !exclude.has(scopeKey(row.tenantId, row.scopeType, row.scopeId)));
}

// ── 主函数 ────────────────────────────────────────────────

/**
 * 密钥自动轮换 ticker
 *
 * 定期扫描所有活跃的 partition_keys，检查其年龄是否超过 KEY_MAX_AGE_DAYS，
 * 超过则自动轮换并入队 re-encryption 作业。
 */
export async function tickKeyRotation(params: {
  pool: Pool;
  queue: Queue;
  masterKey?: string;
}): Promise<KeyRotationTickResult> {
  const { pool, queue } = params;
  const masterKey = resolveMasterKey(params.masterKey);

  const result: KeyRotationTickResult = {
    scanned: 0,
    rotated: 0,
    warned: 0,
    reencryptJobsEnqueued: 0,
    failed: 0,
    details: [],
  };

  // ── Step 1: 扫描所有活跃密钥及其年龄 ───────────────────
  const agingKeys = await pool.query(
    `
      SELECT
        tenant_id,
        scope_type,
        scope_id,
        key_version,
        created_at,
        EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0 AS age_days
      FROM partition_keys
      WHERE status = 'active'
      ORDER BY created_at ASC
      LIMIT 500
    `,
  );

  result.scanned = agingKeys.rowCount ?? 0;

  let rotationCount = 0;
  const attemptedReencryptScopes = new Set<string>();

  for (const row of agingKeys.rows as any[]) {
    const tenantId = String(row.tenant_id);
    const scopeType = String(row.scope_type);
    const scopeId = String(row.scope_id);
    const keyVersion = Number(row.key_version);
    const ageDays = Number(row.age_days);

    // ── 检查是否需要轮换 ─────────────────────────────────
    if (ageDays >= KEY_MAX_AGE_DAYS) {
      // 防风暴：超过限制则跳过
      if (rotationCount >= MAX_ROTATIONS_PER_TICK) {
        result.details.push({
          tenantId, scopeType, scopeId, keyVersion, ageDays: Math.floor(ageDays),
          action: "skipped",
          error: `max_rotations_per_tick_reached (${MAX_ROTATIONS_PER_TICK})`,
        });
        continue;
      }

      try {
        const newKey = await performAutoRotation({
          pool, tenantId, scopeType, scopeId, masterKey,
        });
        result.rotated++;
        rotationCount++;
        attemptedReencryptScopes.add(scopeKey(tenantId, scopeType, scopeId));

        const job = await enqueueReencryptJob({
          queue,
          tenantId,
          scopeType,
          scopeId,
          keyVersion: newKey.keyVersion,
        });

        // 审计记录
        await writeRotationAudit(pool, {
          tenantId, scopeType, scopeId,
          oldKeyVersion: keyVersion,
          newKeyVersion: newKey.keyVersion,
          trigger: "auto_rotation",
          reencryptJobId: String(job.id ?? ""),
          ageDays: Math.floor(ageDays),
        });

        result.reencryptJobsEnqueued++;

        result.details.push({
          tenantId, scopeType, scopeId, keyVersion, ageDays: Math.floor(ageDays),
          action: "rotated",
          newKeyVersion: newKey.keyVersion,
        });

        console.log(
          `[key-rotation-ticker] AUTO-ROTATED: tenant=${tenantId} scope=${scopeType}:${scopeId} ` +
          `v${keyVersion}→v${newKey.keyVersion} age=${Math.floor(ageDays)}d`,
        );
      } catch (err: any) {
        result.failed++;
        result.details.push({
          tenantId, scopeType, scopeId, keyVersion, ageDays: Math.floor(ageDays),
          action: "failed",
          error: String(err?.message ?? err),
        });
        console.error(
          `[key-rotation-ticker] ROTATION FAILED: tenant=${tenantId} scope=${scopeType}:${scopeId} v${keyVersion}`,
          err,
        );
      }
    } else if (ageDays >= KEY_MAX_AGE_DAYS - WARN_BEFORE_DAYS) {
      // ── 预警：即将到期 ──────────────────────────────────
      result.warned++;
      result.details.push({
        tenantId, scopeType, scopeId, keyVersion, ageDays: Math.floor(ageDays),
        action: "warned",
      });

      await writeRotationAudit(pool, {
        tenantId, scopeType, scopeId,
        oldKeyVersion: keyVersion,
        newKeyVersion: undefined,
        trigger: "expiry_warning",
        ageDays: Math.floor(ageDays),
      });
    }
  }


  const pendingReencryptScopes = await listPendingReencryptScopes({
    pool,
    limit: MAX_ROTATIONS_PER_TICK,
    excludeScopeKeys: attemptedReencryptScopes,
  });
  for (const pendingScope of pendingReencryptScopes) {
    try {
      await enqueueReencryptJob({
        queue,
        tenantId: pendingScope.tenantId,
        scopeType: pendingScope.scopeType,
        scopeId: pendingScope.scopeId,
        keyVersion: pendingScope.activeKeyVersion,
      });
      result.reencryptJobsEnqueued++;
      result.details.push({
        tenantId: pendingScope.tenantId,
        scopeType: pendingScope.scopeType,
        scopeId: pendingScope.scopeId,
        keyVersion: pendingScope.activeKeyVersion,
        ageDays: 0,
        action: "reencrypt_queued",
      });
    } catch (err: any) {
      result.failed++;
      result.details.push({
        tenantId: pendingScope.tenantId,
        scopeType: pendingScope.scopeType,
        scopeId: pendingScope.scopeId,
        keyVersion: pendingScope.activeKeyVersion,
        ageDays: 0,
        action: "failed",
        error: String(err?.message ?? err),
      });
      console.error(
        `[key-rotation-ticker] PENDING REENCRYPT ENQUEUE FAILED: tenant=${pendingScope.tenantId} scope=${pendingScope.scopeType}:${pendingScope.scopeId}`,
        err,
      );
    }
  }
  if (result.rotated > 0 || result.warned > 0 || result.reencryptJobsEnqueued > 0 || result.failed > 0) {
    console.log(
      `[key-rotation-ticker] tick complete: scanned=${result.scanned} ` +
      `rotated=${result.rotated} warned=${result.warned} failed=${result.failed} ` +
      `reencryptJobs=${result.reencryptJobsEnqueued}`,
    );
  }

  return result;
}

// ── 自动轮换执行 ──────────────────────────────────────────

interface AutoRotationResult {
  keyVersion: number;
  status: string;
}

/**
 * 执行单个分区密钥的自动轮换。
 *
 * 原子操作（事务内）：
 * 1. 将当前 active key 标记为 retired（保留可解密能力）
 * 2. 生成新的 AES-256 密钥并用 masterKey 包装
 * 3. 插入新 active key（version + 1）
 */
async function performAutoRotation(params: {
  pool: Pool;
  tenantId: string;
  scopeType: string;
  scopeId: string;
  masterKey: string;
}): Promise<AutoRotationResult> {
  const { pool, tenantId, scopeType, scopeId, masterKey } = params;

  // 使用事务确保原子性
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 锁定当前最新版本
    const cur = await client.query(
      `SELECT key_version
       FROM partition_keys
       WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3
       ORDER BY key_version DESC LIMIT 1
       FOR UPDATE`,
      [tenantId, scopeType, scopeId],
    );

    const nextVersion = cur.rowCount ? Number(cur.rows[0].key_version) + 1 : 1;

    // 将所有 active 密钥标记为 retired（双密钥过渡期开始）
    await client.query(
      `UPDATE partition_keys
       SET status = 'retired', updated_at = now()
       WHERE tenant_id = $1 AND scope_type = $2 AND scope_id = $3 AND status = 'active'`,
      [tenantId, scopeType, scopeId],
    );

    // 生成新密钥
    const keyBytes = crypto.randomBytes(32);
    const encryptedKey = encryptJson(masterKey, { k: keyBytes.toString("base64") });

    // 插入新活跃密钥
    await client.query(
      `INSERT INTO partition_keys (tenant_id, scope_type, scope_id, key_version, status, encrypted_key)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [tenantId, scopeType, scopeId, nextVersion, encryptedKey],
    );

    await client.query("COMMIT");

    return { keyVersion: nextVersion, status: "active" };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── 审计写入 ──────────────────────────────────────────────

async function writeRotationAudit(
  pool: Pool,
  params: {
    tenantId: string;
    scopeType: string;
    scopeId: string;
    oldKeyVersion: number;
    newKeyVersion?: number;
    trigger: "auto_rotation" | "expiry_warning";
    reencryptJobId?: string;
    ageDays: number;
  },
) {
  const traceId = `worker:key-rotation:${crypto.randomUUID()}`;
  const action = params.trigger === "auto_rotation"
    ? "key.auto_rotated"
    : "key.expiry_warning";

  const outputDigest = {
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    oldKeyVersion: params.oldKeyVersion,
    newKeyVersion: params.newKeyVersion ?? null,
    trigger: params.trigger,
    ageDays: params.ageDays,
    maxAgeDays: KEY_MAX_AGE_DAYS,
    reencryptJobId: params.reencryptJobId ?? null,
  };

  try {
    await pool.query(
      `INSERT INTO audit_events (
         subject_id, tenant_id, space_id, resource_type, action,
         input_digest, output_digest, result, trace_id, error_category
       )
       VALUES (NULL, $1, $2, 'keyring', $3, NULL, $4::jsonb, 'success', $5, NULL)`,
      [
        params.tenantId,
        params.scopeType === "space" ? params.scopeId : null,
        action,
        JSON.stringify(outputDigest),
        traceId,
      ],
    );
  } catch (err) {
    // 审计写入失败不应影响轮换流程
    console.error("[key-rotation-ticker] audit write failed", err);
  }
}

// ── 工具函数 ──────────────────────────────────────────────

function resolveMasterKey(given?: string): string {
  const key = String(given ?? "").trim()
    || String(process.env.API_MASTER_KEY ?? "").trim()
    || (process.env.NODE_ENV === "production" ? "" : "dev-master-key-change-me");
  if (!key) {
    throw new Error("master_key_missing: cannot perform key rotation without master key");
  }
  return key;
}

// ── 密钥健康状态查询 ──────────────────────────────────────

export interface KeyHealthReport {
  totalActive: number;
  totalRetired: number;
  totalDisabled: number;
  agingKeys: Array<{
    tenantId: string;
    scopeType: string;
    scopeId: string;
    keyVersion: number;
    ageDays: number;
    status: string;
  }>;
  /** 即将过期（age > maxAge - warnDays）的密钥数 */
  nearExpiry: number;
  /** 已过期（age > maxAge）但未轮换的密钥数 */
  overdue: number;
}

/**
 * 获取密钥健康报告，用于运维监控和诊断端点。
 */
export async function getKeyHealthReport(params: {
  pool: Pool;
}): Promise<KeyHealthReport> {
  const { pool } = params;

  const statusCounts = await pool.query(
    `SELECT status, COUNT(*)::int AS cnt
     FROM partition_keys
     GROUP BY status`,
  );

  let totalActive = 0;
  let totalRetired = 0;
  let totalDisabled = 0;
  for (const r of statusCounts.rows as any[]) {
    switch (r.status) {
      case "active": totalActive = Number(r.cnt); break;
      case "retired": totalRetired = Number(r.cnt); break;
      case "disabled": totalDisabled = Number(r.cnt); break;
    }
  }

  const agingRes = await pool.query(
    `SELECT
       tenant_id, scope_type, scope_id, key_version, status,
       EXTRACT(EPOCH FROM (now() - created_at)) / 86400.0 AS age_days
     FROM partition_keys
     WHERE status = 'active'
     ORDER BY created_at ASC
     LIMIT 100`,
  );

  const agingKeys = (agingRes.rows as any[]).map((r) => ({
    tenantId: String(r.tenant_id),
    scopeType: String(r.scope_type),
    scopeId: String(r.scope_id),
    keyVersion: Number(r.key_version),
    ageDays: Math.floor(Number(r.age_days)),
    status: String(r.status),
  }));

  const nearExpiry = agingKeys.filter(
    (k) => k.ageDays >= KEY_MAX_AGE_DAYS - WARN_BEFORE_DAYS && k.ageDays < KEY_MAX_AGE_DAYS,
  ).length;

  const overdue = agingKeys.filter(
    (k) => k.ageDays >= KEY_MAX_AGE_DAYS,
  ).length;

  return {
    totalActive,
    totalRetired,
    totalDisabled,
    agingKeys,
    nearExpiry,
    overdue,
  };
}
