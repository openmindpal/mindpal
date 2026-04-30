import { Errors } from "../../../lib/errors";
import { pickSecret } from "./channelCommon";
import { verifySlackSignature, slackSendTextWithRetry } from "./slack";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider, inferAttachmentType } from "./providerAdapters";
import type { UnifiedAttachment } from "@openslin/shared";
import { SlackSocketClient } from "./slackSocketMode";

const slackPlugin: ChannelProviderPlugin = {
  provider: "slack",
  meta: {
    provider: "slack",
    displayName: { zh: "Slack", en: "Slack" },
    icon: "slack",
    setupModes: ["manual"],
    features: { admissionPolicy: false, groupChat: true, directMessage: true, richMessage: true },
    manualConfigFields: [
      { key: "slackBotToken", label: { zh: "Bot Token", en: "Bot Token" }, type: "secret", required: true },
      { key: "slackSigningSecret", label: { zh: "Signing Secret", en: "Signing Secret" }, type: "secret", required: true },
      { key: "slackAppToken", label: { zh: "App-Level Token", en: "App-Level Token" }, type: "secret", required: false },
      { key: "slackClientId", label: { zh: "Client ID", en: "Client ID" }, type: "text", required: false },
      { key: "slackClientSecret", label: { zh: "Client Secret", en: "Client Secret" }, type: "secret", required: false },
    ],
    supportsEdit: true,
  },

  extractWorkspaceId(req) {
    const rawBody = typeof (req as any).body === "string" ? (req as any).body : JSON.stringify((req as any).body ?? {});
    const body = JSON.parse(rawBody);
    return String(body?.team_id ?? "").trim();
  },

  async verifySignature(ctx, rawBody) {
    const req = ctx.req as any;
    const tsRaw = String((req.headers["x-slack-request-timestamp"] as string | undefined) ?? "");
    const timestampSec = tsRaw ? Number(tsRaw) : NaN;
    if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestampSec) > ctx.cfg.toleranceSec) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    const signingSecret = pickSecret(ctx.secretPayload, "slackSigningSecret");
    if (!signingSecret) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    const sigHeader = String((req.headers["x-slack-signature"] as string | undefined) ?? "");
    verifySlackSignature({ signingSecret, timestampSec: Math.floor(timestampSec), rawBody, signatureHeader: sigHeader });
  },

  async handleProtocol(ctx) {
    const rawBody = typeof (ctx.req as any).body === "string" ? (ctx.req as any).body : JSON.stringify((ctx.req as any).body ?? {});
    const body = JSON.parse(rawBody);
    const typ = String(body?.type ?? "");
    if (typ === "url_verification") {
      const challenge = String(body?.challenge ?? "");
      if (!challenge) throw Errors.badRequest("challenge 缺失");
      const teamId = String(body?.team_id ?? "").trim();
      (ctx.req as any).ctx.audit!.outputDigest = { provider: "slack", workspaceId: teamId, type: typ };
      return { challenge };
    }
    return null;
  },

  async parseInbound(ctx): Promise<ParsedInbound> {
    const rawBody = typeof (ctx.req as any).body === "string" ? (ctx.req as any).body : JSON.stringify((ctx.req as any).body ?? {});
    const body = JSON.parse(rawBody);
    const req = ctx.req as any;
    const tsRaw = String((req.headers["x-slack-request-timestamp"] as string | undefined) ?? "");
    const timestampSec = tsRaw ? Number(tsRaw) : NaN;

    const teamId = String(body?.team_id ?? "").trim();
    const eventId = String(body?.event_id ?? "").trim();
    if (!eventId) throw Errors.badRequest("eventId 缺失");
    const ev = body?.event ?? {};
    const channelChatId = String(ev?.channel ?? "").trim();
    const channelUserId = String(ev?.user ?? "").trim();
    const msgText = typeof ev?.text === "string" ? String(ev.text) : "";

    // ── Slack 附件提取：event.files[] ──
    const attachments: UnifiedAttachment[] = [];
    const files = ev?.files;
    if (Array.isArray(files)) {
      for (const f of files) {
        const mimeType = String(f.mimetype ?? f.mime_type ?? "application/octet-stream");
        attachments.push({
          type: inferAttachmentType(mimeType),
          mimeType,
          name: f.name || f.title,
          sizeBytes: f.size != null ? Number(f.size) : undefined,
          dataUrl: String(f.url_private_download ?? f.url_private ?? ""),
        });
      }
    }

    return {
      workspaceId: teamId,
      eventId,
      nonce: String((body?.event_time ?? timestampSec) ?? timestampSec),
      timestampSec: Math.floor(timestampSec),
      channelChatId,
      channelUserId,
      text: msgText,
      rawBody: body,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  },

  formatOutbound(_locale, _replyText, correlation) {
    return { correlation, status: "succeeded" };
  },

  async sendReply(ctx, text, chatId) {
    const botToken = pickSecret(ctx.secretPayload, "slackBotToken");
    if (!botToken) throw Errors.channelConfigMissing();
    const json = await slackSendTextWithRetry({
      botToken,
      channel: chatId,
      text,
      maxAttempts: Math.min(3, Number(ctx.cfg.maxAttempts ?? 2)),
      backoffMsBase: Number(ctx.cfg.backoffMsBase ?? 200),
    });
    return { messageId: json?.ts as string | undefined };
  },

  async editMessage(ctx, messageId, text, chatId) {
    const botToken = pickSecret(ctx.secretPayload, "slackBotToken");
    if (!botToken) throw Errors.channelConfigMissing();
    const res = await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: chatId, ts: messageId, text }),
    });
    const json: any = await res.json().catch(() => null);
    if (!json?.ok) throw new Error(`Slack 编辑消息失败: ${json?.error ?? res.status}`);
  },

  // ─── Socket Mode 长连接 ───────────────────────────────────────────────────

  async startLongConnection({ credentials, onEvent }) {
    const appToken = credentials.slackAppToken;
    if (!appToken) throw new Error("Missing slackAppToken for Socket Mode");

    const client = new SlackSocketClient({ appToken });

    client.on("event", async (payload: any) => {
      try {
        const ev = payload?.event ?? {};
        const teamId = String(payload?.team_id ?? "").trim();
        const eventId = String(payload?.event_id ?? ev?.event_ts ?? "").trim();
        if (!eventId) return;

        const channelChatId = String(ev?.channel ?? "").trim();
        const channelUserId = String(ev?.user ?? "").trim();
        const msgText = typeof ev?.text === "string" ? String(ev.text) : "";
        if (!msgText) return;

        // ── WS 模式 Slack 附件提取 ──
        const attachments: UnifiedAttachment[] = [];
        const wsFiles = ev?.files;
        if (Array.isArray(wsFiles)) {
          for (const f of wsFiles) {
            const mimeType = String(f.mimetype ?? f.mime_type ?? "application/octet-stream");
            attachments.push({
              type: inferAttachmentType(mimeType),
              mimeType,
              name: f.name || f.title,
              sizeBytes: f.size != null ? Number(f.size) : undefined,
              dataUrl: String(f.url_private_download ?? f.url_private ?? ""),
            });
          }
        }

        const parsed: ParsedInbound = {
          workspaceId: teamId,
          eventId,
          nonce: eventId,
          timestampSec: Math.floor(Date.now() / 1000),
          channelChatId,
          channelUserId,
          text: msgText,
          rawBody: payload,
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        await onEvent(parsed);
      } catch (err: any) {
        console.error("[slack-ws] event handling error", err?.message ?? err);
      }
    });

    await client.start();
    return { stop: () => client.stop() };
  },
};

registerChannelProvider(slackPlugin);
