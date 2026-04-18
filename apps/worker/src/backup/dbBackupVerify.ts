/**
 * P3-03b: 数据库备份完整性验证
 *
 * Worker ticker 定期对已完成但未验证的备份执行完整性校验：
 * 1. TOC 验证：使用 pg_restore --list 读取备份 TOC（Table of Contents），确认备份格式完整
 * 2. SHA-256 校验：重新计算文件校验和，与存储的校验和对比
 * 3. 文件存在性：确认备份文件仍然存在且可读
 *
 * 验证结果更新到 db_backups 表的 verified_at / verify_toc_ok / verify_checksum_ok 字段。
 */

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fss from "node:fs";
import fs from "node:fs/promises";
import type { Pool } from "pg";

// ── 配置 ──────────────────────────────────────────────────

/** pg_restore 可执行文件路径 */
const PG_RESTORE_BIN = process.env.PG_RESTORE_BIN ?? "pg_restore";

/** 每次 tick 最多验证的备份数 */
const MAX_VERIFY_PER_TICK = Math.max(1, Number(process.env.DB_BACKUP_MAX_VERIFY_PER_TICK) || 5);

/** 验证超时（ms），默认 5 分钟 */
const VERIFY_TIMEOUT_MS = Math.max(10_000, Number(process.env.DB_BACKUP_VERIFY_TIMEOUT_MS) || 5 * 60_000);

/** 是否启用自动验证（默认跟随备份启用状态） */
const VERIFY_ENABLED = (process.env.DB_BACKUP_ENABLED ?? "false").toLowerCase() === "true";

// ── 类型定义 ──────────────────────────────────────────────

export interface DbBackupVerifyTickResult {
  verified: number;
  passed: number;
  failed: number;
  errors: string[];
}

interface PendingBackup {
  id: string;
  storagePath: string;
  sha256Checksum: string | null;
  pgDumpFormat: string;
  backupType: string;
}

// ── 工具函数 ──────────────────────────────────────────────

/** 计算文件 SHA-256（流式） */
async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fss.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** 检查文件是否存在且可读 */
async function isFileReadable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fss.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// ── TOC 验证 ──────────────────────────────────────────────

/**
 * 使用 pg_restore --list 读取备份 TOC。
 * 如果能成功读取 TOC，说明备份文件格式完整。
 *
 * 返回 TOC 行数（对象数量）。
 */
async function verifyToc(filePath: string): Promise<{ ok: boolean; objectCount: number; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(PG_RESTORE_BIN, ["--list", filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, objectCount: 0, error: `pg_restore --list timeout after ${VERIFY_TIMEOUT_MS}ms` });
    }, VERIFY_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, objectCount: 0, error: `pg_restore spawn error: ${err.message}` });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        // 每行代表一个数据库对象（表、索引、函数等）
        const lines = stdout.split("\n").filter((l) => l.trim() && !l.startsWith(";"));
        resolve({ ok: true, objectCount: lines.length });
      } else {
        const errMsg = stderr.slice(-300).trim();
        resolve({ ok: false, objectCount: 0, error: `pg_restore --list exited with code ${code}: ${errMsg}` });
      }
    });
  });
}

// ── 主 Ticker 函数 ───────────────────────────────────────

/**
 * 备份验证 ticker。
 *
 * 查找 status='completed' 且 verified_at IS NULL 的备份记录，
 * 对每个执行 TOC 验证 + SHA-256 校验。
 */
export async function tickDbBackupVerify(params: { pool: Pool }): Promise<DbBackupVerifyTickResult> {
  const { pool } = params;
  const result: DbBackupVerifyTickResult = {
    verified: 0,
    passed: 0,
    failed: 0,
    errors: [],
  };

  if (!VERIFY_ENABLED) {
    return result;
  }

  try {
    // 查找待验证的备份
    const pending = await pool.query(
      `SELECT id, storage_path, sha256_checksum, pg_dump_format, backup_type
       FROM db_backups
       WHERE status = 'completed'
         AND verified_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [MAX_VERIFY_PER_TICK],
    );

    if (!pending.rowCount || pending.rowCount === 0) {
      return result;
    }

    for (const row of pending.rows) {
      const backup = row as unknown as PendingBackup;
      const verifyResult = await verifyOneBackup(pool, backup);
      result.verified++;

      if (verifyResult.passed) {
        result.passed++;
      } else {
        result.failed++;
        if (verifyResult.error) {
          result.errors.push(`${backup.id}: ${verifyResult.error}`);
        }
      }
    }

    if (result.verified > 0) {
      console.log(
        `[db-backup-verify] Verified ${result.verified} backup(s): ${result.passed} passed, ${result.failed} failed`,
      );
    }
  } catch (err: any) {
    const errMsg = String(err?.message ?? err);
    result.errors.push(errMsg);
    console.error("[db-backup-verify] tick failed:", errMsg);
  }

  return result;
}

// ── 单个备份验证 ─────────────────────────────────────────

async function verifyOneBackup(
  pool: Pool,
  backup: PendingBackup,
): Promise<{ passed: boolean; error?: string }> {
  let tocOk = false;
  let checksumOk = false;
  let verifyError: string | null = null;

  try {
    // ── 1. 文件存在性检查 ─────────────────────────────
    const readable = await isFileReadable(backup.storagePath);
    if (!readable) {
      verifyError = `Backup file not found or not readable: ${backup.storagePath}`;
      await updateVerifyStatus(pool, backup.id, false, false, verifyError);
      return { passed: false, error: verifyError };
    }

    // ── 2. TOC 验证 ───────────────────────────────────
    if (backup.pgDumpFormat === "custom") {
      const tocResult = await verifyToc(backup.storagePath);
      tocOk = tocResult.ok;

      if (!tocOk) {
        verifyError = `TOC verification failed: ${tocResult.error}`;
        console.warn(`[db-backup-verify] ${backup.id} TOC FAILED: ${tocResult.error}`);
      } else {
        console.log(`[db-backup-verify] ${backup.id} TOC OK (${tocResult.objectCount} objects)`);
      }
    } else {
      // 非 custom 格式跳过 TOC 验证
      tocOk = true;
    }

    // ── 3. SHA-256 校验 ───────────────────────────────
    if (backup.sha256Checksum) {
      const currentSha256 = await computeFileSha256(backup.storagePath);
      checksumOk = currentSha256 === backup.sha256Checksum;

      if (!checksumOk) {
        const err = `Checksum mismatch: expected=${backup.sha256Checksum.slice(0, 16)}... actual=${currentSha256.slice(0, 16)}...`;
        verifyError = verifyError ? `${verifyError}; ${err}` : err;
        console.warn(`[db-backup-verify] ${backup.id} CHECKSUM MISMATCH`);
      } else {
        console.log(`[db-backup-verify] ${backup.id} checksum OK`);
      }
    } else {
      // 无校验和记录，跳过（不算失败）
      checksumOk = true;
    }

    // ── 4. 更新状态 ───────────────────────────────────
    const passed = tocOk && checksumOk;
    await updateVerifyStatus(pool, backup.id, tocOk, checksumOk, verifyError);

    // 写审计
    await writeVerifyAudit(pool, {
      backupId: backup.id,
      backupType: backup.backupType,
      tocOk,
      checksumOk,
      passed,
      error: verifyError,
    });

    return { passed, error: verifyError ?? undefined };

  } catch (err: any) {
    const errMsg = String(err?.message ?? err).slice(0, 1000);
    await updateVerifyStatus(pool, backup.id, tocOk, checksumOk, errMsg);
    return { passed: false, error: errMsg };
  }
}

// ── 数据库更新 ───────────────────────────────────────────

async function updateVerifyStatus(
  pool: Pool,
  backupId: string,
  tocOk: boolean,
  checksumOk: boolean,
  error: string | null,
): Promise<void> {
  const passed = tocOk && checksumOk;
  const newStatus = passed ? "verified" : "verify_failed";

  await pool.query(
    `UPDATE db_backups SET
      status = $2,
      verified_at = now(),
      verify_toc_ok = $3,
      verify_checksum_ok = $4,
      verify_error = $5,
      updated_at = now()
    WHERE id = $1`,
    [backupId, newStatus, tocOk, checksumOk, error],
  );
}

// ── 审计 ──────────────────────────────────────────────────

async function writeVerifyAudit(
  pool: Pool,
  digest: Record<string, unknown>,
): Promise<void> {
  const traceId = `worker:db-backup-verify:${crypto.randomUUID()}`;

  try {
    await pool.query(
      `INSERT INTO audit_events (
         subject_id, tenant_id, space_id, resource_type, action,
         input_digest, output_digest, result, trace_id, error_category
       )
       VALUES (NULL, '__system__', NULL, 'db_backup', 'db_backup.verified', NULL, $1::jsonb, $2, $3, NULL)`,
      [
        JSON.stringify(digest),
        digest.passed ? "success" : "error",
        traceId,
      ],
    );
  } catch (err) {
    console.error("[db-backup-verify] audit write failed", err);
  }
}
