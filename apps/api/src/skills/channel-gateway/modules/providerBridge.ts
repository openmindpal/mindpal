import { z } from "zod";
import { Errors } from "../../../lib/errors";
import { pickSecret } from "./channelCommon";
import { bridgeSendWithRetry } from "./bridgeSend";
import { computeBridgeBodyDigest, verifyBridgeSignature } from "./bridgeContract";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";
import { channelIngressPipeline } from "./channelPipeline";

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

function makeBridgePlugin(provider: string): ChannelProviderPlugin {
  return {
    provider,

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

      if (body.provider === "qq.onebot" || body.provider === "imessage.bridge") {
        if (!baseUrl) throw Errors.channelConfigMissing();
        await bridgeSendWithRetry({
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
      } else if (slackBotToken) {
        await sendViaSlack({ botToken: slackBotToken, channel: chatId, text });
      } else if (webhookUrl) {
        await sendViaWebhook({ webhookUrl, text });
      } else {
        throw Errors.channelConfigMissing();
      }
    },
  };
}

// 注册 bridge 作为通用 provider（实际的 provider name 来自 body.provider）
const bridgePlugin = makeBridgePlugin("bridge");
registerChannelProvider(bridgePlugin);

// ─── 保留 handleBridgeEvents 导出（routes.ts 使用） ─────────────────────────

export async function handleBridgeEvents(ctx: { app: any; req: any; reply: any }, opts?: { expectedProvider?: string }) {
  // 预校验 provider
  const body = z.object({ provider: z.string().min(1) }).passthrough().parse(ctx.req.body);
  if (opts?.expectedProvider && body.provider !== opts.expectedProvider) throw Errors.badRequest("provider 不匹配");

  // 为此 provider 动态创建插件实例（复用 bridge 逻辑，但 provider 名称来自 body）
  const plugin = makeBridgePlugin(body.provider);
  return channelIngressPipeline(ctx, plugin);
}
