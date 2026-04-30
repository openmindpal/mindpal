import type { ContentPart, ImageContentPart, AudioContentPart, VideoContentPart, TextContentPart } from "./index";

/* ================================================================== */
/*  类型定义                                                            */
/* ================================================================== */

/** 统一附件类型（兼容 DeviceAttachment + channelAttachment + WebAttachment） */
export interface UnifiedAttachment {
  /** 附件模态类型 */
  type: "image" | "document" | "voice" | "video";
  /** MIME 类型 */
  mimeType: string;
  /** 文件名（可选） */
  name?: string;
  /** 文件原始字节大小（可选，校验时优先使用） */
  sizeBytes?: number;
  /** RFC 2397 data URL（data:mime;base64,...） */
  dataUrl?: string;
  /** 纯文本文档内容（仅 document 类型可用） */
  textContent?: string;
}

/** 元数据驱动的多模态能力约束 */
export interface MultimodalCapabilities {
  /** 允许的模态列表 */
  modalities: Array<"image" | "audio" | "video" | "document">;
  /** 每种模态的校验约束（key 为模态名） */
  constraints: Partial<Record<string, {
    /** 最大文件字节数 */
    maxFileSizeBytes?: number;
    /** 允许的 MIME 类型列表 */
    supportedMimeTypes?: string[];
  }>>;
}

/* ================================================================== */
/*  默认能力配置                                                        */
/* ================================================================== */

/** 系统级默认多模态能力（兜底配置，各入口层可覆盖） */
export const DEFAULT_MULTIMODAL_CAPABILITIES: MultimodalCapabilities = {
  modalities: ["image", "audio", "video", "document"],
  constraints: {
    image: {
      maxFileSizeBytes: 20_000_000,
      supportedMimeTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
    },
    audio: {
      maxFileSizeBytes: 20_000_000,
      supportedMimeTypes: [
        "audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg", "audio/webm",
        "audio/flac", "audio/aac", "audio/mp4", "audio/x-m4a",
      ],
    },
    video: {
      maxFileSizeBytes: 50_000_000,
      supportedMimeTypes: ["video/mp4", "video/webm", "video/ogg", "video/quicktime"],
    },
    document: {
      maxFileSizeBytes: 20_000_000,
      supportedMimeTypes: [
        "application/pdf", "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain", "text/csv", "text/markdown", "application/json",
        "text/html", "application/xml", "text/xml",
      ],
    },
  },
};

/* ================================================================== */
/*  音频格式映射                                                        */
/* ================================================================== */

/** MIME → 短格式名映射表 */
const AUDIO_MIME_MAP: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp3": "mp3",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
};

/** 文件扩展名 → 短格式名 */
const AUDIO_EXT_MAP: Record<string, string> = {
  wav: "wav",
  mp3: "mp3",
  ogg: "ogg",
  opus: "ogg",
  webm: "webm",
  flac: "flac",
  aac: "aac",
  m4a: "m4a",
};

/**
 * MIME → 短格式名映射（替代 dispatch.streamAnswer.ts 中的 normalizeAudioAttachmentFormat）。
 *
 * 先查精确 MIME 映射表，再做子串匹配，最后从文件扩展名降级推断。
 * 支持：wav, mp3, mpeg, ogg, opus, webm, flac, aac, m4a。
 *
 * @param mimeType - 音频 MIME 类型
 * @param fileName - 文件名（可选，用于扩展名降级）
 * @returns 短格式名，如 "mp3", "wav" 等
 */
export function normalizeAudioFormat(mimeType: string, fileName?: string): string {
  const mime = String(mimeType ?? "").toLowerCase().trim();

  // 1. 精确匹配
  if (AUDIO_MIME_MAP[mime]) return AUDIO_MIME_MAP[mime];

  // 2. 子串匹配（兼容 dispatch.streamAnswer.ts 中的 includes 逻辑）
  if (mime.includes("wav")) return "wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("opus")) return "ogg";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("m4a")) return "m4a";

  // 3. 从文件扩展名降级推断
  const ext = String(fileName ?? "").split(".").pop()?.toLowerCase();
  if (ext && AUDIO_EXT_MAP[ext]) return AUDIO_EXT_MAP[ext];

  // 4. 兜底默认
  return "wav";
}

/* ================================================================== */
/*  校验函数                                                            */
/* ================================================================== */

/**
 * 将附件 type 映射为模态 key（voice → audio）。
 * @internal
 */
function toModalityKey(attType: string): string {
  return attType === "voice" ? "audio" : attType;
}

/**
 * 从 dataUrl base64 payload 估算原始文件字节数。
 * 算法与 deviceMultimodalHandler.ts 一致：base64Part.length * 3 / 4。
 * @internal
 */
function estimateBytesFromDataUrl(dataUrl: string): number {
  const base64Part = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return Math.ceil((base64Part?.length ?? 0) * 3 / 4);
}

/**
 * 校验单个附件是否满足能力约束。
 *
 * 校验步骤：
 * 1. 模态类型映射（voice → audio）
 * 2. 检查模态是否被允许
 * 3. MIME 类型检查
 * 4. 文件大小检查（优先 sizeBytes，降级从 dataUrl 估算）
 *
 * @param att  - 待校验附件
 * @param caps - 多模态能力约束
 * @returns 校验结果
 */
export function validateAttachment(
  att: UnifiedAttachment,
  caps: MultimodalCapabilities,
): { valid: boolean; error?: string } {
  const modalityKey = toModalityKey(att.type);

  // 1. 模态是否被允许
  if (
    !caps.modalities.includes(modalityKey as any) &&
    !caps.modalities.includes(att.type as any)
  ) {
    return { valid: false, error: `不支持的模态: ${att.type}` };
  }

  // 2. 获取约束配置
  const constraint = caps.constraints[modalityKey];
  if (!constraint) {
    // 无约束 → 默认通过
    return { valid: true };
  }

  // 3. MIME 类型检查
  if (
    constraint.supportedMimeTypes &&
    constraint.supportedMimeTypes.length > 0 &&
    att.mimeType &&
    !constraint.supportedMimeTypes.includes(att.mimeType)
  ) {
    return { valid: false, error: `不支持的文件格式: ${att.mimeType}` };
  }

  // 4. 文件大小检查
  if (constraint.maxFileSizeBytes != null) {
    let fileSize = att.sizeBytes;

    // 如果 sizeBytes 不存在但 dataUrl 存在，从 dataUrl 估算
    if (fileSize == null && att.dataUrl) {
      fileSize = estimateBytesFromDataUrl(att.dataUrl);
    }

    if (fileSize != null && fileSize > constraint.maxFileSizeBytes) {
      const limitMB = Math.round(constraint.maxFileSizeBytes / 1_000_000);
      return {
        valid: false,
        error: `附件 ${att.name ?? att.type} 超过大小限制（${limitMB}MB）`,
      };
    }
  }

  return { valid: true };
}

/**
 * 批量校验附件。
 *
 * @param atts - 附件数组
 * @param caps - 多模态能力约束
 * @returns valid: 通过校验的附件；errors: 失败的错误信息
 */
export function validateAttachmentBatch(
  atts: UnifiedAttachment[],
  caps: MultimodalCapabilities,
): { valid: UnifiedAttachment[]; errors: string[] } {
  const valid: UnifiedAttachment[] = [];
  const errors: string[] = [];
  for (const att of atts) {
    const result = validateAttachment(att, caps);
    if (result.valid) {
      valid.push(att);
    } else {
      errors.push(result.error!);
    }
  }
  return { valid, errors };
}

/* ================================================================== */
/*  转换函数                                                            */
/* ================================================================== */

/**
 * 从 dataUrl 提取 base64 payload（去掉 data:...;base64, 前缀）。
 *
 * @param dataUrl - RFC 2397 data URL
 * @returns 纯 base64 字符串
 */
export function extractBase64Payload(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

/**
 * 转换为 orchestrateChatTurn 参数格式。
 *
 * @param att - 统一附件
 * @returns orchestrator 所需的附件对象
 */
export function toOrchestratorAttachment(att: UnifiedAttachment): {
  type: string;
  mimeType: string;
  name?: string;
  dataUrl: string;
} {
  return {
    type: att.type,
    mimeType: att.mimeType,
    ...(att.name != null ? { name: att.name } : {}),
    dataUrl: att.dataUrl ?? "",
  };
}

/**
 * 批量转换 UnifiedAttachment 为 LLM ContentPart 数组。
 *
 * 转换规则（精确匹配 dispatch.streamAnswer.ts 现有逻辑）：
 * - image → ImageContentPart: `{ type: "image_url", image_url: { url, detail: "auto" } }`
 * - voice → AudioContentPart: `{ type: "input_audio", input_audio: { data, format } }`
 * - video → VideoContentPart: `{ type: "video_url", video_url: { url } }`
 * - document → TextContentPart（如有 textContent）或 ImageContentPart（如有 dataUrl）
 *
 * @param atts - 统一附件数组
 * @returns LLM ContentPart 数组
 */
export function toContentParts(atts: UnifiedAttachment[]): ContentPart[] {
  const parts: ContentPart[] = [];

  for (const att of atts) {
    switch (att.type) {
      case "image": {
        if (att.dataUrl) {
          parts.push({
            type: "image_url",
            image_url: { url: att.dataUrl, detail: "auto" },
          } satisfies ImageContentPart);
        }
        break;
      }
      case "voice": {
        if (att.dataUrl) {
          const format = normalizeAudioFormat(att.mimeType, att.name);
          parts.push({
            type: "input_audio",
            input_audio: {
              data: extractBase64Payload(att.dataUrl),
              format: format as AudioContentPart["input_audio"]["format"],
            },
          } satisfies AudioContentPart);
        }
        break;
      }
      case "video": {
        if (att.dataUrl) {
          parts.push({
            type: "video_url",
            video_url: { url: att.dataUrl },
          } satisfies VideoContentPart);
        }
        break;
      }
      case "document": {
        if (att.textContent) {
          parts.push({
            type: "text",
            text: att.textContent,
          } satisfies TextContentPart);
        } else if (att.dataUrl) {
          // 文档 dataUrl 作为图片嵌入（用于 OCR / 视觉理解场景）
          parts.push({
            type: "image_url",
            image_url: { url: att.dataUrl, detail: "auto" },
          } satisfies ImageContentPart);
        }
        break;
      }
    }
  }

  return parts;
}
