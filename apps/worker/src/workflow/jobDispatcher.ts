/**
 * jobDispatcher.ts — Worker Job 分发路由器
 *
 * 将原 index.ts Worker callback 中的巨型 if/else job kind 链提取为独立模块，
 * 按 data.kind 路由到对应 processor。index.ts 仅需薄壳调用 dispatchJob()。
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type Redis from "ioredis";
import { getWorkerContributions } from "../lib/workerSkillContract";

// ─── Job handler 依赖上下文 ───
export interface JobDeps {
  pool: Pool;
  queue: Queue;
  redis: Redis;
  masterKey: string;
  mediaFsRootDir: string;
}

// ─── Job handler 类型 ───
type JobHandler = (data: any, deps: JobDeps) => Promise<void>;

// ─── 注册表 ───
const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler) {
  handlers.set(kind, handler);
}

export function getJobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}

/**
 * 分发 job 到对应 handler。
 * 返回 true 表示已处理（不需要继续走 step 流程），false 表示非 kind job（走默认 step 处理）。
 */
export async function dispatchJob(data: any, deps: JobDeps): Promise<boolean> {
  const kind = data?.kind as string | undefined;
  if (!kind) return false;

  // 1. 优先查 skill 贡献（消除重复，skill 为唯一来源）
  for (const [, contrib] of getWorkerContributions()) {
    const jh = contrib.jobs?.find((j) => j.kind === kind);
    if (jh) {
      await jh.process({ pool: deps.pool, data, queue: deps.queue });
      return true;
    }
  }

  // 2. 查内置 handler（非 skill 管辖的 job kind）
  const handler = handlers.get(kind);
  if (!handler) return false;

  await handler(data, deps);
  return true;
}

// ──────────────────────────────────────────────────────
// 内置 job handler 注册（声明式，从 builtinJobHandlers.ts 自动发现）
// ──────────────────────────────────────────────────────
import { registerBuiltinJobHandlers } from "./builtinJobHandlers";

// 模块加载时自动注册所有内置 handler
const _registeredKinds = registerBuiltinJobHandlers();
export { _registeredKinds as registeredBuiltinKinds };
