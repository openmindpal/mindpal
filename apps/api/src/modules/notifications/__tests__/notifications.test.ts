import { describe, it, expect } from "vitest";
import { renderTemplateText } from "../render";
import { digestParams, digestInputV1, sha256Hex } from "../digest";

/* ── render ── */
describe("notifications/render", () => {
  describe("renderTemplateText", () => {
    it("should replace {{key}} with params values", () => {
      expect(renderTemplateText("Hello {{name}}, welcome!", { name: "Alice" })).toBe("Hello Alice, welcome!");
    });

    it("should replace multiple placeholders", () => {
      expect(renderTemplateText("{{a}} + {{b}} = {{c}}", { a: 1, b: 2, c: 3 })).toBe("1 + 2 = 3");
    });

    it("should replace with empty string for null/undefined values", () => {
      expect(renderTemplateText("Hi {{name}}", { name: null })).toBe("Hi ");
      expect(renderTemplateText("Hi {{name}}", {})).toBe("Hi ");
    });

    it("should handle boolean and number values", () => {
      expect(renderTemplateText("Active: {{active}}", { active: true })).toBe("Active: true");
      expect(renderTemplateText("Count: {{n}}", { n: 42 })).toBe("Count: 42");
    });

    it("should ignore object/array values (replace with empty)", () => {
      expect(renderTemplateText("Data: {{obj}}", { obj: { nested: true } })).toBe("Data: ");
    });

    it("should return empty string for falsy text", () => {
      expect(renderTemplateText("", {})).toBe("");
    });

    it("should handle non-object params", () => {
      expect(renderTemplateText("Hello {{x}}", null)).toBe("Hello ");
      expect(renderTemplateText("Hello {{x}}", 42)).toBe("Hello ");
    });

    it("should support spaces around key in braces", () => {
      expect(renderTemplateText("{{ name }}", { name: "Bob" })).toBe("Bob");
    });

    it("should support dotted keys", () => {
      expect(renderTemplateText("{{user.name}}", { "user.name": "Eve" })).toBe("Eve");
    });
  });
});

/* ── digest ── */
describe("notifications/digest", () => {
  describe("digestParams", () => {
    it("should return keyCount, keys, and sha256_8 for an object", () => {
      const result = digestParams({ a: 1, b: "hello" });
      expect(result.keyCount).toBe(2);
      expect(result.keys).toEqual(["a", "b"]);
      expect(result.sha256_8).toHaveLength(8);
    });

    it("should handle null/undefined input", () => {
      const result = digestParams(null);
      expect(result.keyCount).toBe(0);
      expect(result.keys).toEqual([]);
      expect(result.sha256_8).toHaveLength(8);
    });

    it("should handle array input (not object)", () => {
      const result = digestParams([1, 2, 3]);
      expect(result.keyCount).toBe(0);
    });

    it("should truncate keys to max 50", () => {
      const bigObj: any = {};
      for (let i = 0; i < 100; i++) bigObj[`k${i}`] = i;
      const result = digestParams(bigObj);
      expect(result.keys.length).toBe(50);
      expect(result.keyCount).toBe(100);
    });
  });

  describe("digestInputV1", () => {
    it("should strip tracking keys (traceId, requestId, etc)", () => {
      const input = { action: "send", traceId: "abc", requestId: "123", data: "hello" };
      const result = digestInputV1(input);
      // The result should be same as digesting { action: "send", data: "hello" }
      const baseline = digestParams({ action: "send", data: "hello" });
      expect(result.sha256_8).toBe(baseline.sha256_8);
    });

    it("should handle null input", () => {
      const result = digestInputV1(null);
      expect(result.keyCount).toBe(0);
    });

    it("should recursively strip tracking keys in nested objects", () => {
      const input = { data: { nested: true, trace_id: "x" } };
      const result = digestInputV1(input);
      // trace_id should be omitted from nested object
      expect(result.keyCount).toBe(1); // only "data"
    });
  });

  describe("sha256Hex", () => {
    it("should produce a 64-char hex string", () => {
      const h = sha256Hex("hello");
      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });

    it("should produce deterministic output", () => {
      expect(sha256Hex("test")).toBe(sha256Hex("test"));
    });

    it("should produce different output for different input", () => {
      expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
    });
  });
});
