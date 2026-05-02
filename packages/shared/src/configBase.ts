/**
 * configBase.ts — 公共基础配置解析，消除 api/worker 重复配置逻辑
 */

export type DbConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** 连接池参数 — 可通过环境变量覆盖，各消费端可按角色调整默认值 */
  pool: {
    /** 最大连接数 (default: 20) */
    max: number;
    /** 最小保持连接数 (default: 2) */
    min: number;
    /** 空闲连接超时 ms (default: 30000) */
    idleTimeoutMs: number;
    /** 新建连接超时 ms (default: 5000) */
    connectionTimeoutMs: number;
    /** 语句执行超时 ms (default: 30000, 0=不限制) */
    statementTimeoutMs: number;
  };
};

export type RedisConfig = {
  host: string;
  port: number;
};

export function loadDbConfig(env: NodeJS.ProcessEnv): DbConfig {
  return {
    host: env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(env.POSTGRES_PORT ?? 5432),
    database: env.POSTGRES_DB ?? "mindpal",
    user: env.POSTGRES_USER ?? "mindpal",
    password: env.POSTGRES_PASSWORD ?? "mindpal",
    pool: {
      max: clampInt(env.DB_POOL_MAX, 1, 200, 20),
      min: clampInt(env.DB_POOL_MIN, 0, 50, 2),
      idleTimeoutMs: clampInt(env.DB_POOL_IDLE_TIMEOUT_MS, 1000, 600_000, 30_000),
      connectionTimeoutMs: clampInt(env.DB_POOL_CONNECTION_TIMEOUT_MS, 1000, 60_000, 5_000),
      statementTimeoutMs: clampInt(env.DB_POOL_STATEMENT_TIMEOUT_MS, 0, 300_000, 30_000),
    },
  };
}

/** 辅助: 解析环境变量为整数并 clamp 到 [min, max] 范围 */
function clampInt(raw: string | undefined, lo: number, hi: number, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export function loadRedisConfig(env: NodeJS.ProcessEnv): RedisConfig {
  return {
    host: env.REDIS_HOST ?? "127.0.0.1",
    port: Number(env.REDIS_PORT ?? 6379),
  };
}

export function loadMasterKey(env: NodeJS.ProcessEnv): string {
  const isProd = env.NODE_ENV === "production";
  const masterKeyRaw = (env.API_MASTER_KEY ?? "").trim();
  const masterKey = masterKeyRaw || (!isProd ? "dev-master-key-change-me" : "");
  if (isProd && (!masterKey || masterKey === "dev-master-key-change-me")) {
    throw new Error("API_MASTER_KEY is required in production");
  }
  return masterKey;
}
