import { z } from "zod";
import { Errors } from "../../../lib/errors";
import { pickSecret } from "./channelCommon";
import { bridgeSendWithRetry } from "./bridgeSend";
import { computeBridgeBodyDigest, verifyBridgeSignature } from "./bridgeContract";
import type { ChannelProviderPlugin, ChannelProviderMeta, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";
import { channelIngressPipeline } from "./channelPipeline";
import { DingtalkStreamClient } from "./dingtalkStream";

type BridgeMessageBody = {
  provider: string;
  workspaceId: string;
  eventId: string;
  timestampMs: number;
  nonce: string;
  type: "message";
  channelChatId: string;
  channelUserId: string;
  bridgeMessageId?: string;
  text?: string;
  attachments?: any[];
  raw?: any;
};

async function sendViaWebhook(params: { webhookUrl: string; text: string; headers?: Record<string, string> }) {
  const res = await fetch(params.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...(params.headers ?? {}) },
    body: JSON.stringify({ text: params.text, content: params.text }),
  });
  if (!res.ok) throw Errors.badRequest("webhook_send_failed");
}

async function sendViaSlack(params: { botToken: string; channel: string; text: string }) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${params.botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ channel: params.channel, text: params.text }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw Errors.badRequest("slack_send_failed");
  if (json && typeof json === "object" && (json as any).ok === false) throw Errors.badRequest("slack_send_error");
}

// ─── Provider 元数据定义 ─────────────────────────────────────────────────────

const bridgeProviderMetas: Record<string, ChannelProviderMeta> = {
  bridge: {
    provider: "bridge",
    displayName: { zh: "Bridge", en: "Bridge" },
    icon: "bridge",
    setupModes: ["manual"],
    features: { admissionPolicy: false, groupChat: true, directMessage: true, richMessage: false },
    supportsEdit: true,
    manualConfigFields: [
      { key: "bridgeBaseUrl", label: { zh: "Bridge URL", en: "Bridge URL" }, type: "text", required: true },
      { key: "webhookSecret", label: { zh: "Webhook Secret", en: "Webhook Secret" }, type: "secret", required: true },
    ],
  },
  "qq.onebot": {
    provider: "qq.onebot",
    displayName: { zh: "QQ", en: "QQ" },
    icon: "qq",
    setupModes: ["manual"],
    features: { admissionPolicy: false, groupChat: true, directMessage: true, richMessage: false },
    manualConfigFields: [
      { key: "bridgeBaseUrl", label: { zh: "Bridge URL", en: "Bridge URL" }, type: "text", required: true },
      { key: "webhookSecret", label: { zh: "Webhook Secret", en: "Webhook Secret" }, type: "secret", required: true },
    ],
  },
  "imessage.bridge": {
    provider: "imessage.bridge",
    displayName: { zh: "iMessage", en: "iMessage" },
    icon: "imessage",
    setupModes: ["manual"],
    features: { admissionPolicy: false, groupChat: false, directMessage: true, richMessage: false },
    manualConfigFields: [
      { key: "bridgeBaseUrl", label: { zh: "Bridge URL", en: "Bridge URL" }, type: "text", required: true },
      { key: "webhookSecret", label: { zh: "Webhook Secret", en: "Webhook Secret" }, type: "secret", required: true },
    ],
  },
  dingtalk: {
    provider: "dingtalk",
    displayName: { zh: "钉钉", en: "DingTalk" },
    icon: "dingtalk",
    setupModes: ["qr"],
    features: { admissionPolicy: true, groupChat: true, directMessage: true, richMessage: true },
    supportsEdit: true,
  },
  wecom: {
    provider: "wecom",
    displayName: { zh: "企业微信", en: "WeCom" },
    icon: "wecom",
    setupModes: ["qr", "manual"],
    features: { admissionPolicy: false, groupChat: true, directMessage: true, richMessage: true },
    supportsEdit: false,
    manualConfigFields: [
      { key: "botId", label: { zh: "Bot ID", en: "Bot ID" }, type: "text", required: true },
      { key: "botSecret", label: { zh: "Secret", en: "Secret" }, type: "secret", required: true },
    ],
  },
};

function makeBridgePlugin(provider: string, overrides?: Partial<ChannelProviderPlugin>): ChannelProviderPlugin {
  return {
    provider,
    meta: bridgeProviderMetas[provider] ?? bridgeProviderMetas.bridge,
    ...overrides,

    extractWorkspaceId(req) {
      const body = (req as any).body ?? {};
      return String(body?.workspaceId ?? "").trim();
    },

    async verifySignature(ctx, _rawBody) {
      const body = z
        .object({
          provider: z.string().min(1),
          workspaceId: z.string().min(1),
          eventId: z.string().min(1),
          timestampMs: z.number().int().positive(),
          nonce: z.string().min(1),
          type: z.literal("message"),
          channelChatId: z.string().min(1),
          channelUserId: z.string().min(1),
          bridgeMessageId: z.string().min(1).optional(),
          text: z.string().max(20000).optional(),
          attachments: z.array(z.any()).optional(),
          raw: z.any().optional(),
        })
        .parse(ctx.req.body);

      const req = ctx.req as any;
      const cfg = ctx.cfg;

      const nowMs = Date.now();
      if (Math.abs(nowMs - body.timestampMs) > cfg.toleranceSec * 1000) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.channelReplayDenied();
      }

      const webhookSecret =
        (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") ||
        pickSecret(ctx.secretPayload, "webhookSecret");
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
    },

    async parseInbound(ctx): Promise<ParsedInbound> {
      const body = z
        .object({
          provider: z.string().min(1),
          workspaceId: z.string().min(1),
          eventId: z.string().min(1),
          timestampMs: z.number().int().positive(),
          nonce: z.string().min(1),
          type: z.literal("message"),
          channelChatId: z.string().min(1),
          channelUserId: z.string().min(1),
          bridgeMessageId: z.string().min(1).optional(),
          text: z.string().max(20000).optional(),
          attachments: z.array(z.any()).optional(),
          raw: z.any().optional(),
        })
        .parse(ctx.req.body) as BridgeMessageBody;

      return {
        workspaceId: body.workspaceId,
        eventId: body.eventId,
        nonce: body.nonce,
        timestampSec: Math.floor(body.timestampMs / 1000),
        channelChatId: body.channelChatId,
        channelUserId: body.channelUserId,
        text: body.text ?? "",
        rawBody: body,
      };
    },

    formatOutbound(_locale, _replyText, correlation) {
      return { correlation, status: "succeeded" };
    },

    async sendReply(ctx, text, chatId) {
      const body = ctx.req.body as BridgeMessageBody;
      const secretPayload = ctx.secretPayload;
      const cfg = ctx.cfg;
      const webhookSecret =
        (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") ||
        pickSecret(secretPayload, "webhookSecret");

      const baseUrl = pickSecret(secretPayload, "bridgeBaseUrl");
      const webhookUrl = pickSecret(secretPayload, "webhookUrl");
      const slackBotToken = pickSecret(secretPayload, "slackBotToken");

      if (body.provider === "qq.onebot" || body.provider === "imessage.bridge" || body.provider === "dingtalk" || body.provider === "wecom") {
        if (!baseUrl) throw Errors.channelConfigMissing();
        const result = await bridgeSendWithRetry({
          baseUrl,
          secret: webhookSecret,
          provider: body.provider,
          workspaceId: body.workspaceId,
          requestId: (ctx.req as any).ctx.requestId,
          traceId: (ctx.req as any).ctx.traceId,
          to: { channelChatId: chatId },
          message: { text },
          idempotencyKey: `outbox_bridge_${Date.now()}`,
          maxAttempts: Math.min(3, Number(cfg.maxAttempts ?? 2)),
          backoffMsBase: Number(cfg.backoffMsBase ?? 200),
        });
        return { messageId: result?.messageId as string | undefined };
      } else if (slackBotToken) {
        await sendViaSlack({ botToken: slackBotToken, channel: chatId, text });
      } else if (webhookUrl) {
        await sendViaWebhook({ webhookUrl, text });
      } else {
        throw Errors.channelConfigMissing();
      }
      return { messageId: undefined };
    },

    async editMessage(ctx, messageId, text, chatId) {
      const body = ctx.req.body as BridgeMessageBody;
      const effectiveProvider = body.provider ?? provider;
      // 企业微信 API 不支持消息编辑，静默跳过
      if (effectiveProvider === "wecom") return;

      const secretPayload = ctx.secretPayload;
      const cfg = ctx.cfg;
      const webhookSecret =
        (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") ||
        pickSecret(secretPayload, "webhookSecret");
      const baseUrl = pickSecret(secretPayload, "bridgeBaseUrl");
      if (!baseUrl) return; // Bridge 不可用时静默跳过

      await bridgeSendWithRetry({
        baseUrl,
        secret: webhookSecret,
        provider: body.provider ?? provider,
        workspaceId: body.workspaceId ?? "",
        requestId: (ctx.req as any).ctx?.requestId ?? "",
        traceId: (ctx.req as any).ctx?.traceId ?? "",
        to: { channelChatId: chatId },
        message: { text, action: "edit", messageId },
        idempotencyKey: `edit_${messageId}_${Date.now()}`,
        maxAttempts: 2,
        backoffMsBase: 200,
      });
    },
  };
}

// ─── 钉钉 setup 方法 ────────────────────────────────────────────────────────

const dingtalkSetup: Pick<ChannelProviderPlugin, "buildSetupAuthorizeUrl" | "handleSetupCallback"> = {
  buildSetupAuthorizeUrl({ redirectUri, state }) {
    const clientId = process.env.DINGTALK_SUITE_KEY || process.env.DINGTALK_CLIENT_ID || "";
    const u = new URL("https://login.dingtalk.com/oauth2/auth");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid corpid");
    u.searchParams.set("prompt", "consent");
    return u.toString();
  },
  async handleSetupCallback({ code }) {
    const clientId = process.env.DINGTALK_SUITE_KEY || process.env.DINGTALK_CLIENT_ID || "";
    const clientSecret = process.env.DINGTALK_SUITE_SECRET || process.env.DINGTALK_CLIENT_SECRET || "";
    const tokenRes = await fetch("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret, code, grantType: "authorization_code" }),
    });
    const tokenJson: any = await tokenRes.json();
    const corpId = String(tokenJson?.corpId ?? "");
    return {
      workspaceId: corpId || "default",
      credentials: { clientId, clientSecret, webhookSecret: process.env.DINGTALK_WEBHOOK_SECRET || "" },
      displayName: "钉钉组织",
    };
  },
};

// ─── 企微 setup 方法 ────────────────────────────────────────────────────────

const wecomSetup: Pick<ChannelProviderPlugin, "buildSetupAuthorizeUrl" | "handleSetupCallback"> = {
  buildSetupAuthorizeUrl({ redirectUri, state }) {
    const corpId = process.env.WECOM_CORP_ID || "";
    const u = new URL("https://open.work.weixin.qq.com/wwopen/sso/qrConnect");
    u.searchParams.set("appid", corpId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  },
  async handleSetupCallback({ code }) {
    const corpId = process.env.WECOM_CORP_ID || "";
    const corpSecret = process.env.WECOM_CORP_SECRET || "";
    // 企微应用级配置：使用 corpId/corpSecret 获取 access_token（code 仅用于确认用户完成了扫码授权，实际凭据来自 ISV 环境变量）
    const tokenRes = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`);
    const tokenJson: any = await tokenRes.json();
    if (tokenJson.errcode && tokenJson.errcode !== 0) {
      throw new Error(`企业微信授权失败: ${tokenJson.errmsg || `errcode ${tokenJson.errcode}`}`);
    }
    return {
      workspaceId: corpId || "default",
      credentials: { corpId, corpSecret, webhookSecret: process.env.WECOM_WEBHOOK_SECRET || "" },
      displayName: "企业微信",
    };
  },
};

// ─── 注册所有 bridge provider ────────────────────────────────────────────────

const bridgePlugin = makeBridgePlugin("bridge");
registerChannelProvider(bridgePlugin);

registerChannelProvider(makeBridgePlugin("qq.onebot"));
registerChannelProvider(makeBridgePlugin("imessage.bridge"));
const dingtalkPlugin = makeBridgePlugin("dingtalk", {
  ...dingtalkSetup,
  async startLongConnection({ credentials, onEvent }) {
    const appKey = credentials.appKey || credentials.clientId || "";
    const appSecret = credentials.appSecret || credentials.clientSecret || "";
    if (!appKey || !appSecret) throw new Error("Missing dingtalk appKey/appSecret");

    const client = new DingtalkStreamClient({ appKey, appSecret });

    client.on("event", async (eventData: any) => {
      try {
        const parsed: ParsedInbound = {
          workspaceId: String(eventData?.corpId ?? ""),
          eventId: String(eventData?.msgId ?? eventData?.chatbotCorpId ?? `dt_${Date.now()}`),
          nonce: String(eventData?.msgId ?? `dt_${Date.now()}`),
          timestampSec: Math.floor(Date.now() / 1000),
          channelChatId: String(eventData?.conversationId ?? ""),
          channelUserId: String(eventData?.senderStaffId ?? eventData?.senderId ?? ""),
          text: String(eventData?.text?.content ?? "").trim(),
          rawBody: eventData,
        };
        await onEvent(parsed);
      } catch (err: any) {
        console.error("[dingtalk-stream] event handling error", err?.message ?? err);
      }
    });

    await client.start();
    return { stop: () => client.stop() };
  },
});
registerChannelProvider(dingtalkPlugin);
registerChannelProvider(makeBridgePlugin("wecom", wecomSetup));

// ─── 保留 handleBridgeEvents 导出（routes.ts 使用） ─────────────────────────

export async function handleBridgeEvents(ctx: { app: any; req: any; reply: any }, opts?: { expectedProvider?: string }) {
  // 预校验 provider
  const body = z.object({ provider: z.string().min(1) }).passthrough().parse(ctx.req.body);
  if (opts?.expectedProvider && body.provider !== opts.expectedProvider) throw Errors.badRequest("provider 不匹配");

  // 为此 provider 动态创建插件实例（复用 bridge 逻辑，但 provider 名称来自 body）
  const plugin = makeBridgePlugin(body.provider);
  return channelIngressPipeline(ctx, plugin);
}
