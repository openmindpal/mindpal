import { z } from "zod";
import { Errors } from "../../../lib/errors";
import { timingSafeTokenCompare } from "./channelCommon";
import { resolveChannelSecretPayload } from "./channelSecret";
import { feishuSendTextToChatWithRetry, getFeishuTenantAccessToken } from "./feishu";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider, inferAttachmentType } from "./providerAdapters";
import type { UnifiedAttachment } from "@mindpal/shared";
import { FeishuWsClient } from "./feishuLongConnection";

function toTextPayload(raw: unknown) {
  if (typeof raw !== "string") return "";
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && typeof (j as any).text === "string") return String((j as any).text);
  } catch {}
  return raw;
}

const feishuPlugin: ChannelProviderPlugin = {
  provider: "feishu",
  meta: {
    provider: "feishu",
    displayName: { zh: "飞书", en: "Feishu" },
    icon: "feishu",
    setupModes: ["qr"],
    features: { admissionPolicy: true, groupChat: true, directMessage: true, richMessage: true },
    supportsEdit: true,
  },

  extractWorkspaceId(req) {
    const body = (req as any).body ?? {};
    return String(body?.header?.tenant_key ?? body?.tenant_key ?? "").trim();
  },

  async verifySignature(ctx) {
    const body = z.any().parse(ctx.req.body);
    const secretPayload = ctx.secretPayload;
    const cfg = ctx.cfg;
    const tokenExpected =
      (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") ||
      (typeof (secretPayload as any).verifyToken === "string" ? String((secretPayload as any).verifyToken) : "");
    if (!tokenExpected) {
      (ctx.req as any).ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelConfigMissing();
    }
    const tokenActual = String(body?.token ?? body?.header?.token ?? "");
    // 修复时序攻击：使用 timingSafeTokenCompare 替代 !==
    if (!tokenActual || !timingSafeTokenCompare(tokenActual, tokenExpected)) {
      (ctx.req as any).ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelSignatureInvalid();
    }
  },

  async handleProtocol(ctx) {
    const body = z.any().parse(ctx.req.body);
    const typ = String(body?.type ?? "");
    if (typ === "url_verification") {
      const challenge = String(body?.challenge ?? "");
      if (!challenge) throw Errors.badRequest("challenge 缺失");
      const workspaceId = String(body?.header?.tenant_key ?? body?.tenant_key ?? "").trim();
      (ctx.req as any).ctx.audit!.outputDigest = { provider: "feishu", workspaceId, type: typ };
      return { challenge };
    }
    return null;
  },

  async parseInbound(ctx): Promise<ParsedInbound> {
    const body = z.any().parse(ctx.req.body);
    const req = ctx.req as any;
    const tsRaw = (req.headers["x-lark-request-timestamp"] as string | undefined) ?? "";
    const nonce = ((req.headers["x-lark-request-nonce"] as string | undefined) ?? "").trim();
    const timestampSec = tsRaw ? Number(tsRaw) : NaN;
    if (!Number.isFinite(timestampSec)) throw Errors.badRequest("timestamp 无效");

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestampSec) > ctx.cfg.toleranceSec) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.channelReplayDenied();
    }

    const eventId = String(body?.header?.event_id ?? "").trim();
    if (!eventId) throw Errors.badRequest("eventId 缺失");
    const channelChatId = String(body?.event?.message?.chat_id ?? "").trim();
    const channelUserId = String(body?.event?.sender?.sender_id?.open_id ?? body?.event?.sender?.sender_id?.user_id ?? "").trim();
    const msgText = toTextPayload(body?.event?.message?.content);

    // ── 提取附件（根据飞书消息类型）──
    const attachments: UnifiedAttachment[] = [];
    const msgType = String(body?.event?.message?.message_type ?? "text");
    const rawContent = body?.event?.message?.content;
    let parsedContent: any = null;
    if (typeof rawContent === "string") {
      try { parsedContent = JSON.parse(rawContent); } catch { /* ignore */ }
    } else if (rawContent && typeof rawContent === "object") {
      parsedContent = rawContent;
    }

    if (parsedContent) {
      const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
      if (msgType === "image" && parsedContent.image_key) {
        // 图片消息：存储飞书图片下载 URL 供后续处理
        attachments.push({
          type: "image",
          mimeType: "image/png",
          name: parsedContent.image_key,
          dataUrl: `${baseUrl}/open-apis/im/v1/images/${parsedContent.image_key}`,
        });
      } else if (msgType === "file" && parsedContent.file_key) {
        // 文件消息
        const mimeType = String(parsedContent.mime_type ?? "application/octet-stream");
        attachments.push({
          type: inferAttachmentType(mimeType),
          mimeType,
          name: parsedContent.file_name || parsedContent.file_key,
          sizeBytes: parsedContent.file_size != null ? Number(parsedContent.file_size) : undefined,
          dataUrl: `${baseUrl}/open-apis/im/v1/messages/${body?.event?.message?.message_id}/resources/${parsedContent.file_key}`,
        });
      } else if (msgType === "audio" && parsedContent.file_key) {
        // 音频消息
        attachments.push({
          type: "voice",
          mimeType: "audio/ogg",
          name: parsedContent.file_key,
          dataUrl: `${baseUrl}/open-apis/im/v1/messages/${body?.event?.message?.message_id}/resources/${parsedContent.file_key}`,
        });
      }
    }

    return {
      workspaceId: String(body?.header?.tenant_key ?? body?.tenant_key ?? "").trim(),
      eventId,
      nonce: nonce || eventId,
      timestampSec,
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

  buildSetupAuthorizeUrl({ redirectUri, state }) {
    const appId = process.env.FEISHU_ISV_APP_ID || process.env.FEISHU_APP_ID || "";
    const base = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";
    const u = new URL(`${base}/open-apis/authen/v1/authorize`);
    u.searchParams.set("app_id", appId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("scope", "contact:user.base:readonly");
    return u.toString();
  },
  async handleSetupCallback({ code }) {
    const appId = process.env.FEISHU_ISV_APP_ID || process.env.FEISHU_APP_ID || "";
    const appSecret = process.env.FEISHU_ISV_APP_SECRET || process.env.FEISHU_APP_SECRET || "";
    const base = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";
    // 1. 用 code 换取 user_access_token
    const tokenRes = await fetch(`${base}/open-apis/authen/v1/oidc/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${await getFeishuTenantAccessToken({ baseUrl: base, appId, appSecret })}` },
      body: JSON.stringify({ grant_type: "authorization_code", code }),
    });
    const tokenJson: any = await tokenRes.json();
    const tenantKey = String(tokenJson?.data?.tenant_key ?? "");
    const displayName = String(tokenJson?.data?.name ?? "");
    // 返回凭据供 setup 回调自动存储
    return {
      workspaceId: tenantKey || "default",
      credentials: { appId, appSecret },
      displayName: displayName || "飞书组织",
    };
  },

  async sendReply(ctx, text, chatId) {
    const cfg = ctx.cfg;
    const secretPayload = ctx.secretPayload;
    const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? cfg.providerConfig : {};
    const appIdEnvKey = String((providerConfig as any).appIdEnvKey ?? "");
    const appSecretEnvKey = String((providerConfig as any).appSecretEnvKey ?? "");
    const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
    const appId =
      (appIdEnvKey ? String(process.env[appIdEnvKey] ?? "") : "") ||
      (typeof (secretPayload as any).appId === "string" ? String((secretPayload as any).appId) : "");
    const appSecret =
      (appSecretEnvKey ? String(process.env[appSecretEnvKey] ?? "") : "") ||
      (typeof (secretPayload as any).appSecret === "string" ? String((secretPayload as any).appSecret) : "");
    if (appId && appSecret) {
      const accessToken = await getFeishuTenantAccessToken({ baseUrl, appId, appSecret });
      const json = await feishuSendTextToChatWithRetry({
        baseUrl,
        tenantAccessToken: accessToken,
        chatId,
        text,
        maxAttempts: Math.min(3, Number(cfg.maxAttempts ?? 2)),
        backoffMsBase: Number(cfg.backoffMsBase ?? 200),
      });
      return { messageId: json?.data?.message_id as string | undefined };
    }
    return { messageId: undefined };
  },

  async editMessage(ctx, messageId, text, _chatId) {
    const cfg = ctx.cfg;
    const secretPayload = ctx.secretPayload;
    const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? cfg.providerConfig : {};
    const appIdEnvKey = String((providerConfig as any).appIdEnvKey ?? "");
    const appSecretEnvKey = String((providerConfig as any).appSecretEnvKey ?? "");
    const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
    const appId =
      (appIdEnvKey ? String(process.env[appIdEnvKey] ?? "") : "") ||
      (typeof (secretPayload as any).appId === "string" ? String((secretPayload as any).appId) : "");
    const appSecret =
      (appSecretEnvKey ? String(process.env[appSecretEnvKey] ?? "") : "") ||
      (typeof (secretPayload as any).appSecret === "string" ? String((secretPayload as any).appSecret) : "");
    if (!appId || !appSecret) throw new Error("飞书凭据缺失，无法编辑消息");
    const token = await getFeishuTenantAccessToken({ baseUrl, appId, appSecret });
    const res = await fetch(`${baseUrl}/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) }),
    });
    if (!res.ok) throw new Error(`飞书编辑消息失败: ${res.status}`);
  },

  // ─── 长连接 ───────────────────────────────────────────────────────────────

  async startLongConnection({ credentials, onEvent }) {
    const { appId, appSecret } = credentials;
    const baseUrl = process.env.FEISHU_BASE_URL || "https://open.feishu.cn";

    const client = new FeishuWsClient({ appId, appSecret, baseUrl });

    client.on("event", async (eventData: any) => {
      try {
        // 跳过 url_verification 等非消息事件
        const eventType = String(eventData?.header?.event_type ?? eventData?.type ?? "");
        if (eventType === "url_verification") return;
        // 必须有消息内容才路由到 pipeline
        if (!eventData?.event?.message) return;

        const parsed = parseWsEventToInbound(eventData);
        await onEvent(parsed);
      } catch (err: any) {
        console.error("[feishu-ws] event handling error", err?.message ?? err);
      }
    });

    await client.start();
    return { stop: () => client.stop() };
  },
};

// ─── 长连接：从 WS 事件体提取 ParsedInbound（与 parseInbound 逻辑一致但不依赖 HTTP 请求） ───

function parseWsEventToInbound(body: any): ParsedInbound {
  const eventId = String(body?.header?.event_id ?? "").trim();
  if (!eventId) throw new Error("eventId 缺失");
  const channelChatId = String(body?.event?.message?.chat_id ?? "").trim();
  const channelUserId = String(
    body?.event?.sender?.sender_id?.open_id ?? body?.event?.sender?.sender_id?.user_id ?? ""
  ).trim();
  const msgText = toTextPayload(body?.event?.message?.content);
  const timestampSec = Math.floor(Date.now() / 1000);

  // ── WS 模式附件提取（与 parseInbound 逻辑一致）──
  const attachments: UnifiedAttachment[] = [];
  const msgType = String(body?.event?.message?.message_type ?? "text");
  const rawContent = body?.event?.message?.content;
  let parsedContent: any = null;
  if (typeof rawContent === "string") {
    try { parsedContent = JSON.parse(rawContent); } catch { /* ignore */ }
  } else if (rawContent && typeof rawContent === "object") {
    parsedContent = rawContent;
  }
  if (parsedContent) {
    const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
    if (msgType === "image" && parsedContent.image_key) {
      attachments.push({
        type: "image",
        mimeType: "image/png",
        name: parsedContent.image_key,
        dataUrl: `${baseUrl}/open-apis/im/v1/images/${parsedContent.image_key}`,
      });
    } else if (msgType === "file" && parsedContent.file_key) {
      const mimeType = String(parsedContent.mime_type ?? "application/octet-stream");
      attachments.push({
        type: inferAttachmentType(mimeType),
        mimeType,
        name: parsedContent.file_name || parsedContent.file_key,
        sizeBytes: parsedContent.file_size != null ? Number(parsedContent.file_size) : undefined,
        dataUrl: `${baseUrl}/open-apis/im/v1/messages/${body?.event?.message?.message_id}/resources/${parsedContent.file_key}`,
      });
    } else if (msgType === "audio" && parsedContent.file_key) {
      attachments.push({
        type: "voice",
        mimeType: "audio/ogg",
        name: parsedContent.file_key,
        dataUrl: `${baseUrl}/open-apis/im/v1/messages/${body?.event?.message?.message_id}/resources/${parsedContent.file_key}`,
      });
    }
  }

  return {
    workspaceId: String(body?.header?.tenant_key ?? body?.tenant_key ?? "").trim(),
    eventId,
    nonce: eventId,
    timestampSec,
    channelChatId,
    channelUserId,
    text: msgText,
    rawBody: body,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

registerChannelProvider(feishuPlugin);

// ─── 保留旧导出（routes.ts 使用） ───────────────────────────────────────────

export async function testFeishuConfig(params: { app: any; tenantId: string; cfg: any }) {
  const cfg = params.cfg;
  const secretPayload = cfg.secretId
    ? await resolveChannelSecretPayload({ app: params.app, tenantId: params.tenantId, spaceId: cfg.spaceId ?? null, secretId: String(cfg.secretId) })
    : {};
  const tokenExpected =
    (cfg.secretEnvKey ? String(process.env[cfg.secretEnvKey] ?? "") : "") ||
    (typeof (secretPayload as any).verifyToken === "string" ? String((secretPayload as any).verifyToken) : "");
  if (!tokenExpected) throw Errors.channelConfigMissing();

  const providerConfig = cfg.providerConfig && typeof cfg.providerConfig === "object" ? cfg.providerConfig : {};
  const appIdEnvKey = String((providerConfig as any).appIdEnvKey ?? "");
  const appSecretEnvKey = String((providerConfig as any).appSecretEnvKey ?? "");
  const baseUrl = String(process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn");
  const appId =
    (appIdEnvKey ? String(process.env[appIdEnvKey] ?? "") : "") ||
    (typeof (secretPayload as any).appId === "string" ? String((secretPayload as any).appId) : "");
  const appSecret =
    (appSecretEnvKey ? String(process.env[appSecretEnvKey] ?? "") : "") ||
    (typeof (secretPayload as any).appSecret === "string" ? String((secretPayload as any).appSecret) : "");
  if (!appId || !appSecret) throw Errors.channelConfigMissing();
  await getFeishuTenantAccessToken({ baseUrl, appId, appSecret });
  return { ok: true, baseUrl, hasVerifyToken: true, hasAppCreds: true };
}
