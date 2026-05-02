import fs from "node:fs/promises";
import path from "node:path";
import "./otel";
import { loadConfig } from "./config";
import { validateEnvironment, formatValidationResult } from "@mindpal/shared";
import { migrate } from "./db/migrate";
import { createPool } from "./db/pool";
import { createWorkflowQueue } from "./modules/workflow/queue";
import { buildServer } from "./server";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:lifecycle" });

async function findMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "../migrations"),
    path.resolve(process.cwd(), "apps/api/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isDirectory()) return c;
    } catch {
      continue;
    }
  }
  // 6.1 FIX: 所有候选目录都不存在时抛错，而非静默返回不存在的路径
  throw new Error(
    `找不到 migrations 目录，已尝试: ${candidates.join(", ")}. 请确认工作目录正确或 migrations 目录已存在。`
  );
}

async function main() {
  /* ── P0: 启动时环境变量校验 ──────────────────────────────────── */
  const envResult = validateEnvironment("api");
  if (!envResult.valid) {
    _logger.error(formatValidationResult(envResult));
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
  } else if (envResult.warnings.length > 0) {
    _logger.warn(formatValidationResult(envResult));
  }

  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);
  await migrate(pool, await findMigrationsDir());

  const queue = createWorkflowQueue(cfg);
  const app = buildServer(cfg, { db: pool, queue });

  /* ── P0-04: Graceful Shutdown (hook 必须在 listen 之前注册) ───── */
  const SHUTDOWN_TIMEOUT_MS = Math.max(Number(process.env.SHUTDOWN_TIMEOUT_MS) || 15_000, 5_000);
  let shuttingDown = false;

  // P2-7: 在 shutdown 过程中立即拒绝新请求，返回 503 + Connection: close
  app.addHook("onRequest", async (_req, reply) => {
    if (shuttingDown) {
      reply.code(503).header("connection", "close").send({ error: "server_shutting_down" });
    }
  });

  // P3-3: 从环境变量读取 host，容器化部署需绑定 0.0.0.0
  await app.listen({ port: cfg.port, host: process.env.API_HOST ?? "0.0.0.0" });

  /* ── P1-G5: 启动恢复 + Supervisor ──────────────────────────────── */
  try {
    const { listShutdownPausedEntries, updateEntryStatus } = await import("./kernel/taskQueueRepo");
    const { startTaskQueueSupervisor, recoverInterruptedTasks } = await import("./kernel/taskQueueSupervisor");
    const { getOrCreateTaskQueueSystem } = await import("./kernel/taskQueueFactory");

    // 确保 TaskQueueManager 在启动阶段已初始化，避免 mgr 为 undefined
    const { manager: mgr } = getOrCreateTaskQueueSystem(app);
    (app as any)._taskQueueManager = mgr;

    // 1. 启动 TaskQueue Supervisor（僵尸任务检测）
    // P2-1 修复：注入 Manager.markFailed 回调，触发依赖级联/重试/通知/重调度
    startTaskQueueSupervisor({
      pool,
      onZombieDetected: (entryId: string, error: string) => mgr.markFailed(entryId, error),
    });

    // 2. 恢复因上次 shutdown 暂停的任务
    const shutdownPaused = await listShutdownPausedEntries(pool);
    if (shutdownPaused.length > 0) {
      let recovered = 0;
      for (const entry of shutdownPaused) {
        try {
          await updateEntryStatus(pool, {
            entryId: entry.entryId,
            status: "queued",
            checkpointRef: null,
          });
          recovered++;
        } catch (e: any) {
          _logger.warn(`Failed to recover entry ${entry.entryId}`, { err: e?.message });
        }
      }
      if (recovered > 0) {
        _logger.info(`Recovered ${recovered}/${shutdownPaused.length} shutdown-paused tasks to queued`);
      }
    }

    // 3. P0: 恢复中断的 executing 任务（检查点恢复机制）
    // 注入 Redis 供检查点缓存读取
    try { mgr.setRedis(app.redis as any); } catch { /* ignore */ }
    // 使用 setImmediate 延迟，不阻塞启动
    recoverInterruptedTasks({ pool, manager: mgr }).catch((e: any) => {
      _logger.warn("Checkpoint recovery failed (non-fatal)", { err: e?.message });
    });
  } catch (e: any) {
    _logger.warn("Startup recovery error (non-fatal)", { err: e?.message });
  }

  async function gracefulShutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    _logger.info(`${signal} received — starting graceful shutdown`, { timeoutMs: SHUTDOWN_TIMEOUT_MS });

    // 设置硬超时保底
    const forceTimer = setTimeout(() => {
      _logger.error(`Graceful shutdown timeout exceeded (${SHUTDOWN_TIMEOUT_MS}ms) — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 0) P1-G5: 停止 Supervisor
      try {
        const { stopTaskQueueSupervisor } = await import("./kernel/taskQueueSupervisor");
        stopTaskQueueSupervisor();
      } catch { /* ignore */ }

      // 0.1) P3-15: 暂停所有活跃任务并写入 checkpoint
      try {
        // 复用运行时已初始化的 Manager（包含活跃的 AbortController 引用）
        let mgr = (app as any)._taskQueueManager;
        if (!mgr) {
          // 边界情况：无请求处理过，创建最小实例仅用于 DB 状态清理
          const { createTaskQueueManager } = await import("./kernel/taskQueueManager");
          const { createQueueEventEmitter } = await import("./lib/sessionEventBus");
          mgr = createTaskQueueManager(pool);
          mgr.setEmitter(createQueueEventEmitter());
        }
        const paused = await mgr.pauseAllForShutdown();
        if (paused > 0) _logger.info(`Paused ${paused} active tasks (checkpoint written)`);
      } catch (e: any) {
        _logger.warn("Task queue shutdown error", { err: e?.message });
      }

      // 1) 关闭会话级 SSE 连接
      try {
        const { shutdownAllSessions } = await import("./lib/sessionEventBus");
        shutdownAllSessions();
      } catch { /* ignore */ }

      // 2) 排空所有活跃 SSE 连接
      const { drainAllConnections } = await import("./lib/streamingPipeline");
      const drained = await drainAllConnections("server_shutting_down");
      if (drained > 0) _logger.info(`Drained ${drained} active SSE connections`);

      // 3) 停止接受新请求 + 等待进行中请求排空
      await app.close();
      _logger.info("Fastify server closed — no more connections");

      // 4) 关闭 BullMQ 队列
      try { await queue.close(); } catch (e: any) {
        _logger.warn("queue.close() error", { err: e?.message });
      }

      // 5) 关闭数据库连接池
      try { await pool.end(); } catch (e: any) {
        _logger.warn("pool.end() error", { err: e?.message });
      }

      _logger.info("Graceful shutdown complete");
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (e: any) {
      _logger.error(`Graceful shutdown error: ${e?.message}`);
      clearTimeout(forceTimer);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

main().catch((err) => {
  _logger.error("main() fatal error", { err: (err as Error)?.message, stack: (err as Error)?.stack });
  process.exit(1);
});
