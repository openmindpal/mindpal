import type { FastifyReply, FastifyRequest } from "fastify";
import { redactString, resolveDlpPolicyFromEnv, shouldDenyDlpForTarget, StructuredLogger } from "@openslin/shared";
import {
  extractTextForPromptInjectionScan,
  getPromptInjectionDenyTargetsFromEnv,
  getPromptInjectionModeFromEnv,
  scanPromptInjection,
  shouldDenyPromptInjectionForTarget,
  summarizePromptInjection,
} from "../../safety-policy/modules/promptInjectionGuard";
import { Errors } from "../../../lib/errors";
import { setAuditContext } from "../../../modules/audit/context";
import { requirePermission } from "../../../modules/auth/guard";
import { orchestrateChatTurn } from "../../orchestrator/modules/orchestrator";
import { toReplyText } from "./channelCommon";
import { channelConversationId } from "./conversationId";
import { resolveChannelSecretPayload } from "./channelSecret";
import type { ChannelProviderPlugin, IngressContext } from "./providerAdapters";
import {
  finalizeIngressEvent,
  getChannelAccount,
  getChannelChatBinding,
  getIngressEvent,
  getWebhookConfig,
  insertIngressEvent,
  insertOutboxMessage,
  markOutboxAcked,
  markOutboxDelivered,
} from "./channelRepo";
import { computeBridgeBodyDigest } from "./bridgeContract";

const _logger = new StructuredLogger({ module: "api:channelPipeline" });

// ─── DLP 辅助 ────────────────────────────────────────────────────────────────

function dlpRuleIdsFromSummary(summary: { hitCounts?: Record<string, number> }) {
  const hitCounts = summary?.hitCounts ?? {};
  const out: string[] = [];
  if ((hitCounts.token ?? 0) > 0) out.push("dlp.token");
  if ((hitCounts.email ?? 0) > 0) out.push("dlp.email");
  if ((hitCounts.phone ?? 0) > 0) out.push("dlp.phone");
  return out;
}

// ─── 通用入站管道 ────────────────────────────────────────────────────────────

export async function channelIngressPipeline(
  ctx: { app: any; req: FastifyRequest; reply: FastifyReply },
  plugin: ChannelProviderPlugin,
) {
  const req = ctx.req as any;
  const reply = ctx.reply;
  const app = ctx.app;

  setAuditContext(req, { resourceType: "channel", action: `${plugin.provider}.ingress` });
  const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";

  // 1. extractWorkspaceId
  const workspaceId = plugin.extractWorkspaceId(req);
  if (!workspaceId) throw Errors.badRequest("workspaceId 缺失");

  // 2. getWebhookConfig + resolveSecret
  const cfg = await getWebhookConfig({ pool: app.db, tenantId, provider: plugin.provider, workspaceId });
  if (!cfg) {
    req.ctx.audit!.errorCategory = "policy_violation";
    throw Errors.channelConfigMissing();
  }

  const secretPayload = cfg.secretId
    ? await resolveChannelSecretPayload({ app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId })
    : {};

  const iCtx: IngressContext = { app, req, reply, tenantId, cfg, secretPayload };

  // 3. handleProtocol? (短路)
  if (plugin.handleProtocol) {
    const proto = await plugin.handleProtocol(iCtx);
    if (proto !== null && proto !== undefined) return proto;
  }

  // 4. verifySignature
  const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  await plugin.verifySignature(iCtx, rawBody);

  // 5. parseInbound → 标准化 ParsedInbound
  const inbound = await plugin.parseInbound(iCtx);

  // 6. insertIngressEvent → 幂等去重
  const bodyDigest = computeBridgeBodyDigest({
    provider: plugin.provider,
    workspaceId: inbound.workspaceId,
    eventId: inbound.eventId,
    timestampSec: inbound.timestampSec,
    channelChatId: inbound.channelChatId || null,
    channelUserId: inbound.channelUserId || null,
    text: inbound.text || null,
    payload: inbound.rawBody ?? null,
  });

  const inserted = await insertIngressEvent({
    pool: app.db,
    tenantId,
    provider: plugin.provider,
    workspaceId: inbound.workspaceId,
    eventId: inbound.eventId,
    nonce: inbound.nonce,
    bodyDigest,
    bodyJson: inbound.rawBody,
    requestId: req.ctx.requestId,
    traceId: req.ctx.traceId,
    status: "received",
  });

  if (!inserted) {
    // 幂等竞态修复：仅终态（succeeded/denied/failed）且有 responseJson 时返回缓存
    const prior = await getIngressEvent({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      eventId: inbound.eventId,
    });
    const terminalStatuses = new Set(["succeeded", "denied", "failed"]);
    if (prior && terminalStatuses.has(prior.status) && prior.responseStatusCode && prior.responseJson) {
      req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId: inbound.eventId };
      reply.status(prior.responseStatusCode);
      return prior.responseJson;
    }
    // 非终态 → 返回 202 processing
    reply.status(202);
    return { status: "processing", retryAfterMs: 3000 };
  }

  // 7. 身份映射
  let subjectId: string | null = null;
  let spaceId: string | null = null;
  let resolvedChatId = inbound.channelChatId || null;

  if (inbound.channelUserId) {
    const acc = await getChannelAccount({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelUserId: inbound.channelUserId,
    });
    if (acc && acc.status === "active") {
      subjectId = acc.subjectId;
      spaceId = acc.spaceId ?? null;
    }
  }
  if (!subjectId && inbound.channelChatId) {
    const binding = await getChannelChatBinding({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelChatId: inbound.channelChatId,
    });
    if (binding && binding.status === "active") {
      subjectId = binding.defaultSubjectId ?? null;
      spaceId = binding.spaceId;
      resolvedChatId = binding.channelChatId;
    }
  }

  if (!subjectId || !spaceId || !resolvedChatId) {
    req.ctx.audit!.errorCategory = "policy_violation";
    const err = Errors.channelMappingMissing();
    const resp = {
      correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId },
      status: "denied",
      errorCode: err.errorCode,
    };
    await finalizeIngressEvent({
      pool: app.db,
      id: inserted.id,
      status: "denied",
      responseStatusCode: 403,
      responseJson: resp,
    });
    await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelChatId: resolvedChatId ?? "unknown",
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "denied",
      messageJson: { errorCode: err.errorCode, message: err.messageI18n },
    });
    throw err;
  }

  // 8. requirePermission
  req.ctx.subject = { subjectId, tenantId, spaceId };
  const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
  req.ctx.audit!.policyDecision = decision;

  // 9. 入站 Prompt Injection 扫描（统一对所有 Provider）
  const piMode = getPromptInjectionModeFromEnv();
  const piDenyTargets = getPromptInjectionDenyTargetsFromEnv();
  const piTarget = "channel:send";
  const piText = extractTextForPromptInjectionScan(inbound.text ?? "");
  const piScan = scanPromptInjection(piText);
  const piDenied = shouldDenyPromptInjectionForTarget({ scan: piScan, mode: piMode, target: piTarget, denyTargets: piDenyTargets });
  const piSummary = summarizePromptInjection(piScan, piMode, piTarget, piDenied);
  if (piDenied) {
    req.ctx.audit!.errorCategory = "policy_violation";
    const err = Errors.safetyPromptInjectionDenied();
    const resp = {
      correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId },
      status: "denied" as const,
      errorCode: err.errorCode,
      safetySummary: { decision: "denied" as const, target: piTarget, ruleIds: piSummary.ruleIds, promptInjection: piSummary },
    };
    await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
    await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelChatId: resolvedChatId,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "denied",
      messageJson: { errorCode: err.errorCode, message: err.messageI18n },
    });
    req.ctx.audit!.outputDigest = resp;
    return reply.status(403).send(resp);
  }

  // 10. insertOutboxMessage(processing) → orchestrateChatTurn
  const received = await insertOutboxMessage({
    pool: app.db,
    tenantId,
    provider: plugin.provider,
    workspaceId: inbound.workspaceId,
    channelChatId: resolvedChatId,
    requestId: req.ctx.requestId,
    traceId: req.ctx.traceId,
    status: "processing",
    messageJson: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" },
  });

  try {
    const conversationId = channelConversationId({
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelChatId: resolvedChatId,
      threadId: null,
    });
    const out = await orchestrateChatTurn({
      app,
      pool: app.db,
      subject: { subjectId, tenantId, spaceId },
      message: inbound.text ?? "",
      locale: req.ctx.locale,
      conversationId,
      authorization: null,
      traceId: req.ctx.traceId,
    });
    const replyText = toReplyText(req.ctx.locale, out);

    // 11. 出站 DLP 扫描（统一对所有 Provider）
    const dlpPolicy = resolveDlpPolicyFromEnv(process.env);
    const dlpTarget = "channel:send";
    const dlp = redactString(replyText);
    const dlpDenied = shouldDenyDlpForTarget({ summary: dlp.summary, target: dlpTarget, policy: dlpPolicy });
    const dlpRuleIds = dlpRuleIdsFromSummary(dlp.summary);
    const egressDlpSummary = dlpDenied
      ? { ...dlp.summary, disposition: "deny" as const, redacted: true, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version, target: dlpTarget, decision: "denied" as const, ruleIds: dlpRuleIds }
      : dlp.summary.redacted
        ? { ...dlp.summary, disposition: "redact" as const, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version, target: dlpTarget, decision: "allowed" as const, ruleIds: dlpRuleIds }
        : { ...dlp.summary, mode: dlpPolicy.mode, policyVersion: dlpPolicy.version, target: dlpTarget, decision: "allowed" as const, ruleIds: dlpRuleIds };
    const safeReplyText = dlp.value;

    if (dlpDenied) {
      req.ctx.audit!.errorCategory = "policy_violation";
      const err = Errors.dlpDenied();
      const resp = {
        correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId },
        status: "denied" as const,
        errorCode: err.errorCode,
        safetySummary: { decision: "denied" as const, target: dlpTarget, ruleIds: dlpRuleIds, dlpSummary: egressDlpSummary },
      };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: plugin.provider,
        workspaceId: inbound.workspaceId,
        channelChatId: resolvedChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "denied",
        messageJson: { errorCode: err.errorCode, message: err.messageI18n },
      });
      req.ctx.audit!.outputDigest = {
        status: "denied",
        provider: plugin.provider,
        workspaceId: inbound.workspaceId,
        eventId: inbound.eventId,
        outboxId: received.id,
        safetySummary: { decision: "denied", target: dlpTarget, ruleIds: dlpRuleIds, dlpSummary: egressDlpSummary },
      };
      throw err;
    }

    // 12. async delivery mode
    if (cfg.deliveryMode === "async") {
      const queued = await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: plugin.provider,
        workspaceId: inbound.workspaceId,
        channelChatId: resolvedChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "queued",
        messageJson: { text: safeReplyText },
      });
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "queued", responseStatusCode: 202, responseJson: resp });
      req.ctx.audit!.outputDigest = {
        status: "queued",
        provider: plugin.provider,
        workspaceId: inbound.workspaceId,
        eventId: inbound.eventId,
        outboxId: queued.id,
      };
      reply.status(202);
      return resp;
    }

    // 13. sendReply 或直接返回 formatOutbound
    const correlation = { requestId: req.ctx.requestId, traceId: req.ctx.traceId };
    if (plugin.sendReply) {
      await plugin.sendReply(iCtx, safeReplyText, resolvedChatId);
    }

    const respBody = plugin.formatOutbound(req.ctx.locale, safeReplyText, correlation);
    await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: respBody });
    const sent = await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelChatId: resolvedChatId,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "succeeded",
      messageJson: respBody,
    });
    await markOutboxDelivered({ pool: app.db, tenantId, ids: [sent.id, received.id] });
    await markOutboxAcked({ pool: app.db, tenantId, ids: [sent.id, received.id] });
    req.ctx.audit!.outputDigest = {
      status: "succeeded",
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      eventId: inbound.eventId,
      outboxId: received.id,
      safetySummary: { decision: "allowed", target: dlpTarget, ruleIds: dlpRuleIds, dlpSummary: egressDlpSummary },
      egress: { target: dlpTarget, redacted: Boolean(egressDlpSummary.redacted) },
    };
    return respBody;
  } catch (e: any) {
    const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "failed" as const };
    await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp }).catch(() => {});
    await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: plugin.provider,
      workspaceId: inbound.workspaceId,
      channelChatId: resolvedChatId,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "failed",
      messageJson: resp,
    }).catch(() => {});
    throw e;
  }
}
