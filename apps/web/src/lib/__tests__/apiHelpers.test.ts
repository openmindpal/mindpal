import { describe, it, expect } from "vitest";
import { text, pickLocale } from "../api";
import {
  toApiError,
  isPlainObject,
  safeJsonString,
  nextId,
  errText,
  errorMessageText,
} from "../apiError";

/* ═══════════ api.ts pure helpers ═══════════ */
describe("web/api text()", () => {
  it("should return locale text", () => {
    expect(text({ "zh-CN": "你好", "en-US": "hello" }, "en-US")).toBe("hello");
  });

  it("should fallback to zh-CN", () => {
    expect(text({ "zh-CN": "你好" }, "en-US")).toBe("你好");
  });

  it("should fallback to first value if no match", () => {
    expect(text({ fr: "bonjour" }, "en-US")).toBe("bonjour");
  });

  it("should return empty string for undefined", () => {
    expect(text(undefined, "zh-CN")).toBe("");
  });

  it("should return string as-is", () => {
    expect(text("hello", "zh-CN")).toBe("hello");
  });
});

describe("web/api pickLocale()", () => {
  it("should pick lang from searchParams", () => {
    expect(pickLocale({ lang: "en-US" })).toBe("en-US");
  });

  it("should pick first element from array", () => {
    expect(pickLocale({ lang: ["en-US", "zh-CN"] })).toBe("en-US");
  });

  it("should default to zh-CN when missing", () => {
    expect(pickLocale({})).toBe("zh-CN");
  });

  it("should default to zh-CN for undefined", () => {
    expect(pickLocale({ lang: undefined })).toBe("zh-CN");
  });
});

/* ═══════════ apiError.ts pure helpers ═══════════ */
describe("web/apiError", () => {
  describe("toApiError", () => {
    it("should wrap object as ApiError", () => {
      const e = { errorCode: "NOT_FOUND", message: "gone" };
      expect(toApiError(e)).toBe(e);
    });

    it("should wrap string to ApiError", () => {
      expect(toApiError("oops")).toEqual({ errorCode: "ERROR", message: "oops" });
    });

    it("should wrap null/undefined", () => {
      expect(toApiError(null)).toEqual({ errorCode: "ERROR", message: "null" });
    });
  });

  describe("isPlainObject", () => {
    it("should return true for plain object", () => {
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    it("should return false for array", () => {
      expect(isPlainObject([1])).toBe(false);
    });

    it("should return false for null/undefined", () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
    });

    it("should return false for string", () => {
      expect(isPlainObject("str")).toBe(false);
    });
  });

  describe("safeJsonString", () => {
    it("should stringify object", () => {
      expect(safeJsonString({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    });

    it("should return 'null' for undefined/null", () => {
      expect(safeJsonString(undefined)).toBe("null");
      expect(safeJsonString(null)).toBe("null");
    });

    it("should return 'null' for circular ref", () => {
      const obj: any = {};
      obj.self = obj;
      expect(safeJsonString(obj)).toBe("null");
    });
  });

  describe("nextId", () => {
    it("should start with prefix", () => {
      expect(nextId("test")).toMatch(/^test_/);
    });

    it("should be unique", () => {
      expect(nextId("a")).not.toBe(nextId("a"));
    });
  });

  describe("errText", () => {
    it("should return empty for null", () => {
      expect(errText("zh-CN", null)).toBe("");
      expect(errText("zh-CN", undefined)).toBe("");
    });

    it("should format code and message", () => {
      expect(errText("zh-CN", { errorCode: "NOT_FOUND", message: "未找到" })).toBe("NOT_FOUND: 未找到");
    });

    it("should append traceId if present", () => {
      const result = errText("zh-CN", { errorCode: "ERR", traceId: "abc123" });
      expect(result).toContain("traceId=abc123");
    });

    it("should resolve i18n message object", () => {
      const result = errText("en-US", { errorCode: "ERR", message: { "zh-CN": "错误", "en-US": "error" } });
      expect(result).toBe("ERR: error");
    });
  });

  describe("errorMessageText", () => {
    it("should return empty for falsy", () => {
      expect(errorMessageText("zh-CN", null)).toBe("");
      expect(errorMessageText("zh-CN", "")).toBe("");
    });

    it("should return string as-is", () => {
      expect(errorMessageText("zh-CN", "hello")).toBe("hello");
    });

    it("should resolve i18n object", () => {
      expect(errorMessageText("en-US", { "zh-CN": "错误", "en-US": "error" })).toBe("error");
    });
  });
});
