import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const mockFindOnlineDevice = vi.fn();
const mockDispatchAndWaitForResult = vi.fn();

vi.mock("../device-runtime/modules/deviceCommandBridge", () => ({
  findOnlineDevice: (...args: any[]) => mockFindOnlineDevice(...args),
  dispatchAndWaitForResult: (...args: any[]) => mockDispatchAndWaitForResult(...args),
}));

import { browserAutomationRoutes } from "./routes";

function buildTestApp() {
  const app = Fastify({ logger: false });
  const query = vi.fn();
  (app as any).decorate("db", { query });
  app.addHook("onRequest", async (req: any) => {
    req.tenantId = "tenant_test";
  });
  app.register(browserAutomationRoutes);
  return { app: app as FastifyInstance, query };
}

describe("browserAutomationRoutes", () => {
  let app: FastifyInstance;
  let query: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const built = buildTestApp();
    app = built.app;
    query = built.query;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOnlineDevice.mockResolvedValue("device_browser_1");
    mockDispatchAndWaitForResult.mockResolvedValue({
      success: true,
      status: "succeeded",
      executionId: "exec-1",
      result: { ok: true },
    });
    query.mockResolvedValue({ rows: [] });
  });

  it("POST /browser-automation/navigate 在缺少 url 时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/navigate",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "url is required" });
    expect(mockDispatchAndWaitForResult).not.toHaveBeenCalled();
  });

  it("POST /browser-automation/navigate 会把 device_unavailable 映射为 503", async () => {
    mockDispatchAndWaitForResult.mockResolvedValue({
      success: false,
      status: "device_unavailable",
      error: "device offline",
    });

    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/navigate",
      payload: { url: "https://example.com", timeout: 2500 },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "device offline", status: "device_unavailable" });
    expect(mockFindOnlineDevice).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      capability: "browser",
    });
  });

  it("POST /browser-automation/navigate 会把 timeout 映射为 504", async () => {
    mockDispatchAndWaitForResult.mockResolvedValue({
      success: false,
      status: "timeout",
      error: "timed out",
      executionId: "exec-timeout",
    });

    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/navigate",
      payload: { url: "https://example.com" },
    });

    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({
      error: "timed out",
      status: "timeout",
      executionId: "exec-timeout",
    });
  });

  it("GET /browser-automation/session/status 会转发 session.status 动作", async () => {
    mockDispatchAndWaitForResult.mockResolvedValue({
      success: true,
      status: "succeeded",
      result: { connected: true },
    });

    const res = await app.inject({
      method: "GET",
      url: "/browser-automation/session/status",
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: { action: "session.status", params: {} },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /browser-automation/click 会校验 selector 必填", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/click",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "selector is required" });
  });

  it("POST /browser-automation/type 会转发输入参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/type",
      payload: { selector: "#search", text: "openslin", clear: true, delay: 20 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: {
        action: "type",
        params: { selector: "#search", text: "openslin", delay: 20, clear: true },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /browser-automation/select 在缺少选择参数时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/select",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "selector, label, value, or index is required" });
  });

  it("POST /browser-automation/scroll 会转发滚动参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/scroll",
      payload: { x: 0, y: 480, behavior: "smooth" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: {
        action: "scroll",
        params: { selector: undefined, x: 0, y: 480, behavior: "smooth" },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /browser-automation/tab/switch 在缺少 tabId 和 index 时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/tab/switch",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "tabId or index is required" });
    expect(mockDispatchAndWaitForResult).not.toHaveBeenCalled();
  });

  it("POST /browser-automation/tab/new 会转发新标签页参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/tab/new",
      payload: { url: "https://example.com/new", activate: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: {
        action: "tab.new",
        params: { url: "https://example.com/new", activate: true },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /browser-automation/evaluate 会校验 script 必填", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/evaluate",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "script is required" });
  });

  it("POST /browser-automation/waitFor 会把 timeout 传入桥接层", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/waitFor",
      payload: { text: "Checkout", state: "visible", timeout: 1800 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: {
        action: "waitFor",
        params: { selector: undefined, text: "Checkout", state: "visible", timeout: 1800 },
      },
      timeout: 1800,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("GET /browser-automation/tabs 会转发 tab.list 动作", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/browser-automation/tabs",
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: { action: "tab.list", params: {} },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /browser-automation/tab/close 会转发关闭标签页参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/tab/close",
      payload: { index: 2 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: {
        action: "tab.close",
        params: { tabId: undefined, index: 2 },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /browser-automation/screenshot 在没有默认设备时返回 404", async () => {
    mockFindOnlineDevice.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/screenshot",
      payload: { fullPage: true },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "No browser-capable device available" });
    expect(mockDispatchAndWaitForResult).not.toHaveBeenCalled();
  });

  it("POST /browser-automation/extract 支持仅 filter 的提取请求", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/browser-automation/extract",
      payload: { filter: "Order", multiple: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_browser_1",
      toolPrefix: "browser",
      command: {
        action: "extract",
        params: { selector: undefined, attribute: undefined, multiple: true, filter: "Order" },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("GET /browser-automation/execution/:id 在查到记录时返回执行详情", async () => {
    query.mockResolvedValue({
      rows: [{
        device_execution_id: "exec-42",
        device_id: "device_browser_1",
        tool_ref: "browser.navigate@1",
        status: "succeeded",
        output_digest: { ok: true },
        error_category: null,
        created_at: "2026-04-07T00:00:00.000Z",
        claimed_at: "2026-04-07T00:00:01.000Z",
        completed_at: "2026-04-07T00:00:02.000Z",
      }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/browser-automation/execution/exec-42",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      executionId: "exec-42",
      deviceId: "device_browser_1",
      toolRef: "browser.navigate@1",
      status: "succeeded",
      outputDigest: { ok: true },
      errorCategory: null,
      createdAt: "2026-04-07T00:00:00.000Z",
      claimedAt: "2026-04-07T00:00:01.000Z",
      completedAt: "2026-04-07T00:00:02.000Z",
    });
  });

  it("GET /browser-automation/execution/:id 在未查到记录时返回 404", async () => {
    query.mockResolvedValue({ rows: [] });

    const res = await app.inject({
      method: "GET",
      url: "/browser-automation/execution/exec-missing",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Execution not found" });
  });
});
