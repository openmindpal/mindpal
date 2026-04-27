/**
 * providerWechat.ts — 微信 Provider（扫码即用模式）
 */
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";

// ─── 微信 access_token 缓存 ─────────────────────────────────────────────────
let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getWechatAccessToken(ctx: IngressContext): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _cachedToken.expiresAt) return _cachedToken.token;

  const cfg = ctx.cfg;
  const secretPayload = ctx.secretPayload;
  const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? cfg.providerConfig : {};
  const appIdEnvKey = String((providerConfig as any).appIdEnvKey ?? "");
  const appSecretEnvKey = String((providerConfig as any).appSecretEnvKey ?? "");
  const appId =
    (appIdEnvKey ? String(process.env[appIdEnvKey] ?? "") : "") ||
    (typeof (secretPayload as any).appId === "string" ? String((secretPayload as any).appId) : "") ||
    String(process.env.WECHAT_APP_ID ?? "");
  const appSecret =
    (appSecretEnvKey ? String(process.env[appSecretEnvKey] ?? "") : "") ||
    (typeof (secretPayload as any).appSecret === "string" ? String((secretPayload as any).appSecret) : "") ||
    String(process.env.WECHAT_APP_SECRET ?? "");
  if (!appId || !appSecret) throw new Error("微信凭据缺失，无法获取 access_token");

  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`,
  );
  const json: any = await res.json();
  if (!json.access_token) throw new Error(`微信 access_token 获取失败: ${json.errmsg ?? res.status}`);

  _cachedToken = { token: json.access_token, expiresAt: now + (json.expires_in ?? 7200) * 1000 - 60_000 };
  return _cachedToken.token;
}

const wechatPlugin: ChannelProviderPlugin = {
  provider: "wechat",
  meta: {
    provider: "wechat",
    displayName: { zh: "微信", en: "WeChat" },
    icon: "wechat",
    setupModes: ["qr"],
    features: { admissionPolicy: false, groupChat: false, directMessage: true, richMessage: true },
    supportsEdit: false,
  },
  extractWorkspaceId(req) {
    const body = (req as any).body ?? {};
    return String(body?.ToUserName ?? body?.workspaceId ?? "").trim();
  },
  async verifySignature(_ctx) {
    // 微信通过 bridge 模式时由 bridge 层验签
  },
  async parseInbound(ctx): Promise<ParsedInbound> {
    const body: any = ctx.req.body ?? {};
    return {
      workspaceId: String(body?.ToUserName ?? body?.workspaceId ?? "").trim(),
      eventId: String(body?.MsgId ?? body?.eventId ?? "").trim(),
      nonce: String(body?.nonce ?? body?.MsgId ?? "").trim(),
      timestampSec: Number(body?.CreateTime ?? Math.floor(Date.now() / 1000)),
      channelChatId: String(body?.FromUserName ?? body?.channelChatId ?? "").trim(),
      channelUserId: String(body?.FromUserName ?? body?.channelUserId ?? "").trim(),
      text: String(body?.Content ?? body?.text ?? ""),
      rawBody: body,
    };
  },
  formatOutbound(_locale, _replyText, correlation) {
    return { correlation, status: "succeeded" };
  },
  buildSetupAuthorizeUrl({ redirectUri, state }) {
    const appId = process.env.WECHAT_APP_ID || "";
    const u = new URL("https://open.weixin.qq.com/connect/qrconnect");
    u.searchParams.set("appid", appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "snsapi_login");
    u.searchParams.set("state", state);
    return u.toString();
  },
  async handleSetupCallback({ code }) {
    const appId = process.env.WECHAT_APP_ID || "";
    const appSecret = process.env.WECHAT_APP_SECRET || "";
    const tokenRes = await fetch(
      `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${appId}&secret=${appSecret}&code=${code}&grant_type=authorization_code`
    );
    const tokenJson: any = await tokenRes.json();
    if (!tokenRes.ok || (tokenJson.errcode && tokenJson.errcode !== 0)) {
      throw new Error(`微信授权失败: ${tokenJson.errmsg || `HTTP ${tokenRes.status}`}`);
    }
    const openid = String(tokenJson?.openid ?? "");
    if (!openid) {
      throw new Error("微信授权失败: 未获取到 openid");
    }
    return {
      workspaceId: openid,
      credentials: { appId, appSecret },
      displayName: "微信",
    };
  },

  async sendReply(ctx, text, chatId) {
    const accessToken = await getWechatAccessToken(ctx);
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ touser: chatId, msgtype: "text", text: { content: text } }),
      },
    );
    const json: any = await res.json();
    if (json.errcode && json.errcode !== 0) {
      console.error("[wechat] sendReply error:", json);
    }
  },
};

registerChannelProvider(wechatPlugin);
