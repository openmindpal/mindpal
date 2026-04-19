import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission } from "../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { getGlobalLoopConcurrency } from "../kernel/priorityScheduler";
import { getNotifOnlineCount, getNotifOnlineSubjectCount, getNotifNodeId } from "../plugins/realtimeNotification";
import { getAllBreakerMetrics } from "@openslin/shared";

async function countKeysByPattern(params: { redis: any; pattern: string; maxScans: number }) {
  let cursor = "0";
  let scanned = 0;
  let count = 0;
  do {
    const [next, keys] = (await params.redis.scan(cursor, "MATCH", params.pattern, "COUNT", "200")) as unknown as [string, string[]];
    cursor = next;
    scanned += 1;
    count += keys.length;
  } while (cursor !== "0" && scanned < params.maxScans);
  return { count, truncated: cursor !== "0" };
}

export const diagnosticsRoutes: FastifyPluginAsync = async (app) => {
  // ── 基础诊断（原有） ──────────────────────────────────
  app.get("/diagnostics", async (req) => {
    setAuditContext(req, { resourceType: "diagnostics", action: "read" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_DIAGNOSTICS_READ });

    const q = z.object({ scope: z.enum(["tenant", "space"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    const scopeType = q.scope ?? "space";
    const scopeId = scopeType === "tenant" ? subject.tenantId : subject.spaceId;

    const counts =
      app.queue && typeof (app.queue as any).getJobCounts === "function"
        ? await (app.queue as any).getJobCounts("waiting", "active", "delayed", "failed", "completed")
        : { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };

    const cbPattern = `cb:model_chat:open:${subject.tenantId}:*`;
    let cb = { count: 0, truncated: false };
    try {
      cb = await countKeysByPattern({ redis: app.redis, pattern: cbPattern, maxScans: 20 });
    } catch { /* Redis unavailable — degrade gracefully */ }

    req.ctx.audit!.outputDigest = { scopeType, queue: counts, circuitOpenCount: cb.count, circuitOpenTruncated: cb.truncated };
    return {
      scopeType,
      scopeId: scopeId ?? null,
      queue: counts,
      modelCircuit: { openCount: cb.count, truncated: cb.truncated },
      traceId: req.ctx.traceId,
    };
  });

  // ── P3-07b: 运行时诊断全量 dump ──────────────────────
  app.get("/diagnostics/dump", async (req) => {
    setAuditContext(req, { resourceType: "diagnostics", action: "dump" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, ...PERM.GOVERNANCE_DIAGNOSTICS_DUMP });

    const subject = req.ctx.subject!;
    const db = app.db as any;
    const redis = app.redis as any;
    const now = Date.now();

    // 1. Agent Loop 全局并发 (进程内)
    const loopConcurrency = getGlobalLoopConcurrency();

    // 2. 队列积压
    let queueBacklog: Record<string, number> = {};
    try {
      queueBacklog =
        app.queue && typeof (app.queue as any).getJobCounts === "function"
          ? await (app.queue as any).getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused")
          : {};
    } catch { /* queue unavailable */ }

    // 3. 连接池状态
    let dbPool: Record<string, unknown> = {};
    try {
      const pool = db;
      dbPool = {
        totalCount: pool.totalCount ?? null,
        idleCount: pool.idleCount ?? null,
        waitingCount: pool.waitingCount ?? null,
      };
    } catch { /* pool stats unavailable */ }

    // 4. Redis 连接状态
    let redisInfo: Record<string, unknown> = {};
    try {
      const info = await redis.info("clients");
      const connectedMatch = typeof info === "string" ? info.match(/connected_clients:(\d+)/) : null;
      const blockedMatch = typeof info === "string" ? info.match(/blocked_clients:(\d+)/) : null;
      redisInfo = {
        connectedClients: connectedMatch ? Number(connectedMatch[1]) : null,
        blockedClients: blockedMatch ? Number(blockedMatch[1]) : null,
        status: redis.status ?? "unknown",
      };
    } catch {
      redisInfo = { status: redis.status ?? "unknown", error: "info_unavailable" };
    }

    // 5. 进程内存使用
    const mem = process.memoryUsage();
    const memory = {
      rssBytes: mem.rss,
      heapTotalBytes: mem.heapTotal,
      heapUsedBytes: mem.heapUsed,
      externalBytes: mem.external,
      arrayBuffersBytes: mem.arrayBuffers ?? 0,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
    };

    // 6. WebSocket 通知连接
    const wsNotifications = {
      onlineConnections: getNotifOnlineCount(),
      onlineSubjects: getNotifOnlineSubjectCount(),
      nodeId: getNotifNodeId(),
    };

    // 7. 熔断器状态（全量 — 来自 shared CircuitBreaker 注册表）
    let circuitBreakers: any[] = [];
    try {
      circuitBreakers = getAllBreakerMetrics().map((m) => ({
        name: m.name,
        state: m.state,
        totalSuccesses: m.totalSuccesses,
        totalFailures: m.totalFailures,
        totalShortCircuited: m.totalShortCircuited,
        consecutiveFailures: m.consecutiveFailures,
        lastFailureTs: m.lastFailureTs,
      }));
    } catch { /* breaker registry unavailable */ }

    // 8. Agent Processes 全局统计 (DB)
    let agentProcessStats: Record<string, unknown> = {};
    try {
      const apRes = await db.query(
        `SELECT status, COUNT(*) AS cnt FROM agent_processes
         WHERE status IN ('running', 'pending', 'paused', 'preempted')
         GROUP BY status`,
      );
      const stats: Record<string, number> = {};
      for (const r of (apRes.rows as any[])) {
        stats[r.status] = Number(r.cnt);
      }
      agentProcessStats = stats;
    } catch { /* agent_processes table may not exist */ }

    // 9. Checkpoint 统计
    let checkpointStats: Record<string, unknown> = {};
    try {
      const cpRes = await db.query(
        `SELECT status, COUNT(*) AS cnt FROM agent_loop_checkpoints
         WHERE status IN ('running', 'resuming', 'paused')
         GROUP BY status`,
      );
      const stats: Record<string, number> = {};
      for (const r of (cpRes.rows as any[])) {
        stats[r.status] = Number(r.cnt);
      }
      checkpointStats = stats;
    } catch { /* table may not exist */ }

    // 10. 通知队列积压
    let notificationQueueBacklog = 0;
    try {
      const nqRes = await db.query(
        "SELECT COUNT(*) AS cnt FROM notification_queue WHERE status = 'queued'",
      );
      notificationQueueBacklog = Number((nqRes.rows as any[])[0]?.cnt ?? 0);
    } catch { /* table may not exist */ }

    // 11. 进程信息
    const processInfo = {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };

    const dump = {
      timestamp: new Date().toISOString(),
      nodeId: getNotifNodeId(),
      processInfo,
      agentLoopConcurrency: loopConcurrency,
      agentProcessStats,
      checkpointStats,
      queueBacklog,
      notificationQueueBacklog,
      dbPool,
      redis: redisInfo,
      memory,
      wsNotifications,
      circuitBreakers,
      traceId: req.ctx.traceId,
    };

    req.ctx.audit!.outputDigest = {
      sections: Object.keys(dump).length,
      loopActive: loopConcurrency.active,
      memoryRssMB: memory.rssMB,
      circuitBreakerCount: circuitBreakers.length,
    };

    return dump;
  });
};
