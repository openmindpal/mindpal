/**
 * lib/apiClient 单元测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, qs } from "../lib/apiClient";
import type { ApiClientOptions } from "../lib/apiClient";

/* ─── qs() 纯函数测试 ──────────────────────────────────────────── */
describe("qs()", () => {
  it("空参数返回空字符串", () => {
    expect(qs({})).toBe("");
  });

  it("忽略 undefined / null / 空字符串", () => {
    expect(qs({ a: undefined, b: null, c: "" })).toBe("");
  });

  it("正确编码字符串参数", () => {
    const result = qs({ foo: "bar", baz: "hello world" });
    expect(result).toContain("foo=bar");
    expect(result).toContain("baz=hello+world");
    expect(result.startsWith("?")).toBe(true);
  });

  it("正确编码数字和布尔参数", () => {
    const result = qs({ limit: 10, active: true });
    expect(result).toContain("limit=10");
    expect(result).toContain("active=true");
  });

  it("混合参数 — 有效值保留，无效值忽略", () => {
    const result = qs({ keep: "yes", drop: undefined, zero: 0 });
    expect(result).toContain("keep=yes");
    // 0 是有效值
    expect(result).toContain("zero=0");
    expect(result).not.toContain("drop");
  });
});

/* ─── fetch mock 基础设施 ───────────────────────────────────────── */
const OPTS: ApiClientOptions = {
  apiBase: "http://test-api:3001",
  token: "test-token-123",
  tenantId: "tenant_1",
  spaceId: "space_1",
};

const OPTS_MINIMAL: ApiClientOptions = {
  apiBase: "http://test-api:3001",
  token: "tok",
};

function mockFetchOk(data: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function mockFetchError(status: number, errBody: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    ok: false,
    text: () => Promise.resolve(JSON.stringify(errBody)),
  });
}

function mockFetchEmpty() {
  return vi.fn().mockResolvedValue({
    status: 204,
    ok: true,
    text: () => Promise.resolve(""),
  });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ─── HTTP 方法测试 ─────────────────────────────────────────────── */
describe("apiGet()", () => {
  it("发送 GET 请求并返回解析后的 JSON", async () => {
    const mock = mockFetchOk({ items: [1, 2, 3] });
    globalThis.fetch = mock as any;

    const res = await apiGet(OPTS, "/test/path");

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ items: [1, 2, 3] });

    // 验证请求 URL
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("http://test-api:3001/test/path");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("正确携带 authorization / tenant / space / trace headers", async () => {
    const mock = mockFetchOk({});
    globalThis.fetch = mock as any;

    await apiGet(OPTS, "/h");
    const headers = mock.mock.calls[0][1].headers;

    expect(headers.authorization).toBe("Bearer test-token-123");
    expect(headers["x-tenant-id"]).toBe("tenant_1");
    expect(headers["x-space-id"]).toBe("space_1");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-trace-id"]).toMatch(/^cli-/);
  });

  it("无 tenantId/spaceId 时不发送对应 header", async () => {
    const mock = mockFetchOk({});
    globalThis.fetch = mock as any;

    await apiGet(OPTS_MINIMAL, "/h");
    const headers = mock.mock.calls[0][1].headers;

    expect(headers["x-tenant-id"]).toBeUndefined();
    expect(headers["x-space-id"]).toBeUndefined();
  });

  it("支持 extraHeaders 覆盖", async () => {
    const mock = mockFetchOk({});
    globalThis.fetch = mock as any;

    await apiGet(OPTS, "/h", { "x-custom": "val" });
    const headers = mock.mock.calls[0][1].headers;
    expect(headers["x-custom"]).toBe("val");
  });
});

describe("apiPost()", () => {
  it("发送 POST 请求并序列化 body", async () => {
    const mock = mockFetchOk({ id: "abc" });
    globalThis.fetch = mock as any;

    const res = await apiPost(OPTS, "/create", { name: "test" });

    expect(res.data).toEqual({ id: "abc" });
    const [, init] = mock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "test" }));
  });

  it("body 为 undefined 时不发送 body", async () => {
    const mock = mockFetchOk({});
    globalThis.fetch = mock as any;

    await apiPost(OPTS, "/trigger");
    const [, init] = mock.mock.calls[0];
    expect(init.body).toBeUndefined();
  });
});

describe("apiPut()", () => {
  it("发送 PUT 请求", async () => {
    const mock = mockFetchOk({ updated: true });
    globalThis.fetch = mock as any;

    const res = await apiPut(OPTS, "/update/1", { val: 42 });
    expect(res.data).toEqual({ updated: true });
    expect(mock.mock.calls[0][1].method).toBe("PUT");
  });
});

describe("apiPatch()", () => {
  it("发送 PATCH 请求", async () => {
    const mock = mockFetchOk({ patched: true });
    globalThis.fetch = mock as any;

    const res = await apiPatch(OPTS, "/patch/1", { status: "done" });
    expect(res.data).toEqual({ patched: true });
    expect(mock.mock.calls[0][1].method).toBe("PATCH");
  });
});

describe("apiDelete()", () => {
  it("发送 DELETE 请求", async () => {
    const mock = mockFetchOk({ deleted: true });
    globalThis.fetch = mock as any;

    const res = await apiDelete(OPTS, "/remove/1");
    expect(res.data).toEqual({ deleted: true });
    expect(mock.mock.calls[0][1].method).toBe("DELETE");
  });
});

/* ─── 边界场景 ──────────────────────────────────────────────────── */
describe("边界场景", () => {
  it("HTTP 错误码时 ok 为 false", async () => {
    const mock = mockFetchError(403, { errorCode: "FORBIDDEN" });
    globalThis.fetch = mock as any;

    const res = await apiGet(OPTS, "/forbidden");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(403);
    expect(res.data).toEqual({ errorCode: "FORBIDDEN" });
  });

  it("空响应体解析为 null", async () => {
    const mock = mockFetchEmpty();
    globalThis.fetch = mock as any;

    const res = await apiGet(OPTS, "/empty");
    expect(res.data).toBeNull();
  });

  it("非 JSON 响应体返回原始文本", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve("plain text response"),
    }) as any;

    const res = await apiGet(OPTS, "/text");
    expect(res.data).toBe("plain text response");
  });
});
