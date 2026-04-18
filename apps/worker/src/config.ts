import { loadDbConfig, loadRedisConfig, loadMasterKey, type DbConfig, type RedisConfig } from "@openslin/shared";

export type WorkerConfig = {
  db: DbConfig;
  redis: RedisConfig;
  secrets: {
    masterKey: string;
  };
  media: {
    fsRootDir: string;
  };
  /** Worker 并发度（BullMQ concurrency），默认 5 */
  concurrency: number;
  /** Graceful shutdown 超时（ms），最小 10_000，默认 30_000 */
  shutdownTimeoutMs: number;
  /** 单个 Job 最大执行时长（ms），0 = 不限制，默认 300_000（5 分钟） */
  jobTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    db: loadDbConfig(env),
    redis: loadRedisConfig(env),
    secrets: { masterKey: loadMasterKey(env) },
    media: { fsRootDir: env.MEDIA_FS_ROOT_DIR ?? "var/media" },
    concurrency: Math.max(Number(env.WORKER_CONCURRENCY) || 5, 1),
    shutdownTimeoutMs: Math.max(Number(env.WORKER_SHUTDOWN_TIMEOUT_MS) || 30_000, 10_000),
    jobTimeoutMs: Math.max(Number(env.WORKER_JOB_TIMEOUT_MS) || 300_000, 0),
  };
}
