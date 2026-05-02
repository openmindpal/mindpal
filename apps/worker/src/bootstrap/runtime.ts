import { Queue } from "bullmq";
import Redis from "ioredis";
import {
  createRedisConcurrencyBackend,
  setConcurrencyBackend,
  validateProductionBaseline,
  initializeServiceLogging,
  createModuleLogger,
} from "@mindpal/shared";

const _rootLogger = initializeServiceLogging({ serviceName: "worker" });
const _logger = createModuleLogger("worker:runtime");
import { registerAdvancedChunkStrategies } from "../knowledge/chunkStrategy";
import { RedisStreamsBus } from "../lib/redisStreamsBus";
import { CRITICAL_EVENT_CHANNELS } from "@mindpal/shared";

import "../tickers";
import type { WorkerConfig } from "../config";
import { createPool } from "../db/pool";
import { attachJobTraceCarrier } from "../lib/tracing";
import { getWorkerContributions } from "../lib/workerSkillContract";
import { registerBuiltinChannelAdapters } from "../notifications/builtinAdapters";
import { initWorkerSkills } from "../skills/registry";
import { startHealthServer } from "../health/healthServer";
import { registerTicker, startAllTickers, stopAllTickers } from "../tickerRegistry";
import { withLock } from "../lib/distributedLock";

let contributionTickersRegistered = false;

export type WorkerRuntime = {
  pool: ReturnType<typeof createPool>;
  queue: Queue;
  redis: any;
  redisPub: Redis;
  redisLock: Redis;
  healthServer: any;
  connection: { host: string; port: number };
  /** Redis Streams 后端 — 关键事件可靠消费 */
  streamsBus: RedisStreamsBus;
};

export function logWorkerProductionBaseline() {
  const baselineResult = validateProductionBaseline(process.env, ["process", "container"]);
  if (!baselineResult.valid) {
    _logger.error("production baseline validation FAILED", {
      violations: baselineResult.violations,
    });
    return;
  }
  if (baselineResult.policy.isProduction) {
    _logger.info("production baseline validation passed", {
      minIsolation: baselineResult.policy.minIsolation,
      trustEnforced: baselineResult.policy.trustEnforced,
    });
  }
}

function registerContributionTickersOnce() {
  if (contributionTickersRegistered) return;
  contributionTickersRegistered = true;
  for (const [, contrib] of getWorkerContributions()) {
    if (!contrib.tickers) continue;
    for (const st of contrib.tickers) {
      registerTicker({
        name: st.name,
        intervalMs: st.intervalMs,
        lockKey: `tick:${st.name}`,
        lockTtlMs: st.intervalMs + 5_000,
        handler: async ({ pool, queue }) => {
          await st.tick({ pool, queue });
        },
      });
    }
  }
}

export function initializeWorkerExtensions() {
  registerBuiltinChannelAdapters();

  // 注册高级分块策略 (Parent-Child / Table-aware / Code-aware)
  registerAdvancedChunkStrategies();

  try {
    const skillResult = initWorkerSkills();
    _logger.info("initWorkerSkills", {
      registered: skillResult.registered.length,
      coreCount: skillResult.coreCount,
      optionalCount: skillResult.optionalCount,
      skipped: skillResult.skipped,
    });
  } catch (e: any) {
    _logger.error("initWorkerSkills FAILED", { error: String(e?.message ?? e) });
  }
  registerContributionTickersOnce();
}

export async function createWorkerRuntime(cfg: WorkerConfig): Promise<WorkerRuntime> {
  const pool = createPool(cfg);
  const connection = { host: cfg.redis.host, port: cfg.redis.port };
  const queue = new Queue("workflow", { connection });
  const origAdd = queue.add.bind(queue);
  (queue as any).add = (name: string, data: any, opts: any) =>
    origAdd(name, attachJobTraceCarrier(data ?? {}), opts);

  const redis = await queue.client;
  const redisPub = new Redis({ host: cfg.redis.host, port: cfg.redis.port, maxRetriesPerRequest: null });
  const redisLock = new Redis({ host: cfg.redis.host, port: cfg.redis.port, maxRetriesPerRequest: null });

  if ((process.env.CONCURRENCY_BACKEND ?? "local") === "redis") {
    setConcurrencyBackend(createRedisConcurrencyBackend(redisPub));
    _logger.info("Redis concurrency backend enabled");
  }

  startAllTickers({ pool, queue, redis: redisPub, redisLock, masterKey: cfg.secrets.masterKey, cfg, withLock });
  const healthServer = startHealthServer({ pool, queue, redis });

  // P1: Redis Streams 后端 — 关键事件可靠消费
  const hostname = (process.env.HOSTNAME ?? process.env.COMPUTERNAME ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const streamsBus = new RedisStreamsBus({
    redis: redisPub,
    consumerGroup: "mindpal-worker-group",
    consumerId: `worker-${hostname}-${process.pid}`,
    maxStreamLength: 10_000,
    blockTimeoutMs: 5_000,
  });

  return {
    pool,
    queue,
    redis,
    redisPub,
    redisLock,
    healthServer,
    connection,
    streamsBus,
  };
}

export async function shutdownWorkerRuntime(runtime: WorkerRuntime) {
  stopAllTickers();
  // P1: 先关闭 Streams 读取循环
  try {
    await runtime.streamsBus.close();
  } catch (e: any) {
    _logger.warn("streamsBus.close() error", { err: e?.message });
  }
  try {
    await runtime.queue.close();
  } catch (e: any) {
    _logger.warn("queue.close() error", { err: e?.message });
  }
  try {
    await runtime.redisPub.quit();
  } catch (e: any) {
    _logger.warn("redisPub.quit() error", { err: e?.message });
  }
  try {
    await runtime.redisLock.quit();
  } catch (e: any) {
    _logger.warn("redisLock.quit() error", { err: e?.message });
  }
  if (runtime.healthServer && typeof runtime.healthServer.close === "function") {
    await new Promise<void>((resolve) => runtime.healthServer.close(() => resolve()));
  }
  try {
    await runtime.pool.end();
  } catch (e: any) {
    _logger.warn("pool.end() error", { err: e?.message });
  }
}
