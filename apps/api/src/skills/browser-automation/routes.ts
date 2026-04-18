/**
 * Browser Automation Routes
 *
 * HTTP API for browser automation operations.
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

interface BrowserCommand {
  action: string;
  params: Record<string, any>;
}

type BrowserCommandResult = DeviceCommandResult;

/* ── Device Agent Bridge ── */

/**
 * P1-2: 改造为真实桥接——下发命令到 device-agent，轮询等待结果，超时取消。
 * 替代原来的 "insert → return queued" 模式。
 */
async function sendBrowserCommand(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  command: BrowserCommand;
  timeout?: number;
  spaceId?: string;
  subjectId?: string;
}): Promise<BrowserCommandResult> {
  return dispatchAndWaitForResult({
    pool: params.pool,
    tenantId: params.tenantId,
    deviceId: params.deviceId,
    toolPrefix: "browser",
    command: params.command,
    timeout: params.timeout,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
  });
}

/**
 * P1-2: 使用 device_records 表查找在线设备（替代原来查询不存在的 devices 表）。
 */
async function getDefaultDeviceId(pool: Pool, tenantId: string): Promise<string | null> {
  return findOnlineDevice({ pool, tenantId, capability: "browser" });
}

/* ── Routes ── */

export const browserAutomationRoutes: FastifyPluginAsync = async (app) => {
  const pool = (app as any).db as Pool;

  /**
   * POST /browser-automation/navigate
   * Navigate to URL
   */
  app.post<{
    Body: {
      deviceId?: string;
      url: string;
      waitUntil?: string;
      timeout?: number;
    };
  }>("/browser-automation/navigate", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, url, waitUntil, timeout } = req.body;

    if (!url) {
      return reply.status(400).send({ error: "url is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "navigate", params: { url, waitUntil, timeout } },
      timeout,
    });

    if (result.status === "device_unavailable") {
      return reply.status(503).send({ error: result.error, status: "device_unavailable" });
    }
    if (result.status === "timeout") {
      return reply.status(504).send({ error: result.error, status: "timeout", executionId: result.executionId });
    }

    return reply.send(result);
  });

  /**
   * POST /browser-automation/screenshot
   * Take screenshot
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector?: string;
      fullPage?: boolean;
      format?: string;
    };
  }>("/browser-automation/screenshot", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, fullPage, format } = req.body;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "screenshot", params: { selector, fullPage, format } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/click
   * Click element
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector: string;
      button?: string;
      clickCount?: number;
    };
  }>("/browser-automation/click", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, button, clickCount } = req.body;

    if (!selector) {
      return reply.status(400).send({ error: "selector is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "click", params: { selector, button, clickCount } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/type
   * Type text into input
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector: string;
      text: string;
      delay?: number;
      clear?: boolean;
    };
  }>("/browser-automation/type", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, text, delay, clear } = req.body;

    if (!selector || text === undefined) {
      return reply.status(400).send({ error: "selector and text are required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "type", params: { selector, text, delay, clear } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/select
   * Select dropdown option
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector?: string;
      value?: string;
      label?: string;
      index?: number;
    };
  }>("/browser-automation/select", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, value, label, index } = req.body;

    if (!selector && value === undefined && !label && index === undefined) {
      return reply.status(400).send({ error: "selector, label, value, or index is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "select", params: { selector, value, label: label ?? selector, index } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/scroll
   * Scroll page
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector?: string;
      x?: number;
      y?: number;
      behavior?: string;
    };
  }>("/browser-automation/scroll", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, x, y, behavior } = req.body;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "scroll", params: { selector, x, y, behavior } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/extract
   * Extract data from page
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector?: string;
      attribute?: string;
      multiple?: boolean;
      filter?: string;
    };
  }>("/browser-automation/extract", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, attribute, multiple, filter } = req.body;

    if (!selector && !filter) {
      return reply.status(400).send({ error: "selector or filter is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "extract", params: { selector, attribute, multiple, filter } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/evaluate
   * Execute JavaScript in page context
   */
  app.post<{
    Body: {
      deviceId?: string;
      script: string;
      args?: any[];
    };
  }>("/browser-automation/evaluate", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, script, args } = req.body;

    if (!script) {
      return reply.status(400).send({ error: "script is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    // This is a high-risk operation - should be gated by approval in production
    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "evaluate", params: { script, args } },
    });

    return reply.send(result);
  });

  /**
   * POST /browser-automation/waitFor
   * Wait for element
   */
  app.post<{
    Body: {
      deviceId?: string;
      selector?: string;
      text?: string;
      state?: string;
      timeout?: number;
    };
  }>("/browser-automation/waitFor", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, selector, text, state, timeout } = req.body;

    if (!selector && !text) {
      return reply.status(400).send({ error: "selector or text is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "waitFor", params: { selector, text, state, timeout } },
      timeout,
    });

    return reply.send(result);
  });

  app.get<{
    Querystring: { deviceId?: string };
  }>("/browser-automation/session/status", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId } = req.query;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "session.status", params: {} },
    });

    return reply.send(result);
  });

  app.get<{
    Querystring: { deviceId?: string };
  }>("/browser-automation/tabs", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId } = req.query;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "tab.list", params: {} },
    });

    return reply.send(result);
  });

  app.post<{
    Body: { deviceId?: string; url?: string; activate?: boolean };
  }>("/browser-automation/tab/new", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, url, activate } = req.body;

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "tab.new", params: { url, activate } },
    });

    return reply.send(result);
  });

  app.post<{
    Body: { deviceId?: string; tabId?: string; index?: number };
  }>("/browser-automation/tab/switch", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, tabId, index } = req.body;

    if (!tabId && index === undefined) {
      return reply.status(400).send({ error: "tabId or index is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "tab.switch", params: { tabId, index } },
    });

    return reply.send(result);
  });

  app.post<{
    Body: { deviceId?: string; tabId?: string; index?: number };
  }>("/browser-automation/tab/close", async (req, reply) => {
    const tenantId = (req as any).tenantId ?? "default";
    const { deviceId: inputDeviceId, tabId, index } = req.body;

    if (!tabId && index === undefined) {
      return reply.status(400).send({ error: "tabId or index is required" });
    }

    const deviceId = inputDeviceId ?? (await getDefaultDeviceId(pool, tenantId));
    if (!deviceId) {
      return reply.status(404).send({ error: "No browser-capable device available" });
    }

    const result = await sendBrowserCommand({
      pool,
      tenantId,
      deviceId,
      command: { action: "tab.close", params: { tabId, index } },
    });

    return reply.send(result);
  });

  /**
   * GET /browser-automation/execution/:id
   * Get execution status — P1-2: 查询真实执行状态
   */
  app.get<{
    Params: { id: string };
  }>("/browser-automation/execution/:id", async (req, reply) => {
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
