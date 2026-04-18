import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { getObservabilitySummary, getAgentOSOperationsMetrics, checkArchitectureQualityAlerts, getRuntimeDegradationStats, getCoreRunMetrics } from "../../modules/governance/observabilityRepo";
import {
  getVocabLoaderStatus, forceReloadVocab,
  setTenantVocabOverride, clearTenantVocabOverride,
  getVocabSnapshot, getTenantVocabSnapshot,
  type IntentVocabJson,
} from "../../skills/orchestrator/modules/intentVocabLoader";

export const governanceObservabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get("/governance/observability/summary", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "summary" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    const window = q.window ?? "1h";
    const out = await getObservabilitySummary({ pool: app.db as any, tenantId: subject.tenantId, window });
    req.ctx.audit!.outputDigest = { window, routes: out.routes.length, sync: out.sync.length, topErrors: out.topErrors.length };
    return out;
  });

  // P2-15: Agent OS 运营指标
  app.get("/governance/observability/operations", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "operations" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getAgentOSOperationsMetrics({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
  });

  // P2-15.4: 架构质量告警
  app.get("/governance/observability/quality-alerts", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "quality_alerts" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return checkArchitectureQualityAlerts({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
  });

  // P1-11.4: 运行时降级统计
  app.get("/governance/observability/degradation-stats", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "degradation_stats" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getRuntimeDegradationStats({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
  });

  // P3-2: 核心运行指标 (治理仪表盘)
  app.get("/governance/run-metrics", async (req) => {
    const q = z.object({ window: z.enum(["1h", "24h", "7d"]).optional() }).parse(req.query);
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "observability", action: "run_metrics" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    const metrics = await getCoreRunMetrics({ pool: app.db as any, tenantId: subject.tenantId, window: q.window ?? "24h" });
    req.ctx.audit!.outputDigest = { totalRuns: metrics.totalRuns, activeRuns: metrics.activeRuns, blockedRuns: metrics.blockedRuns };
    return metrics;
  });

  /* ================================================================== */
  /*  P1: 词表治理端点                                                     */
  /* ================================================================== */

  // P1: 获取词表加载状态
  app.get("/governance/vocab/status", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "vocab.status" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getVocabLoaderStatus();
  });

  // P1: 获取当前全局词表快照
  app.get("/governance/vocab/snapshot", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "vocab.snapshot" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getVocabSnapshot();
  });

  // P1: 获取租户词表快照
  app.get("/governance/vocab/tenant-snapshot", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "vocab.tenant_snapshot" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.read" });
    return getTenantVocabSnapshot(subject.tenantId);
  });

  // P1: 强制重新加载全局词表
  app.post("/governance/vocab/reload", async (req) => {
    setAuditContext(req, { resourceType: "governance", action: "vocab.reload" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.write" });
    const snapshot = forceReloadVocab();
    req.ctx.audit!.outputDigest = { version: snapshot.version, source: snapshot.source };
    return { ok: true, version: snapshot.version, source: snapshot.source, loadedAt: snapshot.loadedAt };
  });

  // P1: 设置租户词表覆盖
  app.put("/governance/vocab/tenant-override", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "vocab.tenant_override.set" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.write" });
    const body = req.body as Partial<IntentVocabJson>;
    setTenantVocabOverride(subject.tenantId, body);
    req.ctx.audit!.outputDigest = { tenantId: subject.tenantId };
    return { ok: true, tenantId: subject.tenantId };
  });

  // P1: 清除租户词表覆盖
  app.delete("/governance/vocab/tenant-override", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "vocab.tenant_override.clear" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "governance", action: "observability.write" });
    clearTenantVocabOverride(subject.tenantId);
    req.ctx.audit!.outputDigest = { tenantId: subject.tenantId };
    return { ok: true, tenantId: subject.tenantId };
  });
};

