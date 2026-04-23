import type { FastifyReply, FastifyRequest } from "fastify";
import { Errors } from "../../../lib/errors";

// ─── 插件接口类型 ────────────────────────────────────────────────────────────

export type IngressContext = {
  app: any;
  req: FastifyRequest;
  reply: FastifyReply;
  tenantId: string;
  cfg: any; // ChannelWebhookConfigRow
  secretPayload: Record<string, unknown>;
};

export type ParsedInbound = {
  workspaceId: string;
  eventId: string;
  nonce: string;
  timestampSec: number;
  channelChatId: string;
  channelUserId: string;
  text: string;
  rawBody: any;
};

export type ChannelProviderPlugin = {
  provider: string;
  /** 从请求中解析 workspaceId（用于查配置，在签名验证之前） */
  extractWorkspaceId: (req: FastifyRequest) => string;
  /** 签名/Token 验证 */
  verifySignature: (ctx: IngressContext, rawBody: string) => Promise<void>;
  /** 解析标准化入站消息 */
  parseInbound: (ctx: IngressContext) => Promise<ParsedInbound>;
  /** 构造出站回复体 */
  formatOutbound: (locale: string, replyText: string, correlation: any) => any;
  /** 同步回复（可选，有则同步发送，无则走 outbox 异步） */
  sendReply?: (ctx: IngressContext, text: string, chatId: string) => Promise<void>;
  /** 协议级处理（如 Discord PING、Feishu url_verification），返回非 null 则短路 */
  handleProtocol?: (ctx: IngressContext) => Promise<any | null>;
};

// ─── 插件注册表 ──────────────────────────────────────────────────────────────

const registry: Record<string, ChannelProviderPlugin> = {};

export function registerChannelProvider(plugin: ChannelProviderPlugin) {
  registry[plugin.provider] = plugin;
}

export function getChannelProviderPlugin(provider: string): ChannelProviderPlugin {
  const p = registry[provider];
  if (!p) throw new Error(`未知 provider: ${provider}`);
  return p;
}

// ─── 后向兼容旧接口 ─────────────────────────────────────────────────────────

export type ChannelProviderAdapter = {
  provider: string;
  handle: (ctx: { app: any; req: FastifyRequest; reply: FastifyReply }) => Promise<any>;
};

export function getChannelProviderAdapter(provider: string): ChannelProviderAdapter {
  const key = String(provider ?? "").trim();
  // 尝试新插件管道
  const plugin = registry[key];
  if (plugin) {
    return {
      provider: plugin.provider,
      handle: async (ctx) => {
        const { channelIngressPipeline } = await import("./channelPipeline");
        return channelIngressPipeline(ctx, plugin);
      },
    };
  }
  throw Errors.badRequest("未知 provider");
}
