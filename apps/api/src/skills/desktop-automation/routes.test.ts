import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

const mockFindOnlineDevice = vi.fn();
const mockDispatchAndWaitForResult = vi.fn();

vi.mock("../device-runtime/modules/deviceCommandBridge", () => ({
  findOnlineDevice: (...args: any[]) => mockFindOnlineDevice(...args),
  dispatchAndWaitForResult: (...args: any[]) => mockDispatchAndWaitForResult(...args),
}));

import { desktopAutomationRoutes } from "./routes";

function buildTestApp() {
  const app = Fastify({ logger: false });
  const query = vi.fn();
  (app as any).decorate("db", { query });
  app.addHook("onRequest", async (req: any) => {
    req.tenantId = "tenant_test";
  });
  app.register(desktopAutomationRoutes);
  return { app: app as FastifyInstance, query };
}

describe("desktopAutomationRoutes", () => {
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
    mockFindOnlineDevice.mockResolvedValue("device_desktop_1");
    mockDispatchAndWaitForResult.mockResolvedValue({
      success: true,
      status: "succeeded",
      executionId: "desktop-exec-1",
      result: { ok: true },
    });
    query.mockResolvedValue({ rows: [] });
  });

  it("POST /desktop-automation/launch 在缺少 appPath 时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/launch",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "appPath is required" });
  });

  it("GET /desktop-automation/windows 会转发 window.list 动作", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/desktop-automation/windows?filter=chrome",
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: { action: "window.list", params: { filter: "chrome" } },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /desktop-automation/window/focus 在缺少 windowId/title 时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/window/focus",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "windowId or title is required" });
  });

  it("POST /desktop-automation/window/resize 会转发尺寸参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/window/resize",
      payload: { windowId: "w-1", x: 10, y: 20, width: 900, height: 700 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: {
        action: "window.resize",
        params: { windowId: "w-1", x: 10, y: 20, width: 900, height: 700 },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /desktop-automation/mouse/click 在缺少坐标时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/mouse/click",
      payload: { x: 10 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "x and y are required" });
  });

  it("POST /desktop-automation/mouse/drag 会转发拖拽参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/mouse/drag",
      payload: { startX: 1, startY: 2, endX: 30, endY: 40, button: "left" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: {
        action: "mouse.drag",
        params: { startX: 1, startY: 2, endX: 30, endY: 40, button: "left" },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /desktop-automation/keyboard/type 在缺少 text 时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/keyboard/type",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "text is required" });
  });

  it("POST /desktop-automation/keyboard/hotkey 会校验 keys", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/keyboard/hotkey",
      payload: { keys: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "keys array is required" });
  });

  it("POST /desktop-automation/screen/capture 会转发区域截图参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/screen/capture",
      payload: { x: 10, y: 20, width: 300, height: 200, windowId: "w-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: {
        action: "screen.capture",
        params: { x: 10, y: 20, width: 300, height: 200, windowId: "w-1" },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /desktop-automation/screen/ocr 会转发 OCR 参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/screen/ocr",
      payload: { x: 5, y: 6, width: 100, height: 50, language: "eng" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: {
        action: "screen.ocr",
        params: { x: 5, y: 6, width: 100, height: 50, language: "eng" },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("GET /desktop-automation/clipboard 会转发 clipboard.get 动作", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/desktop-automation/clipboard",
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: { action: "clipboard.get", params: {} },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("POST /desktop-automation/clipboard 在缺少 text/imageBase64 时返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/clipboard",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "text or imageBase64 is required" });
  });

  it("POST /desktop-automation/file/dialog 会校验 type", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/file/dialog",
      payload: { type: "invalid" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "type must be one of: open, save, folder" });
  });

  it("POST /desktop-automation/file/dialog 会转发文件对话框参数", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/file/dialog",
      payload: {
        type: "open",
        title: "Pick file",
        filters: [{ name: "Images", extensions: ["png", "jpg"] }],
        defaultPath: "C:\\temp",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDispatchAndWaitForResult).toHaveBeenCalledWith({
      pool: expect.any(Object),
      tenantId: "tenant_test",
      deviceId: "device_desktop_1",
      toolPrefix: "desktop",
      command: {
        action: "file.dialog",
        params: {
          type: "open",
          title: "Pick file",
          filters: [{ name: "Images", extensions: ["png", "jpg"] }],
          defaultPath: "C:\\temp",
        },
      },
      timeout: undefined,
      spaceId: undefined,
      subjectId: undefined,
    });
  });

  it("GET /desktop-automation/execution/:id 在查到记录时返回执行详情", async () => {
    query.mockResolvedValue({
      rows: [{
        device_execution_id: "desktop-exec-42",
        device_id: "device_desktop_1",
        tool_ref: "desktop.window.list@1",
        status: "succeeded",
        output_digest: { windows: [] },
        error_category: null,
        created_at: "2026-04-07T00:00:00.000Z",
        claimed_at: "2026-04-07T00:00:01.000Z",
        completed_at: "2026-04-07T00:00:02.000Z",
      }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/desktop-automation/execution/desktop-exec-42",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      executionId: "desktop-exec-42",
      deviceId: "device_desktop_1",
      toolRef: "desktop.window.list@1",
      status: "succeeded",
      outputDigest: { windows: [] },
      errorCategory: null,
      createdAt: "2026-04-07T00:00:00.000Z",
      claimedAt: "2026-04-07T00:00:01.000Z",
      completedAt: "2026-04-07T00:00:02.000Z",
    });
  });

  it("POST /desktop-automation/launch 在没有默认设备时返回 404", async () => {
    mockFindOnlineDevice.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/desktop-automation/launch",
      payload: { appPath: "notepad.exe" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "No desktop-capable device available" });
    expect(mockDispatchAndWaitForResult).not.toHaveBeenCalled();
  });
});
