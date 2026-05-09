import { Pool } from "pg";
import type { ApiConfig } from "../config";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "db:pool" });

export function createPool(cfg: ApiConfig): Pool {
  const { db } = cfg;
  const pool = new Pool({
    host: db.host,
    port: db.port,
    database: db.database,
    user: db.user,
    password: db.password,
    // ─ P0-01: 连接池调优参数 ─
    max: db.pool.max,
    min: db.pool.min,
    idleTimeoutMillis: db.pool.idleTimeoutMs,
    connectionTimeoutMillis: db.pool.connectionTimeoutMs,
    statement_timeout: db.pool.statementTimeoutMs || undefined,
  });

  // ─ 连接池可观测性日志 ─
  pool.on("connect", () => {
    _logger.info("new connection established", { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  });
  pool.on("error", (err) => {
    _logger.error("pool background error", { err: err.message, code: (err as NodeJS.ErrnoException).code });
  });
  pool.on("remove", () => {
    _logger.info("connection removed", { total: pool.totalCount, idle: pool.idleCount });
  });

  _logger.info("pool created", {
    max: db.pool.max,
    min: db.pool.min,
    idleMs: db.pool.idleTimeoutMs,
    connectMs: db.pool.connectionTimeoutMs,
    statementMs: db.pool.statementTimeoutMs,
  });

  return pool;
}

/**
 * 启动时校验向量维度一致性：确保 DB 中的 vector 列维度与环境变量配置一致。
 * 在服务启动完成、DB 连接池就绪后调用。
 */
export async function validateVectorDimensions(pool: Pool, logger: { error: (...args: any[]) => void; info: (...args: any[]) => void }): Promise<void> {
  const envDim = Number(process.env.KNOWLEDGE_EMBEDDING_DIMENSIONS ?? process.env.MEMORY_EMBEDDING_DIMENSIONS ?? 1536);

  try {
    // 查询 pgvector 列的实际维度（通过 pg_attribute.atttypmod）
    const result = await pool.query(`
      SELECT c.relname AS table_name, a.attname AS column_name, a.atttypmod AS dimensions
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      WHERE a.atttypid = (SELECT oid FROM pg_type WHERE typname = 'vector')
        AND a.atttypmod > 0
        AND c.relkind = 'r'
      ORDER BY c.relname, a.attname
    `);

    if (result.rows.length === 0) {
      logger.info("[VectorDimCheck] No vector columns found, skipping dimension validation");
      return;
    }

    const mismatches = result.rows.filter((row: any) => row.dimensions !== envDim);
    if (mismatches.length > 0) {
      logger.error(
        { envDim, mismatches: mismatches.map((r: any) => ({ table: r.table_name, column: r.column_name, dbDim: r.dimensions })) },
        `[VectorDimCheck] Vector dimension mismatch detected! ENV=${envDim} but DB columns have different dimensions. Update migrations or ENV to align.`,
      );
      // 开发阶段仅警告不退出，生产环境可改为 process.exit(1)
    } else {
      logger.info({ envDim, columns: result.rows.length }, "[VectorDimCheck] All vector dimensions consistent");
    }
  } catch (err: unknown) {
    // pgvector 扩展可能未安装，不应阻断启动
    logger.info({ error: String((err as Error)?.message ?? err) }, "[VectorDimCheck] Skipped (pgvector may not be installed)");
  }
}
