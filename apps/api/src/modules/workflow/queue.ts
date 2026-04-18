import { Queue } from "bullmq";
import type { ApiConfig } from "../../config";
import { attachJobTraceCarrier } from "../../lib/tracing";

export type WorkflowQueue = Queue;

// ── P1-03: 租户级队列优先级 ────────────────────────────────────

/**
 * BullMQ priority 数值越小越优先。
 * 租户层级映射到 BullMQ priority:
 * - critical:  1  (实时业务租户、付费高级租户)
 * - high:      5
 * - normal:   10  (默认)
 * - low:      20  (免费租户/批量任务)
 */
export type TenantTier = "critical" | "high" | "normal" | "low";

const TIER_PRIORITY: Record<TenantTier, number> = {
  critical: 1,
  high: 5,
  normal: 10,
  low: 20,
};

// 运行时缓存：租户 ID → 层级，避免每次查 DB
const tenantTierCache = new Map<string, { tier: TenantTier; expiresAt: number }>();
const TIER_CACHE_TTL_MS = 60_000; // 60s 缓存

/** 解析租户优先级（从 DB tenant_settings 或环境变量） */
export async function resolveTenantTier(pool: any, tenantId: string): Promise<TenantTier> {
  const now = Date.now();
  const cached = tenantTierCache.get(tenantId);
  if (cached && cached.expiresAt > now) return cached.tier;

  let tier: TenantTier = "normal";
  try {
    const res = await pool.query(
      `SELECT (settings->>'queueTier') AS tier FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId],
    );
    if (res.rowCount) {
      const raw = String(res.rows[0].tier ?? "");
      if (raw in TIER_PRIORITY) tier = raw as TenantTier;
    }
  } catch { /* 查询失败使用默认 */ }

  tenantTierCache.set(tenantId, { tier, expiresAt: now + TIER_CACHE_TTL_MS });
  return tier;
}

/** 获取 BullMQ 优先级数值 */
export function tierToPriority(tier: TenantTier): number {
  return TIER_PRIORITY[tier] ?? TIER_PRIORITY.normal;
}

export function createWorkflowQueue(cfg: ApiConfig) {
  const connection = { host: cfg.redis.host, port: cfg.redis.port };
  const q = new Queue("workflow", { connection });
  const origAdd = q.add.bind(q);
  (q as any).add = (name: string, data: any, opts: any) => origAdd(name, attachJobTraceCarrier(data ?? {}), opts);
  return q;
}

export async function setRunAndJobStatus(params: {
  pool: any;
  tenantId: string;
  runId: string;
  jobId: string;
  runStatus: string;
  jobStatus: string;
}) {
  await params.pool.query("UPDATE runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [
    params.tenantId,
    params.runId,
    params.runStatus,
  ]);
  await params.pool.query("UPDATE jobs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [
    params.tenantId,
    params.jobId,
    params.jobStatus,
  ]);
}

export async function enqueueWorkflowStep(params: {
  queue: WorkflowQueue;
  pool: any;
  jobId: string;
  runId: string;
  stepId: string;
  tenantId?: string;
  attempts?: number;
  backoffDelayMs?: number;
}) {
  const attempts = typeof params.attempts === "number" && Number.isFinite(params.attempts) ? params.attempts : 3;
  const delay = typeof params.backoffDelayMs === "number" && Number.isFinite(params.backoffDelayMs) ? params.backoffDelayMs : 500;

  // P1-03: 租户级优先级
  let priority: number | undefined;
  if (params.tenantId) {
    try {
      const tier = await resolveTenantTier(params.pool, params.tenantId);
      priority = tierToPriority(tier);
    } catch { /* 失败时不设置优先级，等同默认 */ }
  }

  const bj = await params.queue.add(
    "step",
    { jobId: params.jobId, runId: params.runId, stepId: params.stepId },
    { attempts, backoff: { type: "exponential", delay }, ...(priority !== undefined ? { priority } : {}) },
  );
  await params.pool.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [
    String((bj as any).id ?? ""),
    params.stepId,
  ]);
  return bj;
}
