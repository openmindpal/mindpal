/**
 * parsers/pdfParser.ts — PDF 文档解析器
 *
 * 需要安装 pdf-parse 依赖: npm install pdf-parse
 */
import type { DocumentParser, DocumentParseInput, DocumentParseResult, DocumentParseConfig } from "../documentParser";
import { defaultParseConfig } from "../documentParser";
import type { DocumentElement, DocumentFormatName } from "../documentParser";

/** 截断文本到指定长度 */
function truncateText(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  return { text: text.slice(0, maxLen), truncated: true };
}

export class PdfParser implements DocumentParser {
  readonly name = "pdf";
  readonly supportedFormats: DocumentFormatName[] = ["pdf"];
  readonly supportedMimeTypes = ["application/pdf"];

  supports(mimeType: string): boolean {
    return mimeType.toLowerCase() === "application/pdf";
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);
    const warnings: string[] = [];

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    let pdfParse: any;
    try {
      pdfParse = (await import("pdf-parse")).default ?? (await import("pdf-parse"));
    } catch {
      throw new Error("pdf_parse_not_installed: 请安装 pdf-parse 依赖 (npm install pdf-parse)");
    }

    const data = await pdfParse(input.buffer, { max: 0 });
    let rawText = String(data.text ?? "");

    if (!rawText.trim() && cfg.ocrFallback) {
      warnings.push("pdf_no_text_extracted_ocr_required");
      rawText = "[PDF 为扫描件或图片型 PDF，需要 OCR 解析]";
    }

    const { text, truncated } = truncateText(rawText, cfg.maxTextLength);
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    // 按页面分割元素
    const elements: DocumentElement[] = [];
    if (cfg.preservePageBreaks && data.numpages > 1) {
      // pdf-parse 在页面间插入 \n\n，尝试按此分割
      const pages = text.split(/\n{3,}/);
      for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i]!.trim();
        if (pageText) {
          elements.push({ type: "paragraph", text: pageText, pageNumber: i + 1 });
        }
        if (i < pages.length - 1) {
          elements.push({ type: "page_break", text: "", pageNumber: i + 1 });
        }
      }
    } else {
      elements.push({ type: "paragraph", text });
    }

    return {
      text,
      elements,
      documentMetadata: {
        title: data.info?.Title || undefined,
        author: data.info?.Author || undefined,
        createdAt: data.info?.CreationDate || undefined,
        modifiedAt: data.info?.ModDate || undefined,
        pageCount: data.numpages,
        wordCount: text.split(/\s+/).filter(Boolean).length,
        extra: { pdfVersion: data.version },
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: text.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "pdf-parse",
        truncated,
        warnings,
      },
    };
  }
}
