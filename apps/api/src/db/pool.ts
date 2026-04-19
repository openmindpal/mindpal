import { Pool } from "pg";
import type { ApiConfig } from "../config";
import { StructuredLogger } from "@openslin/shared";

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
