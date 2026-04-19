/**
 * serverTimers.ts — 从 server.ts 提取的定时器模块。
 *
 * 包含 5 组 setInterval 定时器：
 * 1. 审计 outbox 分发 + backlog 告警
 * 2. 工作流队列 backlog 指标 + 告警
 * 3. 协同编辑 backlog 指标
 * 4. Worker 心跳 / 步骤 / 工具执行指标
 * 5. Skills 目录热扫描（运行期自动发现新增 Skill 包）
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { MetricsRegistry } from "../modules/metrics/metrics";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "serverTimers" });
import { dispatchAuditOutboxBatch } from "../modules/audit/outboxRepo";
import { collectCollabBacklogMetrics } from "../modules/metrics/collabBacklog";

import { rescanAndRegisterTools } from "../modules/tools/toolAutoDiscovery";
import { invalidateToolCatalogQueryCache } from "../modules/agentContext";

type RedisLike = { get(key: string): Promise<string | null>; };

export type ServerTimerDeps = {
  db: Pool;
  queue: Queue;
  redis: RedisLike;
  metrics: MetricsRegistry;
  log: { warn: (msg: string, ctx?: any) => void; error?: (msg: string, ctx?: any) => void };
};

export type ServerTimerHandles = {
  auditOutboxTimer: ReturnType<typeof setInterval> | null;
  queueBacklogTimer: ReturnType<typeof setInterval> | null;
  collabBacklogTimer: ReturnType<typeof setInterval>;
  workerMetricsTimer: ReturnType<typeof setInterval>;
  skillRescanTimer: ReturnType<typeof setInterval> | null;
  stopAll: () => void;
};

export function initServerTimers(deps: ServerTimerDeps): ServerTimerHandles {
  const { db, queue, redis, metrics, log } = deps;

  // ── 1. 审计 outbox 分发 + backlog 告警 ──
  const auditOutboxEnabled = process.env.AUDIT_OUTBOX_DISPATCHER === "0" ? false : true;
  const auditOutboxIntervalMs = Math.max(250, Number(process.env.AUDIT_OUTBOX_INTERVAL_MS ?? "1000") || 1000);
  const auditOutboxBatch = Math.max(1, Math.min(200, Number(process.env.AUDIT_OUTBOX_BATCH ?? "50") || 50));
  let lastOutboxBacklogAtMs = 0;
  const auditOutboxTimer =
    auditOutboxEnabled
      ? setInterval(() => {
          dispatchAuditOutboxBatch({ pool: db, limit: auditOutboxBatch })
            .then((r) => {
              metrics.incAuditOutboxDispatch({ result: "ok" }, r.ok);
              metrics.incAuditOutboxDispatch({ result: "failed" }, r.failed);
            })
            .catch((e: any) => {
              log.warn("[server] audit outbox dispatch failed", { error: String(e?.message ?? e) });
            });
          const now = Date.now();
          const interval = Math.max(1000, Number(process.env.AUDIT_OUTBOX_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
          if (now - lastOutboxBacklogAtMs >= interval) {
            lastOutboxBacklogAtMs = now;
            db
              .query("SELECT status, COUNT(*)::int AS c FROM audit_outbox GROUP BY status")
              .then((res) => {
                const map = new Map<string, number>();
                for (const row of res.rows) map.set(String((row as Record<string, unknown>).status), Number((row as Record<string, unknown>).c ?? 0));
                const statuses = ["queued", "processing", "succeeded", "failed"];
                for (const s of statuses) metrics.setAuditOutboxBacklog({ status: s, count: map.get(s) ?? 0 });
                /* P1-2: outbox backlog 告警阈值 */
                const outboxThreshold = Math.max(1, Number(process.env.ALERT_OUTBOX_BACKLOG_THRESHOLD ?? "500") || 500);
                const deadletterThreshold = Math.max(1, Number(process.env.ALERT_OUTBOX_DEADLETTER_THRESHOLD ?? "10") || 10);
                const totalPending = (map.get("queued") ?? 0) + (map.get("processing") ?? 0) + (map.get("failed") ?? 0);
                const deadletterCount = map.get("deadletter") ?? 0;
                if (totalPending > outboxThreshold) {
                                  _logger.error("audit_outbox_backlog exceeded threshold", { totalPending, threshold: outboxThreshold });
                  metrics.incAlertFired({ alert: "outbox_backlog" });
                }
                if (deadletterCount > deadletterThreshold) {
                                  _logger.error("audit_outbox_deadletter exceeded threshold", { deadletterCount, threshold: deadletterThreshold });
                  metrics.incAlertFired({ alert: "outbox_deadletter" });
                }
              })
              .catch((e: any) => {
                log.warn("[server] audit outbox backlog query failed", { error: String(e?.message ?? e) });
              });
          }
        }, auditOutboxIntervalMs)
      : null;
  if (auditOutboxTimer) auditOutboxTimer.unref();

  // ── 2. 工作流队列 backlog 指标 + 告警 ──
  const queueBacklogIntervalMs = Math.max(1000, Number(process.env.WORKFLOW_QUEUE_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
  const canReadQueueCounts = Boolean(queue && typeof (queue as unknown as Record<string, unknown>).getJobCounts === "function");
  const queueBacklogTimer = canReadQueueCounts
    ? setInterval(() => {
        (queue as unknown as { getJobCounts(...statuses: string[]): Promise<Record<string, number>> })
          .getJobCounts("waiting", "active", "delayed", "failed")
          .then((c: Record<string, number>) => {
            const statuses = ["waiting", "active", "delayed", "failed"] as const;
            for (const s of statuses) metrics.setWorkflowQueueBacklog({ status: s, count: Number(c?.[s] ?? 0) });
            /* P1-2: queue backlog 告警阈值 */
            const queueThreshold = Math.max(1, Number(process.env.ALERT_QUEUE_BACKLOG_THRESHOLD ?? "1000") || 1000);
            const totalQueue = Number(c?.waiting ?? 0) + Number(c?.active ?? 0) + Number(c?.delayed ?? 0);
            if (totalQueue > queueThreshold) {
                            _logger.error("workflow_queue_backlog exceeded threshold", { totalQueue, threshold: queueThreshold });
              metrics.incAlertFired({ alert: "queue_backlog" });
            }
          })
          .catch((e: any) => {
            log.warn("[server] queue backlog query failed", { error: String(e?.message ?? e) });
          });
      }, queueBacklogIntervalMs)
    : null;
  if (queueBacklogTimer) queueBacklogTimer.unref();

  // ── 3. 协同编辑 backlog 指标 ──
  const collabBacklogIntervalMs = Math.max(1000, Number(process.env.COLLAB_BACKLOG_INTERVAL_MS ?? "10000") || 10000);
  const collabBacklogTimer = setInterval(() => {
    collectCollabBacklogMetrics(db, metrics).catch(() => {});
  }, collabBacklogIntervalMs);
  collabBacklogTimer.unref();

  // ── 4. Worker 心跳 / 步骤 / 工具执行指标 ──
  const workerMetricsIntervalMs = Math.max(1000, Number(process.env.WORKER_METRICS_INTERVAL_MS ?? "10000") || 10000);
  const workerMetricsTimer = setInterval(() => {
    if ((redis as Record<string, unknown>)?.status !== "ready") {
      return;
    }
    Promise.all([
      redis.get("worker:heartbeat:ts"),
      redis.get("worker:workflow:step:success"),
      redis.get("worker:workflow:step:error"),
      redis.get("worker:tool_execute:success"),
      redis.get("worker:tool_execute:error"),
    ])
      .then(([hb, ok, err, toolOk, toolErr]) => {
        const ts = hb ? Number(hb) : NaN;
        const ageSec = Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 1000) : 1e9;
        metrics.setWorkerHeartbeatAgeSeconds({ worker: "workflow", ageSeconds: ageSec });
        metrics.setWorkerWorkflowStepCount({ result: "success", count: ok ? Number(ok) : 0 });
        metrics.setWorkerWorkflowStepCount({ result: "error", count: err ? Number(err) : 0 });
        metrics.setWorkerToolExecuteCount({ result: "success", count: toolOk ? Number(toolOk) : 0 });
        metrics.setWorkerToolExecuteCount({ result: "error", count: toolErr ? Number(toolErr) : 0 });
      })
      .catch(() => {
      });
  }, workerMetricsIntervalMs);
  workerMetricsTimer.unref();

  // ── 5. Skills 目录热扫描：运行期自动发现新增 Skill 包 ──
  const skillRescanEnabled = process.env.SKILL_RESCAN_DISABLED !== "1";
  const skillRescanIntervalMs = Math.max(30_000, Number(process.env.SKILL_RESCAN_INTERVAL_MS ?? "60000") || 60_000);
  let skillRescanInFlight = false;
  const skillRescanTimer = skillRescanEnabled
    ? setInterval(() => {
        if (skillRescanInFlight) return;
        skillRescanInFlight = true;
        rescanAndRegisterTools(db)
          .then((r) => {
            if (r.registered > 0) {
              // 新工具被注册，失效 Agent Loop 的工具发现缓存
              invalidateToolCatalogQueryCache();
              log.warn(
                `[server] Skill hot-rescan: ${r.registered} tool(s) registered, ${r.skipped} skipped — tool discovery cache invalidated`,
              );
            }
          })
          .catch((e: any) => {
            log.warn("[server] Skill hot-rescan failed", { error: String(e?.message ?? e) });
          })
          .finally(() => {
            skillRescanInFlight = false;
          });
      }, skillRescanIntervalMs)
    : null;
  if (skillRescanTimer) skillRescanTimer.unref();

  return {
    auditOutboxTimer,
    queueBacklogTimer,
    collabBacklogTimer,
    workerMetricsTimer,
    skillRescanTimer,
    stopAll() {
      if (auditOutboxTimer) clearInterval(auditOutboxTimer);
      if (queueBacklogTimer) clearInterval(queueBacklogTimer);
      clearInterval(collabBacklogTimer);
      clearInterval(workerMetricsTimer);
      if (skillRescanTimer) clearInterval(skillRescanTimer);
    },
  };
}
