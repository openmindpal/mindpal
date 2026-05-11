/**
 * documentParser.ts — 统一文档解析抽象层
 *
 * 提供多格式文档解析器接口 + 注册表 + 内置解析器，
 * 所有解析器实现统一接口，支持动态注册与配置化。
 *
 * 架构与 chunkStrategy.ts 对齐：接口 + 注册表 + 内置实现 + 统一入口
 *
 * 外部格式解析器（PDF/DOCX/XLSX/PPTX）→ ./parsers/
 *
 * 依赖方向：
 *   packages/shared (本文件)
 *   → worker/knowledge/processor.ts
 *   → worker/knowledge/ingest.ts
 *   → api/skills/knowledge-rag/routes.ts
 *   → api/skills/orchestrator/dispatch.streamAnswer.ts
 */

import crypto from "node:crypto";
import { resolveNumber, resolveString, resolveBoolean } from "./runtimeConfig";
import { PdfParser, DocxParser, XlsxParser, PptxParser, stripHtmlTags, htmlTableToMarkdown } from "./parsers";

// ─── 类型定义 ──────────────────────────────────────────────────

/** 支持的文档格式名称 */
export type DocumentFormatName =
  | "pdf"
  | "docx"
  | "xlsx"
  | "csv"
  | "pptx"
  | "html"
  | "markdown"
  | "plaintext"
  | "rtf"
  | "json"
  | "xml";

/** 文档结构元素类型 */
export type DocumentElementType =
  | "heading"
  | "paragraph"
  | "table"
  | "code"
  | "list"
  | "image_ref"
  | "page_break"
  | "footnote"
  | "metadata";

/** 文档结构元素 */
export interface DocumentElement {
  /** 元素类型 */
  type: DocumentElementType;
  /** 元素文本内容 */
  text: string;
  /** 标题层级 (1-6, 仅 heading 有效) */
  level?: number;
  /** 页码 (仅分页文档有效) */
  pageNumber?: number;
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
}

/** 文档解析结果 */
export interface DocumentParseResult {
  /** 提取的全文纯文本（用于分块 + 嵌入） */
  text: string;
  /** 结构化元素列表（用于高级分块策略） */
  elements: DocumentElement[];
  /** 文档元数据（标题、作者、创建日期等） */
  documentMetadata: DocumentMetadata;
  /** 解析统计 */
  stats: DocumentParseStats;
}

/** 文档元数据 */
export interface DocumentMetadata {
  /** 文档标题 (从文档属性或首标题提取) */
  title?: string;
  /** 作者 */
  author?: string;
  /** 创建日期 */
  createdAt?: string;
  /** 修改日期 */
  modifiedAt?: string;
  /** 页数 (分页文档) */
  pageCount?: number;
  /** 字数 (提取后) */
  wordCount?: number;
  /** 语言 */
  language?: string;
  /** 额外属性 */
  extra?: Record<string, unknown>;
}

/** 解析统计 */
export interface DocumentParseStats {
  /** 原始文件大小 (字节) */
  originalByteSize: number;
  /** 提取文本长度 (字符) */
  extractedTextLength: number;
  /** 结构元素数量 */
  elementCount: number;
  /** 解析耗时 (ms) */
  parseTimeMs: number;
  /** 解析方法 */
  parseMethod: string;
  /** 是否截断 */
  truncated: boolean;
  /** 警告信息 */
  warnings: string[];
}

/** 文档解析配置 */
export interface DocumentParseConfig {
  /** 最大文件大小（字节，超过则拒绝） */
  maxFileSizeBytes: number;
  /** 最大提取文本长度（字符，超过则截断） */
  maxTextLength: number;
  /** 是否保留分页标记 */
  preservePageBreaks: boolean;
  /** 是否保留表格结构（Markdown 格式） */
  preserveTableStructure: boolean;
  /** 是否提取文档元数据 */
  extractMetadata: boolean;
  /** OCR 回退配置（仅 PDF） */
  ocrFallback: boolean;
  /** 外部 OCR 端点（可选） */
  ocrEndpoint?: string;
  /** 超时时间 (ms) */
  timeoutMs: number;
}

/** 文档解析器接口 */
export interface DocumentParser {
  /** 解析器名称 */
  readonly name: string;
  /** 支持的格式列表 */
  readonly supportedFormats: DocumentFormatName[];
  /** 支持的 MIME 类型列表 */
  readonly supportedMimeTypes: string[];
  /** 解析文档 */
  parse(input: DocumentParseInput): Promise<DocumentParseResult>;
  /** 检查是否支持指定 MIME 类型 */
  supports(mimeType: string): boolean;
}

/** 解析输入 */
export interface DocumentParseInput {
  /** 文件二进制内容 */
  buffer: Buffer;
  /** MIME 类型 */
  mimeType: string;
  /** 文件名（可选，用于格式推断） */
  fileName?: string;
  /** 解析配置覆盖 */
  config?: Partial<DocumentParseConfig>;
}

// ─── 默认配置 ──────────────────────────────────────────────────

export const DEFAULT_PARSE_CONFIG: DocumentParseConfig = {
  maxFileSizeBytes: 100 * 1024 * 1024, // 100MB
  maxTextLength: 2_000_000, // 200万字符
  preservePageBreaks: true,
  preserveTableStructure: true,
  extractMetadata: true,
  ocrFallback: false,
  timeoutMs: 60_000,
};

export function defaultParseConfig(overrides?: Partial<DocumentParseConfig>): DocumentParseConfig {
  return { ...DEFAULT_PARSE_CONFIG, ...overrides };
}

// ─── 工具函数 ──────────────────────────────────────────────────

/** 根据 MIME 类型推断格式名 */
export function mimeToFormat(mimeType: string): DocumentFormatName | null {
  const m = mimeType.toLowerCase().trim();
  if (m === "application/pdf") return "pdf";
  if (m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || m === "application/msword") return "docx";
  if (m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || m === "application/vnd.ms-excel") return "xlsx";
  if (m === "text/csv" || m === "application/csv") return "csv";
  if (m === "application/vnd.openxmlformats-officedocument.presentationml.presentation" || m === "application/vnd.ms-powerpoint") return "pptx";
  if (m === "text/html" || m === "application/xhtml+xml") return "html";
  if (m === "text/markdown" || m === "text/x-markdown") return "markdown";
  if (m === "text/plain") return "plaintext";
  if (m === "application/rtf" || m === "text/rtf") return "rtf";
  if (m === "application/json") return "json";
  if (m === "text/xml" || m === "application/xml") return "xml";
  return null;
}

/** 根据文件扩展名推断格式名 */
export function extensionToFormat(fileName: string): DocumentFormatName | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf": return "pdf";
    case "docx": case "doc": return "docx";
    case "xlsx": case "xls": return "xlsx";
    case "csv": return "csv";
    case "pptx": case "ppt": return "pptx";
    case "html": case "htm": return "html";
    case "md": case "markdown": return "markdown";
    case "txt": case "text": case "log": return "plaintext";
    case "rtf": return "rtf";
    case "json": return "json";
    case "xml": return "xml";
    case "yaml": case "yml": case "toml": case "ini": case "conf": return "plaintext";
    default: return null;
  }
}

/** 推断文档格式 */
export function detectFormat(mimeType: string, fileName?: string): DocumentFormatName | null {
  return mimeToFormat(mimeType) ?? (fileName ? extensionToFormat(fileName) : null);
}

/** 将 base64 data URL 转为 Buffer */
export function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    // 尝试直接作为 base64 解码
    return { buffer: Buffer.from(dataUrl, "base64"), mimeType: "application/octet-stream" };
  }
  return { buffer: Buffer.from(match[2]!, "base64"), mimeType: match[1]! };
}

/** 截断文本到指定长度 */
function truncateText(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  return { text: text.slice(0, maxLen), truncated: true };
}

// ─── 内置解析器: Plaintext / Markdown / HTML ──

class PlaintextParser implements DocumentParser {
  readonly name = "plaintext";
  readonly supportedFormats: DocumentFormatName[] = ["plaintext", "json", "xml", "csv"];
  readonly supportedMimeTypes = [
    "text/plain", "application/json", "text/xml", "application/xml",
    "text/csv", "application/csv", "text/yaml", "application/yaml",
    "text/x-toml",
  ];

  supports(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase()) || mimeType.startsWith("text/");
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    const rawText = input.buffer.toString("utf8");
    const { text, truncated } = truncateText(rawText, cfg.maxTextLength);
    const warnings: string[] = [];
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    const elements: DocumentElement[] = [{ type: "paragraph", text }];

    return {
      text,
      elements,
      documentMetadata: {
        wordCount: text.split(/\s+/).filter(Boolean).length,
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: text.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "plaintext",
        truncated,
        warnings,
      },
    };
  }
}

class MarkdownParser implements DocumentParser {
  readonly name = "markdown";
  readonly supportedFormats: DocumentFormatName[] = ["markdown"];
  readonly supportedMimeTypes = ["text/markdown", "text/x-markdown"];

  supports(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    const rawText = input.buffer.toString("utf8");
    const { text, truncated } = truncateText(rawText, cfg.maxTextLength);
    const warnings: string[] = [];
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    // 提取结构化元素
    const elements: DocumentElement[] = [];
    const lines = text.split("\n");
    let currentParagraph = "";
    let firstHeading: string | undefined;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        if (currentParagraph.trim()) {
          elements.push({ type: "paragraph", text: currentParagraph.trim() });
          currentParagraph = "";
        }
        const level = headingMatch[1]!.length;
        const headingText = headingMatch[2]!.trim();
        elements.push({ type: "heading", text: headingText, level });
        if (!firstHeading) firstHeading = headingText;
      } else if (line.startsWith("```")) {
        if (currentParagraph.trim()) {
          elements.push({ type: "paragraph", text: currentParagraph.trim() });
          currentParagraph = "";
        }
        elements.push({ type: "code", text: line });
      } else if (line.startsWith("|") && line.includes("|")) {
        if (currentParagraph.trim()) {
          elements.push({ type: "paragraph", text: currentParagraph.trim() });
          currentParagraph = "";
        }
        elements.push({ type: "table", text: line });
      } else {
        currentParagraph += line + "\n";
      }
    }
    if (currentParagraph.trim()) {
      elements.push({ type: "paragraph", text: currentParagraph.trim() });
    }

    return {
      text,
      elements,
      documentMetadata: {
        title: firstHeading,
        wordCount: text.split(/\s+/).filter(Boolean).length,
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: text.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "markdown",
        truncated,
        warnings,
      },
    };
  }
}

class HtmlParser implements DocumentParser {
  readonly name = "html";
  readonly supportedFormats: DocumentFormatName[] = ["html"];
  readonly supportedMimeTypes = ["text/html", "application/xhtml+xml"];

  supports(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    const rawHtml = input.buffer.toString("utf8");

    // 提取 <title>
    const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1]!.trim() : undefined;

    // 移除 script/style 标签
    let cleaned = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");

    // 结构化提取
    const elements: DocumentElement[] = [];

    // 提取标题 h1-h6
    const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let hMatch;
    while ((hMatch = headingRegex.exec(cleaned)) !== null) {
      const level = Number(hMatch[1]);
      const text = stripHtmlTags(hMatch[2]!).trim();
      if (text) elements.push({ type: "heading", text, level });
    }

    // 提取表格
    if (cfg.preserveTableStructure) {
      const tableRegex = /<table[\s\S]*?<\/table>/gi;
      let tMatch;
      while ((tMatch = tableRegex.exec(cleaned)) !== null) {
        const tableText = htmlTableToMarkdown(tMatch[0]);
        if (tableText.trim()) elements.push({ type: "table", text: tableText });
      }
    }

    // 全文纯文本
    const text = stripHtmlTags(cleaned)
      .replace(/\s+/g, " ")
      .trim();

    const { text: truncatedText, truncated } = truncateText(text, cfg.maxTextLength);
    const warnings: string[] = [];
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    if (elements.length === 0) {
      elements.push({ type: "paragraph", text: truncatedText });
    }

    return {
      text: truncatedText,
      elements,
      documentMetadata: {
        title,
        wordCount: truncatedText.split(/\s+/).filter(Boolean).length,
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: truncatedText.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "html",
        truncated,
        warnings,
      },
    };
  }
}

// ─── 解析器注册表 ──────────────────────────────────────────────

const _parsers = new Map<string, DocumentParser>();

/** 注册文档解析器 */
export function registerDocumentParser(parser: DocumentParser): void {
  _parsers.set(parser.name, parser);
}

/** 获取指定名称的解析器 */
export function getDocumentParser(name: string): DocumentParser | undefined {
  return _parsers.get(name);
}

/** 列出所有已注册的解析器 */
export function listDocumentParsers(): DocumentParser[] {
  return Array.from(_parsers.values());
}

/** 根据 MIME 类型查找支持的解析器 */
export function findParserByMimeType(mimeType: string): DocumentParser | null {
  const m = mimeType.toLowerCase().trim();
  for (const parser of _parsers.values()) {
    if (parser.supports(m)) return parser;
  }
  return null;
}

/** 根据文件名查找支持的解析器 */
export function findParserByFileName(fileName: string): DocumentParser | null {
  const format = extensionToFormat(fileName);
  if (!format) return null;
  for (const parser of _parsers.values()) {
    if (parser.supportedFormats.includes(format)) return parser;
  }
  return null;
}

// ─── 显式注册内置解析器（消费方调用，消除模块级副作用）─────────

let _builtinRegistered = false;

/** 显式注册所有内置文档解析器（首次使用前调用一次） */
export function registerBuiltinDocumentParsers(): void {
  if (_builtinRegistered) return;
  _builtinRegistered = true;
  registerDocumentParser(new PlaintextParser());
  registerDocumentParser(new MarkdownParser());
  registerDocumentParser(new HtmlParser());
  registerDocumentParser(new PdfParser());
  registerDocumentParser(new DocxParser());
  registerDocumentParser(new XlsxParser());
  registerDocumentParser(new PptxParser());
}

// ─── 统一入口 ──────────────────────────────────────────────────

/**
 * 解析文档 — 统一入口
 *
 * 自动根据 MIME 类型或文件名选择合适的解析器。
 * 解析失败时降级到纯文本提取。
 *
 * @param input - 解析输入（buffer + mimeType + fileName）
 * @returns 解析结果
 */
export async function parseDocument(input: DocumentParseInput): Promise<DocumentParseResult> {
  // 确保内置解析器已注册（安全保障）
  registerBuiltinDocumentParsers();
  const startedAt = Date.now();

  // 1. 查找解析器
  let parser = findParserByMimeType(input.mimeType);
  if (!parser && input.fileName) {
    parser = findParserByFileName(input.fileName);
  }

  // 2. 如果找不到解析器，尝试作为纯文本
  if (!parser) {
    // 检查是否为文本类型
    if (input.mimeType.startsWith("text/") || isLikelyTextBuffer(input.buffer)) {
      parser = getDocumentParser("plaintext")!;
    } else {
      throw new Error(`unsupported_format: 不支持的文件格式 (${input.mimeType}${input.fileName ? ", " + input.fileName : ""})`);
    }
  }

  // 3. 执行解析
  try {
    return await parser.parse(input);
  } catch (e: any) {
    // 解析失败，尝试降级到纯文本
    const msg = String(e?.message ?? e);
    if (parser.name !== "plaintext" && isLikelyTextBuffer(input.buffer)) {
      console.warn(`[documentParser] ${parser.name} 解析失败 (${msg})，降级到纯文本`);
      const fallback = getDocumentParser("plaintext")!;
      const result = await fallback.parse(input);
      result.stats.warnings.push(`parser_degraded: ${parser.name} → plaintext (${msg})`);
      result.stats.parseMethod = `plaintext (degraded from ${parser.name})`;
      return result;
    }
    throw e;
  }
}

/** 检查 buffer 是否可能是文本内容（检查前 8KB） */
function isLikelyTextBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8192);
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!;
    // 控制字符（除了 TAB/LF/CR）
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) nonText++;
  }
  return nonText / sample.length < 0.1; // <10% 非文本字符视为文本
}

/** 列出所有支持的 MIME 类型 */
export function listSupportedMimeTypes(): string[] {
  const mimes = new Set<string>();
  for (const parser of _parsers.values()) {
    for (const m of parser.supportedMimeTypes) mimes.add(m);
  }
  return Array.from(mimes);
}

/** 列出所有支持的文件格式 */
export function listSupportedFormats(): DocumentFormatName[] {
  const formats = new Set<DocumentFormatName>();
  for (const parser of _parsers.values()) {
    for (const f of parser.supportedFormats) formats.add(f);
  }
  return Array.from(formats);
}

/** 从环境变量解析文档解析配置 */
export function resolveParseConfigFromEnv(): Partial<DocumentParseConfig> {
  const config: Partial<DocumentParseConfig> = {};
  const maxFileSize = resolveNumber("DOCUMENT_PARSER_MAX_FILE_SIZE_MB").value;
  if (maxFileSize > 0) config.maxFileSizeBytes = maxFileSize * 1024 * 1024;
  const maxTextLen = resolveNumber("DOCUMENT_PARSER_MAX_TEXT_LENGTH").value;
  if (maxTextLen > 0) config.maxTextLength = maxTextLen;
  if (resolveBoolean("DOCUMENT_PARSER_OCR_FALLBACK").value) config.ocrFallback = true;
  const ocrEndpoint = resolveString("DOCUMENT_PARSER_OCR_ENDPOINT").value;
  if (ocrEndpoint) config.ocrEndpoint = ocrEndpoint;
  const timeout = resolveNumber("DOCUMENT_PARSER_TIMEOUT_MS").value;
  if (timeout > 0) config.timeoutMs = timeout;
  return config;
}
