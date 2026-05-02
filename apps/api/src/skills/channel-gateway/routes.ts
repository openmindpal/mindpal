import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:channelGateway" });
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission } from "../../modules/auth/guard";
import { orchestrateChatTurn } from "../orchestrator/modules/orchestrator";
import { channelConversationId } from "./modules/conversationId";
import { sha256Hex, stableStringify } from "../../lib/digest";
import { listChannelProviderMetas, getChannelProviderPluginOrNull, getChannelProviderPlugin } from "./modules/providerAdapters";
// 副作用导入：注册各 Provider 插件到 registry
import "./modules/providerFeishu";
import "./modules/providerSlack";
import "./modules/providerDiscord";
import "./modules/providerBridge";
import "./modules/providerWechat";
import { testFeishuConfig } from "./modules/providerFeishu";
import { handleBridgeEvents } from "./modules/providerBridge";
import { resolveChannelSecretPayload } from "./modules/channelSecret";
import { channelWsIngressPipeline, channelIngressPipeline } from "./modules/channelPipeline";
import { computeBridgeBodyDigest, verifyBridgeSignature } from "./modules/bridgeContract";
import {
  finalizeIngressEvent,
  getChannelAccount,
  getChannelChatBinding,
  getIngressEvent,
  getIngressEventById,
  getWebhookConfig,
  listWebhookConfigs,
  getLatestOutboxByRequestId,
  insertIngressEvent,
  insertOutboxMessage,
  listIngressEventsByStatus,
  listOutboxMessages,
  listUndeliveredOutboxMessages,
  markIngressQueued,
  markOutboxAcked,
  markOutboxDelivered,
  markOutboxCanceled,
  markOutboxQueued,
  upsertChannelAccount,
  upsertChannelChatBinding,
  upsertWebhookConfig,
  revokeChannelAccount,
  revokeChannelChatBinding,
} from "./modules/channelRepo";
import {
  updateWebhookConfigEnabled,
  updateWebhookConfigAdmissionPolicy,
  deleteWebhookConfig,
} from "./modules/channelRepo";
import {
  createBindingState,
  consumeBindingState,
  getBindingStateByState,
  listBindingStates,
  newBindingStateValue,
} from "./modules/channelBindingRepo";
import {
  buildChannelBindingAuthorizeUrl,
  exchangeCodeForChannelUser,
  resolveBindingCredentials,
} from "./modules/channelBindingOAuth";

/** 活跃的长连接 stop 函数注册表 */
const activeLongConnections = new Map<string, () => void>();

function hmacHex(secret: string, input: string) {
  return crypto.createHmac("sha256", secret).update(input, "utf8").digest("hex");
}

/** IM 渠道附件 schema（兼容不同渠道适配器的字段名） */
const channelAttachmentSchema = z.array(z.object({
  type: z.enum(["image", "document", "voice", "video"]).default("image"),
  mimeType: z.string().min(1).max(200).optional(),
  name: z.string().max(500).optional(),
  url: z.string().max(20_000_000).optional(),
  dataUrl: z.string().max(20_000_000).optional(),
  textContent: z.string().max(500_000).optional(),
})).max(10).optional();

/** 将渠道消息中的附件转为 orchestrateChatTurn 期望的格式 */
function parseChannelAttachments(
  body: { attachments?: unknown; files?: unknown; images?: unknown },
): Array<{ type: string; mimeType: string; name?: string; dataUrl: string }> {
  const raw = body.attachments ?? body.files ?? body.images;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw
    .filter((a: any) => a && typeof a === "object")
    .map((a: any) => ({
      type: String(a.type ?? "image"),
      mimeType: String(a.mimeType ?? a.mime_type ?? "application/octet-stream"),
      ...(a.name ? { name: String(a.name) } : {}),
      dataUrl: String(a.dataUrl ?? a.data_url ?? a.url ?? ""),
    }))
    .filter((a) => a.dataUrl);
}

export const channelRoutes: FastifyPluginAsync = async (app) => {
  app.post("/channels/feishu/events", async (req, reply) => {
    const plugin = getChannelProviderPlugin("feishu");
    return channelIngressPipeline({ app, req, reply }, plugin);
  });

  app.register(async (sub) => {
    sub.addContentTypeParser("application/json", { parseAs: "string" }, async (_req: any, body: any) => body);

    sub.post("/channels/slack/events", async (req, reply) => {
      const plugin = getChannelProviderPlugin("slack");
      return channelIngressPipeline({ app, req, reply }, plugin);
    });

    sub.post("/channels/discord/interactions", async (req, reply) => {
      const plugin = getChannelProviderPlugin("discord");
      return channelIngressPipeline({ app, req, reply }, plugin);
    });
  });

  app.post("/channels/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply });
  });

  app.post("/channels/qq/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "qq.onebot" });
  });

  app.post("/channels/imessage/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "imessage.bridge" });
  });

  app.post("/channels/outbox/receipts", async (req) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        eventId: z.string().min(1),
        timestampMs: z.number().int().positive(),
        nonce: z.string().min(1),
        receiptType: z.enum(["delivered", "acked"]),
        outboxIds: z.array(z.string().uuid()).min(1).max(200),
        at: z.string().optional(),
        externalMessageRef: z.string().optional(),
        digest: z.any().optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "channel", action: "outbox.receipt" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const cfg = await getWebhookConfig({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId });
    if (!cfg) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }

    const nowMs = Date.now();
    if (Math.abs(nowMs - body.timestampMs) > cfg.toleranceSec * 1000) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
    const webhookSecret =
      (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") ||
      (typeof (secretPayload as any).webhookSecret === "string" ? String((secretPayload as any).webhookSecret) : "");
    if (!webhookSecret) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }

    const signature = String((req.headers["x-bridge-signature"] as string | undefined) ?? "");
    const nonceHeader = String((req.headers["x-bridge-nonce"] as string | undefined) ?? "");
    const tsHeader = Number((req.headers["x-bridge-timestamp"] as string | undefined) ?? "");
    if (!nonceHeader || !Number.isFinite(tsHeader)) throw Errors.badRequest("bridge headers 缺失");
    if (nonceHeader !== body.nonce || tsHeader !== body.timestampMs) throw Errors.badRequest("bridge headers/body 不一致");

    const bodyDigest = computeBridgeBodyDigest(body);
    verifyBridgeSignature({ secret: webhookSecret, timestampMs: body.timestampMs, nonce: body.nonce, eventId: body.eventId, bodyDigest, signature });

    const ids = body.outboxIds;

    // 验证 outboxIds 存在且属于该 tenant+provider+workspace
    const existingRows = await app.db.query(
      `SELECT id FROM channel_outbox_messages
       WHERE tenant_id = $1 AND provider = $2 AND workspace_id = $3 AND id = ANY($4::uuid[])`,
      [tenantId, body.provider, body.workspaceId, ids]
    );
    const validIdSet = new Set((existingRows.rows as any[]).map((r: any) => String(r.id)));
    const invalidIds = ids.filter((id: string) => !validIdSet.has(id));
    if (invalidIds.length > 0) {
      throw Errors.badRequest(`outboxIds not found or not owned: ${invalidIds.join(",")}`);
    }

    if (body.receiptType === "delivered") {
      const updated = await markOutboxDelivered({ pool: app.db, tenantId, ids });
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, receiptType: body.receiptType, updatedCount: updated.length };
      return { updatedCount: updated.length };
    }
    const updated = await markOutboxAcked({ pool: app.db, tenantId, ids });
    req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, receiptType: body.receiptType, updatedCount: updated.length };
    return { updatedCount: updated.length };
  });

  app.post("/channels/dingtalk/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "dingtalk" });
  });

  app.post("/channels/wecom/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "wecom" });
  });

  app.post("/channels/slack/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "slack" });
  });

  app.post("/channels/discord/bridge/events", async (req, reply) => {
    return handleBridgeEvents({ app, req, reply }, { expectedProvider: "discord" });
  });

  app.post("/channels/webhook/ingress", async (req, reply) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        eventId: z.string().min(1),
        timestamp: z.union([z.number().int().positive(), z.string().min(1)]),
        nonce: z.string().min(1),
        channelUserId: z.string().min(1).optional(),
        channelChatId: z.string().min(1).optional(),
        text: z.string().max(20000).optional(),
        attachments: channelAttachmentSchema,
        files: channelAttachmentSchema,
        images: channelAttachmentSchema,
        payload: z.any().optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "channel", action: "webhook.ingress" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const timestampSec =
      typeof body.timestamp === "number"
        ? Math.floor(body.timestamp / 1000)
        : Math.floor(Date.parse(body.timestamp) / 1000);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

    const bodyForDigest = {
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      timestamp: timestampSec,
      nonce: body.nonce,
      channelUserId: body.channelUserId ?? null,
      channelChatId: body.channelChatId ?? null,
      text: body.text ?? null,
      payload: body.payload ?? null,
    };
    const bodyDigest = sha256Hex(stableStringify(bodyForDigest));

    const cfg = await getWebhookConfig({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId });
    if (!cfg) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    if (Math.abs(nowSec - timestampSec) > cfg.toleranceSec) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }
    const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
    const envSecret = cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "";
    const secret = envSecret || (typeof (secretPayload as any).webhookSecret === "string" ? String((secretPayload as any).webhookSecret) : "");
    if (!secret) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    const signature = (req.headers["x-signature"] as string | undefined) ?? "";
    const signingInput = `${timestampSec}.${body.nonce}.${body.eventId}.${bodyDigest}`;
    const expected = hmacHex(secret, signingInput);
    if (!signature || signature !== expected) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelSignatureInvalid();
    }

    const inserted = await insertIngressEvent({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      nonce: body.nonce,
      bodyDigest,
      bodyJson: bodyForDigest,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "received",
    });

    if (!inserted) {
      const prior = await getIngressEvent({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId });
      if (prior?.responseStatusCode && prior.responseJson) {
        req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId: body.eventId };
        reply.status(prior.responseStatusCode);
        return prior.responseJson;
      }
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    let subjectId: string | null = null;
    let spaceId: string | null = null;
    if (body.channelUserId) {
      const acc = await getChannelAccount({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelUserId: body.channelUserId });
      if (acc && acc.status === "active") {
        subjectId = acc.subjectId;
        spaceId = acc.spaceId ?? null;
      }
    }
    if (!subjectId && body.channelChatId) {
      const binding = await getChannelChatBinding({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelChatId: body.channelChatId });
      if (binding && binding.status === "active") {
        subjectId = binding.defaultSubjectId ?? null;
        spaceId = binding.spaceId;
      }
    }
    if (!subjectId || !spaceId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      const err = Errors.channelMappingMissing();
      await finalizeIngressEvent({
        pool: app.db,
        id: inserted.id,
        status: "denied",
        responseStatusCode: 403,
        responseJson: { errorCode: err.errorCode, message: err.messageI18n },
      });
      throw Errors.channelMappingMissing();
    }

    req.ctx.subject = { subjectId, tenantId, spaceId };
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    if (cfg.deliveryMode === "async") {
      const channelChatId = (body.channelChatId ?? body.channelUserId ?? "").trim();
      if (!channelChatId) {
        req.ctx.audit!.errorCategory = "policy_violation";
        const err = Errors.badRequest("缺少 channelChatId");
        await finalizeIngressEvent({
          pool: app.db,
          id: inserted.id,
          status: "denied",
          responseStatusCode: 400,
          responseJson: { errorCode: err.errorCode, message: err.messageI18n },
        });
        reply.status(400);
        return { errorCode: err.errorCode, message: err.messageI18n, traceId: req.ctx.traceId };
      }
      await app.db.query("UPDATE channel_ingress_events SET space_id = $2 WHERE id = $1", [inserted.id, spaceId]);
      const received = await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "processing",
        messageJson: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" },
      });
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "queued", responseStatusCode: 202, responseJson: resp });
      req.ctx.audit!.outputDigest = { status: "queued", provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId, outboxId: received.id };
      reply.status(202);
      return resp;
    }

    try {
      await app.db.query("UPDATE channel_ingress_events SET space_id = $2 WHERE id = $1", [inserted.id, spaceId]);
      const convChatId = (body.channelChatId ?? body.channelUserId ?? "").trim() || null;
      const conversationId = convChatId ? channelConversationId({ provider: body.provider, workspaceId: body.workspaceId, channelChatId: convChatId, threadId: null }) : null;
      const channelAttachments = parseChannelAttachments(body);
      const out = await orchestrateChatTurn({
        app,
        pool: app.db,
        subject: req.ctx.subject!,
        message: body.text ?? "",
        locale: req.ctx.locale,
        conversationId,
        authorization: (req.headers.authorization as string | undefined) ?? null,
        traceId: req.ctx.traceId,
        ...(channelAttachments.length > 0 ? { attachments: channelAttachments } : {}),
      });
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "succeeded", result: out };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
      req.ctx.audit!.outputDigest = { status: "succeeded", provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId };
      return resp;
    } catch (e: any) {
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "failed" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
      throw e;
    }
  });

  // [高级] 手动配置入口 — 仅供高级用户/调试使用（新流程由 setup/callback 自动创建）
  app.post("/governance/channels/webhook/configs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        spaceId: z.string().min(1).optional(),
        secretEnvKey: z.string().min(1).optional(),
        secretId: z.string().uuid().optional(),
        providerConfig: z.record(z.string(), z.any()).optional(),
        toleranceSec: z.number().int().positive().max(3600).optional(),
        deliveryMode: z.enum(["sync", "async"]).optional(),
        maxAttempts: z.number().int().min(1).max(50).optional(),
        backoffMsBase: z.number().int().min(0).max(60_000).optional(),
      })
      .parse(req.body);
    if (!body.secretEnvKey && !body.secretId) throw Errors.badRequest("secretEnvKey 或 secretId 必填其一");
    const cfg = await upsertWebhookConfig({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      spaceId: body.spaceId ?? null,
      secretEnvKey: body.secretEnvKey ?? null,
      secretId: body.secretId ?? null,
      providerConfig: body.providerConfig ?? null,
      toleranceSec: body.toleranceSec,
      deliveryMode: body.deliveryMode,
      maxAttempts: body.maxAttempts,
      backoffMsBase: body.backoffMsBase,
    });
    req.ctx.audit!.outputDigest = { provider: cfg.provider, workspaceId: cfg.workspaceId };
    return { config: cfg };
  });

  app.get("/governance/channels/webhook/configs", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        provider: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const configs = await listWebhookConfigs({ pool: app.db, tenantId: subject.tenantId, provider: q.provider, workspaceId: q.workspaceId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: configs.length };
    return { configs };
  });

  // [高级] 手动配置入口 — 仅供高级用户/调试使用（setup 流程自带验证，此路由用于独立测试飞书配置）
  app.post("/governance/channels/providers/feishu/test", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.read" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({ workspaceId: z.string().min(1) }).parse(req.body);
    const cfg = await getWebhookConfig({ pool: app.db, tenantId: subject.tenantId, provider: "feishu", workspaceId: body.workspaceId });
    if (!cfg) throw Errors.channelConfigMissing();
    const result = await testFeishuConfig({ app, tenantId: subject.tenantId, cfg });
    req.ctx.audit!.outputDigest = { provider: "feishu", workspaceId: body.workspaceId, ok: true };
    return { result };
  });

  // [高级] 手动配置入口 — 仅供高级用户/调试使用（setup 流程自带验证，此路由用于独立测试任意 provider 配置）
  app.post("/governance/channels/providers/test", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.webhook_config.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.read" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({ provider: z.string().min(1), workspaceId: z.string().min(1) }).parse(req.body);
    const cfg = await getWebhookConfig({ pool: app.db, tenantId: subject.tenantId, provider: body.provider, workspaceId: body.workspaceId });
    if (!cfg) throw Errors.channelConfigMissing();

    if (body.provider === "feishu") {
      const result = await testFeishuConfig({ app, tenantId: subject.tenantId, cfg });
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result };
    }

    const secretPayload = cfg.secretId ? await resolveChannelSecretPayload({ app, tenantId: subject.tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId }) : {};
    const envSecret = cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "";
    const webhookSecret = envSecret || (typeof (secretPayload as any).webhookSecret === "string" ? String((secretPayload as any).webhookSecret) : "");
    const slackSigningSecret = typeof (secretPayload as any).slackSigningSecret === "string" ? String((secretPayload as any).slackSigningSecret) : "";
    const discordPublicKey = typeof (secretPayload as any).discordPublicKey === "string" ? String((secretPayload as any).discordPublicKey) : "";

    const bridgeBaseUrl = typeof (secretPayload as any).bridgeBaseUrl === "string" ? String((secretPayload as any).bridgeBaseUrl) : "";
    const webhookUrl = typeof (secretPayload as any).webhookUrl === "string" ? String((secretPayload as any).webhookUrl) : "";
    const slackBotToken = typeof (secretPayload as any).slackBotToken === "string" ? String((secretPayload as any).slackBotToken) : "";

    if (body.provider === "qq.onebot" || body.provider === "imessage.bridge") {
      if (!webhookSecret || !bridgeBaseUrl) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "bridge", hasBridgeBaseUrl: true, hasWebhookSecret: true } };
    }
    if (body.provider === "slack") {
      if (!slackBotToken || (!slackSigningSecret && !webhookSecret)) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "slack_api", hasSlackSigningSecret: !!slackSigningSecret, hasWebhookSecret: !!webhookSecret, hasSlackBotToken: true } };
    }
    if (body.provider === "dingtalk" || body.provider === "wecom") {
      if (!webhookSecret || !webhookUrl) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "webhook", hasWebhookSecret: true, hasWebhookUrl: true } };
    }
    if (body.provider === "discord") {
      if (!discordPublicKey && (!webhookSecret || !webhookUrl)) throw Errors.channelConfigMissing();
      req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
      return { result: { ok: true, mode: "discord", hasDiscordPublicKey: !!discordPublicKey, hasWebhookSecret: !!webhookSecret, hasWebhookUrl: !!webhookUrl } };
    }
    req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, ok: true };
    return { result: { ok: true, mode: "unknown", hasWebhookSecret: !!webhookSecret } };
  });

  app.get("/governance/channels/ingress-events", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.ingress.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.ingress.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        status: z.enum(["failed", "deadletter", "queued"]).optional(),
        provider: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const status = q.status ?? "deadletter";
    const events = await listIngressEventsByStatus({ pool: app.db, tenantId: subject.tenantId, status, provider: q.provider, workspaceId: q.workspaceId, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { status, count: events.length };
    return { events };
  });

  app.post("/governance/channels/ingress-events/:id/retry", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "channel.ingress.retry" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.ingress.retry" });
    req.ctx.audit!.policyDecision = decision;

    const existing = await getIngressEventById({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!existing) throw Errors.badRequest("IngressEvent 不存在");
    const updated = await markIngressQueued({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!updated) throw Errors.badRequest("IngressEvent 不存在");
    req.ctx.audit!.outputDigest = { id: updated.id, status: updated.status };
    return { event: updated };
  });

  app.get("/governance/channels/outbox", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.outbox.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.outbox.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        status: z.string().min(1).optional(),
        provider: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        channelChatId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const rows = await listOutboxMessages({
      pool: app.db,
      tenantId: subject.tenantId,
      status: q.status ?? null,
      provider: q.provider ?? null,
      workspaceId: q.workspaceId ?? null,
      channelChatId: q.channelChatId ?? null,
      limit: q.limit ?? 50,
    });
    req.ctx.audit!.outputDigest = { count: rows.length, status: q.status ?? null };
    return { messages: rows };
  });

  app.get("/governance/channels/outbox/dlq", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.outbox.read" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.outbox.read" });
    req.ctx.audit!.policyDecision = decision;

    const q = z
      .object({
        provider: z.string().min(1).optional(),
        workspaceId: z.string().min(1).optional(),
        channelChatId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(req.query);
    const rows = await listOutboxMessages({
      pool: app.db,
      tenantId: subject.tenantId,
      status: "deadletter",
      provider: q.provider ?? null,
      workspaceId: q.workspaceId ?? null,
      channelChatId: q.channelChatId ?? null,
      limit: q.limit ?? 50,
    });
    req.ctx.audit!.outputDigest = { count: rows.length, status: "deadletter" };
    return { messages: rows };
  });

  app.post("/governance/channels/outbox/:id/retry", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "channel.outbox.retry" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.outbox.retry" });
    req.ctx.audit!.policyDecision = decision;
    const updated = await markOutboxQueued({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!updated) throw Errors.badRequest("OutboxMessage 不存在");
    req.ctx.audit!.outputDigest = { id: updated.id, status: updated.status };
    return { message: updated };
  });

  app.post("/governance/channels/outbox/:id/cancel", async (req) => {
    const subject = req.ctx.subject!;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "governance", action: "channel.outbox.cancel" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.outbox.cancel" });
    req.ctx.audit!.policyDecision = decision;
    const updated = await markOutboxCanceled({ pool: app.db, tenantId: subject.tenantId, id: params.id });
    if (!updated) throw Errors.badRequest("OutboxMessage 不存在");
    req.ctx.audit!.outputDigest = { id: updated.id, status: updated.status };
    return { message: updated };
  });

  app.post("/governance/channels/accounts", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.mapping.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.mapping.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelUserId: z.string().min(1),
        subjectId: z.string().min(1),
        spaceId: z.string().min(1),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body);
    const acc = await upsertChannelAccount({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelUserId: body.channelUserId,
      subjectId: body.subjectId,
      spaceId: body.spaceId,
      status: body.status ?? "active",
    });
    req.ctx.audit!.outputDigest = { provider: acc.provider, workspaceId: acc.workspaceId, channelUserId: acc.channelUserId, subjectId: acc.subjectId };
    return { account: acc };
  });

  app.post("/governance/channels/chats", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.mapping.write" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.mapping.write" });
    req.ctx.audit!.policyDecision = decision;

    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelChatId: z.string().min(1),
        spaceId: z.string().min(1),
        defaultSubjectId: z.string().min(1).optional(),
        status: z.enum(["active", "disabled"]).optional(),
      })
      .parse(req.body);
    const binding = await upsertChannelChatBinding({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
      spaceId: body.spaceId,
      defaultSubjectId: body.defaultSubjectId ?? null,
      status: body.status ?? "active",
    });
    req.ctx.audit!.outputDigest = { provider: binding.provider, workspaceId: binding.workspaceId, channelChatId: binding.channelChatId, spaceId: binding.spaceId };
    return { chat: binding };
  });

  app.post("/channels/im/mock/ingress", async (req, reply) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        eventId: z.string().min(1),
        timestamp: z.union([z.number().int().positive(), z.string().min(1)]),
        channelUserId: z.string().min(1).optional(),
        channelChatId: z.string().min(1).optional(),
        type: z.enum(["message", "command", "callback"]),
        text: z.string().max(20000).optional(),
        attachments: channelAttachmentSchema,
        files: channelAttachmentSchema,
        images: channelAttachmentSchema,
        command: z.object({ name: z.string().min(1), args: z.record(z.string(), z.any()).optional() }).optional(),
        callback: z.object({ actionId: z.string().min(1), value: z.any().optional(), messageRef: z.string().min(1).optional() }).optional(),
      })
      .parse(req.body);

    setAuditContext(req, { resourceType: "channel", action: "im.ingress" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const timestampSec =
      typeof body.timestamp === "number"
        ? Math.floor(body.timestamp / 1000)
        : Math.floor(Date.parse(body.timestamp) / 1000);
    if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

    const payloadForDigest = {
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      timestamp: timestampSec,
      channelUserId: body.channelUserId ?? null,
      channelChatId: body.channelChatId ?? null,
      type: body.type,
      text: body.text ?? null,
      command: body.command ?? null,
      callback: body.callback ?? null,
    };
    const bodyDigest = sha256Hex(stableStringify(payloadForDigest));

    const inserted = await insertIngressEvent({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      eventId: body.eventId,
      nonce: body.eventId,
      bodyDigest,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "received",
    });

    if (!inserted) {
      const prior = await getIngressEvent({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, eventId: body.eventId });
      if (prior?.responseStatusCode && prior.responseJson) {
        req.ctx.audit!.outputDigest = { deduped: true, status: prior.status, eventId: body.eventId };
        reply.status(prior.responseStatusCode);
        return prior.responseJson;
      }
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    let subjectId: string | null = null;
    let spaceId: string | null = null;
    let channelChatId = body.channelChatId ?? null;

    if (body.channelUserId) {
      const acc = await getChannelAccount({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelUserId: body.channelUserId });
      if (acc && acc.status === "active") {
        subjectId = acc.subjectId;
        spaceId = acc.spaceId ?? null;
      }
    }
    if (!subjectId && body.channelChatId) {
      const binding = await getChannelChatBinding({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId, channelChatId: body.channelChatId });
      if (binding && binding.status === "active") {
        subjectId = binding.defaultSubjectId ?? null;
        spaceId = binding.spaceId;
        channelChatId = binding.channelChatId;
      }
    }

    if (!subjectId || !spaceId || !channelChatId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      const err = Errors.channelMappingMissing();
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "denied", errorCode: err.errorCode };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "denied", responseStatusCode: 403, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId: channelChatId ?? "unknown",
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "denied",
        messageJson: { errorCode: err.errorCode, message: err.messageI18n },
      });
      throw err;
    }

    req.ctx.subject = { subjectId, tenantId, spaceId };
    const decision = await requirePermission({ req, resourceType: "orchestrator", action: "turn" });
    req.ctx.audit!.policyDecision = decision;

    const received = await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId,
      requestId: req.ctx.requestId,
      traceId: req.ctx.traceId,
      status: "processing",
      messageJson: { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "processing" },
    });

    const inputText =
      body.type === "message"
        ? body.text ?? ""
        : body.type === "command"
          ? `/${body.command?.name ?? "command"} ${stableStringify(body.command?.args ?? {})}`
          : `callback:${body.callback?.actionId ?? ""} ${stableStringify(body.callback?.value ?? null)}`;

    try {
      const mockAttachments = parseChannelAttachments(body);
      const out = await orchestrateChatTurn({
        app,
        pool: app.db,
        subject: req.ctx.subject!,
        message: inputText,
        locale: req.ctx.locale,
        authorization: (req.headers.authorization as string | undefined) ?? null,
        traceId: req.ctx.traceId,
        ...(mockAttachments.length > 0 ? { attachments: mockAttachments } : {}),
      });
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "succeeded", result: out };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "succeeded", responseStatusCode: 200, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "succeeded",
        messageJson: resp,
      });
      req.ctx.audit!.outputDigest = { status: "succeeded", outboxId: received.id, eventId: body.eventId };
      return resp;
    } catch (e: any) {
      const resp = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId }, status: "failed" as const };
      await finalizeIngressEvent({ pool: app.db, id: inserted.id, status: "failed", responseStatusCode: 500, responseJson: resp });
      await insertOutboxMessage({
        pool: app.db,
        tenantId,
        provider: body.provider,
        workspaceId: body.workspaceId,
        channelChatId,
        requestId: req.ctx.requestId,
        traceId: req.ctx.traceId,
        status: "failed",
        messageJson: resp,
      });
      throw e;
    }
  });

  app.post("/channels/im/mock/outbox/poll", async (req) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelChatId: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "im.outbox.poll" });

    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const msgs = await listUndeliveredOutboxMessages({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
      limit: body.limit ?? 20,
    });
    await markOutboxDelivered({ pool: app.db, tenantId, ids: msgs.map((m) => m.id) });
    req.ctx.audit!.outputDigest = { count: msgs.length };
    return { messages: msgs };
  });

  app.post("/channels/im/mock/outbox/ack", async (req) => {
    const body = z.object({ ids: z.array(z.string().uuid()).max(100) }).parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "im.outbox.ack" });
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const rows = await markOutboxAcked({ pool: app.db, tenantId, ids: body.ids });
    req.ctx.audit!.outputDigest = { count: rows.length };
    return { acked: rows.map((r) => r.id) };
  });

  app.post("/channels/im/mock/cancel", async (req) => {
    const body = z
      .object({
        provider: z.string().min(1),
        workspaceId: z.string().min(1),
        channelChatId: z.string().min(1),
        requestId: z.string().uuid(),
      })
      .parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "im.cancel" });
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const prior = await getLatestOutboxByRequestId({ pool: app.db, tenantId, requestId: body.requestId });
    if (!prior) throw Errors.badRequest("correlation 不存在");
    const resp = { correlation: { requestId: body.requestId }, status: "canceled" as const };
    await insertOutboxMessage({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
      requestId: body.requestId,
      traceId: prior.traceId,
      status: "canceled",
      messageJson: resp,
    });
    req.ctx.audit!.outputDigest = { requestId: body.requestId };
    return resp;
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 渠道 Setup（扫码自动配置）
  // ═══════════════════════════════════════════════════════════════════════════

  /** GET /channels/providers — 返回所有 Provider 元数据 */
  app.get("/channels/providers", async (req) => {
    setAuditContext(req, { resourceType: "channel", action: "providers.list" });

    const decision = await requirePermission({
      req,
      resourceType: "governance",
      action: "channel.webhook_config.read",
    });
    req.ctx.audit!.policyDecision = decision;
    const tenantId = req.ctx.subject!.tenantId;

    const metas = listChannelProviderMetas();
    const configs = await listWebhookConfigs({ pool: app.db, tenantId, limit: 200 });
    const configMap: Record<string, any> = {};
    for (const c of configs) {
      configMap[c.provider] = c;
    }
    return {
      providers: metas.map(m => ({
        ...m,
        status: configMap[m.provider]
          ? (configMap[m.provider].enabled ? "connected" : "disabled")
          : "unconfigured",
        workspaceId: configMap[m.provider]?.workspaceId ?? null,
        admissionPolicy: configMap[m.provider]?.admissionPolicy ?? "open",
        customName: configMap[m.provider]?.displayName ?? null,
      })),
    };
  });

  /** POST /channels/setup/:provider/init — 生成扫码二维码 */
  app.post("/channels/setup/:provider/init", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const body = z.object({
      spaceId: z.string().min(1).optional(),
    }).parse(req.body ?? {});

    setAuditContext(req, { resourceType: "channel", action: "setup.init" });

    const decision = await requirePermission({
      req,
      resourceType: "governance",
      action: "channel.webhook_config.write",
    });
    req.ctx.audit!.policyDecision = decision;

    const plugin = getChannelProviderPluginOrNull(params.provider);
    if (!plugin || !plugin.buildSetupAuthorizeUrl) {
      throw Errors.badRequest(`Provider "${params.provider}" 不支持扫码配置`);
    }

    const subject = req.ctx.subject!;
    const tenantId = subject.tenantId;

    const state = newBindingStateValue();
    const created = await createBindingState({
      pool: app.db,
      tenantId,
      provider: params.provider,
      workspaceId: "__setup__",
      spaceId: body.spaceId ?? "default",
      targetSubjectId: null,
      state,
      label: `setup:${params.provider}`,
      ttlSeconds: 600,
    });

    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    if (!host) throw Errors.badRequest("缺少 host");
    const redirectUri = `${proto}://${host}/v1/channels/setup/${encodeURIComponent(params.provider)}/callback`;

    const authorizeUrl = plugin.buildSetupAuthorizeUrl({ redirectUri, state });

    req.ctx.audit!.outputDigest = {
      provider: params.provider,
      setupId: created.row.id,
      expiresAt: created.row.expiresAt,
    };

    return {
      setupId: created.row.id,
      authorizeUrl,
      expiresAt: created.row.expiresAt,
      provider: params.provider,
    };
  });

  /** GET /channels/setup/:provider/callback — 平台扫码回调 */
  app.get("/channels/setup/:provider/callback", async (req, reply) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(req.query);
    setAuditContext(req, { resourceType: "channel", action: "setup.callback" });

    // 1. 验证 state
    const bindingState = await getBindingStateByState({ pool: app.db, state: q.state });
    if (!bindingState) {
      return reply.status(400).type("text/html; charset=utf-8").send(htmlResult("配置失败", "授权链接无效或已过期，请重新扫码。"));
    }
    if (bindingState.provider !== params.provider) {
      return reply.status(400).type("text/html; charset=utf-8").send(htmlResult("配置失败", "授权链接与渠道不匹配。"));
    }
    if (bindingState.status !== "pending") {
      return reply.status(400).type("text/html; charset=utf-8").send(htmlResult("配置失败", "该授权链接已被使用，请重新扫码。"));
    }
    const expiresMs = Date.parse(bindingState.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) {
      return reply.status(400).type("text/html; charset=utf-8").send(htmlResult("配置失败", "授权链接已过期，请重新扫码。"));
    }

    const plugin = getChannelProviderPluginOrNull(params.provider);
    if (!plugin || !plugin.handleSetupCallback) {
      return reply.status(400).type("text/html; charset=utf-8").send(htmlResult("配置失败", `Provider "${params.provider}" 不支持自动配置。`));
    }

    // 2. 调用 plugin 处理回调
    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    const redirectUri = `${proto}://${host}/v1/channels/setup/${encodeURIComponent(params.provider)}/callback`;

    let setupResult;
    try {
      setupResult = await plugin.handleSetupCallback({ code: q.code, redirectUri, state: q.state });
    } catch (e: any) {
      _logger.error("setup callback failed", { provider: params.provider, error: e?.message ?? e });
      return reply.status(500).type("text/html; charset=utf-8").send(htmlResult("配置失败", `获取授权信息失败：${e?.message ?? "未知错误"}`));
    }

    const tenantId = bindingState.tenantId;

    // 3. 自动创建加密 secret
    let secretId: string | null = null;
    if (Object.keys(setupResult.credentials).length > 0) {
      try {
        const { createSecretRecord } = await import("../../modules/secrets/secretRepo");
        const { encryptSecretEnvelope } = await import("../../modules/secrets/envelope");
        const encResult = await encryptSecretEnvelope({
          pool: app.db,
          tenantId,
          masterKey: app.cfg.secrets.masterKey,
          scopeType: "tenant",
          scopeId: tenantId,
          payload: setupResult.credentials,
        });
        const secretRecord = await createSecretRecord({
          pool: app.db,
          tenantId,
          scopeType: "tenant",
          scopeId: tenantId,
          connectorInstanceId: crypto.randomUUID(),
          keyVersion: encResult.keyVersion,
          encFormat: encResult.encFormat,
          encryptedPayload: encResult.encryptedPayload,
        });
        secretId = secretRecord.id;
      } catch (e: any) {
        _logger.error("auto-create secret failed, falling back", { provider: params.provider, error: e?.message ?? e });
      }
    }

    // 4. 自动写入 webhook_config
    await upsertWebhookConfig({
      pool: app.db,
      tenantId,
      provider: params.provider,
      workspaceId: setupResult.workspaceId,
      spaceId: bindingState.spaceId !== "default" ? bindingState.spaceId : null,
      secretEnvKey: null,
      secretId: secretId,
      providerConfig: null,
      enabled: true,
      autoProvisioned: true,
      admissionPolicy: "open",
      displayName: setupResult.displayName ?? null,
      setupState: setupResult.webhookRegistered ? { webhookRegistered: true } : null,
    });

    // 5. 自动注册 Webhook（如果 plugin 支持）
    if (plugin.registerWebhook) {
      try {
        const callbackUrl = `${proto}://${host}/channels/${encodeURIComponent(params.provider)}/events`;
        const webhookResult = await plugin.registerWebhook({ credentials: setupResult.credentials, callbackUrl });
        if (webhookResult.ok) {
          _logger.info("webhook auto-registered", { provider: params.provider, registrationId: webhookResult.registrationId });
        }
      } catch (e: any) {
        _logger.error("webhook auto-registration failed", { provider: params.provider, error: e?.message ?? e });
      }
    }

    // 6. 尝试启动长连接（非阻塞，与 Webhook 模式并存）
    if (plugin.startLongConnection && setupResult.credentials) {
      const connKey = `${params.provider}:${setupResult.workspaceId}`;
      // 先关闭旧连接
      const prev = activeLongConnections.get(connKey);
      if (prev) { try { prev(); } catch { /* ignore */ } activeLongConnections.delete(connKey); }

      plugin.startLongConnection({
        credentials: setupResult.credentials,
        onEvent: async (parsed) => {
          _logger.info("long connection event received", { provider: params.provider, eventId: parsed.eventId });
          await channelWsIngressPipeline({ app, tenantId, plugin, parsed });
        },
      }).then(({ stop }) => {
        activeLongConnections.set(connKey, stop);
        _logger.info("long connection started", { provider: params.provider, workspaceId: setupResult.workspaceId });
      }).catch((err: any) => {
        _logger.error("long connection start failed (non-blocking)", { provider: params.provider, error: err?.message });
      });
    }

    // 7. 消费 state
    await consumeBindingState({ pool: app.db, state: q.state, boundChannelUserId: `setup:${setupResult.workspaceId}` });

    req.ctx.audit!.outputDigest = {
      provider: params.provider,
      workspaceId: setupResult.workspaceId,
      autoProvisioned: true,
      secretId,
    };

    reply.header("content-type", "text/html; charset=utf-8");
    return htmlResult("配置成功", `${setupResult.displayName ?? params.provider} 渠道已成功连接！现在可以在该平台中与智能体对话了。`);
  });

  /** POST /channels/setup/:provider/toggle — 启用/禁用 */
  app.post("/channels/setup/:provider/toggle", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const body = z.object({
      workspaceId: z.string().min(1),
      enabled: z.boolean(),
    }).parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "setup.toggle" });

    const tenantId = (req as any).ctx?.subject?.tenantId ?? (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.write" });
    req.ctx.audit!.policyDecision = decision;

    const updated = await updateWebhookConfigEnabled({
      pool: app.db, tenantId, provider: params.provider, workspaceId: body.workspaceId, enabled: body.enabled,
    });
    if (!updated) throw Errors.notFound("config not found");

    req.ctx.audit!.outputDigest = { provider: params.provider, workspaceId: body.workspaceId, enabled: body.enabled };
    return { status: "ok", enabled: body.enabled };
  });

  /** POST /channels/setup/:provider/remove — 移除配置 */
  app.post("/channels/setup/:provider/remove", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const body = z.object({ workspaceId: z.string().min(1) }).parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "setup.remove" });

    const tenantId = (req as any).ctx?.subject?.tenantId ?? (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.write" });
    req.ctx.audit!.policyDecision = decision;

    const deleted = await deleteWebhookConfig({
      pool: app.db, tenantId, provider: params.provider, workspaceId: body.workspaceId,
    });
    if (!deleted) throw Errors.notFound("config not found");

    req.ctx.audit!.outputDigest = { provider: params.provider, workspaceId: body.workspaceId, removed: true };
    return { status: "removed" };
  });

  /** POST /channels/setup/:provider/admission — 切换准入策略 */
  app.post("/channels/setup/:provider/admission", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const body = z.object({
      workspaceId: z.string().min(1),
      policy: z.enum(["open", "pairing"]),
    }).parse(req.body);
    setAuditContext(req, { resourceType: "channel", action: "setup.admission" });

    const tenantId = (req as any).ctx?.subject?.tenantId ?? (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.write" });
    req.ctx.audit!.policyDecision = decision;

    const updated = await updateWebhookConfigAdmissionPolicy({
      pool: app.db, tenantId, provider: params.provider, workspaceId: body.workspaceId, admissionPolicy: body.policy,
    });
    if (!updated) throw Errors.notFound("config not found");

    req.ctx.audit!.outputDigest = { provider: params.provider, workspaceId: body.workspaceId, admissionPolicy: body.policy };
    return { status: "ok", admissionPolicy: body.policy };
  });

  /** GET /channels/setup/:provider/status — 查询单个 setup 状态（供前端轮询） */
  app.get("/channels/setup/:provider/status", async (req) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    setAuditContext(req, { resourceType: "channel", action: "setup.status" });

    const decision = await requirePermission({
      req,
      resourceType: "governance",
      action: "channel.webhook_config.read",
    });
    req.ctx.audit!.policyDecision = decision;
    const tenantId = req.ctx.subject!.tenantId;

    const configs = await listWebhookConfigs({ pool: app.db, tenantId, provider: params.provider, limit: 1 });
    const config = configs[0] ?? null;

    return {
      provider: params.provider,
      configured: !!config,
      enabled: config?.enabled ?? false,
      workspaceId: config?.workspaceId ?? null,
      admissionPolicy: config?.admissionPolicy ?? "open",
      displayName: config?.displayName ?? null,
      autoProvisioned: config?.autoProvisioned ?? false,
    };
  });

  /** POST /channels/setup/:provider/manual — 手动配置 */
  app.post("/channels/setup/:provider/manual", async (req, reply) => {
    setAuditContext(req, { resourceType: "channel", action: "setup.manual" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.webhook_config.write" });
    req.ctx.audit!.policyDecision = decision;
    const tenantId = req.ctx.subject!.tenantId;
    const provider = (req.params as any).provider;
    const body = (req.body as any) ?? {};

    // 获取 plugin
    const plugin = getChannelProviderPluginOrNull(provider);
    if (!plugin) return reply.code(400).send({ error: "unknown_provider" });

    // 校验必须是 manual mode
    if (!plugin.meta.setupModes.includes("manual")) {
      return reply.code(400).send({ error: "provider_not_manual", message: "此渠道不支持手动配置" });
    }

    // 从 manualConfigFields 校验必填字段
    const fields = plugin.meta.manualConfigFields ?? [];
    const credentials: Record<string, string> = {};
    for (const f of fields) {
      const val = String(body[f.key] ?? "").trim();
      if (f.required && !val) {
        return reply.code(400).send({ error: "missing_field", field: f.key });
      }
      if (val) credentials[f.key] = val;
    }

    // workspaceId: 手动模式使用 body.workspaceId 或生成一个默认值
    const workspaceId = String(body.workspaceId ?? "").trim() || `manual_${provider}_${Date.now()}`;

    // 创建加密 secret（复用现有逻辑，与 setup/callback 路由相同的 dynamic import 方式）
    let secretId: string | null = null;
    if (Object.keys(credentials).length > 0) {
      const { createSecretRecord } = await import("../../modules/secrets/secretRepo");
      const { encryptSecretEnvelope } = await import("../../modules/secrets/envelope");
      const encResult = await encryptSecretEnvelope({
        pool: app.db,
        tenantId,
        masterKey: app.cfg.secrets.masterKey,
        scopeType: "tenant",
        scopeId: tenantId,
        payload: credentials,
      });
      const secretRecord = await createSecretRecord({
        pool: app.db,
        tenantId,
        scopeType: "tenant",
        scopeId: tenantId,
        connectorInstanceId: crypto.randomUUID(),
        keyVersion: encResult.keyVersion,
        encFormat: encResult.encFormat,
        encryptedPayload: encResult.encryptedPayload,
      });
      secretId = secretRecord.id;
    }

    // upsert webhook config
    await upsertWebhookConfig({
      pool: app.db,
      tenantId,
      provider,
      workspaceId,
      secretId,
      enabled: true,
      autoProvisioned: false,
      admissionPolicy: "open",
      displayName: body.displayName || null,
      setupState: { manual: true, configuredAt: new Date().toISOString() },
    });

    return { ok: true, provider, workspaceId };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 渠道扫码授权绑定（Channel QR-code OAuth Binding）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * POST /governance/channels/binding/initiate
   * 管理员生成一个绑定授权链接（含 QR 码用途），用户扫码后自动完成 channel_account 映射。
   */
  app.post("/governance/channels/binding/initiate", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.binding.initiate" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.binding.initiate" });
    req.ctx.audit!.policyDecision = decision;

    const body = z.object({
      provider: z.string().min(1),
      workspaceId: z.string().min(1),
      spaceId: z.string().min(1),
      targetSubjectId: z.string().min(1).optional(),
      label: z.string().max(200).optional(),
      ttlSeconds: z.number().int().min(60).max(86400).optional(),
    }).parse(req.body);

    const tenantId = subject.tenantId;

    // 获取 webhook config 以读取凭据
    const cfg = await getWebhookConfig({ pool: app.db, tenantId, provider: body.provider, workspaceId: body.workspaceId });
    if (!cfg) throw Errors.channelConfigMissing();

    const secretPayload = cfg.secretId
      ? await resolveChannelSecretPayload({ app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId })
      : {};
    const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? (cfg.providerConfig as Record<string, unknown>) : {};
    const credentials = resolveBindingCredentials({ provider: body.provider, secretPayload, providerConfig });

    if (!credentials.appId) {
      _logger.error("provider missing appId/clientId credentials", { provider: body.provider });
      throw Errors.channelConfigMissing();
    }

    // 生成 state
    const state = newBindingStateValue();
    const created = await createBindingState({
      pool: app.db,
      tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      spaceId: body.spaceId,
      targetSubjectId: body.targetSubjectId ?? null,
      state,
      label: body.label ?? null,
      ttlSeconds: body.ttlSeconds ?? 600,
    });

    // 构建回调 URL
    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    if (!host) throw Errors.badRequest("缺少 host");
    const redirectUri = `${proto}://${host}/v1/channels/binding/callback/${encodeURIComponent(body.provider)}`;

    // 构建 IM 平台授权 URL
    const authorizeUrl = buildChannelBindingAuthorizeUrl({
      provider: body.provider,
      credentials,
      redirectUri,
      state,
    });

    req.ctx.audit!.outputDigest = {
      provider: body.provider,
      workspaceId: body.workspaceId,
      spaceId: body.spaceId,
      bindingId: created.row.id,
      expiresAt: created.row.expiresAt,
    };

    return {
      bindingId: created.row.id,
      authorizeUrl,
      expiresAt: created.row.expiresAt,
      provider: body.provider,
      workspaceId: body.workspaceId,
      spaceId: body.spaceId,
    };
  });

  /**
   * GET /channels/binding/callback/:provider
   * IM 平台 OAuth 回调端点 — code 换取用户身份 → 自动创建 channel_account 映射
   */
  app.get("/channels/binding/callback/:provider", async (req, reply) => {
    const params = z.object({ provider: z.string().min(1).max(50) }).parse(req.params);
    const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).parse(req.query);
    setAuditContext(req, { resourceType: "channel", action: "binding.callback" });

    // 1. 查找并校验 binding state
    const bindingState = await getBindingStateByState({ pool: app.db, state: q.state });
    if (!bindingState) {
      _logger.error("callback state invalid", { provider: params.provider });
      return reply.status(400).send(htmlResult("绑定失败", "授权链接无效或已过期，请重新获取绑定二维码。"));
    }
    if (bindingState.provider !== params.provider) {
      _logger.error("callback provider mismatch", { expected: bindingState.provider, actual: params.provider });
      return reply.status(400).send(htmlResult("绑定失败", "授权链接与渠道不匹配。"));
    }
    if (bindingState.status !== "pending") {
      return reply.status(400).send(htmlResult("绑定失败", "该授权链接已被使用，请重新获取。"));
    }
    const expiresMs = Date.parse(bindingState.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs < Date.now()) {
      return reply.status(400).send(htmlResult("绑定失败", "授权链接已过期，请重新获取绑定二维码。"));
    }

    // 2. 读取凭据
    const tenantId = bindingState.tenantId;
    const cfg = await getWebhookConfig({ pool: app.db, tenantId, provider: bindingState.provider, workspaceId: bindingState.workspaceId });
    if (!cfg) {
      _logger.error("callback webhookConfig not found", { provider: bindingState.provider, workspaceId: bindingState.workspaceId });
      return reply.status(500).send(htmlResult("绑定失败", "渠道配置缺失，请联系管理员。"));
    }

    const secretPayload = cfg.secretId
      ? await resolveChannelSecretPayload({ app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId })
      : {};
    const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? (cfg.providerConfig as Record<string, unknown>) : {};
    const credentials = resolveBindingCredentials({ provider: bindingState.provider, secretPayload, providerConfig });

    // 3. code → 渠道用户身份
    const xfProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
    const proto = xfProto === "https" || xfProto === "http" ? xfProto : "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]?.trim();
    const redirectUri = `${proto}://${host}/v1/channels/binding/callback/${encodeURIComponent(params.provider)}`;

    let channelUser;
    try {
      channelUser = await exchangeCodeForChannelUser({
        provider: bindingState.provider,
        code: q.code,
        credentials,
        redirectUri,
      });
    } catch (e: any) {
      _logger.error("code exchange for user identity failed", { provider: bindingState.provider, error: e?.message ?? e });
      return reply.status(500).send(htmlResult("绑定失败", `获取您的 ${bindingState.provider} 身份信息失败：${e?.message ?? "未知错误"}`));
    }

    _logger.info("channel user identity obtained", { provider: bindingState.provider, channelUserId: channelUser.channelUserId, displayName: channelUser.displayName });

    // 4. 消费 state
    const consumed = await consumeBindingState({
      pool: app.db,
      state: q.state,
      boundChannelUserId: channelUser.channelUserId,
    });
    if (!consumed) {
      return reply.status(400).send(htmlResult("绑定失败", "该授权链接已被使用或已过期。"));
    }

    // 5. 自动创建 channel_account 映射
    const targetSubjectId = bindingState.targetSubjectId || `auto_${channelUser.channelUserId}`;
    const account = await upsertChannelAccount({
      pool: app.db,
      tenantId,
      provider: bindingState.provider,
      workspaceId: bindingState.workspaceId,
      channelUserId: channelUser.channelUserId,
      subjectId: targetSubjectId,
      spaceId: bindingState.spaceId,
      status: "active",
    });

    _logger.info("channel account bound", { provider: account.provider, channelUserId: account.channelUserId, subjectId: account.subjectId, spaceId: account.spaceId });

    req.ctx.audit!.outputDigest = {
      bindingId: consumed.id,
      provider: consumed.provider,
      workspaceId: consumed.workspaceId,
      channelUserId: channelUser.channelUserId,
      subjectId: targetSubjectId,
      displayName: channelUser.displayName,
    };

    // 6. 返回友好 HTML 页面
    reply.header("content-type", "text/html; charset=utf-8");
    return htmlResult("绑定成功", `您的 ${bindingState.provider} 账号（${channelUser.displayName || channelUser.channelUserId}）已成功绑定到平台。现在可以在 ${bindingState.provider} 中直接与智能体对话了。`);
  });

  /**
   * GET /governance/channels/binding/states
   * 查询绑定状态列表
   */
  // 解绑渠道账户
  app.post("/governance/channels/accounts/revoke", async (req) => {
    const body = z.object({
      provider: z.string().min(1),
      workspaceId: z.string().min(1),
      channelUserId: z.string().min(1),
    }).parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "channel.account.revoke" });
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.account.revoke" });
    req.ctx.audit!.policyDecision = decision;

    const revoked = await revokeChannelAccount({
      pool: app.db, tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelUserId: body.channelUserId,
    });
    if (!revoked) throw Errors.notFound("active account not found");
    req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, channelUserId: body.channelUserId, status: "revoked" };
    return { status: "revoked", account: revoked };
  });

  // 解绑渠道群组
  app.post("/governance/channels/chat-bindings/revoke", async (req) => {
    const body = z.object({
      provider: z.string().min(1),
      workspaceId: z.string().min(1),
      channelChatId: z.string().min(1),
    }).parse(req.body);

    setAuditContext(req, { resourceType: "governance", action: "channel.chat_binding.revoke" });
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? "tenant_dev";
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.chat_binding.revoke" });
    req.ctx.audit!.policyDecision = decision;

    const revoked = await revokeChannelChatBinding({
      pool: app.db, tenantId,
      provider: body.provider,
      workspaceId: body.workspaceId,
      channelChatId: body.channelChatId,
    });
    if (!revoked) throw Errors.notFound("active chat binding not found");
    req.ctx.audit!.outputDigest = { provider: body.provider, workspaceId: body.workspaceId, channelChatId: body.channelChatId, status: "revoked" };
    return { status: "revoked", binding: revoked };
  });

  app.get("/governance/channels/binding/states", async (req) => {
    const subject = req.ctx.subject!;
    setAuditContext(req, { resourceType: "governance", action: "channel.binding.list" });
    const decision = await requirePermission({ req, resourceType: "governance", action: "channel.binding.list" });
    req.ctx.audit!.policyDecision = decision;

    const q = z.object({
      provider: z.string().optional(),
      workspaceId: z.string().optional(),
      status: z.enum(["pending", "consumed", "expired"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }).parse(req.query);

    const states = await listBindingStates({
      pool: app.db,
      tenantId: subject.tenantId,
      provider: q.provider,
      workspaceId: q.workspaceId,
      status: q.status,
      limit: q.limit,
    });

    return { states };
  });

  // ─── 启动恢复：自动重连所有已启用的长连接 ─────────────────────────────────────
  app.addHook("onReady", async () => {
    try {
      const tenantId = process.env.DEFAULT_TENANT_ID ?? "tenant_dev";
      const configs = await listWebhookConfigs({ pool: app.db, tenantId, limit: 200 });
      const enabledConfigs = configs.filter(c => c.enabled);
      if (enabledConfigs.length === 0) return;

      _logger.info("long connection recovery: checking configs", { total: enabledConfigs.length });

      for (const cfg of enabledConfigs) {
        const plugin = getChannelProviderPluginOrNull(cfg.provider);
        if (!plugin?.startLongConnection) continue;

        const connKey = `${cfg.provider}:${cfg.workspaceId}`;
        if (activeLongConnections.has(connKey)) continue; // already connected

        // resolve credentials from secret store
        let credentials: Record<string, string> = {};
        if (cfg.secretId) {
          try {
            const sp = await resolveChannelSecretPayload({ app, tenantId, spaceId: cfg.spaceId ?? null, secretId: cfg.secretId });
            // flatten secret payload to string Record for startLongConnection
            for (const [k, v] of Object.entries(sp)) {
              if (typeof v === "string") credentials[k] = v;
            }
          } catch (e: any) {
            _logger.error("long connection recovery: secret resolve failed", { provider: cfg.provider, workspaceId: cfg.workspaceId, error: e?.message });
            continue;
          }
        }

        if (Object.keys(credentials).length === 0) {
          _logger.debug("long connection recovery: no credentials, skipping", { provider: cfg.provider, workspaceId: cfg.workspaceId });
          continue;
        }

        // non-blocking start
        plugin.startLongConnection({
          credentials,
          onEvent: async (parsed) => {
            _logger.info("long connection event received", { provider: cfg.provider, eventId: parsed.eventId });
            await channelWsIngressPipeline({ app, tenantId, plugin, parsed });
          },
        }).then(({ stop }) => {
          activeLongConnections.set(connKey, stop);
          _logger.info("long connection recovered", { provider: cfg.provider, workspaceId: cfg.workspaceId });
        }).catch((err: any) => {
          _logger.error("long connection recovery failed (non-blocking)", { provider: cfg.provider, workspaceId: cfg.workspaceId, error: err?.message });
        });
      }
    } catch (err: any) {
      _logger.error("long connection recovery: unexpected error", { error: err?.message ?? err });
    }
  });
};

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function htmlResult(title: string, message: string) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - 灵智Mindpal</title>
<style>
  body{margin:0;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f8fafc;color:#1e293b;display:flex;justify-content:center;align-items:center;min-height:100vh}
  .card{background:#fff;border-radius:16px;padding:40px;max-width:480px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  h1{font-size:24px;margin:0 0 16px;color:${title.includes("成功") ? "#16a34a" : "#dc2626"}}
  p{font-size:15px;line-height:1.6;color:#475569;margin:0}
</style></head>
<body><div class="card"><h1>${title.includes("成功") ? "✅" : "❌"} ${title}</h1><p>${message}</p></div></body></html>`;
}
