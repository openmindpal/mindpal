import { z } from "zod";
import { Errors } from "../../../lib/errors";
import { timingSafeTokenCompare } from "./channelCommon";
import { resolveChannelSecretPayload } from "./channelSecret";
import { feishuSendTextToChatWithRetry, getFeishuTenantAccessToken } from "./feishu";
import type { ChannelProviderPlugin, IngressContext, ParsedInbound } from "./providerAdapters";
import { registerChannelProvider } from "./providerAdapters";

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

    return {
      workspaceId: String(body?.header?.tenant_key ?? body?.tenant_key ?? "").trim(),
      eventId,
      nonce: nonce || eventId,
      timestampSec,
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
      await feishuSendTextToChatWithRetry({
        baseUrl,
        tenantAccessToken: accessToken,
        chatId,
        text,
        maxAttempts: Math.min(3, Number(cfg.maxAttempts ?? 2)),
        backoffMsBase: Number(cfg.backoffMsBase ?? 200),
      });
    }
  },
};

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
