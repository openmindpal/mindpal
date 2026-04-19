import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ─── Browser globals mock ─── */
let cookieStore = "";

beforeEach(() => {
  cookieStore = "";
  Object.defineProperty(globalThis, "document", {
    value: { cookie: "", documentElement: { lang: "" } },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis.document, "cookie", {
    get: () => cookieStore,
    set: (v: string) => {
      const name = v.split("=")[0];
      const isDelete = v.includes("max-age=0");
      const existing = cookieStore
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith(`${name}=`));
      if (!isDelete && v.includes("=")) {
        existing.push(v.split(";")[0].trim());
      }
      cookieStore = existing.join("; ");
    },
    configurable: true,
  });

  Object.defineProperty(globalThis, "window", {
    value: {
      location: { protocol: "http:", pathname: "/dashboard", href: "" },
      localStorage: { removeItem: vi.fn() },
    },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "sessionStorage", {
    value: { getItem: vi.fn(() => "0"), setItem: vi.fn() },
    writable: true,
    configurable: true,
  });

  // Mock crypto.randomUUID for deterministic traceId
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => "test-trace-uuid" },
    writable: true,
    configurable: true,
  });

  process.env.NEXT_PUBLIC_DEV_DEFAULT_TOKEN = "";

  // Mock global fetch
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({}),
  }) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

import { apiFetch, setGlobalLocale, API_BASE } from "../api";

describe("web/apiFetch extended", () => {
  it("injects Authorization header from token option", async () => {
    await apiFetch("/test", { token: "tok-abc" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe(`${API_BASE}/test`);
    expect(init.headers.authorization).toBe("Bearer tok-abc");
  });

  it("injects x-trace-id header automatically", async () => {
    await apiFetch("/trace-test");

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers["x-trace-id"]).toBe("test-trace-uuid");
  });

  it("passes idempotency-key header when provided", async () => {
    await apiFetch("/write", { method: "POST", idempotencyKey: "idem-123" });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers["idempotency-key"]).toBe("idem-123");
  });

  it("uses absolute URL when path starts with http", async () => {
    await apiFetch("https://external.api/data");

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe("https://external.api/data");
  });

  it("injects x-user-locale from global locale", async () => {
    setGlobalLocale("en-US");
    await apiFetch("/locale-test");

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers["x-user-locale"]).toBe("en-US");

    // Reset
    setGlobalLocale("zh-CN");
  });

  it("merges caller-supplied headers without overriding auto-injected ones", async () => {
    await apiFetch("/merge", {
      token: "tok",
      headers: { "x-custom": "val" },
    });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    expect(init.headers["x-custom"]).toBe("val");
    expect(init.headers.authorization).toBe("Bearer tok");
  });

  it("caller-supplied x-trace-id takes precedence over auto-generated one", async () => {
    await apiFetch("/custom-trace", {
      headers: { "x-trace-id": "custom-id" },
    });

    const [, init] = (globalThis.fetch as any).mock.calls[0];
    // Caller header is merged after auto headers, so custom wins
    expect(init.headers["x-trace-id"]).toBe("custom-id");
  });

  it("clears token and redirects on 401 response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ status: 401, ok: false });

    await apiFetch("/protected", { token: "old-tok" });

    // sessionStorage.setItem should be called for debounce tracking
    expect(sessionStorage.setItem).toHaveBeenCalled();
  });
});
