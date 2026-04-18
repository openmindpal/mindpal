import { Pool } from "pg";
import type { WorkerConfig } from "../config";

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
    console.log(`[db:worker] new connection established (total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount})`);
  });
  pool.on("error", (err) => {
    console.error(`[db:worker] pool background error: ${err.message}`, { code: (err as any).code });
  });
  pool.on("remove", () => {
    console.log(`[db:worker] connection removed (total=${pool.totalCount}, idle=${pool.idleCount})`);
  });

  console.log(
    `[db:worker] pool created — max=${db.pool.max}, min=${db.pool.min}, ` +
    `idle=${db.pool.idleTimeoutMs}ms, connect=${db.pool.connectionTimeoutMs}ms, ` +
    `statement=${db.pool.statementTimeoutMs}ms`
  );

  return pool;
}
