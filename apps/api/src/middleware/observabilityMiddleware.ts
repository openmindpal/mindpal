/**
 * Phase 2: Audit, DLP, Metrics & Tracing
 *
 * Merges: auditContextPlugin, idempotencyKeyPlugin, dlpPlugin, auditPlugin, metricsPlugin
 *
 * 功能目标：将审计上下文初始化、幂等键提取、DLP 扫描、审计写入、请求指标
 * 整合为统一的可观测性中间件阶段。
 */
import type { FastifyInstance } from "fastify";
import { digestBody } from "../plugins/digests";
import { handleDlpPreSerialization } from "../plugins/dlp";
import { finalizeAudit } from "../plugins/audit";

export function observabilityMiddleware(app: FastifyInstance): void {
  // ── onRequest: 审计上下文初始化 + 幂等键提取 ──
  app.addHook("onRequest", async (req) => {
    // Audit context initialization (from auditContextPlugin)
    req.ctx.audit ??= {};
    req.ctx.audit.startedAtMs = Date.now();
    req.ctx.audit.inputDigest = digestBody(req.body);

    // Idempotency key extraction (from idempotencyKeyPlugin)
    req.ctx.audit.idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      req.ctx.audit.idempotencyKey;
  });

  // ── onError: 审计错误捕获 ──
  app.addHook("onError", async (req, _reply, err) => {
    req.ctx.audit ??= {};
    req.ctx.audit.lastError = err;
  });

  // ── preSerialization: DLP 扫描 → 审计终结 ──
  app.addHook("preSerialization", async (req, reply, payload) => {
    // Phase 1: DLP check
    payload = await handleDlpPreSerialization(app, req, reply, payload);
    // Phase 2: Audit finalize (mergeDigest=false for preSerialization)
    return finalizeAudit(app, { req, reply, payload, mergeDigest: false });
  });

  // ── onSend: 审计终结（含 digest 合并） ──
  app.addHook("onSend", async (req, reply, payload) => {
    return finalizeAudit(app, { req, reply, payload, mergeDigest: true });
  });

  // ── onResponse: 请求指标采集 ──
  app.addHook("onResponse", async (req, reply) => {
    const startedAtMs = req.ctx.audit?.startedAtMs ?? Date.now();
    const latencyMs = Math.max(0, Date.now() - startedAtMs);
    const method = req.method;
    const route =
      ((req as any).routeOptions?.url as string | undefined) ??
      ((req as any).routerPath as string | undefined) ??
      "unmatched";
    app.metrics.observeRequest({ method, route, statusCode: reply.statusCode, latencyMs });

    const pd = req.ctx.audit?.policyDecision as any;
    if (reply.statusCode === 403 && pd && String(pd.decision ?? "") === "deny" && req.ctx.audit?.resourceType && req.ctx.audit?.action) {
      app.metrics.incAuthzDenied({ resourceType: req.ctx.audit.resourceType, action: req.ctx.audit.action });
    }
  });
}
