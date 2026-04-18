/**
 * TaskQueue System Factory — 统一初始化入口
 *
 * 解决问题：dispatch.stream.ts 和 routes.taskQueue.ts 各自创建 Manager 单例
 * 但注入的依赖不完整（前者缺 DepResolver/Scheduler，后者缺 Executor），
 * 导致谁先创建谁就决定了运行时能力缺失。
 *
 * 此工厂确保 Manager 一次性注入全部四个依赖：
 * Emitter + Executor + DepResolver + Scheduler
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { createTaskQueueManager, type TaskQueueManager } from "./taskQueueManager";
import { createQueueEventEmitter } from "../lib/sessionEventBus";
import { createAgentLoopTaskExecutor, type AgentLoopTaskExecutor } from "./agentLoopTaskExecutor";
import { createTaskDependencyResolver, type TaskDependencyResolver } from "./taskDependencyResolver";
import { createSessionScheduler, type SessionScheduler } from "./sessionScheduler";

/* ── 单例键（挂载在 app 上） ── */

const KEY_MGR = "_taskQueueManager";
const KEY_EXECUTOR = "_agentLoopTaskExecutor";
const KEY_DEP_RESOLVER = "_taskDepResolver";
const KEY_SCHEDULER = "_sessionScheduler";

/* ── 返回类型 ── */

export interface TaskQueueSystem {
  manager: TaskQueueManager;
  executor: AgentLoopTaskExecutor;
  depResolver: TaskDependencyResolver;
  scheduler: SessionScheduler;
}

/* ── 工厂函数 ── */

/**
 * 获取或创建完整的 TaskQueue 子系统。
 * 无论由 dispatch.stream.ts 还是 routes.taskQueue.ts 首次调用，
 * 均保证返回注入了全部依赖的 Manager。
 */
export function getOrCreateTaskQueueSystem(app: FastifyInstance & Record<string, any>): TaskQueueSystem {
  if (app[KEY_MGR]) {
    return {
      manager: app[KEY_MGR] as TaskQueueManager,
      executor: app[KEY_EXECUTOR] as AgentLoopTaskExecutor,
      depResolver: app[KEY_DEP_RESOLVER] as TaskDependencyResolver,
      scheduler: app[KEY_SCHEDULER] as SessionScheduler,
    };
  }

  const pool: Pool = app.db;
  const mgr = createTaskQueueManager(pool);

  // 1. Emitter
  mgr.setEmitter(createQueueEventEmitter());

  // 2. Executor（桥接队列调度 ↔ AgentLoop 执行）
  const executor = createAgentLoopTaskExecutor(app);
  executor.setCallbacks({
    onCompleted: (entryId, result) =>
      mgr.markCompleted(entryId, result as Record<string, unknown> | undefined),
    onFailed: (entryId, error) => mgr.markFailed(entryId, error),
  });
  mgr.setExecutor(executor);

  // 3. DepResolver（依赖解析 + 级联 + output_to_input）
  const depResolver = createTaskDependencyResolver(pool);
  mgr.setDependencyResolver(depResolver);

  // 4. Scheduler（会话级智能调度）
  const scheduler = createSessionScheduler(pool);
  mgr.setSessionScheduler(scheduler);

  // 挂载到 app 单例
  app[KEY_MGR] = mgr;
  app[KEY_EXECUTOR] = executor;
  app[KEY_DEP_RESOLVER] = depResolver;
  app[KEY_SCHEDULER] = scheduler;

  return { manager: mgr, executor, depResolver, scheduler };
}
