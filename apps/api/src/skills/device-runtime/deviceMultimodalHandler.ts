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
  type DeviceMultimodalResponse,
  type DeviceAttachment,
  type DeviceModality,
} from "@openslin/shared";

import { orchestrateChatTurn } from "../orchestrator/modules/orchestrator";

const _logger = new StructuredLogger({ module: "api:deviceMultimodal" });

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
  const multimodalCaps = (meta?.multimodalCapabilities ?? meta?.multimodalConfig) as Record<string, unknown> | null;
  const maxFileSize = Number(multimodalCaps?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE);
  const allowedModalities = Array.isArray(multimodalCaps?.modalities)
    ? (multimodalCaps.modalities as string[])
    : null;
  const supportedFormats = (multimodalCaps?.supportedFormats ?? DEFAULT_SUPPORTED_FORMATS) as Record<string, string[]>;

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
 * 处理设备多模态查询
 *
 * 流程：设备查询 → 校验 → orchestrateChatTurn() → 流式推送回设备
 */
export async function processDeviceQuery(params: ProcessDeviceQueryParams): Promise<void> {
  const { ws, payload, deviceRecord, pool, app } = params;
  const { sessionId, message, attachments, conversationId } = payload;

  const sendResponse = (resp: Omit<DeviceMultimodalResponse, "type" | "sessionId">) => {
    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify({ type: "device_response", sessionId, ...resp }));
      }
    } catch { /* WS 发送失败忽略 */ }
  };

  // 1. 基础校验
  if (!message?.trim()) {
    sendResponse({ error: "message 不能为空", done: true });
    return;
  }

  // 2. 附件校验（元数据驱动）
  if (attachments && attachments.length > 0) {
    const validation = validateAttachments(attachments, deviceRecord);
    if (!validation.valid) {
      _logger.warn("attachment validation failed", {
        deviceId: deviceRecord.deviceId,
        error: validation.error,
      });
      sendResponse({ error: validation.error, done: true });
      return;
    }
  }

  // 3. 构建 LlmSubject（复用现有的认证上下文）
  const subject = {
    tenantId: deviceRecord.tenantId,
    spaceId: deviceRecord.spaceId ?? "",
    subjectId: deviceRecord.ownerSubjectId ?? `device:${deviceRecord.deviceId}`,
  };

  // 4. 将设备附件转换为 orchestrateChatTurn 的 attachments 格式
  const orchAttachments = (attachments ?? [])
    .filter((a: DeviceAttachment) => a.dataUrl)
    .map((a: DeviceAttachment) => ({
      type: a.type,
      mimeType: a.mimeType,
      name: a.name,
      dataUrl: a.dataUrl!,
    }));

  // 5. 调用核心管线
  _logger.info("processing device query", {
    deviceId: deviceRecord.deviceId,
    sessionId,
    messageLen: message.length,
    attachmentCount: orchAttachments.length,
    attachmentTypes: orchAttachments.map((a: { type: string }) => a.type),
  });

  try {
    const result = await orchestrateChatTurn({
      app,
      pool,
      subject,
      message: message.trim(),
      locale: "zh-CN",
      conversationId: conversationId || sessionId,
      persistSession: true,
      attachments: orchAttachments.length > 0 ? orchAttachments : undefined,
    });

    // 6. 将响应作为流式消息推送回设备
    // orchestrateChatTurn 返回完整文本，按 chunk 分割推送以模拟流式体验
    const replyText = typeof result.replyText === "string"
      ? result.replyText
      : "";

    if (replyText) {
      // 分块推送（每 chunk ~200 字符，模拟流式）
      const CHUNK_SIZE = 200;
      for (let i = 0; i < replyText.length; i += CHUNK_SIZE) {
        sendResponse({ chunk: replyText.slice(i, i + CHUNK_SIZE) });
      }
    }

    // 7. 发送完成标记
    sendResponse({ done: true });

    _logger.info("device query completed", {
      deviceId: deviceRecord.deviceId,
      sessionId,
      replyLen: replyText.length,
      hasToolSuggestions: !!(result as any).toolSuggestions?.length,
    });
  } catch (err: any) {
    _logger.error("device query failed", {
      deviceId: deviceRecord.deviceId,
      sessionId,
      error: err?.message ?? "unknown",
    });
    sendResponse({ error: err?.message ?? "处理失败", done: true });
  }
}
