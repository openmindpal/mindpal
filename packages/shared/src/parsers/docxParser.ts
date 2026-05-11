/**
 * parsers/docxParser.ts — Word/Excel/PowerPoint 文档解析器
 *
 * 包含 DocxParser、XlsxParser、PptxParser 实现。
 * 依赖：mammoth (docx), xlsx (excel), unzipper (pptx)
 */
import type { DocumentParser, DocumentParseInput, DocumentParseResult, DocumentParseConfig } from "../documentParser";
import { defaultParseConfig } from "../documentParser";
import type { DocumentElement, DocumentFormatName } from "../documentParser";

// ─── 工具函数 ──────────────────────────────────────────────────

/** 截断文本到指定长度 */
function truncateText(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  return { text: text.slice(0, maxLen), truncated: true };
}

/** 去除 HTML 标签 */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** 简单 HTML 表格转 Markdown */
export function htmlTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(trMatch[1]!)) !== null) {
      cells.push(stripHtmlTags(cellMatch[1]!).trim());
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return "";

  const maxCols = Math.max(...rows.map(r => r.length));
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    while (row.length < maxCols) row.push("");
    lines.push("| " + row.join(" | ") + " |");
    if (i === 0) {
      lines.push("| " + row.map(() => "---").join(" | ") + " |");
    }
  }
  return lines.join("\n");
}

/** 简单 CSV 行解析 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/** 二维数组转 Markdown 表格 */
function rowsToMarkdownTable(rows: any[][]): string {
  if (rows.length === 0) return "";
  const maxCols = Math.max(...rows.map(r => r.length));
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i]!.map(c => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " "));
    while (cells.length < maxCols) cells.push("");
    lines.push("| " + cells.join(" | ") + " |");
    if (i === 0) {
      lines.push("| " + cells.map(() => "---").join(" | ") + " |");
    }
  }
  return lines.join("\n");
}

// ─── DocxParser ──────────────────────────────────────────────────

/**
 * Word (.docx) 解析器 — 需要安装 mammoth 依赖
 * 安装: npm install mammoth
 */
export class DocxParser implements DocumentParser {
  readonly name = "docx";
  readonly supportedFormats: DocumentFormatName[] = ["docx"];
  readonly supportedMimeTypes = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
  ];

  supports(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);
    const warnings: string[] = [];

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    let mammoth: any;
    try {
      mammoth = await import("mammoth");
    } catch {
      throw new Error("mammoth_not_installed: 请安装 mammoth 依赖 (npm install mammoth)");
    }

    // 先提取为 HTML（保留结构），再转为 Markdown 风格文本
    const htmlResult = await mammoth.convertToHtml({ buffer: input.buffer });
    const rawHtml = String(htmlResult.value ?? "");
    const convertWarnings = (htmlResult.messages ?? [])
      .filter((m: any) => m.type === "warning")
      .map((m: any) => String(m.message));
    warnings.push(...convertWarnings.slice(0, 10));

    // 也提取纯文本
    const textResult = await mammoth.extractRawText({ buffer: input.buffer });
    const rawText = String(textResult.value ?? "");

    const { text, truncated } = truncateText(rawText, cfg.maxTextLength);
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    // 从 HTML 提取结构化元素
    const elements: DocumentElement[] = [];
    let firstHeading: string | undefined;

    const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let hMatch;
    while ((hMatch = headingRegex.exec(rawHtml)) !== null) {
      const level = Number(hMatch[1]);
      const headingText = stripHtmlTags(hMatch[2]!).trim();
      if (headingText) {
        elements.push({ type: "heading", text: headingText, level });
        if (!firstHeading) firstHeading = headingText;
      }
    }

    // 提取表格
    if (cfg.preserveTableStructure) {
      const tableRegex = /<table[\s\S]*?<\/table>/gi;
      let tMatch;
      while ((tMatch = tableRegex.exec(rawHtml)) !== null) {
        const tableText = htmlTableToMarkdown(tMatch[0]);
        if (tableText.trim()) elements.push({ type: "table", text: tableText });
      }
    }

    if (elements.length === 0) {
      elements.push({ type: "paragraph", text });
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
        parseMethod: "mammoth",
        truncated,
        warnings,
      },
    };
  }
}

// ─── XlsxParser ──────────────────────────────────────────────────

/**
 * Excel (.xlsx / .csv) 解析器 — 需要安装 xlsx 依赖
 * 安装: npm install xlsx
 */
export class XlsxParser implements DocumentParser {
  readonly name = "xlsx";
  readonly supportedFormats: DocumentFormatName[] = ["xlsx", "csv"];
  readonly supportedMimeTypes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/csv",
  ];

  supports(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);
    const warnings: string[] = [];

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    // CSV 使用内置解析
    const isCsv = input.mimeType === "text/csv" || input.mimeType === "application/csv"
      || input.fileName?.toLowerCase().endsWith(".csv");
    if (isCsv) {
      return this.parseCsv(input, cfg, startedAt);
    }

    let XLSX: any;
    try {
      XLSX = await import("xlsx");
    } catch {
      throw new Error("xlsx_not_installed: 请安装 xlsx 依赖 (npm install xlsx)");
    }

    const workbook = XLSX.read(input.buffer, { type: "buffer" });
    const elements: DocumentElement[] = [];
    const textParts: string[] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      elements.push({ type: "heading", text: `Sheet: ${sheetName}`, level: 2 });

      if (cfg.preserveTableStructure) {
        // 转为 Markdown 表格
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (rows.length > 0) {
          const mdTable = rowsToMarkdownTable(rows);
          elements.push({ type: "table", text: mdTable });
          textParts.push(`## ${sheetName}\n\n${mdTable}`);
        }
      } else {
        const csv = XLSX.utils.sheet_to_csv(sheet);
        textParts.push(`## ${sheetName}\n\n${csv}`);
        elements.push({ type: "paragraph", text: csv });
      }
    }

    const fullText = textParts.join("\n\n");
    const { text, truncated } = truncateText(fullText, cfg.maxTextLength);
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    return {
      text,
      elements,
      documentMetadata: {
        wordCount: text.split(/\s+/).filter(Boolean).length,
        extra: { sheetCount: workbook.SheetNames.length, sheetNames: workbook.SheetNames },
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: text.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "xlsx",
        truncated,
        warnings,
      },
    };
  }

  private async parseCsv(input: DocumentParseInput, cfg: DocumentParseConfig, startedAt: number): Promise<DocumentParseResult> {
    const warnings: string[] = [];
    const rawText = input.buffer.toString("utf8");
    const lines = rawText.split("\n").filter(l => l.trim());
    const rows = lines.map(line => parseCsvLine(line));

    let text: string;
    const elements: DocumentElement[] = [];
    if (cfg.preserveTableStructure && rows.length > 0) {
      const mdTable = rowsToMarkdownTable(rows);
      text = mdTable;
      elements.push({ type: "table", text: mdTable });
    } else {
      text = rawText;
      elements.push({ type: "paragraph", text: rawText });
    }

    const { text: truncText, truncated } = truncateText(text, cfg.maxTextLength);
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    return {
      text: truncText,
      elements,
      documentMetadata: {
        wordCount: truncText.split(/\s+/).filter(Boolean).length,
        extra: { rowCount: rows.length },
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: truncText.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "csv",
        truncated,
        warnings,
      },
    };
  }
}

// ─── PptxParser ──────────────────────────────────────────────────

/**
 * PowerPoint (.pptx) 解析器 — 基于 ZIP 解压 + XML 解析
 * 不需要额外依赖（使用 Node.js 内置 zlib）
 */
export class PptxParser implements DocumentParser {
  readonly name = "pptx";
  readonly supportedFormats: DocumentFormatName[] = ["pptx"];
  readonly supportedMimeTypes = [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint",
  ];

  supports(mimeType: string): boolean {
    return this.supportedMimeTypes.includes(mimeType.toLowerCase());
  }

  async parse(input: DocumentParseInput): Promise<DocumentParseResult> {
    const startedAt = Date.now();
    const cfg = defaultParseConfig(input.config);
    const warnings: string[] = [];

    if (input.buffer.length > cfg.maxFileSizeBytes) {
      throw new Error(`file_too_large: ${input.buffer.length} > ${cfg.maxFileSizeBytes}`);
    }

    // PPTX 是 ZIP 格式，内含 ppt/slides/slide*.xml
    let unzipper: any;
    try {
      unzipper = await import("unzipper");
    } catch {
      throw new Error("unzipper_not_installed: 请安装 unzipper 依赖 (npm install unzipper)");
    }

    const directory = await unzipper.Open.buffer(input.buffer);
    const slideFiles = directory.files
      .filter((f: any) => /^ppt\/slides\/slide\d+\.xml$/i.test(f.path))
      .sort((a: any, b: any) => {
        const numA = Number(a.path.match(/slide(\d+)/)?.[1] ?? 0);
        const numB = Number(b.path.match(/slide(\d+)/)?.[1] ?? 0);
        return numA - numB;
      });

    const elements: DocumentElement[] = [];
    const textParts: string[] = [];

    for (let i = 0; i < slideFiles.length; i++) {
      const file = slideFiles[i]!;
      const content = (await file.buffer()).toString("utf8");
      // 从 XML 中提取所有 <a:t> 文本节点
      const texts: string[] = [];
      const textRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
      let tMatch;
      while ((tMatch = textRegex.exec(content)) !== null) {
        const t = tMatch[1]!.trim();
        if (t) texts.push(t);
      }
      const slideText = texts.join(" ");
      if (slideText) {
        elements.push({ type: "heading", text: `幻灯片 ${i + 1}`, level: 2, pageNumber: i + 1 });
        elements.push({ type: "paragraph", text: slideText, pageNumber: i + 1 });
        textParts.push(`## 幻灯片 ${i + 1}\n\n${slideText}`);
      }
    }

    // 也尝试提取备注
    const noteFiles = directory.files
      .filter((f: any) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(f.path));
    for (const nf of noteFiles) {
      const content = (await nf.buffer()).toString("utf8");
      const texts: string[] = [];
      const textRegex = /<a:t[^>]*>([\s\S]*?)<\/a:t>/gi;
      let tMatch;
      while ((tMatch = textRegex.exec(content)) !== null) {
        const t = tMatch[1]!.trim();
        if (t && !t.match(/^\d+$/)) texts.push(t); // 过滤纯页码
      }
      const noteText = texts.join(" ");
      if (noteText.length > 10) {
        textParts.push(`> 备注: ${noteText}`);
      }
    }

    const fullText = textParts.join("\n\n");
    const { text, truncated } = truncateText(fullText, cfg.maxTextLength);
    if (truncated) warnings.push(`text_truncated_at_${cfg.maxTextLength}`);

    return {
      text,
      elements,
      documentMetadata: {
        pageCount: slideFiles.length,
        wordCount: text.split(/\s+/).filter(Boolean).length,
      },
      stats: {
        originalByteSize: input.buffer.length,
        extractedTextLength: text.length,
        elementCount: elements.length,
        parseTimeMs: Date.now() - startedAt,
        parseMethod: "pptx-xml",
        truncated,
        warnings,
      },
    };
  }
}
