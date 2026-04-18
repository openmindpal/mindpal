/**
 * lib/output 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { printResult, printJson } from "../lib/output";
import type { ApiResponse } from "../lib/apiClient";

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let tableSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  tableSpy = vi.spyOn(console, "table").mockImplementation(() => {});
  process.exitCode = undefined as any;
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  tableSpy.mockRestore();
  process.exitCode = undefined as any;
});

describe("printResult()", () => {
  it("成功响应以 JSON 格式打印", () => {
    const res: ApiResponse = { status: 200, ok: true, data: { hello: "world" } };
    printResult(res, "json");

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toEqual({ hello: "world" });
  });

  it("默认格式为 json", () => {
    const res: ApiResponse = { status: 200, ok: true, data: { a: 1 } };
    printResult(res);

    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({ a: 1 });
  });

  it("失败响应输出到 stderr 并设置 exitCode=1", () => {
    const res: ApiResponse = { status: 403, ok: false, data: { errorCode: "FORBIDDEN" } };
    printResult(res, "json");

    expect(errorSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(output.status).toBe(403);
    expect(output.error).toEqual({ errorCode: "FORBIDDEN" });
    expect(process.exitCode).toBe(1);
    // 不应调用 console.log
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("table 格式 — 含数组字段时用 console.table", () => {
    const res: ApiResponse = {
      status: 200,
      ok: true,
      data: { items: [{ id: 1 }, { id: 2 }], total: 2 },
    };
    printResult(res, "table");

    expect(tableSpy).toHaveBeenCalledOnce();
    expect(tableSpy.mock.calls[0][0]).toEqual([{ id: 1 }, { id: 2 }]);
    // 额外字段（total）也应打印
    expect(logSpy).toHaveBeenCalledOnce();
    const rest = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(rest).toEqual({ total: 2 });
  });

  it("table 格式 — 数组为空时回退 json 打印", () => {
    const res: ApiResponse = {
      status: 200,
      ok: true,
      data: { items: [], total: 0 },
    };
    printResult(res, "table");

    // 空数组不走 console.table，回退 json
    expect(tableSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("table 格式 — 无数组字段时回退 json 打印", () => {
    const res: ApiResponse = {
      status: 200,
      ok: true,
      data: { name: "test", value: 42 },
    };
    printResult(res, "table");

    expect(tableSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("table 格式 — 非对象数据回退 json 打印", () => {
    const res: ApiResponse = { status: 200, ok: true, data: "raw string" };
    printResult(res, "table");

    expect(tableSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledOnce();
  });

  it("table 格式 — 仅有数组字段无额外字段时不多打印", () => {
    const res: ApiResponse = {
      status: 200,
      ok: true,
      data: { rows: [{ a: 1 }] },
    };
    printResult(res, "table");

    expect(tableSpy).toHaveBeenCalledOnce();
    // 没有额外字段，logSpy 不应被调用
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("printJson()", () => {
  it("美化打印 JSON 数据", () => {
    printJson({ x: 1, y: [2, 3] });

    expect(logSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(output).toEqual({ x: 1, y: [2, 3] });
  });

  it("打印 null", () => {
    printJson(null);
    expect(logSpy).toHaveBeenCalledWith("null");
  });
});
