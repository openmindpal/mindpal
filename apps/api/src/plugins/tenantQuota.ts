/**
 * 多租户资源配额中间件
 *
 * 功能目标：防止恶意租户资源耗尽攻击
 * - 基于内存计数器的 API 请求速率限制（每分钟）
 * - 超配额时返回 429 Too Many Requests
 * - 集成到 Fastify 插件系统
 */
import type { FastifyPluginAsync } from "fastify";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:tenantQuota" });

/* ================================================================== */
/*  Quota Types                                                         */
/* ================================================================== */

export interface TenantQuotaConfig {
  /** 存储字节上限 */
  storageBytes: number;
  /** 每分钟 API 请求上限 */
  apiRequestsPerMinute: number;
  /** 每小时计算秒数上限 */
  computeSecondsPerHour: number;
}

const DEFAULT_QUOTA: TenantQuotaConfig = {
  storageBytes: 10 * 1024 * 1024 * 1024, // 10GB
  apiRequestsPerMinute: 600,
  computeSecondsPerHour: 3600,
};

/* ================================================================== */
/*  In-Memory Rate Limiter                                              */
/* ================================================================== */

interface RateBucket {
  count: number;
  windowStart: number; // ms timestamp
}

/** 每租户 API 请求速率计数器 */
export const rateBuckets = new Map<string, RateBucket>();

/** 自定义配额覆盖（可通过 setTenantQuota 运行时调整） */
const quotaOverrides = new Map<string, Partial<TenantQuotaConfig>>();

/** 获取租户有效配额 */
export function getEffectiveQuota(tenantId: string): TenantQuotaConfig {
  const override = quotaOverrides.get(tenantId);
  if (!override) return DEFAULT_QUOTA;
  return {
    storageBytes: override.storageBytes ?? DEFAULT_QUOTA.storageBytes,
    apiRequestsPerMinute: override.apiRequestsPerMinute ?? DEFAULT_QUOTA.apiRequestsPerMinute,
    computeSecondsPerHour: override.computeSecondsPerHour ?? DEFAULT_QUOTA.computeSecondsPerHour,
  };
}

/** 运行时设置租户配额覆盖 */
export function setTenantQuota(tenantId: string, quota: Partial<TenantQuotaConfig>): void {
  quotaOverrides.set(tenantId, quota);
}

/** 检查并递增 API 请求计数，返回是否超配额 */
export function checkAndIncrementApiRate(tenantId: string, limit: number): { exceeded: boolean; current: number; resetMs: number } {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window
  let bucket = rateBuckets.get(tenantId);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    // 新窗口
    bucket = { count: 1, windowStart: now };
    rateBuckets.set(tenantId, bucket);
    return { exceeded: false, current: 1, resetMs: windowMs };
  }

  bucket.count += 1;
  const resetMs = windowMs - (now - bucket.windowStart);

  if (bucket.count > limit) {
    return { exceeded: true, current: bucket.count, resetMs };
  }

  return { exceeded: false, current: bucket.count, resetMs };
}

/** 获取速率限制快照（用于健康检查/诊断） */
export function getRateLimitSnapshot(): Array<{ tenantId: string; count: number; windowStart: number }> {
  const out: Array<{ tenantId: string; count: number; windowStart: number }> = [];
  for (const [tenantId, bucket] of rateBuckets) {
    if (bucket.count > 0) out.push({ tenantId, count: bucket.count, windowStart: bucket.windowStart });
  }
  return out.sort((a, b) => b.count - a.count);
}

/* ================================================================== */
/*  Fastify Plugin                                                      */
/* ================================================================== */

const RETRY_AFTER_SEC = 10;

export const tenantQuotaPlugin: FastifyPluginAsync<{
  /** 全局默认每分钟 API 请求上限 */
  defaultApiRequestsPerMinute?: number;
}> = async (app, opts) => {
  const globalLimit = opts.defaultApiRequestsPerMinute
    ?? (Number(process.env.TENANT_API_REQUESTS_PER_MINUTE) || DEFAULT_QUOTA.apiRequestsPerMinute);

  // 定期清理过期窗口（每 2 分钟）
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [tenantId, bucket] of rateBuckets) {
      if (now - bucket.windowStart >= 120_000) {
        rateBuckets.delete(tenantId);
      }
    }
  }, 120_000);
  cleanupInterval.unref();

  app.addHook("onClose", () => {
    clearInterval(cleanupInterval);
  });

  app.addHook("onRequest", async (req, reply) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return; // 未认证请求不做配额检查

    const quota = getEffectiveQuota(tenantId);
    const effectiveLimit = Math.min(quota.apiRequestsPerMinute, globalLimit);

    const result = checkAndIncrementApiRate(tenantId, effectiveLimit);

    // 设置速率限制响应头
    reply.header("X-RateLimit-Limit", String(effectiveLimit));
    reply.header("X-RateLimit-Remaining", String(Math.max(0, effectiveLimit - result.current)));
    reply.header("X-RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)));

    if (result.exceeded) {
      _logger.warn("tenant quota exceeded", {
        tenantId,
        current: result.current,
        limit: effectiveLimit,
      } as Record<string, unknown>);

      reply.header("Retry-After", String(RETRY_AFTER_SEC));
      reply.status(429).send({
        error: "Too Many Requests",
        message: `租户 API 请求配额已超限（${effectiveLimit} 请求/分钟）`,
        retryAfter: RETRY_AFTER_SEC,
      });
      return reply;
    }
  });
};
