/**
 * 端侧执行调度 — Worker 侧设备执行集成
 *
 * 当工作流步骤的 toolRef 以 `device.` 开头时，Worker 需要：
 * 1. 检查是否已有关联的已完成 device_execution（恢复场景）
 * 2. 若无，自动在同 space 内寻找可用设备并创建 device_execution
 * 3. 将 run/step 挂起为 needs_device 状态，等待设备回传
 */
import type { Pool } from "pg";
import { StructuredLogger, resolveNumber } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:deviceDispatch" });

export type DeviceExecutionRow = {
  deviceExecutionId: string;
  tenantId: string;
  spaceId: string | null;
  deviceId: string;
  toolRef: string;
  status: string;
  outputDigest: any;
  evidenceRefs: string[] | null;
  errorCategory: string | null;
  runId: string | null;
  stepId: string | null;
  createdAt: string;
  claimedAt: string | null;
};

function toRow(r: any): DeviceExecutionRow {
  return {
    deviceExecutionId: r.device_execution_id,
    tenantId: r.tenant_id,
    spaceId: r.space_id ?? null,
    deviceId: r.device_id,
    toolRef: r.tool_ref,
    status: r.status,
    outputDigest: r.output_digest ?? null,
    evidenceRefs: Array.isArray(r.evidence_refs) ? (r.evidence_refs as string[]) : null,
    errorCategory: r.error_category ?? null,
    runId: r.run_id ?? null,
    stepId: r.step_id ?? null,
    createdAt: r.created_at,
    claimedAt: r.claimed_at ?? null,
  };
}

const ACTIVE_DEVICE_MAX_STALENESS_MS = resolveNumber("DEVICE_ACTIVE_MAX_STALENESS_MS").value;
const DEVICE_EXECUTION_PENDING_TIMEOUT_MS = resolveNumber("DEVICE_EXECUTION_PENDING_TIMEOUT_MS").value;

const DEVICE_TOOL_ALIAS_MAP: Record<string, string> = {
  "browser.navigate": "device.browser.open",
  "device.browser.navigate": "device.browser.open",
  "browser.fill": "device.browser.type",
  "device.browser.fill": "device.browser.type",
  "desktop.screen.capture": "device.desktop.screenshot",
  "desktop.screenshot": "device.desktop.screenshot",
  "desktop.clipboard.get": "device.clipboard.read",
  "desktop.clipboard.set": "device.clipboard.write",
};

function normalizeDeviceToolName(toolName: string): string {
  if (DEVICE_TOOL_ALIAS_MAP[toolName]) return DEVICE_TOOL_ALIAS_MAP[toolName];
  if (toolName.startsWith("browser.")) return `device.${toolName}`;
  if (toolName.startsWith("desktop.")) return `device.${toolName}`;
  return toolName;
}

export function isDeviceExecutionStale(params: {
  execution: Pick<DeviceExecutionRow, "status" | "createdAt" | "claimedAt">;
  nowMs?: number;
  deviceLastSeenAt?: string | null;
  deviceStatus?: string | null;
}): boolean {
  const nowMs = params.nowMs ?? Date.now();
  const executionStartedAt = Date.parse(params.execution.claimedAt ?? params.execution.createdAt);
  const ageMs = Number.isFinite(executionStartedAt) ? nowMs - executionStartedAt : DEVICE_EXECUTION_PENDING_TIMEOUT_MS + 1;
  if (ageMs > DEVICE_EXECUTION_PENDING_TIMEOUT_MS) return true;
  if (params.deviceStatus && params.deviceStatus !== "active") return true;
  if (params.deviceLastSeenAt) {
    const lastSeenMs = Date.parse(params.deviceLastSeenAt);
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > ACTIVE_DEVICE_MAX_STALENESS_MS) return true;
  }
  return false;
}

/** 检查指定 run/step 是否已有已完成的 device_execution */
export async function getCompletedDeviceExecution(params: {
  pool: Pool;
  tenantId: string;
  runId: string;
  stepId: string;
}): Promise<DeviceExecutionRow | null> {
  const res = await params.pool.query(
    `
      SELECT *
      FROM device_executions
      WHERE tenant_id = $1 AND run_id = $2 AND step_id = $3
        AND status IN ('succeeded', 'failed')
      ORDER BY completed_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.runId, params.stepId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

/** 检查指定 run/step 是否已有 pending/claimed 的 device_execution（避免重复创建） */
export async function getPendingDeviceExecution(params: {
  pool: Pool;
  tenantId: string;
  runId: string;
  stepId: string;
}): Promise<DeviceExecutionRow | null> {
  const res = await params.pool.query(
    `
      SELECT *
      FROM device_executions
      WHERE tenant_id = $1 AND run_id = $2 AND step_id = $3
        AND status IN ('pending', 'claimed')
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.runId, params.stepId],
  );
  if (!res.rowCount) return null;
  return toRow(res.rows[0]);
}

/** 在同 space 内查找最近活跃且支持指定工具的设备 */
export async function findActiveDeviceForTool(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  toolName: string;
}): Promise<{ deviceId: string } | null> {
  const normalizedToolName = normalizeDeviceToolName(params.toolName);
  const res = await params.pool.query(
    `
      SELECT d.device_id
      FROM device_records d
      JOIN device_policies p ON p.tenant_id = d.tenant_id AND p.device_id = d.device_id
      WHERE d.tenant_id = $1
        AND d.space_id = $2
        AND d.status = 'active'
        AND d.last_seen_at > now() - ($3::int * interval '1 millisecond')
        AND p.allowed_tools::jsonb @> $4::jsonb
      ORDER BY d.last_seen_at DESC
      LIMIT 1
    `,
    [params.tenantId, params.spaceId, ACTIVE_DEVICE_MAX_STALENESS_MS, JSON.stringify([normalizedToolName])],
  );
  if (!res.rowCount) return null;
  return { deviceId: String(res.rows[0].device_id) };
}

async function getDeviceLiveness(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
}): Promise<{ status: string | null; lastSeenAt: string | null } | null> {
  const res = await params.pool.query(
    `
      SELECT status, last_seen_at
      FROM device_records
      WHERE tenant_id = $1 AND device_id = $2
      LIMIT 1
    `,
    [params.tenantId, params.deviceId],
  );
  if (!res.rowCount) return null;
  return {
    status: res.rows[0].status ? String(res.rows[0].status) : null,
    lastSeenAt: res.rows[0].last_seen_at ? String(res.rows[0].last_seen_at) : null,
  };
}

async function cancelPendingDeviceExecution(params: {
  pool: Pool;
  tenantId: string;
  deviceExecutionId: string;
}) {
  await params.pool.query(
    `
      UPDATE device_executions
      SET status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND device_execution_id = $2 AND status IN ('pending','claimed')
    `,
    [params.tenantId, params.deviceExecutionId],
  );
}

/** 创建关联 run/step 的 device_execution */
export async function createDeviceExecutionForStep(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  deviceId: string;
  toolRef: string;
  policySnapshotRef: string | null;
  idempotencyKey: string | null;
  requireUserPresence: boolean;
  inputJson: any;
  inputDigest: any;
  runId: string;
  stepId: string;
}): Promise<DeviceExecutionRow> {
  const res = await params.pool.query(
    `
      INSERT INTO device_executions (
        tenant_id, space_id, created_by_subject_id, device_id,
        tool_ref, policy_snapshot_ref, idempotency_key, require_user_presence,
        input_json, input_digest, status, run_id, step_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'pending',$11,$12)
      RETURNING *
    `,
    [
      params.tenantId,
      params.spaceId,
      params.subjectId,
      params.deviceId,
      params.toolRef,
      params.policySnapshotRef,
      params.idempotencyKey,
      params.requireUserPresence,
      params.inputJson ? JSON.stringify(params.inputJson) : null,
      params.inputDigest ? JSON.stringify(params.inputDigest) : null,
      params.runId,
      params.stepId,
    ],
  );
  return toRow(res.rows[0]);
}

/** 判断工具名是否为设备端工具 */
export function isDeviceTool(toolName: string): boolean {
  return normalizeDeviceToolName(toolName).startsWith("device.");
}

/** 获取设备工具的风险级别（用于决定是否需要用户在场确认） */
export function deviceToolRequiresUserPresence(toolName: string): boolean {
  const highRisk = new Set([
    "device.desktop.screenshot",
    "device.desktop.launch",
    "device.file.write",
    "device.file.delete",
    "device.browser.open",
    "device.browser.screenshot",
  ]);
  return highRisk.has(normalizeDeviceToolName(toolName));
}

/**
 * 设备工具执行入口 — 由 builtinTools 调用
 *
 * 流程：
 * 1. 检查是否有已完成的 device_execution（恢复场景） → 直接返回结果
 * 2. 检查是否有待处理的 device_execution → 抛出 needs_device 等待
 * 3. 查找可用设备 → 创建 device_execution → 抛出 needs_device 等待
 */
export async function executeDeviceToolDispatch(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  toolRef: string;
  toolName: string;
  runId: string;
  stepId: string;
  policySnapshotRef: string | null;
  idempotencyKey: string | null;
  toolInput: any;
  inputDigest: any;
}): Promise<any> {
  // 1. 检查已完成的设备执行（step 恢复后再次进入）
  const completed = await getCompletedDeviceExecution({
    pool: params.pool,
    tenantId: params.tenantId,
    runId: params.runId,
    stepId: params.stepId,
  });

  if (completed) {
    if (completed.status === "failed") {
      const msg = completed.errorCategory ?? "device_execution_failed";
      _logger.error("device execution failed", { runId: params.runId, stepId: params.stepId, deviceExecutionId: completed.deviceExecutionId, errorCategory: msg });
      throw new Error(`device_execution_failed:${msg}`);
    }
    // 成功：返回设备执行结果，展开 outputDigest 使其匹配工具 outputSchema
    _logger.info("device execution completed", { runId: params.runId, stepId: params.stepId, deviceExecutionId: completed.deviceExecutionId });
    const deviceOutputDigest = completed.outputDigest && typeof completed.outputDigest === "object" && !Array.isArray(completed.outputDigest) ? completed.outputDigest : {};
    return {
      success: completed.status === "succeeded",
      ...deviceOutputDigest,
      deviceExecutionId: completed.deviceExecutionId,
      deviceId: completed.deviceId,
      evidenceRefs: completed.evidenceRefs,
    };
  }

  // 2. 检查是否已有 pending/claimed 的设备执行（避免重复创建）
  const pending = await getPendingDeviceExecution({
    pool: params.pool,
    tenantId: params.tenantId,
    runId: params.runId,
    stepId: params.stepId,
  });

  if (pending) {
    const deviceLiveness = await getDeviceLiveness({
      pool: params.pool,
      tenantId: params.tenantId,
      deviceId: pending.deviceId,
    });
    if (isDeviceExecutionStale({
      execution: pending,
      deviceLastSeenAt: deviceLiveness?.lastSeenAt ?? null,
      deviceStatus: deviceLiveness?.status ?? null,
    })) {
      await cancelPendingDeviceExecution({
        pool: params.pool,
        tenantId: params.tenantId,
        deviceExecutionId: pending.deviceExecutionId,
      });
      _logger.error("stale device execution canceled", {
        runId: params.runId, stepId: params.stepId, deviceExecutionId: pending.deviceExecutionId,
        deviceId: pending.deviceId, deviceStatus: deviceLiveness?.status ?? "unknown", lastSeenAt: deviceLiveness?.lastSeenAt ?? null,
      });
      throw new Error("timeout");
    }
    _logger.info("existing pending device execution", { runId: params.runId, stepId: params.stepId, deviceExecutionId: pending.deviceExecutionId, status: pending.status });
    const e: any = new Error("needs_device");
    e.deviceExecutionId = pending.deviceExecutionId;
    e.deviceId = pending.deviceId;
    throw e;
  }

  // 3. 查找可用设备
  if (!params.spaceId) {
    throw new Error("policy_violation:device_tool_requires_space");
  }

  const device = await findActiveDeviceForTool({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    toolName: params.toolName,
  });

  if (!device) {
    _logger.error("no active device found", { tenantId: params.tenantId, spaceId: params.spaceId, toolName: params.toolName });
    throw new Error("policy_violation:no_active_device_for_tool");
  }

  // 4. 创建设备执行
  const requireUserPresence = deviceToolRequiresUserPresence(params.toolName);
  const created = await createDeviceExecutionForStep({
    pool: params.pool,
    tenantId: params.tenantId,
    spaceId: params.spaceId,
    subjectId: params.subjectId,
    deviceId: device.deviceId,
    toolRef: params.toolRef,
    policySnapshotRef: params.policySnapshotRef,
    idempotencyKey: params.idempotencyKey,
    requireUserPresence,
    inputJson: params.toolInput,
    inputDigest: params.inputDigest,
    runId: params.runId,
    stepId: params.stepId,
  });

  _logger.info("created device execution", { runId: params.runId, stepId: params.stepId, deviceExecutionId: created.deviceExecutionId, deviceId: device.deviceId, toolRef: params.toolRef });

  // 抛出 needs_device 信号，由 processStep 捕获并挂起 run
  const e: any = new Error("needs_device");
  e.deviceExecutionId = created.deviceExecutionId;
  e.deviceId = device.deviceId;
  throw e;
}
