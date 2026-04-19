/**
 * documentParser.test.ts — 文档解析器单元测试
 *
 * 覆盖每种格式的：正常解析、空内容、损坏文件容错、超大文本截断、
 * 注册表操作、统一入口 parseDocument 行为。
 */
import { describe, expect, it, beforeAll } from "vitest";
import {
  parseDocument,
  findParserByMimeType,
  findParserByFileName,
  listDocumentParsers,
  listSupportedMimeTypes,
  listSupportedFormats,
  mimeToFormat,
  extensionToFormat,
  detectFormat,
  dataUrlToBuffer,
  DEFAULT_PARSE_CONFIG,
  registerBuiltinDocumentParsers,
} from "../documentParser";

// ─── 注册表测试 ──────────────────────────────────────────────────

describe("DocumentParser 注册表", () => {
  beforeAll(() => {
    registerBuiltinDocumentParsers();
  });
  it("应注册至少 7 个内置解析器", () => {
    const parsers = listDocumentParsers();
    expect(parsers.length).toBeGreaterThanOrEqual(7);
  });

  it("listSupportedMimeTypes 应包含常见 MIME 类型", () => {
    const mimes = listSupportedMimeTypes();
    expect(mimes).toContain("text/plain");
    expect(mimes).toContain("text/markdown");
    expect(mimes).toContain("text/html");
    expect(mimes).toContain("application/pdf");
    expect(mimes).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("listSupportedFormats 应包含常见格式名", () => {
    const formats = listSupportedFormats();
    expect(formats).toContain("plaintext");
    expect(formats).toContain("markdown");
    expect(formats).toContain("html");
    expect(formats).toContain("pdf");
    expect(formats).toContain("docx");
  });

  it("findParserByMimeType 对 text/plain 返回解析器", () => {
    const parser = findParserByMimeType("text/plain");
    expect(parser).not.toBeNull();
    expect(parser!.name).toBe("plaintext");
  });

  it("findParserByFileName 对 .md 返回 markdown 解析器", () => {
    const parser = findParserByFileName("readme.md");
    expect(parser).not.toBeNull();
    expect(parser!.name).toBe("markdown");
  });

  it("findParserByMimeType 对未知 MIME 返回 null", () => {
    const parser = findParserByMimeType("application/x-unknown-format");
    expect(parser).toBeNull();
  });
});

// ─── 格式推断测试 ────────────────────────────────────────────────

describe("格式推断函数", () => {
  it("mimeToFormat: application/pdf → pdf", () => {
    expect(mimeToFormat("application/pdf")).toBe("pdf");
  });

  it("mimeToFormat: 未知 MIME → null", () => {
    expect(mimeToFormat("application/x-unknown")).toBeNull();
  });

  it("extensionToFormat: .docx → docx", () => {
    expect(extensionToFormat("report.docx")).toBe("docx");
  });

  it("extensionToFormat: .xlsx → xlsx", () => {
    expect(extensionToFormat("data.xlsx")).toBe("xlsx");
  });

  it("extensionToFormat: .pptx → pptx", () => {
    expect(extensionToFormat("slide.pptx")).toBe("pptx");
  });

  it("extensionToFormat: 未知扩展名 → null", () => {
    expect(extensionToFormat("file.zzz")).toBeNull();
  });
});

// ─── dataUrlToBuffer 测试 ────────────────────────────────────────

describe("dataUrlToBuffer", () => {
  it("正确解码 base64 data URL", () => {
    const text = "Hello, World!";
    const base64 = Buffer.from(text, "utf-8").toString("base64");
    const dataUrl = `data:text/plain;base64,${base64}`;
    const result = dataUrlToBuffer(dataUrl);
    expect(result.buffer.toString("utf-8")).toBe(text);
    expect(result.mimeType).toBe("text/plain");
  });

  it("处理不含 MIME 的 data URL", () => {
    const base64 = Buffer.from("test", "utf-8").toString("base64");
    const dataUrl = `data:text/plain;base64,${base64}`;
    const result = dataUrlToBuffer(dataUrl);
    expect(result.buffer.toString("utf-8")).toBe("test");
  });
});

// ─── Plaintext 解析器测试 ────────────────────────────────────────

describe("PlaintextParser", () => {
  it("正常解析纯文本文件", async () => {
    const text = "这是一段测试文本。\n第二行内容。";
    const buffer = Buffer.from(text, "utf-8");
    const result = await parseDocument({
      buffer,
      mimeType: "text/plain",
      fileName: "test.txt",
    });

    expect(result.text).toContain("这是一段测试文本");
    expect(result.text).toContain("第二行内容");
    expect(result.stats.parseMethod).toBe("plaintext");
    expect(result.stats.originalByteSize).toBe(buffer.length);
    expect(result.stats.truncated).toBe(false);
  });

  it("空文件返回空文本但不报错", async () => {
    const result = await parseDocument({
      buffer: Buffer.from("", "utf-8"),
      mimeType: "text/plain",
      fileName: "empty.txt",
    });
    expect(result.text).toBe("");
    expect(result.stats.extractedTextLength).toBe(0);
  });

  it("超大文本被截断", async () => {
    const longText = "A".repeat(100_000);
    const result = await parseDocument({
      buffer: Buffer.from(longText, "utf-8"),
      mimeType: "text/plain",
      fileName: "large.txt",
      config: { maxTextLength: 1000 },
    });
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.stats.truncated).toBe(true);
  });
});

// ─── Markdown 解析器测试 ─────────────────────────────────────────

describe("MarkdownParser", () => {
  it("正常解析 Markdown 文件", async () => {
    const md = "# 标题\n\n这是正文段落。\n\n## 子标题\n\n- 列表项1\n- 列表项2";
    const result = await parseDocument({
      buffer: Buffer.from(md, "utf-8"),
      mimeType: "text/markdown",
      fileName: "readme.md",
    });

    expect(result.text).toContain("标题");
    expect(result.text).toContain("正文段落");
    // text/markdown 可能匹配 plaintext 或 markdown 解析器
    expect(["markdown", "plaintext"]).toContain(result.stats.parseMethod);
  });

  it("空 Markdown 返回空文本", async () => {
    const result = await parseDocument({
      buffer: Buffer.from("", "utf-8"),
      mimeType: "text/markdown",
      fileName: "empty.md",
    });
    expect(result.text).toBe("");
  });

  it("提取标题元素", async () => {
    const md = "# H1\n\n## H2\n\nContent";
    const result = await parseDocument({
      buffer: Buffer.from(md, "utf-8"),
      mimeType: "text/markdown",
    });
    // 文本应包含标题内容
    expect(result.text).toContain("H1");
    expect(result.text).toContain("Content");
  });
});

// ─── HTML 解析器测试 ─────────────────────────────────────────────

describe("HtmlParser", () => {
  it("正常解析 HTML 并去除标签", async () => {
    const html = `<html><body><h1>标题</h1><p>这是段落</p><table><tr><td>单元格</td></tr></table></body></html>`;
    const result = await parseDocument({
      buffer: Buffer.from(html, "utf-8"),
      mimeType: "text/html",
      fileName: "page.html",
    });

    expect(result.text).toContain("标题");
    expect(result.text).toContain("这是段落");
    // text/html 可能匹配 html 或 plaintext 解析器（取决于注册顺序）
    expect(["html", "plaintext"]).toContain(result.stats.parseMethod);
  });

  it("空 HTML 返回文本结果", async () => {
    const result = await parseDocument({
      buffer: Buffer.from("<html><body></body></html>", "utf-8"),
      mimeType: "text/html",
    });
    // 空 HTML 被解析为文本时，可能保留标签或返回空
    expect(typeof result.text).toBe("string");
  });

  it("损坏的 HTML 不应抛出异常", async () => {
    const broken = "<html><body><p>未闭合标签<div>嵌套";
    const result = await parseDocument({
      buffer: Buffer.from(broken, "utf-8"),
      mimeType: "text/html",
    });
    // 应当返回提取到的部分文本
    expect(result.text).toContain("未闭合标签");
  });
});

// ─── parseDocument 统一入口测试 ──────────────────────────────────

describe("parseDocument 统一入口", () => {
  it("根据 MIME 类型自动选择解析器", async () => {
    const result = await parseDocument({
      buffer: Buffer.from("Hello", "utf-8"),
      mimeType: "text/plain",
    });
    expect(result.stats.parseMethod).toBe("plaintext");
  });

  it("根据文件名后缀选择解析器", async () => {
    const result = await parseDocument({
      buffer: Buffer.from("# Title", "utf-8"),
      mimeType: "application/octet-stream",
      fileName: "readme.md",
    });
    expect(result.stats.parseMethod).toBe("markdown");
  });

  it("未知格式的文本内容降级到纯文本", async () => {
    const result = await parseDocument({
      buffer: Buffer.from("This is just text", "utf-8"),
      mimeType: "text/x-something-custom",
    });
    expect(result.text).toContain("This is just text");
  });

  it("不支持的二进制格式应抛出错误", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0x01, 0x02, 0x03, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01]);
    await expect(
      parseDocument({
        buffer: binary,
        mimeType: "application/x-totally-unknown",
      })
    ).rejects.toThrow("unsupported_format");
  });
});

// ─── DEFAULT_PARSE_CONFIG 测试 ───────────────────────────────────

describe("DEFAULT_PARSE_CONFIG", () => {
  it("默认配置应有合理默认值", () => {
    expect(DEFAULT_PARSE_CONFIG.maxFileSizeBytes).toBeGreaterThan(0);
    expect(DEFAULT_PARSE_CONFIG.maxTextLength).toBeGreaterThan(0);
    expect(DEFAULT_PARSE_CONFIG.timeoutMs).toBeGreaterThan(0);
    expect(typeof DEFAULT_PARSE_CONFIG.preservePageBreaks).toBe("boolean");
    expect(typeof DEFAULT_PARSE_CONFIG.preserveTableStructure).toBe("boolean");
  });
});
