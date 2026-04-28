/**
 * 设备多模态查询处理器
 *
 * 处理设备端（AI眼镜/汽车/IoT等）通过 WebSocket 发送的多模态消息，
 * 复用 orchestrateChatTurn() 核心管线，将流式 AI 响应推送回设备。
 *
 * 设计原则：
 * - 元数据驱动：通过设备注册的能力标签校验多模态权限
 * - 复用核心管线：调用已有的 orchestrateChatTurn()
 * - 轻量化：最小协议设计
 */
import type { Pool } from "pg";
import {
  StructuredLogger,
  type DeviceMultimodalQuery,
  type DeviceAttachment,
  type DeviceModality,
} from "@openslin/shared";

import { invokeModelChatUpstreamStream } from "../model-gateway/modules/invokeChatUpstreamStream";
import { upsertSessionContext } from "../../modules/memory/sessionContextRepo";
import type { DeviceStreamEvent } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:deviceMultimodal" });

// ── WS 安全发送辅助 ───────────────────────────────────────────

function safeSend(ws: WsLike, data: DeviceStreamEvent | Record<string, unknown>): void {
  try {
    if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(data));
  } catch { /* WS 发送失败忽略 */ }
}

// ── 大文件限制 ──────────────────────────────────────────────────

/** 默认最大附件大小：5MB（base64 编码后约 6.67MB dataUrl） */
const DEFAULT_MAX_FILE_SIZE = 5_000_000;

/** dataUrl base64 上限（含 header，约 20MB 安全余量） */
const MAX_DATA_URL_LENGTH = 20_000_000;

// ── 默认支持格式 ────────────────────────────────────────────────

const DEFAULT_SUPPORTED_FORMATS: Record<DeviceModality, string[]> = {
  image: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  audio: ["audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg", "audio/webm"],
  video: ["video/mp4", "video/webm"],
};

// ── 类型定义 ────────────────────────────────────────────────────

interface DeviceRecord {
  deviceId: string;
  tenantId: string;
  spaceId: string | null;
  ownerScope: string;
  ownerSubjectId: string | null;
  metadata?: Record<string, unknown> | null;
}

interface WsLike {
  send(data: string): void;
  readyState: number;
}

export interface ProcessDeviceQueryParams {
  ws: WsLike;
  payload: DeviceMultimodalQuery;
  deviceRecord: DeviceRecord;
  pool: Pool;
  app: any; // FastifyInstance
}

// ── 附件校验 ────────────────────────────────────────────────────

function validateAttachments(
  attachments: DeviceAttachment[],
  deviceRecord: DeviceRecord,
): { valid: boolean; error?: string } {
  // 从设备 metadata 读取多模态配置（元数据驱动）
  const meta = deviceRecord.metadata as Record<string, unknown> | null;

  // 优先按 DeviceMultimodalCapabilities 结构解析
  const caps = meta?.multimodalCapabilities as { modalities?: string[]; multimodalConfig?: Record<string, unknown> } | undefined;
  const cfgFromCaps = caps?.multimodalConfig as { maxFileSize?: number; supportedFormats?: Record<string, string[]> } | undefined;

  // 兼容旧路径：直接存储的 multimodalConfig
  const legacyCfg = meta?.multimodalConfig as { maxFileSize?: number; supportedFormats?: Record<string, string[]> } | undefined;

  const effectiveCfg = cfgFromCaps ?? legacyCfg ?? null;

  const maxFileSize = Number(effectiveCfg?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
  const allowedModalities = Array.isArray(caps?.modalities)
    ? (caps!.modalities as string[])
    : null;
  const supportedFormats = (effectiveCfg?.supportedFormats ?? DEFAULT_SUPPORTED_FORMATS) as Record<string, string[]>;

  for (const att of attachments) {
    // 模态校验（如果设备声明了能力则严格校验）
    const modalityKey = att.type === "voice" ? "audio" : att.type;
    if (allowedModalities && !allowedModalities.includes(modalityKey) && !allowedModalities.includes(att.type)) {
      return { valid: false, error: `设备不支持 ${att.type} 模态` };
    }

    // 大小校验（dataUrl 长度粗略估算原始大小：base64 约为原始的 4/3）
    if (att.dataUrl) {
      if (att.dataUrl.length > MAX_DATA_URL_LENGTH) {
        return { valid: false, error: `附件 ${att.name ?? att.type} 超过大小限制（>50MB 拒绝）` };
      }
      // 估算原始字节数
      const base64Part = att.dataUrl.includes(",") ? att.dataUrl.split(",")[1] : att.dataUrl;
      const estimatedBytes = Math.ceil((base64Part?.length ?? 0) * 3 / 4);
      if (estimatedBytes > maxFileSize) {
        return { valid: false, error: `附件 ${att.name ?? att.type} 超过大小限制（${Math.round(maxFileSize / 1_000_000)}MB）` };
      }
    }

    // 格式校验
    const allowed = supportedFormats[modalityKey] ?? DEFAULT_SUPPORTED_FORMATS[modalityKey as DeviceModality] ?? [];
    if (allowed.length > 0 && att.mimeType && !allowed.includes(att.mimeType)) {
      return { valid: false, error: `不支持的文件格式: ${att.mimeType}` };
    }
  }

  return { valid: true };
}

// ── 核心处理函数 ────────────────────────────────────────────────

/**
 * 提取 base64 payload（去掉 dataUrl header）
 */
function extractBase64Payload(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/**
 * 处理设备多模态查询（流式）
 *
 * 使用 invokeModelChatUpstreamStream 实现每个 delta 立即通过 WS 推送，
 * 采用 DeviceStreamEvent 协议（device_stream_start/delta/end/error）。
 */
export async function processDeviceQuery(params: ProcessDeviceQueryParams): Promise<void> {
  const { ws, payload, deviceRecord, pool, app } = params;
  const { message, attachments, conversationId, sessionId } = payload;
  const streamId = `ds_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. 基础校验
  if (!message?.trim()) {
    safeSend(ws, { type: "device_stream_error", sessionId, streamId, error: "empty message" });
    safeSend(ws, { type: "device_response", sessionId, error: "empty message", done: true });
    return;
  }

  // 2. 附件校验（复用现有 validateAttachments）
  if (attachments && attachments.length > 0) {
    const validation = validateAttachments(attachments, deviceRecord);
    if (!validation.valid) {
      _logger.warn("attachment validation failed", {
        deviceId: deviceRecord.deviceId,
        error: validation.error,
      });
      safeSend(ws, { type: "device_stream_error", sessionId, streamId, error: validation.error ?? "invalid attachments" });
      safeSend(ws, { type: "device_response", sessionId, error: validation.error ?? "invalid attachments", done: true });
      return;
    }
  }

  // 3. 构建 LlmSubject（复用现有的认证上下文，与 processDeviceQuery 保持一致）
  const subject = {
    tenantId: deviceRecord.tenantId,
    spaceId: deviceRecord.spaceId ?? "",
    subjectId: deviceRecord.ownerSubjectId ?? `device:${deviceRecord.deviceId}`,
  };

  // 4. 将设备附件转换为标准格式
  const orchAttachments = (attachments ?? [])
    .filter((a: DeviceAttachment) => a.dataUrl)
    .map((a: DeviceAttachment) => ({
      type: a.type,
      mimeType: a.mimeType,
      name: a.name,
      dataUrl: a.dataUrl!,
    }));

  // 5. 构建 LLM 消息（参考 dispatch.streamAnswer.ts 的多模态内容构建方式）
  const contentParts: Array<{ type: string; [k: string]: any }> = [];

  const imageAtts = orchAttachments.filter((a) => a.type === "image" && a.dataUrl);
  const voiceAtts = orchAttachments.filter((a) => a.type === "voice" && a.dataUrl);
  const videoAtts = orchAttachments.filter((a) => a.type === "video" && a.dataUrl);

  for (const att of imageAtts) {
    contentParts.push({ type: "image_url", image_url: { url: att.dataUrl, detail: "auto" } });
  }
  for (const att of voiceAtts) {
    contentParts.push({ type: "input_audio", input_audio: { data: extractBase64Payload(att.dataUrl), format: "wav" } });
  }
  for (const att of videoAtts) {
    contentParts.push({ type: "video_url", video_url: { url: att.dataUrl } });
  }

  const userContent = contentParts.length > 0
    ? [...contentParts, { type: "text" as const, text: message.trim() }]
    : message.trim();

  const messages: Array<{ role: string; content: string | Array<{ type: string; [k: string]: any }> }> = [
    { role: "user", content: userContent },
  ];

  // 6. 发送流开始信号
  safeSend(ws, { type: "device_stream_start", sessionId, streamId });

  _logger.info("processing device query (streaming)", {
    deviceId: deviceRecord.deviceId,
    sessionId,
    streamId,
    messageLen: message.length,
    attachmentCount: orchAttachments.length,
    attachmentTypes: orchAttachments.map((a) => a.type),
  });

  // 7. 真流式调用
  let fullText = "";
  try {
    await invokeModelChatUpstreamStream({
      app,
      subject,
      body: {
        purpose: "device.multimodal.stream",
        messages,
        stream: true,
        constraints: {},
        ...(orchAttachments.length > 0 ? { attachments: orchAttachments as any } : {}),
      },
      locale: "zh-CN",
      onDelta: (text: string) => {
        fullText += text;
        safeSend(ws, { type: "device_stream_delta", sessionId, streamId, delta: text });
        safeSend(ws, { type: "device_response", sessionId, chunk: text });
      },
    });

    safeSend(ws, { type: "device_stream_end", sessionId, streamId, fullText });
    safeSend(ws, { type: "device_response", sessionId, chunk: fullText, done: true });

    // ── 会话持久化：将本轮对话写入 session_contexts ──
    if (conversationId && deviceRecord.spaceId) {
      try {
        const subjectId = deviceRecord.ownerSubjectId ?? `device:${deviceRecord.deviceId}`;
        const nowIso = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        await upsertSessionContext({
          pool,
          tenantId: deviceRecord.tenantId,
          spaceId: deviceRecord.spaceId,
          subjectId,
          sessionId: conversationId,
          context: {
            v: 2,
            messages: [
              { role: "user", content: message.trim(), at: nowIso },
              { role: "assistant", content: fullText, at: nowIso },
            ],
          },
          expiresAt,
        });
      } catch (persistErr: any) {
        _logger.warn("session persist failed (non-fatal)", { deviceId: deviceRecord.deviceId, conversationId, error: persistErr?.message });
      }
    }

    _logger.info("device query completed (streaming)", {
      deviceId: deviceRecord.deviceId,
      sessionId,
      streamId,
      conversationId: conversationId ?? null,
      replyLen: fullText.length,
    });
  } catch (err: any) {
    _logger.error("device streaming failed, falling back to batch", {
      deviceId: deviceRecord.deviceId,
      sessionId,
      streamId,
      error: err?.message ?? "unknown",
    });
    // 流式失败：发送错误信号
    safeSend(ws, { type: "device_stream_error", sessionId, streamId, error: err?.message || "streaming failed" });
    safeSend(ws, { type: "device_response", sessionId, error: err?.message || "streaming failed", done: true });
  }
}
