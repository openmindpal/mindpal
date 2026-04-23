import { Errors } from "../../../lib/errors";
import { pickSecret } from "./channelCommon";
import { verifySlackSignature, slackSendTextWithRetry } from "./slack";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";

const slackPlugin: ChannelProviderPlugin = {
  provider: "slack",

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

    return {
      workspaceId: teamId,
      eventId,
      nonce: String((body?.event_time ?? timestampSec) ?? timestampSec),
      timestampSec: Math.floor(timestampSec),
      channelChatId,
      channelUserId,
      text: msgText,
      rawBody: body,
    };
  },

  formatOutbound(_locale, _replyText, correlation) {
    return { correlation, status: "succeeded" };
  },

  async sendReply(ctx, text, chatId) {
    const botToken = pickSecret(ctx.secretPayload, "slackBotToken");
    if (!botToken) throw Errors.channelConfigMissing();
    await slackSendTextWithRetry({
      botToken,
      channel: chatId,
      text,
      maxAttempts: Math.min(3, Number(ctx.cfg.maxAttempts ?? 2)),
      backoffMsBase: Number(ctx.cfg.backoffMsBase ?? 200),
    });
  },
};

registerChannelProvider(slackPlugin);
