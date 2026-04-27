import { Errors } from "../../../lib/errors";
import { pickSecret } from "./channelCommon";
import { verifyDiscordSignature } from "./discord";
import { DiscordGatewayClient } from "./discordGateway";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";

const discordPlugin: ChannelProviderPlugin = {
  provider: "discord",
  meta: {
    provider: "discord",
    displayName: { zh: "Discord", en: "Discord" },
    icon: "discord",
    setupModes: ["manual"],
    features: { admissionPolicy: false, groupChat: true, directMessage: true, richMessage: true },
    supportsEdit: true,
    manualConfigFields: [
      { key: "discordPublicKey", label: { zh: "Public Key", en: "Public Key" }, type: "text", required: true },
      { key: "discordBotToken", label: { zh: "Bot Token", en: "Bot Token" }, type: "secret", required: false },
      { key: "discordClientId", label: { zh: "Client ID", en: "Client ID" }, type: "text", required: false },
      { key: "discordClientSecret", label: { zh: "Client Secret", en: "Client Secret" }, type: "secret", required: false },
    ],
  },

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

  // ── Bot 模式：主动发送 & 编辑消息（需配置 discordBotToken）──────────────

  async sendReply(ctx, text, chatId) {
    const botToken = pickSecret(ctx.secretPayload, "discordBotToken");
    if (!botToken) throw Errors.channelConfigMissing();
    const res = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`Discord 发送消息失败: ${res.status}`);
    const json: any = await res.json();
    return { messageId: json.id as string | undefined };
  },

  async editMessage(ctx, messageId, text, chatId) {
    const botToken = pickSecret(ctx.secretPayload, "discordBotToken");
    if (!botToken) throw Errors.channelConfigMissing();
    const res = await fetch(`https://discord.com/api/v10/channels/${chatId}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bot ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`Discord 编辑消息失败: ${res.status}`);
  },

  // ── Gateway 长连接模式 ───────────────────────────────────────────────────

  async startLongConnection({ credentials, onEvent }) {
    const botToken = pickSecret(credentials, "discordBotToken");
    if (!botToken) throw new Error("Missing discordBotToken for Gateway");

    const client = new DiscordGatewayClient({ botToken });

    client.on("message", async (msgData: any) => {
      try {
        // 忽略 bot 自己发的消息
        if (msgData.author?.bot) return;

        const parsed: ParsedInbound = {
          workspaceId: String(msgData.guild_id ?? ""),
          eventId: String(msgData.id ?? ""),
          nonce: String(msgData.nonce ?? msgData.id ?? ""),
          timestampSec: msgData.timestamp
            ? Math.floor(new Date(msgData.timestamp).getTime() / 1000)
            : Math.floor(Date.now() / 1000),
          channelChatId: String(msgData.channel_id ?? ""),
          channelUserId: String(msgData.author?.id ?? ""),
          text: String(msgData.content ?? ""),
          rawBody: msgData,
        };
        await onEvent(parsed);
      } catch (err: any) {
        console.error("[discord-gateway] event handling error", err?.message ?? err);
      }
    });

    await client.start();
    return { stop: () => client.stop() };
  },
};

registerChannelProvider(discordPlugin);
