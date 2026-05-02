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
  validateAttachmentBatch,
  DEFAULT_MULTIMODAL_CAPABILITIES,
  type UnifiedAttachment,
  type MultimodalCapabilities,
} from "@mindpal/shared";

import { orchestrateChatTurn } from "../orchestrator/modules/orchestrator";
import type { DeviceStreamEvent } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "api:deviceMultimodal" });

// ── WS 安全发送辅助 ───────────────────────────────────────────

function safeSend(ws: WsLike, data: DeviceStreamEvent | Record<string, unknown>): void {
  try {
    if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(data));
  } catch { /* WS 发送失败忽略 */ }
}

// 大文件限制和默认支持格式已迁移至 @mindpal/shared（DEFAULT_MULTIMODAL_CAPABILITIES）

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

// ── 设备能力解析（元数据驱动） ──────────────────────────────────

/**
 * 从设备元数据构建 MultimodalCapabilities（保持元数据驱动，DEFAULT_MULTIMODAL_CAPABILITIES 仅作兜底）
 */
function getDeviceCapabilities(deviceRecord: DeviceRecord): MultimodalCapabilities {
  const meta = deviceRecord.metadata as Record<string, unknown> | null;

  // 优先按 DeviceMultimodalCapabilities 结构解析
  const caps = meta?.multimodalCapabilities as { modalities?: string[]; multimodalConfig?: Record<string, unknown> } | undefined;
  const cfgFromCaps = caps?.multimodalConfig as { maxFileSize?: number; supportedFormats?: Record<string, string[]> } | undefined;

  // 兼容旧路径：直接存储的 multimodalConfig
  const legacyCfg = meta?.multimodalConfig as { maxFileSize?: number; supportedFormats?: Record<string, string[]> } | undefined;

  const effectiveCfg = cfgFromCaps ?? legacyCfg ?? null;

  if (!caps && !effectiveCfg) return DEFAULT_MULTIMODAL_CAPABILITIES;

  const modalities = (Array.isArray(caps?.modalities) ? caps!.modalities : DEFAULT_MULTIMODAL_CAPABILITIES.modalities) as MultimodalCapabilities["modalities"];
  const fmts = effectiveCfg?.supportedFormats;
  const maxSize = effectiveCfg?.maxFileSize;

  return {
    modalities,
    constraints: {
      image: {
        maxFileSizeBytes: maxSize != null ? Number(maxSize) : DEFAULT_MULTIMODAL_CAPABILITIES.constraints.image?.maxFileSizeBytes,
        supportedMimeTypes: fmts?.image ?? DEFAULT_MULTIMODAL_CAPABILITIES.constraints.image?.supportedMimeTypes,
      },
      audio: {
        maxFileSizeBytes: maxSize != null ? Number(maxSize) : DEFAULT_MULTIMODAL_CAPABILITIES.constraints.audio?.maxFileSizeBytes,
        supportedMimeTypes: fmts?.audio ?? DEFAULT_MULTIMODAL_CAPABILITIES.constraints.audio?.supportedMimeTypes,
      },
      video: {
        maxFileSizeBytes: maxSize != null ? Number(maxSize) : DEFAULT_MULTIMODAL_CAPABILITIES.constraints.video?.maxFileSizeBytes,
        supportedMimeTypes: fmts?.video ?? DEFAULT_MULTIMODAL_CAPABILITIES.constraints.video?.supportedMimeTypes,
      },
      document: {
        maxFileSizeBytes: maxSize != null ? Number(maxSize) : DEFAULT_MULTIMODAL_CAPABILITIES.constraints.document?.maxFileSizeBytes,
        supportedMimeTypes: fmts?.document ?? DEFAULT_MULTIMODAL_CAPABILITIES.constraints.document?.supportedMimeTypes,
      },
    },
  };
}

/**
 * 处理设备多模态查询
 *
 * 通过 orchestrateChatTurn 标准编排管线处理，自动获得会话持久化、工具执行与 toolContext 持久化能力，
 * 回复结果通过 DeviceStreamEvent 协议（device_stream_start/delta/end/error）推送至设备端。
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

  // 2. 附件校验（使用 shared 层统一校验函数）
  if (attachments && attachments.length > 0) {
    const unifiedAtts: UnifiedAttachment[] = attachments.map((a: DeviceAttachment) => ({
      type: a.type as UnifiedAttachment["type"],
      mimeType: a.mimeType,
      name: a.name,
      dataUrl: a.dataUrl,
    }));
    const deviceCaps = getDeviceCapabilities(deviceRecord);
    const { errors } = validateAttachmentBatch(unifiedAtts, deviceCaps);
    if (errors.length > 0) {
      const errorMsg = errors.join("; ");
      _logger.warn("attachment validation failed", {
        deviceId: deviceRecord.deviceId,
        error: errorMsg,
      });
      safeSend(ws, { type: "device_stream_error", sessionId, streamId, error: errorMsg });
      safeSend(ws, { type: "device_response", sessionId, error: errorMsg, done: true });
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

  // 5. 发送流开始信号
  safeSend(ws, { type: "device_stream_start", sessionId, streamId });

  _logger.info("processing device query via orchestrateChatTurn", {
    deviceId: deviceRecord.deviceId,
    sessionId,
    streamId,
    messageLen: message.length,
    attachmentCount: orchAttachments.length,
    attachmentTypes: orchAttachments.map((a) => a.type),
    conversationId: conversationId ?? null,
  });

  // 6. 调用标准编排管线（内置会话持久化 + 工具执行 + toolContext 持久化）
  const traceId = `device_${deviceRecord.deviceId}_${Date.now()}`;
  try {
    const result = await orchestrateChatTurn({
      app,
      pool,
      subject,
      message: message.trim(),
      locale: "zh-CN",
      conversationId: conversationId ?? undefined,
      authorization: null,
      traceId,
      attachments: orchAttachments.length > 0 ? orchAttachments : undefined,
    });

    const fullText = result.replyText ?? "";

    // 将完整回复通过 WS 推送给设备端（保持 device_stream_delta/end 协议）
    safeSend(ws, { type: "device_stream_delta", sessionId, streamId, delta: fullText });
    safeSend(ws, { type: "device_response", sessionId, chunk: fullText });
    safeSend(ws, { type: "device_stream_end", sessionId, streamId, fullText });
    safeSend(ws, { type: "device_response", sessionId, chunk: fullText, done: true });

    _logger.info("device query completed via orchestrateChatTurn", {
      deviceId: deviceRecord.deviceId,
      sessionId,
      streamId,
      conversationId: result.conversationId ?? conversationId ?? null,
      replyLen: fullText.length,
      hasToolSuggestions: !!(result as any).toolSuggestions,
    });
  } catch (err: any) {
    _logger.error("device orchestrateChatTurn failed", {
      deviceId: deviceRecord.deviceId,
      sessionId,
      streamId,
      error: err?.message ?? "unknown",
    });
    safeSend(ws, { type: "device_stream_error", sessionId, streamId, error: err?.message || "orchestration failed" });
    safeSend(ws, { type: "device_response", sessionId, error: err?.message || "orchestration failed", done: true });
  }
}
