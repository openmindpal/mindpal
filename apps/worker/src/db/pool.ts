import { Pool } from "pg";
import type { WorkerConfig } from "../config";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:dbPool" });

/**
 * Worker 侧连接池——复用 DbConfig.pool 参数，
 * Worker 可通过 DB_POOL_MAX 环境变量单独设置较低的 max（建议 10）。
 */
export function createPool(cfg: WorkerConfig): Pool {
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
    _logger.error("pool background error", { error: err.message, code: (err as any).code });
  });
  pool.on("remove", () => {
    _logger.info("connection removed", { total: pool.totalCount, idle: pool.idleCount });
  });

  _logger.info("pool created", {
    max: db.pool.max,
    min: db.pool.min,
    idleTimeoutMs: db.pool.idleTimeoutMs,
    connectTimeoutMs: db.pool.connectionTimeoutMs,
    statementTimeoutMs: db.pool.statementTimeoutMs,
  });

  return pool;
}
