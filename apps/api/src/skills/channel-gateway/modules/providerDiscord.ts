import { Errors } from "../../../lib/errors";
import { pickSecret } from "./channelCommon";
import { verifyDiscordSignature } from "./discord";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";

const discordPlugin: ChannelProviderPlugin = {
  provider: "discord",

  extractWorkspaceId(req) {
    const rawBody = typeof (req as any).body === "string" ? (req as any).body : JSON.stringify((req as any).body ?? {});
    const body = JSON.parse(rawBody);
    return String(body?.application_id ?? "").trim();
  },

  async verifySignature(ctx, rawBody) {
    const req = ctx.req as any;
    const ts = String((req.headers["x-signature-timestamp"] as string | undefined) ?? "");
    const sig = String((req.headers["x-signature-ed25519"] as string | undefined) ?? "");
    if (!ts || !sig) throw Errors.badRequest("signature headers 缺失");

    const publicKeyHex = pickSecret(ctx.secretPayload, "discordPublicKey");
    if (!publicKeyHex) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    verifyDiscordSignature({ publicKeyHex, signatureHex: sig, timestamp: ts, rawBody });
  },

  async handleProtocol(ctx) {
    const rawBody = typeof (ctx.req as any).body === "string" ? (ctx.req as any).body : JSON.stringify((ctx.req as any).body ?? {});
    const body = JSON.parse(rawBody);
    const typ = Number(body?.type ?? 0);
    if (typ === 1) {
      const appId = String(body?.application_id ?? "").trim();
      (ctx.req as any).ctx.audit!.outputDigest = { provider: "discord", workspaceId: appId, type: "ping" };
      return { type: 1 };
    }
    return null;
  },

  async parseInbound(ctx): Promise<ParsedInbound> {
    const rawBody = typeof (ctx.req as any).body === "string" ? (ctx.req as any).body : JSON.stringify((ctx.req as any).body ?? {});
    const body = JSON.parse(rawBody);
    const req = ctx.req as any;
    const ts = String((req.headers["x-signature-timestamp"] as string | undefined) ?? "");

    const appId = String(body?.application_id ?? "").trim();
    const eventId = String(body?.id ?? "").trim();
    if (!eventId) throw Errors.badRequest("eventId 缺失");

    const channelChatId = String(body?.channel_id ?? "").trim();
    const channelUserId = String(body?.member?.user?.id ?? body?.user?.id ?? "").trim();
    const cmdName = String(body?.data?.name ?? "").trim();

    // 修复：解析 slash command 参数
    const options = Array.isArray(body?.data?.options) ? body.data.options : [];
    const argsText = options.map((o: any) => String(o?.value ?? "")).filter(Boolean).join(" ");
    const msgText = cmdName ? `/${cmdName}${argsText ? " " + argsText : ""}` : "interaction";

    return {
      workspaceId: appId,
      eventId,
      nonce: ts,
      timestampSec: ts ? Number(ts) : Math.floor(Date.now() / 1000),
      channelChatId,
      channelUserId,
      text: msgText,
      rawBody: body,
    };
  },

  formatOutbound(_locale, replyText, _correlation) {
    // Discord interaction 通过 HTTP 响应直接回复
    return { type: 4, data: { content: replyText } };
  },

  // Discord 无 sendReply — 通过 HTTP 响应直接回复
};

registerChannelProvider(discordPlugin);
