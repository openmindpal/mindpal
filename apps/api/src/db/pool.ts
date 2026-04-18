import { Pool } from "pg";
import type { ApiConfig } from "../config";

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
    console.log(`[db:api] new connection established (total=${pool.totalCount}, idle=${pool.idleCount}, waiting=${pool.waitingCount})`);
  });
  pool.on("error", (err) => {
    console.error(`[db:api] pool background error: ${err.message}`, { code: (err as any).code });
  });
  pool.on("remove", () => {
    console.log(`[db:api] connection removed (total=${pool.totalCount}, idle=${pool.idleCount})`);
  });

  console.log(
    `[db:api] pool created — max=${db.pool.max}, min=${db.pool.min}, ` +
    `idle=${db.pool.idleTimeoutMs}ms, connect=${db.pool.connectionTimeoutMs}ms, ` +
    `statement=${db.pool.statementTimeoutMs}ms`
  );

  return pool;
}
