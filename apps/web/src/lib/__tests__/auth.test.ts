import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ─── Browser globals mock ─── */
let cookieStore = "";

beforeEach(() => {
  cookieStore = "";
  // Mock document.cookie
  Object.defineProperty(globalThis, "document", {
    value: {
      cookie: "",
      documentElement: { lang: "" },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis.document, "cookie", {
    get: () => cookieStore,
    set: (v: string) => {
      // Simple cookie jar: parse Set-Cookie and merge
      const name = v.split("=")[0];
      const isDelete = v.includes("max-age=0");
      const existing = cookieStore
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c && !c.startsWith(`${name}=`));
      if (!isDelete && v.includes("=")) {
        // Only keep name=value portion (strip path, max-age etc.)
        const pair = v.split(";")[0].trim();
        existing.push(pair);
      }
      cookieStore = existing.join("; ");
    },
    configurable: true,
  });

  // Mock window
  Object.defineProperty(globalThis, "window", {
    value: {
      location: { protocol: "http:", pathname: "/dashboard", href: "" },
      localStorage: {
        removeItem: vi.fn(),
      },
    },
    writable: true,
    configurable: true,
  });

  // Mock sessionStorage
  Object.defineProperty(globalThis, "sessionStorage", {
    value: { getItem: vi.fn(() => "0"), setItem: vi.fn() },
    writable: true,
    configurable: true,
  });

  // Reset env
  process.env.NEXT_PUBLIC_DEV_DEFAULT_TOKEN = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* Import after mocks so SSR guards see our globals */
import {
  getClientAuthToken,
  setClientAuthToken,
  AUTH_TOKEN_KEY,
  apiHeaders,
  setLocale,
} from "../api";

describe("web/auth — Cookie-based token management", () => {
  it("setClientAuthToken writes token to cookie", () => {
    setClientAuthToken("my-token-123");
    expect(cookieStore).toContain("my-token-123");
  });

  it("getClientAuthToken reads token from cookie", () => {
    // Manually set cookie
    const encoded = encodeURIComponent(AUTH_TOKEN_KEY);
    cookieStore = `${encoded}=tok_abc`;
    expect(getClientAuthToken()).toBe("tok_abc");
  });

  it("setClientAuthToken with empty string clears the cookie", () => {
    setClientAuthToken("some-token");
    expect(cookieStore).toContain("some-token");
    setClientAuthToken("");
    expect(cookieStore).not.toContain("some-token");
  });

  it("getClientAuthToken returns dev default token when cookie is empty", () => {
    process.env.NEXT_PUBLIC_DEV_DEFAULT_TOKEN = "dev-tok-999";
    cookieStore = "";
    const token = getClientAuthToken();
    expect(token).toBe("dev-tok-999");
  });

  it("getClientAuthToken returns empty string when no cookie and no dev default", () => {
    process.env.NEXT_PUBLIC_DEV_DEFAULT_TOKEN = "";
    cookieStore = "";
    const token = getClientAuthToken();
    expect(token).toBe("");
  });

  it("setClientAuthToken removes stale localStorage entry", () => {
    setClientAuthToken("new-tok");
    expect(window.localStorage.removeItem).toHaveBeenCalledWith(AUTH_TOKEN_KEY);
  });

  it("setLocale writes locale cookie and sets html lang", () => {
    setLocale("en-US");
    expect(cookieStore).toContain("en-US");
    expect(document.documentElement.lang).toBe("en-US");
  });
});

describe("web/auth — apiHeaders", () => {
  it("includes authorization header when token is provided", () => {
    const h = apiHeaders("zh-CN", { token: "my-tok" });
    expect(h.authorization).toBe("Bearer my-tok");
  });

  it("does not include authorization when token is empty", () => {
    const h = apiHeaders("zh-CN", { token: "" });
    expect(h.authorization).toBeUndefined();
  });

  it("preserves Bearer prefix if already present", () => {
    const h = apiHeaders("en-US", { token: "Bearer existing" });
    expect(h.authorization).toBe("Bearer existing");
  });

  it("preserves Device prefix if present", () => {
    const h = apiHeaders("en-US", { token: "Device d-123" });
    expect(h.authorization).toBe("Device d-123");
  });

  it("includes x-tenant-id and x-space-id when provided", () => {
    const h = apiHeaders("zh-CN", { token: "t", tenantId: "ten1", spaceId: "sp1" });
    expect(h["x-tenant-id"]).toBe("ten1");
    expect(h["x-space-id"]).toBe("sp1");
  });
});
