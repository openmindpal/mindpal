/**
 * Phase 3: Business Context — Preferences, Tenant Isolation, Tenant Quota
 *
 * Merges: preferencesPlugin, tenantIsolationPlugin, tenantQuotaPlugin
 *
 * 功能目标：在认证完成后初始化业务上下文（locale 偏好解析）、
 * 租户并发隔离（硬/软限制）和租户 API 请求速率配额。
 */
import type { FastifyInstance } from "fastify";
import { resolveNumber, StructuredLogger } from "@mindpal/shared";
import { resolveRequestLocale } from "../lib/locale";
import { getUserLocalePreference } from "../lib/userPreferences";
import { getConfigOverridesWithHotCache } from "../lib/hotConfigEngine";
import { Errors } from "../lib/errors";
import {
  tenantConcurrency,
  decrementTenantCounter,
} from "../plugins/tenantIsolation";
import {
  rateBuckets,
  getEffectiveQuota,
  checkAndIncrementApiRate,
} from "../plugins/tenantQuota";

const _logger = new StructuredLogger({ module: "api:contextMiddleware" });

const DEFAULT_SOFT_QUOTA = 50;
const DEFAULT_HARD_LIMIT = 100;
const ISOLATION_RETRY_AFTER_SEC = 5;
const QUOTA_RETRY_AFTER_SEC = 10;

export function contextMiddleware(app: FastifyInstance): void {
  const softQuota = Number(process.env.TENANT_CONCURRENCY_SOFT_QUOTA) || DEFAULT_SOFT_QUOTA;
  const hardLimit = Number(process.env.TENANT_CONCURRENCY_HARD_LIMIT) || DEFAULT_HARD_LIMIT;
  const globalRateLimit = Number(process.env.TENANT_API_REQUESTS_PER_MINUTE) || 600;

  // ── onRequest: 偏好解析 + 并发隔离 + 请求配额 ──
  app.addHook("onRequest", async (req, reply) => {
    const subject = req.ctx.subject;

    // ── 1. Locale Preferences (from preferencesPlugin) ──
    if (subject) {
      const userLocaleHeader = req.headers["x-user-locale"] as string | undefined;
      const spaceLocaleHeader = req.headers["x-space-locale"] as string | undefined;
      const tenantLocaleHeader = req.headers["x-tenant-locale"] as string | undefined;

      let tenantDefaultLocale: string | undefined;
      const tenantRes = await app.db.query("SELECT default_locale FROM tenants WHERE id = $1 LIMIT 1", [subject.tenantId]);
      if (tenantRes.rowCount) tenantDefaultLocale = tenantRes.rows[0].default_locale as string;

      let spaceDefaultLocale: string | undefined;
      if (subject.spaceId) {
        const spaceRes = await app.db.query("SELECT default_locale FROM spaces WHERE id = $1 AND tenant_id = $2 LIMIT 1", [subject.spaceId, subject.tenantId]);
        if (spaceRes.rowCount) spaceDefaultLocale = spaceRes.rows[0].default_locale as string;
      }

      const userPrefLocale = userLocaleHeader ? null : await getUserLocalePreference({ pool: app.db, tenantId: subject.tenantId, subjectId: subject.subjectId });

      req.ctx.locale = resolveRequestLocale({
        userLocale: userLocaleHeader ?? userPrefLocale ?? undefined,
        spaceLocale: spaceLocaleHeader ?? spaceDefaultLocale,
        tenantLocale: tenantLocaleHeader ?? tenantDefaultLocale,
        acceptLanguage: req.headers["accept-language"] as string | undefined,
        platformLocale: app.cfg.platformLocale,
      });
    }

    if (!subject) return; // 后续检查均需已认证主体

    const tenantId = subject.tenantId;

    // ── 2. Tenant Concurrency Isolation (from tenantIsolationPlugin) ──
    let effectiveQuota = softQuota;
    let effectiveHardLimit = hardLimit;
    try {
      const overrides = await getConfigOverridesWithHotCache({ pool: app.db, tenantId });
      effectiveQuota = resolveNumber("TENANT_CONCURRENCY_SOFT_QUOTA", process.env as Record<string, string | undefined>, overrides, softQuota).value;
      effectiveHardLimit = resolveNumber("TENANT_CONCURRENCY_HARD_LIMIT", process.env as Record<string, string | undefined>, overrides, hardLimit).value;
    } catch { /* 回退到静态配置 */ }

    const currentCount = tenantConcurrency.get(tenantId) ?? 0;

    if (currentCount >= effectiveHardLimit) {
      _logger.warn("tenant concurrent requests exceeded hard limit — blocking", {
        tenantId,
        currentCount,
        hardLimit: effectiveHardLimit,
      });
      try {
        (app.metrics as any).incCounter?.("mindpal_tenant_quota_exceeded_total", { tenant_id: tenantId }, 1);
      } catch { /* metrics 可能未注册 */ }
      reply.header("Retry-After", String(ISOLATION_RETRY_AFTER_SEC));
      throw Errors.tenantConcurrencyExceeded(tenantId, effectiveHardLimit, ISOLATION_RETRY_AFTER_SEC);
    }

    const next = currentCount + 1;
    tenantConcurrency.set(tenantId, next);

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

    // ── 3. Tenant API Request Quota (from tenantQuotaPlugin) ──
    const quota = getEffectiveQuota(tenantId);
    const effectiveRateLimit = Math.min(quota.apiRequestsPerMinute, globalRateLimit);
    const result = checkAndIncrementApiRate(tenantId, effectiveRateLimit);

    reply.header("X-RateLimit-Limit", String(effectiveRateLimit));
    reply.header("X-RateLimit-Remaining", String(Math.max(0, effectiveRateLimit - result.current)));
    reply.header("X-RateLimit-Reset", String(Math.ceil(result.resetMs / 1000)));

    if (result.exceeded) {
      _logger.warn("tenant quota exceeded", {
        tenantId,
        current: result.current,
        limit: effectiveRateLimit,
      } as Record<string, unknown>);
      reply.header("Retry-After", String(QUOTA_RETRY_AFTER_SEC));
      reply.status(429).send({
        error: "Too Many Requests",
        message: `租户 API 请求配额已超限（${effectiveRateLimit} 请求/分钟）`,
        retryAfter: QUOTA_RETRY_AFTER_SEC,
      });
      return reply;
    }
  });

  // ── onResponse: 统一资源清理（递减租户并发计数器） ──
  // 注：onResponse 在响应发送后总是触发（无论成功或错误），
  //     因此无需在 onError 中单独递减，避免 double-decrement。
  app.addHook("onResponse", async (req) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return;
    decrementTenantCounter(tenantId);
  });

  // ── 定期清理过期速率窗口（每 2 分钟） ──
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
}
