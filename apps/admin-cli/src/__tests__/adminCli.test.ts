import { describe, it, expect, vi, beforeEach } from "vitest";
import { qs } from "../lib/apiClient";
import { printResult, printJson } from "../lib/output";
import type { ApiResponse } from "../lib/apiClient";

/* ── apiClient.ts qs() ── */
describe("admin-cli/apiClient qs()", () => {
  it("should return empty string for empty params", () => {
    expect(qs({})).toBe("");
  });

  it("should build query string with string value", () => {
    expect(qs({ name: "alice" })).toBe("?name=alice");
  });

  it("should build query string with number value", () => {
    expect(qs({ page: 2 })).toBe("?page=2");
  });

  it("should build query string with boolean value", () => {
    expect(qs({ active: true })).toBe("?active=true");
  });

  it("should skip undefined values", () => {
    expect(qs({ a: "1", b: undefined })).toBe("?a=1");
  });

  it("should skip null values", () => {
    expect(qs({ a: "1", b: null })).toBe("?a=1");
  });

  it("should skip empty string values", () => {
    expect(qs({ a: "1", b: "" })).toBe("?a=1");
  });

  it("should combine multiple params", () => {
    const result = qs({ page: 1, size: 10, q: "test" });
    expect(result).toContain("page=1");
    expect(result).toContain("size=10");
    expect(result).toContain("q=test");
    expect(result).toMatch(/^\?/);
  });

  it("should URL-encode special characters", () => {
    const result = qs({ q: "hello world" });
    expect(result).toBe("?q=hello+world");
  });

  it("should return empty string when all values are undefined/null/empty", () => {
    expect(qs({ a: undefined, b: null, c: "" })).toBe("");
  });
});

/* ── output.ts ── */
describe("admin-cli/output", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleTableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleTableSpy = vi.spyOn(console, "table").mockImplementation(() => {});
    process.exitCode = undefined as any;
  });

  describe("printResult", () => {
    it("should print JSON for ok response (default format)", () => {
      const res: ApiResponse = { status: 200, ok: true, data: { id: 1 } };
      printResult(res);
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ id: 1 }, null, 2));
    });

    it("should print error and set exitCode for failed response", () => {
      const res: ApiResponse = { status: 500, ok: false, data: { message: "fail" } };
      printResult(res);
      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it("should use console.table for table format with array data", () => {
      const res: ApiResponse = { status: 200, ok: true, data: { items: [{ a: 1 }, { a: 2 }] } };
      printResult(res, "table");
      expect(consoleTableSpy).toHaveBeenCalledWith([{ a: 1 }, { a: 2 }]);
    });

    it("should fall back to JSON when table format but no array field", () => {
      const res: ApiResponse = { status: 200, ok: true, data: { name: "test" } };
      printResult(res, "table");
      expect(consoleLogSpy).toHaveBeenCalled();
    });

    it("should print remaining non-array fields in table mode", () => {
      const res: ApiResponse = { status: 200, ok: true, data: { items: [{ a: 1 }], total: 1 } };
      printResult(res, "table");
      expect(consoleTableSpy).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ total: 1 }, null, 2));
    });
  });

  describe("printJson", () => {
    it("should print data as formatted JSON", () => {
      printJson({ hello: "world" });
      expect(consoleLogSpy).toHaveBeenCalledWith(JSON.stringify({ hello: "world" }, null, 2));
    });

    it("should handle null", () => {
      printJson(null);
      expect(consoleLogSpy).toHaveBeenCalledWith("null");
    });
  });
});
