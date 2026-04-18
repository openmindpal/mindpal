/**
 * Desktop Automation Routes
 *
 * HTTP API for desktop automation operations.
 * Proxies commands to device-agent for execution.
 */
import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import {
  findOnlineDevice,
  dispatchAndWaitForResult,
  type DeviceCommandResult,
} from "../device-runtime/modules/deviceCommandBridge";

/* ── Types ── */

interface DesktopCommand {
  action: string;
  params: Record<string, any>;
}

type DesktopCommandResult = DeviceCommandResult;

/* ── Device Agent Bridge ── */

/**
 * P1-2: 改造为真实桥接——下发命令到 device-agent，轮询等待结果，超时取消。
 */
async function sendDesktopCommand(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  command: DesktopCommand;
  timeout?: number;
  spaceId?: string;
  subjectId?: string;
}): Promise<DesktopCommandResult> {
  return dispatchAndWaitForResult({
    pool: params.pool,
    tenantId: params.tenantId,
    deviceId: params.deviceId,
    toolPrefix: "desktop",
    command: params.command,
    timeout: params.timeout,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
  });
}

/**
 * P1-2: 使用 device_records 表查找在线设备。
 */
async function getDefaultDeviceId(pool: Pool, tenantId: string): Promise<string | null> {
  return findOnlineDevice({ pool, tenantId, capability: "desktop" });
}

/* ── Routes ── */

export const desktopAutomationRoutes: FastifyPluginAsync = async (app) => {
  const pool = (app as any).db as Pool;

  /**
   * POST /desktop-automation/launch
   * Launch application
   */
  app.post<{
    Body: {
      deviceId?: string;
      appPath: string;
      args?: string[];
      workDir?: string;
    };
  }>("/desktop-automation/launch", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, appPath, args, workDir } = req.body;

    if (!appPath) {
      return reply.status(400).send({ error: "appPath is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "launch", params: { appPath, args, workDir } },
    });

    return reply.send(result);
  });

  /**
   * GET /desktop-automation/windows
   * List windows
   */
  app.get<{
    Querystring: { deviceId?: string; filter?: string };
  }>("/desktop-automation/windows", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, filter } = req.query;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "window.list", params: { filter } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/window/focus
   * Focus window
   */
  app.post<{
    Body: { deviceId?: string; windowId?: string; title?: string };
  }>("/desktop-automation/window/focus", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, windowId, title } = req.body;

    if (!windowId && !title) {
      return reply.status(400).send({ error: "windowId or title is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "window.focus", params: { windowId, title } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/window/resize
   * Resize window
   */
  app.post<{
    Body: {
      deviceId?: string;
      windowId: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
  }>("/desktop-automation/window/resize", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, windowId, x, y, width, height } = req.body;

    if (!windowId) {
      return reply.status(400).send({ error: "windowId is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "window.resize", params: { windowId, x, y, width, height } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/mouse/click
   * Mouse click
   */
  app.post<{
    Body: {
      deviceId?: string;
      x: number;
      y: number;
      button?: string;
      clickCount?: number;
    };
  }>("/desktop-automation/mouse/click", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, x, y, button, clickCount } = req.body;

    if (x === undefined || y === undefined) {
      return reply.status(400).send({ error: "x and y are required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "mouse.click", params: { x, y, button, clickCount } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/mouse/move
   * Mouse move
   */
  app.post<{
    Body: { deviceId?: string; x: number; y: number; smooth?: boolean };
  }>("/desktop-automation/mouse/move", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, x, y, smooth } = req.body;

    if (x === undefined || y === undefined) {
      return reply.status(400).send({ error: "x and y are required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "mouse.move", params: { x, y, smooth } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/mouse/drag
   * Mouse drag
   */
  app.post<{
    Body: {
      deviceId?: string;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      button?: string;
    };
  }>("/desktop-automation/mouse/drag", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, startX, startY, endX, endY, button } = req.body;

    if ([startX, startY, endX, endY].some((v) => v === undefined)) {
      return reply.status(400).send({ error: "startX, startY, endX, endY are required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "mouse.drag", params: { startX, startY, endX, endY, button } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/keyboard/type
   * Keyboard type
   */
  app.post<{
    Body: { deviceId?: string; text: string; delay?: number };
  }>("/desktop-automation/keyboard/type", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, text, delay } = req.body;

    if (!text) {
      return reply.status(400).send({ error: "text is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "keyboard.type", params: { text, delay } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/keyboard/hotkey
   * Keyboard hotkey
   */
  app.post<{
    Body: { deviceId?: string; keys: string[] };
  }>("/desktop-automation/keyboard/hotkey", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, keys } = req.body;

    if (!keys || keys.length === 0) {
      return reply.status(400).send({ error: "keys array is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "keyboard.hotkey", params: { keys } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/screen/capture
   * Screen capture
   */
  app.post<{
    Body: {
      deviceId?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      windowId?: string;
    };
  }>("/desktop-automation/screen/capture", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, x, y, width, height, windowId } = req.body;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "screen.capture", params: { x, y, width, height, windowId } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/screen/ocr
   * Screen OCR
   */
  app.post<{
    Body: {
      deviceId?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      language?: string;
    };
  }>("/desktop-automation/screen/ocr", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, x, y, width, height, language } = req.body;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "screen.ocr", params: { x, y, width, height, language } },
    });

    return reply.send(result);
  });

  /**
   * GET /desktop-automation/clipboard
   * Get clipboard
   */
  app.get<{
    Querystring: { deviceId?: string };
  }>("/desktop-automation/clipboard", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId } = req.query;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "clipboard.get", params: {} },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/clipboard
   * Set clipboard
   */
  app.post<{
    Body: { deviceId?: string; text?: string; imageBase64?: string };
  }>("/desktop-automation/clipboard", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, text, imageBase64 } = req.body;

    if (!text && !imageBase64) {
      return reply.status(400).send({ error: "text or imageBase64 is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "clipboard.set", params: { text, imageBase64 } },
    });

    return reply.send(result);
  });

  /**
   * POST /desktop-automation/file/dialog
   * File dialog
   */
  app.post<{
    Body: {
      deviceId?: string;
      type: string;
      title?: string;
      filters?: Array<{ name: string; extensions: string[] }>;
      defaultPath?: string;
    };
  }>("/desktop-automation/file/dialog", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, type, title, filters, defaultPath } = req.body;

    if (!type || !["open", "save", "folder"].includes(type)) {
      return reply.status(400).send({ error: "type must be one of: open, save, folder" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No desktop-capable device available" });
    }

    const result = await sendDesktopCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "file.dialog", params: { type, title, filters, defaultPath } },
    });

    return reply.send(result);
  });

  /**
   * GET /desktop-automation/execution/:id
   * Get execution status — P1-2: 查询真实执行状态
   */
  app.get<{
    Params: { id: string };
  }>("/desktop-automation/execution/:id", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { id } = req.params;

    try {
      const res = await pool.query(
        `SELECT * FROM device_executions WHERE tenant_id = $1 AND device_execution_id = $2`,
        [tenantId, id],
      );

      if (res.rows.length === 0) {
        return reply.status(404).send({ error: "Execution not found" });
      }

      const row = res.rows[0];
      return reply.send({
        executionId: row.device_execution_id,
        deviceId: row.device_id,
        toolRef: row.tool_ref,
        status: row.status,
        outputDigest: row.output_digest,
        errorCategory: row.error_category,
        createdAt: row.created_at,
        claimedAt: row.claimed_at,
        completedAt: row.completed_at,
      });
    } catch (err) {
      return reply.status(500).send({ error: String(err) });
    }
  });
};
