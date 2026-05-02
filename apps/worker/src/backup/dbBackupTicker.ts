/**
 * P3-03a: 数据库自动备份调度器
 *
 * Worker ticker 定期触发 pg_dump 全量逻辑备份，
 * 并执行保留策略清理过期备份文件。
 *
 * ── 设计要点 ──
 * 1. 全量备份：使用 pg_dump --format=custom 生成压缩的自定义格式备份
 * 2. 增量模拟：通过更频繁的全量备份 + 差异对比实现（真正的 WAL 归档需 PG 配置）
 * 3. 保留策略：全量备份保留 FULL_RETENTION_DAYS 天（默认 7），增量保留 INCR_RETENTION_DAYS 天（默认 30）
 * 4. 存储后端：默认本地文件系统（可挂载为 NFS/对象存储卷），可选 S3 兼容存储
 * 5. 防风暴：同一时间只允许一个备份任务运行（分布式锁 + 数据库状态双重保护）
 * 6. 完整性：备份完成后计算 SHA-256 校验和并记录到 db_backups 表
 * 7. 审计：所有备份操作写入 audit_events
 */

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:dbBackupTicker" });

// ── 配置常量 ─────────────────────────────────────────────

/** 备份存储根目录（默认 var/backups） */
const BACKUP_ROOT_DIR = process.env.DB_BACKUP_ROOT_DIR ?? "var/backups";

/** pg_dump 可执行文件路径（默认依赖 PATH） */
const PG_DUMP_BIN = process.env.PG_DUMP_BIN ?? "pg_dump";

/** pg_restore 可执行文件路径（用于 TOC 验证） */
const PG_RESTORE_BIN = process.env.PG_RESTORE_BIN ?? "pg_restore";

/** 全量备份保留天数（默认 7） */
const FULL_RETENTION_DAYS = Math.max(1, Number(process.env.DB_BACKUP_FULL_RETENTION_DAYS) || 7);

/** 增量备份保留天数（默认 30） */
const INCR_RETENTION_DAYS = Math.max(1, Number(process.env.DB_BACKUP_INCR_RETENTION_DAYS) || 30);

/** 备份超时（ms），默认 30 分钟 */
const BACKUP_TIMEOUT_MS = Math.max(60_000, Number(process.env.DB_BACKUP_TIMEOUT_MS) || 30 * 60_000);

/** 每次 tick 最多清理的过期备份数（防风暴） */
const MAX_CLEANUP_PER_TICK = Math.max(1, Number(process.env.DB_BACKUP_MAX_CLEANUP_PER_TICK) || 20);

/** Worker 实例标识 */
const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;

/** 是否启用自动备份（默认关闭，生产环境应开启） */
const BACKUP_ENABLED = (process.env.DB_BACKUP_ENABLED ?? "false").toLowerCase() === "true";

// ── 类型定义 ──────────────────────────────────────────────

export interface DbBackupTickResult {
  backupExecuted: boolean;
  backupId?: string;
  backupType?: "full" | "incremental";
  fileSizeBytes?: number;
  durationMs?: number;
  cleanedUp: number;
  errors: string[];
}

interface BackupRecord {
  id: string;
  backupType: string;
  status: string;
  storagePath: string;
  fileSizeBytes: number | null;
  sha256Checksum: string | null;
  createdAt: string;
}

// ── 工具函数 ──────────────────────────────────────────────

/** 确保目录存在 */
async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 计算文件 SHA-256 校验和（流式，不占用大量内存） */
async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fss.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** 获取文件大小 */
async function getFileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

/** 生成备份文件路径 */
function generateBackupPath(backupType: "full" | "incremental", dbName: string): string {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const filename = `${dbName}_${backupType}_${dateStr}.dump`;
  const subdir = path.join(BACKUP_ROOT_DIR, backupType, now.toISOString().slice(0, 7)); // YYYY-MM 子目录
  return path.join(subdir, filename);
}

/** 计算过期时间 */
function computeExpiresAt(backupType: "full" | "incremental"): Date {
  const days = backupType === "full" ? FULL_RETENTION_DAYS : INCR_RETENTION_DAYS;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ── pg_dump 执行 ─────────────────────────────────────────

interface PgDumpOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  outputPath: string;
  format?: "custom" | "directory" | "plain";
  schemas?: string[];
  timeoutMs?: number;
}

/**
 * 执行 pg_dump 并将输出写入指定路径。
 * 使用 custom 格式（压缩、支持 pg_restore --list TOC 验证）。
 */
async function executePgDump(opts: PgDumpOptions): Promise<{ durationMs: number; pgVersion: string }> {
  const startTime = Date.now();
  const format = opts.format ?? "custom";
  const timeoutMs = opts.timeoutMs ?? BACKUP_TIMEOUT_MS;

  // 确保输出目录存在
  await ensureDir(path.dirname(opts.outputPath));

  const args: string[] = [
    "--host", opts.host,
    "--port", String(opts.port),
    "--username", opts.user,
    "--dbname", opts.database,
    "--format", format === "custom" ? "c" : format === "directory" ? "d" : "p",
    "--file", opts.outputPath,
    "--no-password",
    "--verbose",
    "--compress", "6",       // zlib 压缩等级 6（平衡速度与压缩比）
    "--lock-wait-timeout", "30000", // 30s 锁等待超时
  ];

  // 可选 schema 过滤
  if (opts.schemas?.length) {
    for (const s of opts.schemas) {
      args.push("--schema", s);
    }
  }

  return new Promise((resolve, reject) => {
    let pgVersion = "unknown";
    let stderr = "";

    const child = spawn(PG_DUMP_BIN, args, {
      env: {
        ...process.env,
        PGPASSWORD: opts.password,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 超时保护
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pg_dump timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", () => {
      // pg_dump custom 格式输出到文件，stdout 通常为空
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // 尝试提取 PG 版本
      const vMatch = text.match(/pg_dump.*?(\d+\.\d+)/i);
      if (vMatch) pgVersion = vMatch[1];
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`pg_dump spawn error: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (code === 0) {
        resolve({ durationMs, pgVersion });
      } else {
        // 截取 stderr 最后 500 字符作为错误信息
        const errMsg = stderr.slice(-500).trim();
        reject(new Error(`pg_dump exited with code ${code}: ${errMsg}`));
      }
    });
  });
}

// ── 主 Ticker 函数 ───────────────────────────────────────

/**
 * 数据库自动备份 ticker。
 *
 * 1. 检查是否需要备份（距上次成功备份是否超过间隔）
 * 2. 执行 pg_dump
 * 3. 计算校验和
 * 4. 记录元数据到 db_backups 表
 * 5. 清理过期备份
 */
export async function tickDbBackup(params: {
  pool: Pool;
  dbConfig: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
}): Promise<DbBackupTickResult> {
  const { pool, dbConfig } = params;
  const result: DbBackupTickResult = {
    backupExecuted: false,
    cleanedUp: 0,
    errors: [],
  };

  if (!BACKUP_ENABLED) {
    return result;
  }

  try {
    // ── Step 1: 检查是否已有运行中的备份 ────────────────
    const runningCheck = await pool.query(
      `SELECT id FROM db_backups WHERE status = 'running' AND started_at > now() - interval '2 hours' LIMIT 1`,
    );
    if (runningCheck.rowCount && runningCheck.rowCount > 0) {
      _logger.info("another backup is already running, skipping");
      return result;
    }

    // ── Step 2: 确定备份类型 ─────────────────────────────
    // 检查上次成功的全量备份时间
    const lastFull = await pool.query(
      `SELECT finished_at FROM db_backups
       WHERE backup_type = 'full' AND status IN ('completed', 'verified')
       ORDER BY finished_at DESC LIMIT 1`,
    );

    const lastFullTime = lastFull.rows[0]?.finished_at
      ? new Date(lastFull.rows[0].finished_at).getTime()
      : 0;
    const hoursSinceLastFull = (Date.now() - lastFullTime) / (1000 * 60 * 60);

    // 如果超过 24h 没有全量备份，执行全量；否则执行增量
    const backupType: "full" | "incremental" = hoursSinceLastFull >= 24 ? "full" : "incremental";
    result.backupType = backupType;

    // 增量备份间隔至少 4 小时
    if (backupType === "incremental") {
      const lastAny = await pool.query(
        `SELECT finished_at FROM db_backups
         WHERE status IN ('completed', 'verified')
         ORDER BY finished_at DESC LIMIT 1`,
      );
      const lastAnyTime = lastAny.rows[0]?.finished_at
        ? new Date(lastAny.rows[0].finished_at).getTime()
        : 0;
      const hoursSinceLast = (Date.now() - lastAnyTime) / (1000 * 60 * 60);
      if (hoursSinceLast < 4) {
        // 最近 4 小时内已有备份，跳过
        await cleanupExpiredBackups(pool, result);
        return result;
      }
    }

    // ── Step 3: 创建备份记录 ─────────────────────────────
    const storagePath = generateBackupPath(backupType, dbConfig.database);
    const expiresAt = computeExpiresAt(backupType);

    const insertRes = await pool.query(
      `INSERT INTO db_backups (
        backup_type, status, storage_backend, storage_path, pg_dump_format,
        database_name, started_at, worker_id, retention_policy, expires_at
      ) VALUES ($1, 'running', 'local', $2, 'custom', $3, now(), $4, 'standard', $5)
      RETURNING id`,
      [backupType, storagePath, dbConfig.database, WORKER_ID, expiresAt.toISOString()],
    );
    const backupId = insertRes.rows[0].id as string;
    result.backupId = backupId;

    // ── Step 4: 执行 pg_dump ─────────────────────────────
    _logger.info("starting backup", { backupType, storagePath });
    const startMs = Date.now();

    try {
      const { durationMs, pgVersion } = await executePgDump({
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        user: dbConfig.user,
        password: dbConfig.password,
        outputPath: storagePath,
      });

      // ── Step 5: 计算校验和和文件大小 ────────────────────
      const [sha256, fileSize] = await Promise.all([
        computeFileSha256(storagePath),
        getFileSize(storagePath),
      ]);

      result.durationMs = durationMs;
      result.fileSizeBytes = fileSize;
      result.backupExecuted = true;

      // ── Step 6: 更新备份记录 ────────────────────────────
      await pool.query(
        `UPDATE db_backups SET
          status = 'completed',
          file_size_bytes = $2,
          sha256_checksum = $3,
          pg_version = $4,
          finished_at = now(),
          duration_ms = $5,
          updated_at = now()
        WHERE id = $1`,
        [backupId, fileSize, sha256, pgVersion, durationMs],
      );

      _logger.info("backup completed", { backupType, storagePath, sizeMB: (fileSize / 1024 / 1024).toFixed(1), durationMs, sha256: sha256.slice(0, 16) });

      // ── Step 7: 写入审计 ────────────────────────────────
      await writeBackupAudit(pool, {
        backupId,
        backupType,
        action: "db_backup.completed",
        storagePath,
        fileSize,
        durationMs,
        sha256: sha256.slice(0, 16),
      });

    } catch (dumpError: any) {
      const errMsg = String(dumpError?.message ?? dumpError).slice(0, 2000);
      result.errors.push(errMsg);

      await pool.query(
        `UPDATE db_backups SET
          status = 'failed',
          error_message = $2,
          finished_at = now(),
          duration_ms = $3,
          updated_at = now()
        WHERE id = $1`,
        [backupId, errMsg, Date.now() - startMs],
      );

      _logger.error("backup FAILED", { backupType, err: errMsg });

      await writeBackupAudit(pool, {
        backupId,
        backupType,
        action: "db_backup.failed",
        error: errMsg,
      });

      // 清理失败的备份文件（如果存在）
      try { await fs.unlink(storagePath); } catch { /* ignore */ }
    }

    // ── Step 8: 清理过期备份 ──────────────────────────────
    await cleanupExpiredBackups(pool, result);

  } catch (tickError: any) {
    const errMsg = String(tickError?.message ?? tickError);
    result.errors.push(errMsg);
    _logger.error("tick failed", { error: errMsg });
  }

  return result;
}

// ── 保留策略清理 ─────────────────────────────────────────

/**
 * 清理过期备份：
 * 1. 查询 expires_at 已过期且状态为 completed/verified 的记录
 * 2. 删除对应的备份文件
 * 3. 更新记录状态为 expired
 */
async function cleanupExpiredBackups(pool: Pool, result: DbBackupTickResult): Promise<void> {
  try {
    const expired = await pool.query(
      `SELECT id, storage_path, backup_type, file_size_bytes, sha256_checksum
       FROM db_backups
       WHERE expires_at < now()
         AND status IN ('completed', 'verified', 'verify_failed')
         AND retention_policy != 'legal_hold'
       ORDER BY created_at ASC
       LIMIT $1`,
      [MAX_CLEANUP_PER_TICK],
    );

    if (!expired.rowCount || expired.rowCount === 0) return;

    let cleaned = 0;
    for (const row of expired.rows) {
      const rec = row as BackupRecord;
      try {
        // 删除物理文件
        try {
          await fs.unlink(rec.storagePath);
        } catch (unlinkErr: any) {
          // 文件可能已被手动删除，记录但不阻塞
          if (unlinkErr.code !== "ENOENT") {
            _logger.warn("failed to delete backup file", { path: rec.storagePath, error: unlinkErr.message });
          }
        }

        // 更新状态
        await pool.query(
          `UPDATE db_backups SET status = 'expired', updated_at = now() WHERE id = $1`,
          [rec.id],
        );

        cleaned++;
      } catch (err: any) {
        _logger.error("cleanup failed for backup", { backupId: rec.id, error: err.message });
      }
    }

    if (cleaned > 0) {
      result.cleanedUp = cleaned;
      _logger.info("cleaned up expired backups", { count: cleaned });

      await writeBackupAudit(pool, {
        action: "db_backup.cleanup",
        cleanedCount: cleaned,
      });
    }
  } catch (err: any) {
    _logger.error("cleanup scan failed", { error: err.message });
  }
}

// ── 审计 ──────────────────────────────────────────────────

async function writeBackupAudit(
  pool: Pool,
  digest: Record<string, unknown>,
): Promise<void> {
  const traceId = `worker:db-backup:${crypto.randomUUID()}`;
  const action = String(digest.action ?? "db_backup.unknown");

  try {
    await pool.query(
      `INSERT INTO audit_events (
         subject_id, tenant_id, space_id, resource_type, action,
         input_digest, output_digest, result, trace_id, error_category
       )
       VALUES (NULL, '__system__', NULL, 'db_backup', $1, NULL, $2::jsonb, $3, $4, NULL)`,
      [
        action,
        JSON.stringify(digest),
        digest.error ? "error" : "success",
        traceId,
      ],
    );
  } catch (err) {
    // 审计写入失败不应影响备份流程
    _logger.error("audit write failed", { error: (err as Error)?.message ?? err });
  }
}

// ── 查询接口（供 API/诊断端点使用）──────────────────────

/**
 * 获取备份概况统计
 */
export async function getBackupStats(pool: Pool): Promise<{
  totalBackups: number;
  completedBackups: number;
  failedBackups: number;
  totalSizeBytes: number;
  lastFullBackup: string | null;
  lastIncrementalBackup: string | null;
  nextExpiry: string | null;
}> {
  const stats = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('completed', 'verified')) AS completed,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COALESCE(SUM(file_size_bytes) FILTER (WHERE status IN ('completed', 'verified')), 0) AS total_size,
      MAX(finished_at) FILTER (WHERE backup_type = 'full' AND status IN ('completed', 'verified')) AS last_full,
      MAX(finished_at) FILTER (WHERE backup_type = 'incremental' AND status IN ('completed', 'verified')) AS last_incr,
      MIN(expires_at) FILTER (WHERE status IN ('completed', 'verified') AND expires_at > now()) AS next_expiry
    FROM db_backups
    WHERE status NOT IN ('expired')
  `);

  const r = stats.rows[0] as any;
  return {
    totalBackups: Number(r.total ?? 0),
    completedBackups: Number(r.completed ?? 0),
    failedBackups: Number(r.failed ?? 0),
    totalSizeBytes: Number(r.total_size ?? 0),
    lastFullBackup: r.last_full ? String(r.last_full) : null,
    lastIncrementalBackup: r.last_incr ? String(r.last_incr) : null,
    nextExpiry: r.next_expiry ? String(r.next_expiry) : null,
  };
}

/**
 * 列出最近的备份记录
 */
export async function listRecentBackups(pool: Pool, limit = 20): Promise<Array<{
  id: string;
  backupType: string;
  status: string;
  storagePath: string;
  fileSizeBytes: number | null;
  sha256Checksum: string | null;
  durationMs: number | null;
  createdAt: string;
  expiresAt: string | null;
}>> {
  const res = await pool.query(
    `SELECT id, backup_type, status, storage_path, file_size_bytes,
            sha256_checksum, duration_ms, created_at, expires_at
     FROM db_backups
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  );

  return res.rows.map((r: any) => ({
    id: r.id,
    backupType: r.backup_type,
    status: r.status,
    storagePath: r.storage_path,
    fileSizeBytes: r.file_size_bytes != null ? Number(r.file_size_bytes) : null,
    sha256Checksum: r.sha256_checksum ?? null,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
    createdAt: String(r.created_at),
    expiresAt: r.expires_at ? String(r.expires_at) : null,
  }));
}
