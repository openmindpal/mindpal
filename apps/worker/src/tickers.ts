/**
 * tickers.ts — 所有 Worker Ticker 的声明式注册
 *
 * 每个 ticker 以 registerTicker() 结构化注册到 tickerRegistry，
 * 替代原 index.ts 中 25+ 个内联 setInterval+withLock 块。
 */
import { registerTicker, type TickerDeps } from "./tickerRegistry";
import { StructuredLogger, resolveNumber } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:tickers" });
import { tickWorkflowStepPayloadPurge } from "./workflow/payloadPurge";
import { tickAuditSiemWebhookExport } from "./audit/siemWebhook";
import { tickRetiredSecretsCleanup } from "./secrets/retiredCleanup";
import { tickKeyRotation } from "./keyring/rotationTicker";
import { scanAndEnqueueRegressionEvals } from "./governance/regressionScheduler";
import { purgeExpiredMemories, compactSimilarMemories, distillSessionSummaries, summarizeWithLlm, distillUpgradeMemories, updateMemoryDecayScores } from "./memory/lifecycleWorker";
import { backfillMemoryEmbeddings } from "./memory/memoryEmbedding";
import { tickApprovalExpiry } from "./approvals/expiryTicker";
import { tickNotificationQueue } from "./notifications/queueConsumer";
import { tickActiveReflexion } from "./reflexion/activeReflexion";
import { tickLoopSupervisor } from "./supervisor/loopSupervisor";
import { tickLoopScheduler, reportNodeLoad } from "./supervisor/loopScheduler";
import { tickDbBackup } from "./backup/dbBackupTicker";
import { tickDbBackupVerify } from "./backup/dbBackupVerify";
import { tickDeadLetterRetry } from "./workflow/deadLetterRetryTicker";

// ─── 心跳 ───
registerTicker({
  name: "heartbeat",
  intervalMs: 10_000,
  lockKey: "",
  noLock: true,
  handler: async ({ redis }) => {
    await redis.set("worker:heartbeat:ts", String(Date.now()), "PX", 60_000);
  },
});

// ─── 订阅 / 触发器 / 知识摄取 / Webhook / Channel / 邮件 / 设备 ───
// 以上 7 个 ticker 已通过 skill 贡献体系注册，见：
//   skills/core/knowledge-rag.ts   → knowledge.ingest.scan
//   skills/core/channel-gateway.ts → channel.webhook.delivery, channel.outbox.delivery
//   skills/core/trigger-engine.ts  → trigger.tick
//   skills/optional/notification-outbox.ts → notification.email.delivery
//   skills/optional/subscription-runner.ts → subscription.tick
//   skills/optional/device-runtime.ts      → device.execution.resume

// ─── Step payload 清理 ───
registerTicker({
  name: "step-payload-purge",
  intervalMs: 60_000,
  lockKey: "tick:step-payload-purge",
  lockTtlMs: 60_000,
  handler: async ({ pool }) => { await tickWorkflowStepPayloadPurge({ pool }); },
});

// ─── 审计 SIEM 导出 ───
registerTicker({
  name: "audit-siem-export",
  intervalMs: 2_000,
  lockKey: "tick:audit-siem-export",
  lockTtlMs: 10_000,
  inFlightGuard: true,
  handler: async ({ pool, masterKey }) => { await tickAuditSiemWebhookExport({ pool, masterKey }); },
});

// ─── 过期 Secret 清理 ───
registerTicker({
  name: "retired-secrets-cleanup",
  intervalMs: 60_000,
  lockKey: "tick:retired-secrets-cleanup",
  lockTtlMs: 60_000,
  handler: async ({ pool }) => { await tickRetiredSecretsCleanup({ pool }); },
});

// ─── 密钥自动轮换 ───
registerTicker({
  name: "key-rotation",
  intervalMs: 3_600_000,
  lockKey: "tick:key-rotation",
  lockTtlMs: 120_000,
  handler: async ({ pool, queue, masterKey }) => { await tickKeyRotation({ pool, queue, masterKey }); },
});

// ─── 设备执行恢复 — 已通过 skill 贡献 (skills/optional/device-runtime) 注册 ───

// ─── 回归评估调度 ───
registerTicker({
  name: "regression-eval",
  intervalMs: () => Math.max(resolveNumber("REGRESSION_EVAL_INTERVAL_MS").value, 30_000),
  lockKey: "tick:regression-eval",
  lockTtlMs: () => Math.max(resolveNumber("REGRESSION_EVAL_INTERVAL_MS").value, 30_000),
  handler: async ({ pool, queue }) => { await scanAndEnqueueRegressionEvals({ pool, queue }); },
});

// ─── 记忆过期清理 ───
registerTicker({
  name: "memory-purge",
  intervalMs: () => Math.max(resolveNumber("MEMORY_LIFECYCLE_INTERVAL_MS").value, 60_000),
  lockKey: "tick:memory-purge",
  lockTtlMs: () => Math.max(resolveNumber("MEMORY_LIFECYCLE_INTERVAL_MS").value, 60_000),
  handler: async ({ pool }) => { await purgeExpiredMemories({ pool }); },
});

// ─── 记忆合并+蒸馏 ───
registerTicker({
  name: "memory-compact",
  intervalMs: () => Math.max(resolveNumber("MEMORY_COMPACT_INTERVAL_MS").value, 60_000),
  lockKey: "tick:memory-compact",
  lockTtlMs: () => Math.max(resolveNumber("MEMORY_COMPACT_INTERVAL_MS").value, 60_000),
  handler: async ({ pool, queue }) => {
    const tsRes = await pool.query(
      `SELECT DISTINCT tenant_id, space_id FROM memory_entries WHERE deleted_at IS NULL LIMIT 200`,
    );
    for (const row of tsRes.rows as Record<string, unknown>[]) {
      const tenantId = String(row.tenant_id ?? "");
      const spaceId = String(row.space_id ?? "");
      if (!tenantId || !spaceId) continue;
      await compactSimilarMemories({ pool, tenantId, spaceId }).catch((err) =>
                _logger.error("memory compact failed", { tenantId, spaceId, err: (err as Error)?.message }),
      );
      const distillResult = await distillSessionSummaries({
        pool, tenantId, spaceId,
        summarizeCallback: async (entries) => {
          const result = await summarizeWithLlm(entries);
          if (result) return result;
          const combined = entries.map((e) => (e.title ? `[${e.title}] ` : "") + e.content.slice(0, 100)).join(" | ");
          return combined.slice(0, 500) + (combined.length > 500 ? "..." : "");
        },
      }).catch((err) => {
                _logger.error("memory distill failed", { tenantId, spaceId, err: (err as Error)?.message });
        return null;
      });

      const upgradeResult = await distillUpgradeMemories({ pool, tenantId, spaceId }).catch((err) => {
                _logger.error("memory distill_upgrade failed", { tenantId, spaceId, err: (err as Error)?.message });
        return null;
      });

      const allDistilledIds: string[] = [
        ...(distillResult?.distilledEntryIds ?? []),
        ...(upgradeResult?.distilledEntryIds ?? []),
      ];
      if (allDistilledIds.length > 0) {
        await queue.add(
          "memory.embed",
          { kind: "memory.embed", memoryEntryIds: allDistilledIds, tenantId, spaceId },
          { attempts: 3, backoff: { type: "exponential", delay: 2000 } },
        ).catch((err) => _logger.error("memory.embed enqueue failed", { tenantId, err: (err as Error)?.message }));
      }
    }
  },
});

// ─── 记忆衰减更新 ───
registerTicker({
  name: "memory-decay",
  intervalMs: () => Math.max(resolveNumber("MEMORY_DECAY_INTERVAL_MS").value, 60_000),
  lockKey: "tick:memory-decay",
  lockTtlMs: () => Math.max(resolveNumber("MEMORY_DECAY_INTERVAL_MS").value, 60_000),
  handler: async ({ pool }) => { await updateMemoryDecayScores({ pool }); },
});

// ─── 记忆向量嵌入补全 ───
registerTicker({
  name: "memory-embed-backfill",
  intervalMs: () => Math.max(resolveNumber("MEMORY_EMBEDDING_BACKFILL_INTERVAL_MS").value, 60_000),
  lockKey: "tick:memory-embed-backfill",
  lockTtlMs: () => Math.max(resolveNumber("MEMORY_EMBEDDING_BACKFILL_INTERVAL_MS").value, 60_000),
  handler: async ({ pool }) => { await backfillMemoryEmbeddings({ pool, limit: 50 }); },
});

// ─── 模型能力探测 ───
registerTicker({
  name: "model-probe",
  intervalMs: () => Math.max(resolveNumber("MODEL_PROBE_INTERVAL_MS").value, 60_000),
  lockKey: "tick:model-probe",
  lockTtlMs: () => Math.max(resolveNumber("MODEL_PROBE_INTERVAL_MS").value, 60_000),
  handler: async ({ pool }) => {
    const { runModelProbing } = await import("./model/modelProber");
    const tenants = await pool.query(`SELECT id FROM tenants LIMIT 50`);
    for (const t of tenants.rows) {
      const tid = String((t as Record<string, unknown>).id);
      await runModelProbing({ pool, tenantId: tid }).catch((e: unknown) =>
                _logger.error("model probing failed", { tenantId: tid, err: (e as Error)?.message }),
      );
    }
  },
});

// ─── 审批过期 ───
registerTicker({
  name: "approval-expiry",
  intervalMs: () => Math.max(resolveNumber("APPROVAL_EXPIRY_INTERVAL_MS").value, 10_000),
  lockKey: "tick:approval-expiry",
  lockTtlMs: () => Math.max(resolveNumber("APPROVAL_EXPIRY_INTERVAL_MS").value, 10_000),
  handler: async ({ pool }) => { await tickApprovalExpiry({ pool }); },
});

// ─── 通知队列消费 ───
registerTicker({
  name: "notification-queue",
  intervalMs: () => Math.max(resolveNumber("NOTIFICATION_QUEUE_INTERVAL_MS").value, 1_000),
  lockKey: "tick:notification-queue",
  lockTtlMs: () => Math.max(resolveNumber("NOTIFICATION_QUEUE_INTERVAL_MS").value, 1_000) + 2_000,
  handler: async ({ pool, redis }) => { await tickNotificationQueue({ pool, redis }); },
});

// ─── 主动学习反思 ───
registerTicker({
  name: "active-reflexion",
  intervalMs: () => Math.max(Number(process.env.ACTIVE_REFLEXION_INTERVAL_MS) || 60 * 60_000, 5 * 60_000),
  lockKey: "tick:active-reflexion",
  lockTtlMs: () => Math.max(Math.max(Number(process.env.ACTIVE_REFLEXION_INTERVAL_MS) || 60 * 60_000, 5 * 60_000), 10 * 60_000),
  handler: async ({ pool }) => { await tickActiveReflexion({ pool }); },
});

// ─── Agent Loop Supervisor ───
registerTicker({
  name: "loop-supervisor",
  intervalMs: () => Math.max(Number(process.env.LOOP_SUPERVISOR_INTERVAL_MS) || 15_000, 5_000),
  lockKey: "tick:loop-supervisor",
  lockTtlMs: () => Math.max(Number(process.env.LOOP_SUPERVISOR_INTERVAL_MS) || 15_000, 5_000),
  handler: async ({ pool, queue }) => { await tickLoopSupervisor({ pool, queue }); },
});

// ─── 节点负载上报 ───
registerTicker({
  name: "node-load-report",
  intervalMs: () => Math.max(Number(process.env.LOOP_SCHEDULER_INTERVAL_MS) || 30_000, 10_000),
  lockKey: "",
  noLock: true,
  handler: async ({ redis }) => { await reportNodeLoad(redis); },
});

// ─── Loop Scheduler ───
registerTicker({
  name: "loop-scheduler",
  intervalMs: () => Math.max(Number(process.env.LOOP_SCHEDULER_INTERVAL_MS) || 30_000, 10_000),
  lockKey: "tick:loop-scheduler",
  lockTtlMs: () => Math.max(Number(process.env.LOOP_SCHEDULER_INTERVAL_MS) || 30_000, 10_000),
  handler: async ({ pool, redis }) => { await tickLoopScheduler({ pool, redis }); },
});

// ─── 数据库备份 ───
registerTicker({
  name: "db-backup",
  intervalMs: () => Math.max(Number(process.env.DB_BACKUP_INTERVAL_MS) || 60 * 60_000, 60_000),
  lockKey: "tick:db-backup",
  lockTtlMs: () => Math.max(Math.max(Number(process.env.DB_BACKUP_INTERVAL_MS) || 60 * 60_000, 60_000), 30 * 60_000),
  handler: async ({ pool, cfg }) => {
    await tickDbBackup({ pool, dbConfig: { host: cfg.db.host, port: cfg.db.port, database: cfg.db.database, user: cfg.db.user, password: cfg.db.password } });
  },
});

// ─── 数据库备份验证 ───
registerTicker({
  name: "db-backup-verify",
  intervalMs: () => Math.max(Number(process.env.DB_BACKUP_VERIFY_INTERVAL_MS) || 2 * 60 * 60_000, 60_000),
  lockKey: "tick:db-backup-verify",
  lockTtlMs: 10 * 60_000,
  handler: async ({ pool }) => { await tickDbBackupVerify({ pool }); },
});

// ─── 死信队列自动重试 ───
registerTicker({
  name: "deadletter-retry",
  intervalMs: () => Math.max(Number(process.env.DEADLETTER_RETRY_INTERVAL_MS) || 5 * 60_000, 60_000),
  lockKey: "tick:deadletter-retry",
  lockTtlMs: () => Math.max(Number(process.env.DEADLETTER_RETRY_INTERVAL_MS) || 5 * 60_000, 60_000) + 10_000,
  handler: async ({ pool, queue }) => { await tickDeadLetterRetry({ pool, queue }); },
});
