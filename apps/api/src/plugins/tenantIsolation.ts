/**
 * P1-03b: Per-Tenant Connection Tracking Middleware
 *
 * 跟踪每个租户的并发查询数量，当超过软配额时记录告警。
 * 不阻塞请求（软限制），仅提供可观测性。
 */
import type { FastifyPluginAsync } from "fastify";
import { resolveNumber } from "@openslin/shared";
import { getConfigOverridesWithHotCache } from "../lib/hotConfigEngine";

const DEFAULT_SOFT_QUOTA = 50; // 单租户并发查询软上限

// 运行时计数器
const tenantConcurrency = new Map<string, number>();

/** 获取当前租户并发统计（用于健康检查/诊断） */
export function getTenantConcurrencySnapshot(): Array<{ tenantId: string; concurrent: number }> {
  const out: Array<{ tenantId: string; concurrent: number }> = [];
  for (const [tenantId, count] of tenantConcurrency) {
    if (count > 0) out.push({ tenantId, concurrent: count });
  }
  return out.sort((a, b) => b.concurrent - a.concurrent);
}

export const tenantIsolationPlugin: FastifyPluginAsync<{
  /** 单租户并发查询软上限 */
  softQuota?: number;
}> = async (app, opts) => {
  const softQuota = opts.softQuota ?? (Number(process.env.TENANT_CONCURRENCY_SOFT_QUOTA) || DEFAULT_SOFT_QUOTA);

  app.addHook("onRequest", async (req) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return;

    /* P2-04b: 从热配置获取租户级并发软上限 */
    let effectiveQuota = softQuota;
    try {
      const overrides = await getConfigOverridesWithHotCache({ pool: (req.server as any).db, tenantId });
      effectiveQuota = resolveNumber("TENANT_CONCURRENCY_SOFT_QUOTA", process.env as Record<string, string | undefined>, overrides, softQuota).value;
    } catch { /* 回退到静态配置 */ }

    const current = (tenantConcurrency.get(tenantId) ?? 0) + 1;
    tenantConcurrency.set(tenantId, current);

    if (current > effectiveQuota) {
      console.warn(
        `[tenant-isolation] Tenant ${tenantId} concurrent requests (${current}) exceeds soft quota (${softQuota})`,
      );
      // 可选：通过 metrics 导出
      try {
        (app.metrics as any).incCounter?.("openslin_tenant_quota_exceeded_total", { tenant_id: tenantId }, 1);
      } catch { /* metrics 可能未注册 */ }
    }
  });

  app.addHook("onResponse", async (req) => {
    const tenantId = req.ctx?.subject?.tenantId;
    if (!tenantId) return;

    const current = Math.max(0, (tenantConcurrency.get(tenantId) ?? 0) - 1);
    if (current === 0) {
      tenantConcurrency.delete(tenantId);
    } else {
      tenantConcurrency.set(tenantId, current);
    }
  });
};
