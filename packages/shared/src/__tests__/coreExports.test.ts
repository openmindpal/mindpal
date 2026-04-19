import { describe, expect, it } from "vitest";
import { isSupportedSchemaMigrationKind, SUPPORTED_SCHEMA_MIGRATION_KINDS } from "../schemaMigration";
import {
  extractTextContent, hasImageContent, hasAudioContent, hasVideoContent,
  resolveLocale, t,
} from "../index";

describe("schemaMigration", () => {
  it("SUPPORTED_SCHEMA_MIGRATION_KINDS 包含预期值", () => {
    expect(SUPPORTED_SCHEMA_MIGRATION_KINDS).toContain("backfill_required_field");
    expect(SUPPORTED_SCHEMA_MIGRATION_KINDS).toContain("rename_field_dual_write");
  });

  it("isSupportedSchemaMigrationKind 合法值返回 true", () => {
    expect(isSupportedSchemaMigrationKind("backfill_required_field")).toBe(true);
    expect(isSupportedSchemaMigrationKind("rename_field_dual_write")).toBe(true);
  });

  it("isSupportedSchemaMigrationKind 非法值返回 false", () => {
    expect(isSupportedSchemaMigrationKind("unknown")).toBe(false);
    expect(isSupportedSchemaMigrationKind("")).toBe(false);
    expect(isSupportedSchemaMigrationKind("drop_table")).toBe(false);
  });
});

describe("extractTextContent", () => {
  it("纯文本直接返回", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("多模态数组提取所有 text 片段", () => {
    const content = [
      { type: "text" as const, text: "line1" },
      { type: "image_url" as const, image_url: { url: "https://example.com/img.png" } },
      { type: "text" as const, text: "line2" },
    ];
    expect(extractTextContent(content)).toBe("line1\nline2");
  });

  it("无 text 片段返回空字符串", () => {
    const content = [
      { type: "image_url" as const, image_url: { url: "https://example.com/img.png" } },
    ];
    expect(extractTextContent(content)).toBe("");
  });
});

describe("hasImageContent", () => {
  it("纯文本返回 false", () => {
    expect(hasImageContent("hello")).toBe(false);
  });

  it("包含图像返回 true", () => {
    expect(hasImageContent([
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ])).toBe(true);
  });

  it("不包含图像返回 false", () => {
    expect(hasImageContent([
      { type: "text", text: "hello" },
    ])).toBe(false);
  });
});

describe("hasAudioContent", () => {
  it("纯文本返回 false", () => {
    expect(hasAudioContent("hello")).toBe(false);
  });

  it("包含音频返回 true", () => {
    expect(hasAudioContent([
      { type: "input_audio", input_audio: { data: "base64...", format: "wav" } },
    ])).toBe(true);
  });
});

describe("hasVideoContent", () => {
  it("纯文本返回 false", () => {
    expect(hasVideoContent("hello")).toBe(false);
  });

  it("包含视频返回 true", () => {
    expect(hasVideoContent([
      { type: "video_url", video_url: { url: "https://example.com/vid.mp4" } },
    ])).toBe(true);
  });
});

describe("resolveLocale", () => {
  it("userLocale 最高优先级", () => {
    expect(resolveLocale({ userLocale: "en-US", spaceLocale: "ja-JP", tenantLocale: "zh-CN" })).toBe("en-US");
  });

  it("fallback 到 spaceLocale", () => {
    expect(resolveLocale({ spaceLocale: "ja-JP", tenantLocale: "zh-CN" })).toBe("ja-JP");
  });

  it("fallback 到 tenantLocale", () => {
    expect(resolveLocale({ tenantLocale: "zh-CN" })).toBe("zh-CN");
  });

  it("fallback 到 platformLocale", () => {
    expect(resolveLocale({ platformLocale: "fr-FR" })).toBe("fr-FR");
  });

  it("全部为空默认 zh-CN", () => {
    expect(resolveLocale({})).toBe("zh-CN");
  });
});

describe("t (i18n translation)", () => {
  it("undefined 返回空字符串", () => {
    expect(t(undefined, "zh-CN")).toBe("");
  });

  it("纯字符串直接返回", () => {
    expect(t("hello", "zh-CN")).toBe("hello");
  });

  it("I18nText 按 locale 返回", () => {
    const text = { "zh-CN": "你好", "en-US": "Hello" };
    expect(t(text, "en-US")).toBe("Hello");
    expect(t(text, "zh-CN")).toBe("你好");
  });

  it("未匹配 locale fallback 到 zh-CN", () => {
    const text = { "zh-CN": "你好", "en-US": "Hello" };
    expect(t(text, "ja-JP")).toBe("你好");
  });

  it("既无匹配也无 zh-CN 取第一个值", () => {
    const text = { "en-US": "Hello" };
    expect(t(text, "ja-JP")).toBe("Hello");
  });
});
