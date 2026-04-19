/**
 * tickerRegistry.ts — Worker 定时器注册中心
 *
 * 将原 index.ts 中 25+ 个内联 setInterval+withLock ticker 统一收归到声明式注册表，
 * 支持动态注册、统一启动/停止，以及 graceful shutdown 时自动清理。
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "worker:tickerRegistry" });
import type { WorkerConfig } from "./config";

export interface TickerDeps {
  pool: Pool;
  queue: Queue;
  redis: Redis;
  redisLock: Redis;
  masterKey: string;
  cfg: WorkerConfig;
  withLock: (redis: Redis, opts: { lockKey: string; ttlMs: number }, fn: () => Promise<any>) => Promise<any>;
}

export interface TickerDef {
  name: string;
  intervalMs: number | (() => number);
  lockKey: string;
  lockTtlMs?: number | (() => number);
  /** 如果设置为 true，则 handler 内不使用 withLock，直接执行 */
  noLock?: boolean;
  /** 是否需要手动 in-flight 保护（handler 自行控制） */
  inFlightGuard?: boolean;
  handler: (deps: TickerDeps) => Promise<void>;
}

const registry: TickerDef[] = [];

export function registerTicker(def: TickerDef) {
  registry.push(def);
}

const runningTimers: ReturnType<typeof setInterval>[] = [];

export function startAllTickers(deps: TickerDeps): ReturnType<typeof setInterval>[] {
  for (const def of registry) {
    const intervalMs = typeof def.intervalMs === "function" ? def.intervalMs() : def.intervalMs;
    const lockTtlMs = typeof def.lockTtlMs === "function" ? def.lockTtlMs() : (def.lockTtlMs ?? intervalMs);

    if (def.inFlightGuard) {
      let inFlight = false;
      const timer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        deps.withLock(deps.redisLock, { lockKey: def.lockKey, ttlMs: lockTtlMs }, () => def.handler(deps))
          .catch((err) => _logger.error("tick failed", { name: def.name, err: (err as Error)?.message ?? err }))
          .finally(() => { inFlight = false; });
      }, intervalMs);
      runningTimers.push(timer);
    } else if (def.noLock) {
      const timer = setInterval(() => {
        def.handler(deps).catch((err) => _logger.error("tick failed", { name: def.name, err: (err as Error)?.message ?? err }));
      }, intervalMs);
      runningTimers.push(timer);
    } else {
      const timer = setInterval(() => {
        deps.withLock(deps.redisLock, { lockKey: def.lockKey, ttlMs: lockTtlMs }, () => def.handler(deps))
          .catch((err) => _logger.error("tick failed", { name: def.name, err: (err as Error)?.message ?? err }));
      }, intervalMs);
      runningTimers.push(timer);
    }
  }

  _logger.info("tickers started", { count: registry.length });
  return runningTimers;
}

export function stopAllTickers() {
  _logger.info("stopping tickers", { count: runningTimers.length });
  for (const t of runningTimers) clearInterval(t);
  runningTimers.length = 0;
}

export function getRegisteredTickerNames(): string[] {
  return registry.map((d) => d.name);
}
