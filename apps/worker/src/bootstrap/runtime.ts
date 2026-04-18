import { Queue } from "bullmq";
import Redis from "ioredis";
import {
  createRedisConcurrencyBackend,
  setConcurrencyBackend,
  validateProductionBaseline,
} from "@openslin/shared";
import { registerAdvancedChunkStrategies } from "../knowledge/chunkStrategy";

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
};

export function logWorkerProductionBaseline() {
  const baselineResult = validateProductionBaseline(process.env, ["process", "container"]);
  if (!baselineResult.valid) {
    console.error(
      `[worker] Production baseline validation FAILED. Violations: ${baselineResult.violations.join(", ")}. ` +
        `Startup will continue but dynamic Skill execution may be restricted.`,
    );
    return;
  }
  if (baselineResult.policy.isProduction) {
    console.log(
      `[worker] Production baseline validation passed. ` +
        `minIsolation=${baselineResult.policy.minIsolation}, trustEnforced=${baselineResult.policy.trustEnforced}`,
    );
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
    console.log(
      `[worker] initWorkerSkills: ${skillResult.registered.length} registered ` +
        `(core=${skillResult.coreCount}, optional=${skillResult.optionalCount})` +
        (skillResult.skipped.length > 0 ? `, skipped=${skillResult.skipped.join(",")}` : ""),
    );
  } catch (e: any) {
    console.error("[worker] initWorkerSkills FAILED — worker skill contributions will be unavailable", {
      error: String(e?.message ?? e),
    });
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
    console.log("[worker] P2-4: Redis concurrency backend enabled");
  }

  startAllTickers({ pool, queue, redis: redisPub, redisLock, masterKey: cfg.secrets.masterKey, cfg, withLock });
  const healthServer = startHealthServer({ pool, queue, redis });

  return {
    pool,
    queue,
    redis,
    redisPub,
    redisLock,
    healthServer,
    connection,
  };
}

export async function shutdownWorkerRuntime(runtime: WorkerRuntime) {
  stopAllTickers();
  try {
    await runtime.queue.close();
  } catch (e: any) {
    console.warn(`[worker] queue.close() error: ${e?.message}`);
  }
  try {
    await runtime.redisPub.quit();
  } catch (e: any) {
    console.warn(`[worker] redisPub.quit() error: ${e?.message}`);
  }
  try {
    await runtime.redisLock.quit();
  } catch (e: any) {
    console.warn(`[worker] redisLock.quit() error: ${e?.message}`);
  }
  if (runtime.healthServer && typeof runtime.healthServer.close === "function") {
    await new Promise<void>((resolve) => runtime.healthServer.close(() => resolve()));
  }
  try {
    await runtime.pool.end();
  } catch (e: any) {
    console.warn(`[worker] pool.end() error: ${e?.message}`);
  }
}
