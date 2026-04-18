/**
 * P3-3: 设备状态实时同步
 * 
 * 实现设备与云端的状态同步：
 * - 设备状态上报
 * - 云端状态下推
 * - 状态变更事件
 * - 离线恢复
 */
import type { Pool } from "pg";
import type { DeviceSession } from "./handshakeProtocol";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type DeviceStateType = 
  | "online"
  | "offline"
  | "busy"
  | "idle"
  | "error"
  | "maintenance";

export interface DeviceState {
  deviceId: string;
  tenantId: string;
  state: DeviceStateType;
  /** 当前执行中的任务数 */
  activeTasks: number;
  /** 队列中等待的任务数 */
  pendingTasks: number;
  /** 资源使用情况 */
  resources: {
    cpuPercent?: number;
    memoryPercent?: number;
    diskPercent?: number;
  };
  /** 最近错误 */
  lastError?: string;
  /** 状态更新时间 */
  updatedAt: string;
  /** 版本号 */
  version: number;
}

export type StateChangeEvent = {
  eventId: string;
  deviceId: string;
  tenantId: string;
  fromState: DeviceStateType;
  toState: DeviceStateType;
  reason: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
};

export interface SyncMessage {
  messageType: "state_report" | "state_push" | "command" | "ack";
  deviceId: string;
  payload: Record<string, unknown>;
  timestamp: string;
  sequence: number;
}

/* ================================================================== */
/*  State Management                                                     */
/* ================================================================== */

/**
 * 更新设备状态
 */
export async function updateDeviceState(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  state: DeviceStateType;
  activeTasks?: number;
  pendingTasks?: number;
  resources?: DeviceState["resources"];
  lastError?: string;
}): Promise<DeviceState> {
  const { pool, tenantId, deviceId, state, activeTasks, pendingTasks, resources, lastError } = params;
  
  const res = await pool.query<{
    device_id: string;
    tenant_id: string;
    state: string;
    active_tasks: number;
    pending_tasks: number;
    resources: any;
    last_error: string | null;
    updated_at: string;
    version: number;
  }>(
    `INSERT INTO device_states 
     (tenant_id, device_id, state, active_tasks, pending_tasks, resources, last_error, updated_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 1)
     ON CONFLICT (tenant_id, device_id) DO UPDATE
     SET state = $3,
         active_tasks = COALESCE($4, device_states.active_tasks),
         pending_tasks = COALESCE($5, device_states.pending_tasks),
         resources = COALESCE($6, device_states.resources),
         last_error = $7,
         updated_at = now(),
         version = device_states.version + 1
     RETURNING *`,
    [
      tenantId,
      deviceId,
      state,
      activeTasks ?? 0,
      pendingTasks ?? 0,
      resources ? JSON.stringify(resources) : null,
      lastError ?? null,
    ]
  );
  
  const row = res.rows[0];
  return {
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    state: row.state as DeviceStateType,
    activeTasks: row.active_tasks,
    pendingTasks: row.pending_tasks,
    resources: row.resources ?? {},
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/**
 * 获取设备状态
 */
export async function getDeviceState(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
}): Promise<DeviceState | null> {
  const { pool, tenantId, deviceId } = params;
  
  const res = await pool.query<{
    device_id: string;
    tenant_id: string;
    state: string;
    active_tasks: number;
    pending_tasks: number;
    resources: any;
    last_error: string | null;
    updated_at: string;
    version: number;
  }>(
    "SELECT * FROM device_states WHERE tenant_id = $1 AND device_id = $2",
    [tenantId, deviceId]
  );
  
  if (!res.rowCount) return null;
  
  const row = res.rows[0];
  return {
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    state: row.state as DeviceStateType,
    activeTasks: row.active_tasks,
    pendingTasks: row.pending_tasks,
    resources: row.resources ?? {},
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/**
 * 批量获取设备状态
 */
export async function batchGetDeviceStates(params: {
  pool: Pool;
  tenantId: string;
  deviceIds: string[];
}): Promise<DeviceState[]> {
  const { pool, tenantId, deviceIds } = params;
  
  if (deviceIds.length === 0) return [];
  
  const res = await pool.query<{
    device_id: string;
    tenant_id: string;
    state: string;
    active_tasks: number;
    pending_tasks: number;
    resources: any;
    last_error: string | null;
    updated_at: string;
    version: number;
  }>(
    "SELECT * FROM device_states WHERE tenant_id = $1 AND device_id = ANY($2)",
    [tenantId, deviceIds]
  );
  
  return res.rows.map(row => ({
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    state: row.state as DeviceStateType,
    activeTasks: row.active_tasks,
    pendingTasks: row.pending_tasks,
    resources: row.resources ?? {},
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
    version: row.version,
  }));
}

/* ================================================================== */
/*  State Change Events                                                  */
/* ================================================================== */

/**
 * 记录状态变更事件
 */
export async function recordStateChange(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  fromState: DeviceStateType;
  toState: DeviceStateType;
  reason: string;
  metadata?: Record<string, unknown>;
}): Promise<StateChangeEvent> {
  const { pool, tenantId, deviceId, fromState, toState, reason, metadata } = params;
  
  const res = await pool.query<{ event_id: string; created_at: string }>(
    `INSERT INTO device_state_events 
     (tenant_id, device_id, from_state, to_state, reason, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING event_id, created_at`,
    [tenantId, deviceId, fromState, toState, reason, metadata ? JSON.stringify(metadata) : null]
  );
  
  return {
    eventId: res.rows[0].event_id,
    deviceId,
    tenantId,
    fromState,
    toState,
    reason,
    metadata,
    timestamp: res.rows[0].created_at,
  };
}

/**
 * 获取状态变更历史
 */
export async function getStateChangeHistory(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  limit?: number;
  since?: string;
}): Promise<StateChangeEvent[]> {
  const { pool, tenantId, deviceId, limit = 50, since } = params;
  
  const res = await pool.query<{
    event_id: string;
    device_id: string;
    tenant_id: string;
    from_state: string;
    to_state: string;
    reason: string;
    metadata: any;
    created_at: string;
  }>(
    `SELECT * FROM device_state_events 
     WHERE tenant_id = $1 AND device_id = $2
       AND ($4::TIMESTAMPTZ IS NULL OR created_at > $4)
     ORDER BY created_at DESC
     LIMIT $3`,
    [tenantId, deviceId, limit, since ?? null]
  );
  
  return res.rows.map(row => ({
    eventId: row.event_id,
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    fromState: row.from_state as DeviceStateType,
    toState: row.to_state as DeviceStateType,
    reason: row.reason,
    metadata: row.metadata,
    timestamp: row.created_at,
  }));
}

/* ================================================================== */
/*  Sync Protocol                                                        */
/* ================================================================== */

/**
 * 处理设备状态上报
 */
export async function handleStateReport(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  report: {
    state: DeviceStateType;
    activeTasks: number;
    pendingTasks: number;
    resources: DeviceState["resources"];
    lastError?: string;
    sequence: number;
  };
}): Promise<{ accepted: boolean; serverState: DeviceState; commands?: SyncMessage[] }> {
  const { pool, tenantId, deviceId, report } = params;
  
  // 获取当前状态
  const currentState = await getDeviceState({ pool, tenantId, deviceId });
  
  // 检测状态变更
  const stateChanged = !currentState || currentState.state !== report.state;
  
  // 更新状态
  const newState = await updateDeviceState({
    pool,
    tenantId,
    deviceId,
    state: report.state,
    activeTasks: report.activeTasks,
    pendingTasks: report.pendingTasks,
    resources: report.resources,
    lastError: report.lastError,
  });
  
  // 记录状态变更
  if (stateChanged && currentState) {
    await recordStateChange({
      pool,
      tenantId,
      deviceId,
      fromState: currentState.state,
      toState: report.state,
      reason: "device_report",
      metadata: { sequence: report.sequence },
    });
  }
  
  // 检查是否有待下发的命令
  const commands = await getPendingCommands({ pool, tenantId, deviceId });
  
  return {
    accepted: true,
    serverState: newState,
    commands: commands.length > 0 ? commands : undefined,
  };
}

/**
 * 获取待下发的命令
 */
async function getPendingCommands(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
}): Promise<SyncMessage[]> {
  const { pool, tenantId, deviceId } = params;
  
  const res = await pool.query<{
    command_id: string;
    message_type: string;
    payload: any;
    sequence: number;
    created_at: string;
  }>(
    `SELECT command_id, message_type, payload, sequence, created_at
     FROM device_pending_commands 
     WHERE tenant_id = $1 AND device_id = $2 AND status = 'pending'
     ORDER BY sequence ASC
     LIMIT 10`,
    [tenantId, deviceId]
  );
  
  return res.rows.map(row => ({
    messageType: row.message_type as SyncMessage["messageType"],
    deviceId,
    payload: row.payload ?? {},
    timestamp: row.created_at,
    sequence: row.sequence,
  }));
}

/**
 * 入队设备命令
 */
export async function enqueueDeviceCommand(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  command: {
    type: "policy_update" | "config_update" | "pause" | "resume" | "terminate";
    payload: Record<string, unknown>;
  };
}): Promise<{ commandId: string; sequence: number }> {
  const { pool, tenantId, deviceId, command } = params;
  
  const res = await pool.query<{ command_id: string; sequence: number }>(
    `INSERT INTO device_pending_commands 
     (tenant_id, device_id, message_type, payload, status, sequence, created_at)
     VALUES ($1, $2, 'command', $3, 'pending', 
       COALESCE((SELECT MAX(sequence) + 1 FROM device_pending_commands WHERE tenant_id = $1 AND device_id = $2), 1),
       now())
     RETURNING command_id, sequence`,
    [tenantId, deviceId, JSON.stringify({ type: command.type, ...command.payload })]
  );
  
  return {
    commandId: res.rows[0].command_id,
    sequence: res.rows[0].sequence,
  };
}

/**
 * 确认命令已执行
 */
export async function acknowledgeCommand(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  sequence: number;
  success: boolean;
  error?: string;
}): Promise<void> {
  const { pool, tenantId, deviceId, sequence, success, error } = params;
  
  await pool.query(
    `UPDATE device_pending_commands 
     SET status = $4, 
         error_message = $5,
         acknowledged_at = now()
     WHERE tenant_id = $1 AND device_id = $2 AND sequence <= $3 AND status = 'pending'`,
    [tenantId, deviceId, sequence, success ? "completed" : "failed", error ?? null]
  );
}

/* ================================================================== */
/*  Offline Recovery                                                     */
/* ================================================================== */

/**
 * 处理设备重连
 */
export async function handleDeviceReconnect(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  lastKnownSequence: number;
}): Promise<{
  missedEvents: StateChangeEvent[];
  pendingCommands: SyncMessage[];
  currentState: DeviceState | null;
}> {
  const { pool, tenantId, deviceId, lastKnownSequence } = params;
  
  // 获取当前状态
  const currentState = await getDeviceState({ pool, tenantId, deviceId });
  
  // 获取错过的事件
  const missedEvents = await getStateChangeHistory({
    pool,
    tenantId,
    deviceId,
    limit: 100,
  });
  
  // 获取待执行的命令
  const pendingCommands = await getPendingCommands({ pool, tenantId, deviceId });
  
  // 更新设备状态为在线
  if (currentState?.state === "offline") {
    await updateDeviceState({
      pool,
      tenantId,
      deviceId,
      state: "online",
    });
    
    await recordStateChange({
      pool,
      tenantId,
      deviceId,
      fromState: "offline",
      toState: "online",
      reason: "device_reconnect",
      metadata: { lastKnownSequence },
    });
  }
  
  return {
    missedEvents,
    pendingCommands,
    currentState,
  };
}

/**
 * 标记设备离线
 */
export async function markDeviceOffline(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  reason: string;
}): Promise<void> {
  const { pool, tenantId, deviceId, reason } = params;
  
  const currentState = await getDeviceState({ pool, tenantId, deviceId });
  if (!currentState || currentState.state === "offline") return;
  
  await updateDeviceState({
    pool,
    tenantId,
    deviceId,
    state: "offline",
  });
  
  await recordStateChange({
    pool,
    tenantId,
    deviceId,
    fromState: currentState.state,
    toState: "offline",
    reason,
  });
}

/* ================================================================== */
/*  Monitoring                                                           */
/* ================================================================== */

/**
 * 获取设备状态概览
 */
export async function getDeviceStateOverview(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
}): Promise<{
  total: number;
  online: number;
  offline: number;
  busy: number;
  error: number;
  averageLoad: number;
}> {
  const { pool, tenantId, spaceId } = params;
  
  const res = await pool.query<{
    state: string;
    count: string;
    avg_active: string;
  }>(
    `SELECT ds.state, COUNT(*) as count, AVG(ds.active_tasks) as avg_active
     FROM device_states ds
     JOIN device_records dr ON ds.device_id = dr.device_id AND ds.tenant_id = dr.tenant_id
     WHERE ds.tenant_id = $1 
       AND dr.status = 'active'
       AND ($2::TEXT IS NULL OR dr.space_id = $2)
     GROUP BY ds.state`,
    [tenantId, spaceId ?? null]
  );
  
  let total = 0, online = 0, offline = 0, busy = 0, error = 0;
  let totalActive = 0;
  
  for (const row of res.rows) {
    const count = parseInt(row.count, 10);
    total += count;
    totalActive += parseFloat(row.avg_active) * count;
    
    switch (row.state) {
      case "online":
      case "idle":
        online += count;
        break;
      case "offline":
        offline += count;
        break;
      case "busy":
        busy += count;
        break;
      case "error":
        error += count;
        break;
    }
  }
  
  return {
    total,
    online,
    offline,
    busy,
    error,
    averageLoad: total > 0 ? totalActive / total : 0,
  };
}
