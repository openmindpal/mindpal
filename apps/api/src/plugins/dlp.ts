import type { FastifyPluginAsync } from "fastify";
import { attachDlpSummary, redactValue, shouldDenyDlpForTarget } from "@openslin/shared";
import { Errors } from "../lib/errors";
import { digestBody, digestPayload } from "./digests";
import { resolveRequestDlpPolicyContext } from "../lib/dlpPolicy";

export const dlpPlugin: FastifyPluginAsync = async (app) => {
  app.addHook("preSerialization", async (req, reply, payload) => {
    const subject = req.ctx.subject;
    const dlpContext = await resolveRequestDlpPolicyContext({ db: app.db, subject });
    const dlpPolicy = dlpContext.policy;
    const target = req.ctx.audit?.resourceType && req.ctx.audit?.action ? `${req.ctx.audit.resourceType}:${req.ctx.audit.action}` : "";
    const scanned = redactValue(payload);
    const denied = shouldDenyDlpForTarget({ summary: scanned.summary, target, policy: dlpPolicy });
    if (denied) {
      req.ctx.audit ??= {};
      req.ctx.audit.errorCategory = "policy_violation";
      reply.status(403);
      payload = {
        errorCode: "DLP_DENIED",
        message: Errors.dlpDenied().messageI18n,
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
      };
    } else {
      payload = scanned.value;
    }

    if (payload && typeof payload === "object" && !Array.isArray(payload) && !Buffer.isBuffer(payload)) {
      const out: any = payload as any;
      if (out.traceId === undefined) out.traceId = req.ctx.traceId;
      if (out.requestId === undefined) out.requestId = req.ctx.requestId;
    }

    const audit = req.ctx.audit;
    if (!audit?.resourceType || !audit?.action) return payload;

    audit.outputDigest ??= digestPayload(payload) ?? digestBody(payload);
    const redactedIn = redactValue(audit.inputDigest);
    audit.inputDigest = redactedIn.value;
    const redactedOut = redactValue(audit.outputDigest);
    const dlpSummary = denied
      ? { ...scanned.summary, disposition: "deny" as const, redacted: true, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version }
      : scanned.summary.redacted
        ? { ...scanned.summary, disposition: "redact" as const, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version }
        : { ...redactedOut.summary, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version };
    const outWithDlp = attachDlpSummary(redactedOut.value, dlpSummary);
    const payloadWithDlp = attachDlpSummary(payload, dlpSummary);
    if (payloadWithDlp && typeof payloadWithDlp === "object" && !Array.isArray(payloadWithDlp) && !Buffer.isBuffer(payloadWithDlp)) {
      const obj: any = payloadWithDlp as any;
      if (obj.safetySummary && typeof obj.safetySummary === "object" && !Array.isArray(obj.safetySummary)) {
        const ss: any = obj.safetySummary;
        if (!ss.dlpSummary) ss.dlpSummary = dlpSummary;
        if (!ss.decision) ss.decision = denied ? "denied" : "allowed";
        if (!dlpContext.configOverride && dlpContext.policyDigest && !ss.policyRefsDigest) ss.policyRefsDigest = { contentPolicyDigest: dlpContext.policyDigest };
      } else if (obj.safetySummary === undefined) {
        obj.safetySummary = { decision: denied ? "denied" : "allowed", dlpSummary, ...(!dlpContext.configOverride && dlpContext.policyDigest ? { policyRefsDigest: { contentPolicyDigest: dlpContext.policyDigest } } : {}) };
      }
    }
    audit.outputDigest = outWithDlp;

    return payloadWithDlp ?? payload;
  });
};
