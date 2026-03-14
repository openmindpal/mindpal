import type { FastifyPluginAsync } from "fastify";
import { insertAuditEvent } from "../modules/audit/auditRepo";

function digestBody(body: unknown) {
  if (!body || typeof body !== "object") return body;
  const keys = Object.keys(body as any);
  return { keys: keys.slice(0, 50), keyCount: keys.length };
}

function digestPayload(payload: unknown) {
  if (typeof payload === "string") return { length: payload.length };
  if (payload && Buffer.isBuffer(payload)) return { length: payload.length };
  return undefined;
}

function mergeOutputDigest(existing: unknown, patch: unknown) {
  if (!patch) return existing;
  if (!existing) return patch;
  if (typeof existing !== "object" || Array.isArray(existing)) return existing;
  if (typeof patch !== "object" || Array.isArray(patch)) return existing;
  if (Object.prototype.hasOwnProperty.call(existing, "length")) return existing;
  return { ...(existing as any), ...(patch as any) };
}

export const auditPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    (req as any).ctx ??= {
      traceId: (req.headers["x-trace-id"] as string | undefined) ?? "",
      locale: (req.headers["x-user-locale"] as string | undefined) ?? "zh-CN",
    };
    req.ctx.audit ??= {};
    req.ctx.audit.startedAtMs = Date.now();
    req.ctx.audit.inputDigest = digestBody(req.body);
    req.ctx.audit.idempotencyKey =
      (req.headers["idempotency-key"] as string | undefined) ??
      (req.headers["x-idempotency-key"] as string | undefined) ??
      req.ctx.audit.idempotencyKey;
  });

  app.addHook("onError", async (req, _reply, err) => {
    if (!req.ctx.audit) return;
    req.ctx.audit.lastError = err;
  });

  app.addHook("onSend", async (req, _reply, payload) => {
    if (!req.ctx.audit) return payload;
    req.ctx.audit.outputDigest = mergeOutputDigest(req.ctx.audit.outputDigest, digestPayload(payload));
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    const audit = req.ctx.audit;
    if (!audit?.resourceType || !audit?.action) return;

    const latencyMs = audit.startedAtMs ? Date.now() - audit.startedAtMs : undefined;
    const result =
      reply.statusCode >= 200 && reply.statusCode < 400
        ? "success"
        : reply.statusCode === 401 || reply.statusCode === 403
          ? "denied"
          : "error";

    await insertAuditEvent(app.db, {
      subjectId: req.ctx.subject?.subjectId,
      tenantId: req.ctx.subject?.tenantId,
      spaceId: req.ctx.subject?.spaceId,
      resourceType: audit.resourceType,
      action: audit.action,
      toolRef: audit.toolRef,
      workflowRef: audit.workflowRef,
      policyDecision: audit.policyDecision,
      inputDigest: audit.inputDigest,
      outputDigest: audit.outputDigest,
      idempotencyKey: audit.idempotencyKey,
      result,
      traceId: req.ctx.traceId,
      errorCategory: audit.errorCategory,
      latencyMs,
    });
  });
};
