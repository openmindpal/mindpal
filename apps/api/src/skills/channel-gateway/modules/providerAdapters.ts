import type { FastifyReply, FastifyRequest } from "fastify";
import type { UnifiedAttachment } from "@mindpal/shared";

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
  /** IM 渠道提取的附件（可选，由各 Provider parseInbound 填充） */
  attachments?: UnifiedAttachment[];
};

/**
 * 根据 MIME 类型推断附件模态类型。
 * 供各 Provider 的 parseInbound 共用。
 */
export function inferAttachmentType(mimeType: string): UnifiedAttachment["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "voice";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

/** Provider 元数据（驱动前端 UI 动态渲染） */
export type ChannelProviderMeta = {
  provider: string;
  displayName: Record<string, string>; // { zh: "飞书", en: "Feishu" }
  icon: string; // provider icon URL 或内置 icon key
  setupModes: ("qr" | "manual")[];
  features: {
    admissionPolicy: boolean;
    groupChat: boolean;
    directMessage: boolean;
    richMessage: boolean;
  };
  supportsEdit?: boolean;  // 声明 Provider 是否支持消息编辑（用于流式回复）
  /** 手动配置时需要的字段 schema（仅 manual 模式用，可选） */
  manualConfigFields?: Array<{
    key: string;
    label: Record<string, string>;
    type: "text" | "secret";
    required: boolean;
  }>;
};

export type ChannelSetupResult = {
  workspaceId: string;
  credentials: Record<string, string>;
  webhookRegistered?: boolean;
  displayName?: string;
};

/** sendReply 返回值 */
export type SendReplyResult = { messageId?: string } | void;

export type ChannelProviderPlugin = {
  provider: string;
  /** 元数据声明（驱动前端渲染） */
  meta: ChannelProviderMeta;
  // --- 现有运行时方法（保持不变） ---
  /** 从请求中解析 workspaceId（用于查配置，在签名验证之前） */
  extractWorkspaceId: (req: FastifyRequest) => string;
  /** 签名/Token 验证 */
  verifySignature: (ctx: IngressContext, rawBody: string) => Promise<void>;
  /** 解析标准化入站消息 */
  parseInbound: (ctx: IngressContext) => Promise<ParsedInbound>;
  /** 构造出站回复体 */
  formatOutbound: (locale: string, replyText: string, correlation: any) => any;
  /** 同步回复（可选）。返回平台消息 ID 以支持后续编辑 */
  sendReply?: (ctx: IngressContext, text: string, chatId: string) => Promise<SendReplyResult>;
  /** 编辑已发送的消息（流式更新用，可选） */
  editMessage?: (ctx: IngressContext, messageId: string, text: string, chatId: string) => Promise<void>;
  /** 协议级处理（如 Discord PING、Feishu url_verification），返回非 null 则短路 */
  handleProtocol?: (ctx: IngressContext) => Promise<any | null>;
  // --- 新增 setup 方法（均可选） ---
  /** 生成扫码授权 URL（ISV 级别，用于组织授权） */
  buildSetupAuthorizeUrl?: (params: { redirectUri: string; state: string }) => string;
  /** 处理扫码授权回调：code → 凭据 + 自动配置 */
  handleSetupCallback?: (params: {
    code: string; redirectUri: string; state: string;
  }) => Promise<ChannelSetupResult>;
  /** 向平台自动注册 Webhook 回调 URL（可选） */
  registerWebhook?: (params: {
    credentials: Record<string, string>;
    callbackUrl: string;
  }) => Promise<{ ok: boolean; registrationId?: string }>;
  /** 启动 WebSocket 长连接接收事件（可选，与 webhook 模式并存） */
  startLongConnection?: (params: {
    credentials: Record<string, string>;
    onEvent: (parsed: ParsedInbound) => Promise<void>;
  }) => Promise<{ stop: () => void }>;
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

/** 返回所有已注册 Provider 的元数据列表（供前端动态渲染） */
export function listChannelProviderMetas(): ChannelProviderMeta[] {
  return Object.values(registry).map(p => p.meta);
}

/** 安全获取 plugin（不抛异常版本） */
export function getChannelProviderPluginOrNull(provider: string): ChannelProviderPlugin | null {
  return registry[provider] ?? null;
}
