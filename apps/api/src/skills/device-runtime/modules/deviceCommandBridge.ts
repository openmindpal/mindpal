/**
 * Device Command Bridge — P1-2 共享桥接模块
 *
 * 为 browser-automation 和 desktop-automation 提供统一的命令下发+结果等待机制。
 * 替代原来的 "insert → return queued" 模式，改为：
 *   1. 通过 createDeviceExecution() 插入 pending 记录
 *   2. 轮询 device_executions 表等待 device-agent 完成（succeeded/failed）
 *   3. 超时则取消执行并返回 timeout 错误
 *   4. 设备离线时立即返回 device_unavailable
 */
import type { Pool } from "pg";
import {
  createDeviceExecution,
  getDeviceExecution,
  cancelDeviceExecution,
  type DeviceExecutionRow,
} from "./deviceExecutionRepo";

/* ── Types ── */

export interface DeviceCommand {
  action: string;
  params: Record<string, any>;
}

export interface DeviceCommandResult {
  success: boolean;
  executionId: string;
  status: "succeeded" | "failed" | "timeout" | "device_unavailable";
  data?: any;
  error?: string;
  outputDigest?: any;
}

/* ── Constants ── */

/** 默认命令超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 500;
/** 最大轮询间隔（毫秒，指数退避上限） */
const MAX_POLL_INTERVAL_MS = 2_000;

type OnlineDeviceCandidateRow = {
  device_id: string;
  device_type: string | null;
  capabilities: unknown;
  allowed_tools: unknown;
};

function normalizeCapabilityToolRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof (item as any).toolRef === "string") {
        return String((item as any).toolRef);
      }
      return "";
    })
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function toolMatchesPrefixes(toolRef: string, prefixes: readonly string[]): boolean {
  const normalized = toolRef.trim().toLowerCase();
  return prefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function capabilityPrefixes(capability: string): readonly string[] {
  switch (capability.trim().toLowerCase()) {
    case "browser":
      return ["browser.", "device.browser."];
    case "desktop":
      return ["desktop.", "device.desktop.", "device.clipboard."];
    default:
      return [`${capability.trim().toLowerCase()}.`, `device.${capability.trim().toLowerCase()}.`];
  }
}

function matchesCapability(row: OnlineDeviceCandidateRow, capability: string): boolean {
  const normalizedCapability = capability.trim().toLowerCase();
  const deviceType = String(row.device_type ?? "").trim().toLowerCase();
  if ((normalizedCapability === "browser" || normalizedCapability === "desktop") && deviceType !== "desktop") {
    return false;
  }

  const prefixes = capabilityPrefixes(normalizedCapability);
  const declaredCapabilities = normalizeCapabilityToolRefs(row.capabilities);
  const allowedTools = normalizeCapabilityToolRefs(row.allowed_tools);
  const declaredMatch = declaredCapabilities.length === 0 || declaredCapabilities.some((toolRef) => toolMatchesPrefixes(toolRef, prefixes));
  const allowedMatch = allowedTools.length === 0 || allowedTools.some((toolRef) => toolMatchesPrefixes(toolRef, prefixes));
  return declaredMatch && allowedMatch;
}

/* ── Device Lookup ── */

/**
 * 查找在线的、具备指定 capability 的设备。
 * 使用 device_records 表（真实表结构），而非简化版 devices 表。
 */
export async function findOnlineDevice(params: {
  pool: Pool;
  tenantId: string;
  capability: string;
  preferDeviceId?: string;
}): Promise<string | null> {
  try {
    const values: unknown[] = [params.tenantId];
    let deviceFilterSql = "";
    if (params.preferDeviceId) {
      values.push(params.preferDeviceId);
      deviceFilterSql = "AND d.device_id = $2";
    }

    const res = await params.pool.query<OnlineDeviceCandidateRow>(
      `SELECT d.device_id, d.device_type, s.capabilities, p.allowed_tools
       FROM device_records d
       LEFT JOIN LATERAL (
         SELECT ds.capabilities
         FROM device_sessions ds
         WHERE ds.tenant_id = d.tenant_id
           AND ds.device_id = d.device_id
           AND ds.status = 'active'
         ORDER BY ds.last_activity_at DESC
         LIMIT 1
       ) s ON true
       LEFT JOIN device_policies p ON p.tenant_id = d.tenant_id AND p.device_id = d.device_id
       WHERE d.tenant_id = $1
         ${deviceFilterSql}
         AND d.status = 'active'
         AND d.last_seen_at > now() - interval '5 minutes'
       ORDER BY d.last_seen_at DESC
       LIMIT 50`,
      values,
    );
    const match = res.rows.find((row) => matchesCapability(row, params.capability));
    return match?.device_id ? String(match.device_id) : null;
  } catch {
    return null;
  }
}

/* ── Core Bridge ── */

/**
 * 下发命令到 device-agent 并等待执行结果。
 *
 * @param params.pool       数据库连接池
 * @param params.tenantId   租户 ID
 * @param params.deviceId   目标设备 ID
 * @param params.toolPrefix 工具前缀（"browser" | "desktop"）
 * @param params.command    命令内容
 * @param params.timeout    超时毫秒数（默认 30s）
 * @param params.spaceId    可选 space ID
 * @param params.subjectId  可选调用者 subject ID
 */
export async function dispatchAndWaitForResult(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  toolPrefix: string;
  command: DeviceCommand;
  timeout?: number;
  spaceId?: string;
  subjectId?: string;
}): Promise<DeviceCommandResult> {
  const timeoutMs = params.timeout ?? DEFAULT_TIMEOUT_MS;
  const toolRef = `${params.toolPrefix}.${params.command.action}`;

  // 1. 检查设备是否在线
  const deviceCheck = await params.pool.query(
    `SELECT device_id FROM device_records
     WHERE tenant_id = $1 AND device_id = $2
       AND status = 'active'
       AND last_seen_at > now() - interval '5 minutes'
     LIMIT 1`,
    [params.tenantId, params.deviceId],
  );

  if (!deviceCheck.rowCount) {
    return {
      success: false,
      executionId: "",
      status: "device_unavailable",
      error: `Device ${params.deviceId} is offline or not found`,
    };
  }

  // 2. 创建执行记录
  const execution = await createDeviceExecution({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    createdBySubjectId: params.subjectId,
    deviceId: params.deviceId,
    toolRef,
    inputJson: params.command.params,
    inputDigest: { action: params.command.action, paramKeys: Object.keys(params.command.params) },
  });

  const executionId = execution.deviceExecutionId;

  // 3. 轮询等待结果（指数退避）
  const deadline = Date.now() + timeoutMs;
  let pollInterval = POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    const current = await getDeviceExecution({
      pool: params.pool,
      tenantId: params.tenantId,
      deviceExecutionId: executionId,
    });

    if (!current) {
      // 记录异常消失
      return {
        success: false,
        executionId,
        status: "failed",
        error: "Execution record disappeared unexpectedly",
      };
    }

    if (current.status === "succeeded") {
      return {
        success: true,
        executionId,
        status: "succeeded",
        data: current.outputDigest,
        outputDigest: current.outputDigest,
      };
    }

    if (current.status === "failed") {
      return {
        success: false,
        executionId,
        status: "failed",
        error: current.errorCategory ?? "Execution failed on device",
        data: current.outputDigest,
        outputDigest: current.outputDigest,
      };
    }

    if (current.status === "canceled") {
      return {
        success: false,
        executionId,
        status: "failed",
        error: "Execution was canceled",
      };
    }

    // 指数退避
    pollInterval = Math.min(pollInterval * 1.5, MAX_POLL_INTERVAL_MS);
  }

  // 4. 超时：取消执行
  await cancelDeviceExecution({
    pool: params.pool,
    tenantId: params.tenantId,
    deviceExecutionId: executionId,
  }).catch(() => {}); // 忽略取消失败

  return {
    success: false,
    executionId,
    status: "timeout",
    error: `Command timed out after ${timeoutMs}ms`,
  };
}

/* ── Helpers ── */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
