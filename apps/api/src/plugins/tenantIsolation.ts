/**
 * P1-03b: Per-Tenant Connection Tracking Middleware
 *
 * 跟踪每个租户的并发查询数量：
 * - 硬限制：超过 TENANT_CONCURRENCY_HARD_LIMIT 时返回 HTTP 429 阻断请求
 * - 软限制：达到 80% 硬限制时输出结构化警告日志（可观测性）
 */
import type { FastifyPluginAsync } from "fastify";
import { resolveNumber, StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:tenantIsolation" });
import { getConfigOverridesWithHotCache } from "../lib/hotConfigEngine";
import { Errors } from "../lib/errors";

const DEFAULT_SOFT_QUOTA = 50; // 单租户并发查询软上限
const DEFAULT_HARD_LIMIT = 100; // 单租户并发查询硬上限
const RETRY_AFTER_SEC = 5; // 429 建议重试间隔

// 运行时计数器
export const tenantConcurrency = new Map<string, number>();

/** 获取当前租户并发统计（用于健康检查/诊断） */
export function getTenantConcurrencySnapshot(): Array<{ tenantId: string; concurrent: number }> {
  const out: Array<{ tenantId: string; concurrent: number }> = [];
  for (const [tenantId, count] of tenantConcurrency) {
    if (count > 0) out.push({ tenantId, concurrent: count });
  }
  return out.sort((a, b) => b.concurrent - a.concurrent);
}

/** 递减租户并发计数器（确保不会小于 0） */
export function decrementTenantCounter(tenantId: string): void {
  const current = Math.max(0, (tenantConcurrency.get(tenantId) ?? 0) - 1);
  if (current === 0) {
    tenantConcurrency.delete(tenantId);
  } else {
    tenantConcurrency.set(tenantId, current);
  }
}

export const tenantIsolationPlugin: FastifyPluginAsync<{
  /** 单租户并发查询软上限 */
  softQuota?: number;
  /** 单租户并发查询硬上限 */
  hardLimit?: number;
}> = async (app, opts) => {
  const softQuota = opts.softQuota ?? (Number(process.env.TENANT_CONCURRENCY_SOFT_QUOTA) || DEFAULT_SOFT_QUOTA);
  const hardLimit = opts.hardLimit ?? (Number(process.env.TENANT_CONCURRENCY_HARD_LIMIT) || DEFAULT_HARD_LIMIT);

  app.addHook("onRequest", async (req, reply) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return;

    /* 从热配置获取租户级并发限制 */
    let effectiveQuota = softQuota;
    let effectiveHardLimit = hardLimit;
    try {
      const overrides = await getConfigOverridesWithHotCache({ pool: (req.server as any).db, tenantId });
      effectiveQuota = resolveNumber("TENANT_CONCURRENCY_SOFT_QUOTA", process.env as Record<string, string | undefined>, overrides, softQuota).value;
      effectiveHardLimit = resolveNumber("TENANT_CONCURRENCY_HARD_LIMIT", process.env as Record<string, string | undefined>, overrides, hardLimit).value;
    } catch { /* 回退到静态配置 */ }

    const currentCount = tenantConcurrency.get(tenantId) ?? 0;

    // ── 硬限制：超限时阻断请求，返回 429 ──
    if (currentCount >= effectiveHardLimit) {
      _logger.warn("tenant concurrent requests exceeded hard limit — blocking", {
        tenantId,
        currentCount,
        hardLimit: effectiveHardLimit,
      });

      try {
        (app.metrics as any).incCounter?.("mindpal_tenant_quota_exceeded_total", { tenant_id: tenantId }, 1);
      } catch { /* metrics 可能未注册 */ }

      reply.header("Retry-After", String(RETRY_AFTER_SEC));
      throw Errors.tenantConcurrencyExceeded(tenantId, effectiveHardLimit, RETRY_AFTER_SEC);
    }

    // ── 递增计数器（仅在未被阻断时） ──
    const next = currentCount + 1;
    tenantConcurrency.set(tenantId, next);

    // ── 软限制：接近阈值时输出预警日志 ──
    const warnThreshold = Math.floor(effectiveHardLimit * 0.8);
    if (next >= warnThreshold && next < effectiveHardLimit) {
      _logger.warn("tenant approaching concurrency limit", {
        tenantId,
        currentCount: next,
        hardLimit: effectiveHardLimit,
        warnThreshold,
      });
    }

    if (next > effectiveQuota) {
      _logger.warn("tenant concurrent requests exceeds soft quota", { tenantId, current: next, softQuota: effectiveQuota });
      try {
        (app.metrics as any).incCounter?.("mindpal_tenant_quota_exceeded_total", { tenant_id: tenantId }, 1);
      } catch { /* metrics 可能未注册 */ }
    }
  });

  app.addHook("onResponse", async (req) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return;
    decrementTenantCounter(tenantId);
  });

  app.addHook("onError", async (req) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return;
    decrementTenantCounter(tenantId);
  });
};
