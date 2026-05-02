/**
 * P2-4: 协作运行时状态同步
 * 
 * 实现多智能体之间的状态同步：
 * - 全局协作状态管理
 * - 角色状态同步
 * - 冲突检测与解决
 * - 状态变更通知
 * - 一致性保证
 */
import { collabStreamRedisChannel, createCollabStreamSignal } from "@mindpal/shared";
import type { Pool } from "pg";
import type { RoleName, DynamicCollabState, CollabTurn, TurnOutcome } from "./dynamicCoordinator";
import { broadcast, type AgentMessage } from "./agentProtocol";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type CollabGlobalPhase = 
  | "initializing"
  | "planning"
  | "executing"
  | "reviewing"
  | "needs_approval"
  | "needs_device"
  | "needs_arbiter"
  | "paused"
  | "replanning"
  | "succeeded"
  | "failed"
  | "stopped";

export interface RoleState {
  roleName: RoleName;
  status: "idle" | "active" | "waiting" | "blocked" | "completed" | "failed";
  currentStepId?: string;
  progress?: number;  // 0-100
  lastUpdateAt: string;
  metadata?: Record<string, unknown>;
}

export interface CollabGlobalState {
  collabRunId: string;
  phase: CollabGlobalPhase;
  currentTurn: number;
  currentRole: RoleName | null;
  roleStates: Map<RoleName, RoleState>;
  /** 已完成的步骤 */
  completedStepIds: string[];
  /** 失败的步骤 */
  failedStepIds: string[];
  /** 待执行的步骤 */
  pendingStepIds: string[];
  /** 重规划次数 */
  replanCount: number;
  /** 开始时间 */
  startedAt?: string;
  /** 最后更新时间 */
  lastUpdatedAt: string;
  /** 版本号（用于乐观锁） */
  version: number;
}

export interface StateUpdate {
  updateId: string;
  collabRunId: string;
  sourceRole: RoleName;
  updateType: "role_status" | "step_progress" | "phase_change" | "error" | "replan";
  payload: Record<string, unknown>;
  timestamp: string;
  version: number;
}

export interface ConflictInfo {
  conflictType: "concurrent_update" | "invalid_transition" | "stale_version";
  sourceRole: RoleName;
  expectedVersion: number;
  actualVersion: number;
  resolution?: "accept" | "reject" | "merge";
}

/* ================================================================== */
/*  State Management                                                     */
/* ================================================================== */

/**
 * 初始化协作全局状态
 */
export async function initializeCollabState(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  roles: RoleName[];
  planStepIds: string[];
}): Promise<CollabGlobalState> {
  const { pool, tenantId, collabRunId, roles, planStepIds } = params;
  
  const roleStates = new Map<RoleName, RoleState>();
  const now = new Date().toISOString();
  
  for (const role of roles) {
    roleStates.set(role, {
      roleName: role,
      status: "idle",
      lastUpdateAt: now,
    });
  }
  
  const state: CollabGlobalState = {
    collabRunId,
    phase: "initializing",
    currentTurn: 0,
    currentRole: null,
    roleStates,
    completedStepIds: [],
    failedStepIds: [],
    pendingStepIds: planStepIds,
    replanCount: 0,
    startedAt: now,
    lastUpdatedAt: now,
    version: 1,
  };
  
  // 持久化状态
  await pool.query(
    `INSERT INTO collab_global_state 
     (tenant_id, collab_run_id, phase, current_turn, active_role, role_states, 
      completed_step_ids, failed_step_ids, pending_step_ids, replan_count, 
      started_at, last_updated_at, version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, now())
     ON CONFLICT (tenant_id, collab_run_id) DO UPDATE
     SET phase = EXCLUDED.phase,
         current_turn = EXCLUDED.current_turn,
         active_role = EXCLUDED.active_role,
         role_states = EXCLUDED.role_states,
         completed_step_ids = EXCLUDED.completed_step_ids,
         failed_step_ids = EXCLUDED.failed_step_ids,
         pending_step_ids = EXCLUDED.pending_step_ids,
         replan_count = EXCLUDED.replan_count,
         started_at = COALESCE(collab_global_state.started_at, EXCLUDED.started_at),
         last_updated_at = EXCLUDED.last_updated_at,
         version = collab_global_state.version + 1`,
    [
      tenantId,
      collabRunId,
      state.phase,
      state.currentTurn,
      state.currentRole,
      JSON.stringify(Object.fromEntries(roleStates)),
      JSON.stringify(state.completedStepIds),
      JSON.stringify(state.failedStepIds),
      JSON.stringify(state.pendingStepIds),
      state.replanCount,
      now,
      state.version,
    ]
  );
  
  return state;
}

/**
 * 获取当前协作状态
 */
export async function getCollabState(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
}): Promise<CollabGlobalState | null> {
  const { pool, tenantId, collabRunId } = params;
  
  const res = await pool.query<{
    collab_run_id: string;
    phase: string;
    current_turn: number;
    active_role: string | null;
    role_states: Record<string, RoleState>;
    completed_step_ids: string[];
    failed_step_ids: string[];
    pending_step_ids: string[];
    replan_count: number;
    started_at: string | null;
    last_updated_at: string;
    version: number;
  }>(
    "SELECT * FROM collab_global_state WHERE tenant_id = $1 AND collab_run_id = $2",
    [tenantId, collabRunId]
  );
  
  if (!res.rowCount) return null;
  
  const row = res.rows[0];
  const roleStates = new Map<RoleName, RoleState>();
  
  if (row.role_states) {
    for (const [k, v] of Object.entries(row.role_states)) {
      roleStates.set(k, v as RoleState);
    }
  }
  
  return {
    collabRunId: row.collab_run_id,
    phase: row.phase as CollabGlobalPhase,
    currentTurn: row.current_turn,
    currentRole: row.active_role,
    roleStates,
    completedStepIds: row.completed_step_ids ?? [],
    failedStepIds: row.failed_step_ids ?? [],
    pendingStepIds: row.pending_step_ids ?? [],
    replanCount: row.replan_count,
    startedAt: row.started_at ?? undefined,
    lastUpdatedAt: row.last_updated_at,
    version: row.version,
  };
}

/**
 * 更新协作状态（带乐观锁）
 */
export async function updateCollabState(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  expectedVersion: number;
  updates: Partial<Pick<CollabGlobalState, "phase" | "currentTurn" | "currentRole" | "replanCount">>;
  roleStateUpdates?: Map<RoleName, Partial<RoleState>>;
  stepUpdates?: {
    addCompleted?: string[];
    addFailed?: string[];
    removePending?: string[];
  };
}): Promise<{ ok: boolean; newVersion: number; conflict?: ConflictInfo }> {
  const { pool, tenantId, collabRunId, expectedVersion, updates, roleStateUpdates, stepUpdates } = params;
  const now = new Date().toISOString();
  
  // 使用事务和乐观锁
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // 检查版本号
    const versionCheck = await client.query<{ version: number; role_states: any }>(
      "SELECT version, role_states FROM collab_global_state WHERE tenant_id = $1 AND collab_run_id = $2 FOR UPDATE",
      [tenantId, collabRunId]
    );
    
    if (!versionCheck.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, newVersion: 0 };
    }
    
    const currentVersion = versionCheck.rows[0].version;
    if (currentVersion !== expectedVersion) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        newVersion: currentVersion,
        conflict: {
          conflictType: "stale_version",
          sourceRole: "system",
          expectedVersion,
          actualVersion: currentVersion,
        },
      };
    }
    
    // 合并角色状态更新
    let currentRoleStates = versionCheck.rows[0].role_states ?? {};
    if (roleStateUpdates) {
      for (const [role, partialState] of roleStateUpdates) {
        currentRoleStates[role] = {
          ...(currentRoleStates[role] ?? { roleName: role }),
          ...partialState,
          lastUpdateAt: now,
        };
      }
    }
    
    // 构建更新语句
    const newVersion = currentVersion + 1;
    await client.query(
      `UPDATE collab_global_state 
       SET phase = COALESCE($3, phase),
           current_turn = COALESCE($4, current_turn),
           active_role = COALESCE($5, active_role),
           role_states = $6,
           replan_count = COALESCE($7, replan_count),
           completed_step_ids = CASE 
             WHEN $8::text[] IS NOT NULL 
             THEN COALESCE(completed_step_ids, '[]'::jsonb) || to_jsonb($8::text[])
             ELSE completed_step_ids 
           END,
           failed_step_ids = CASE 
             WHEN $9::text[] IS NOT NULL 
             THEN COALESCE(failed_step_ids, '[]'::jsonb) || to_jsonb($9::text[])
             ELSE failed_step_ids 
           END,
           pending_step_ids = CASE 
             WHEN $10::text[] IS NOT NULL 
             THEN (
               SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
               FROM jsonb_array_elements_text(COALESCE(pending_step_ids, '[]'::jsonb)) AS value
               WHERE value NOT IN (SELECT unnest($10::text[]))
             )
             ELSE pending_step_ids 
           END,
           last_updated_at = $11,
           version = $12
       WHERE tenant_id = $1 AND collab_run_id = $2`,
      [
        tenantId,
        collabRunId,
        updates.phase ?? null,
        updates.currentTurn ?? null,
        updates.currentRole ?? null,
        JSON.stringify(currentRoleStates),
        updates.replanCount ?? null,
        stepUpdates?.addCompleted ?? null,
        stepUpdates?.addFailed ?? null,
        stepUpdates?.removePending ?? null,
        now,
        newVersion,
      ]
    );
    
    await client.query("COMMIT");
    return { ok: true, newVersion };
    
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ================================================================== */
/*  State Synchronization                                                */
/* ================================================================== */

/**
 * 广播状态更新给所有角色
 */
export async function broadcastStateUpdate(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  sourceRole: RoleName;
  updateType: StateUpdate["updateType"];
  payload: Record<string, unknown>;
  version: number;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, sourceRole, updateType, payload, version } = params;
  
  return broadcast({
    pool,
    tenantId,
    collabRunId,
    fromRole: sourceRole,
    payload: {
      type: "state_sync",
      updateType,
      payload,
      version,
      timestamp: new Date().toISOString(),
    },
    priority: updateType === "error" ? "high" : "normal",
  });
}

/**
 * 记录状态更新历史
 */
export async function recordStateUpdate(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  sourceRole: RoleName;
  updateType: StateUpdate["updateType"];
  payload: Record<string, unknown>;
  version: number;
}): Promise<StateUpdate> {
  const { pool, tenantId, collabRunId, sourceRole, updateType, payload, version } = params;
  
  const res = await pool.query<{ update_id: string; created_at: string }>(
    `INSERT INTO collab_state_updates 
     (tenant_id, collab_run_id, source_role, update_type, payload, version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING update_id, created_at`,
    [tenantId, collabRunId, sourceRole, updateType, JSON.stringify(payload), version]
  );
  
  return {
    updateId: res.rows[0].update_id,
    collabRunId,
    sourceRole,
    updateType,
    payload,
    timestamp: res.rows[0].created_at,
    version,
  };
}

/* ================================================================== */
/*  Phase Transitions                                                    */
/* ================================================================== */

/**
 * 有效的状态转换
 */
export const VALID_PHASE_TRANSITIONS: Record<CollabGlobalPhase, CollabGlobalPhase[]> = {
  initializing: ["planning"],
  planning: ["executing", "failed", "stopped"],
  executing: ["reviewing", "needs_approval", "needs_device", "needs_arbiter", "paused", "replanning", "succeeded", "failed", "stopped"],
  reviewing: ["executing", "replanning", "succeeded", "failed", "stopped"],
  needs_approval: ["executing", "paused", "stopped"],
  needs_device: ["executing", "paused", "stopped"],
  needs_arbiter: ["executing", "paused", "succeeded", "failed", "stopped"],
  paused: ["executing", "reviewing", "replanning", "stopped"],
  replanning: ["planning", "executing", "failed", "stopped"],
  succeeded: [],  // 终态
  failed: [],     // 终态
  stopped: [],    // 终态
};

/**
 * 验证状态转换是否有效
 */
export function isValidPhaseTransition(from: CollabGlobalPhase, to: CollabGlobalPhase): boolean {
  return VALID_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

async function publishCollabStreamSignal(params: {
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  kind: "state" | "event" | "envelope" | "status";
}) {
  if (!params.redis) return;
  await params.redis.publish(
    collabStreamRedisChannel(params.collabRunId),
    JSON.stringify(createCollabStreamSignal({
      collabRunId: params.collabRunId,
      tenantId: params.tenantId,
      taskId: params.taskId ?? null,
      kind: params.kind,
      source: "api",
    })),
  ).catch(() => {});
}

export function mapCollabStatusToPhase(status: string | null | undefined): CollabGlobalPhase | null {
  switch (String(status ?? "").trim()) {
    case "planning":
      return "planning";
    case "executing":
      return "executing";
    case "needs_approval":
      return "needs_approval";
    case "needs_device":
      return "needs_device";
    case "needs_arbiter":
      return "needs_arbiter";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "stopped":
    case "canceled":
      return "stopped";
    default:
      return null;
  }
}

/**
 * 执行状态转换
 */
export async function transitionPhase(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  fromPhase: CollabGlobalPhase;
  toPhase: CollabGlobalPhase;
  triggeredBy: RoleName;
  reason?: string;
  version: number;
}): Promise<{ ok: boolean; message: string; newVersion?: number }> {
  const { pool, tenantId, collabRunId, fromPhase, toPhase, triggeredBy, reason, version } = params;
  
  // 验证转换有效性
  if (!isValidPhaseTransition(fromPhase, toPhase)) {
    return { 
      ok: false, 
      message: `Invalid phase transition: ${fromPhase} → ${toPhase}` 
    };
  }
  
  // 更新状态
  const result = await updateCollabState({
    pool,
    tenantId,
    collabRunId,
    expectedVersion: version,
    updates: { phase: toPhase },
  });
  
  if (!result.ok) {
    return { 
      ok: false, 
      message: result.conflict 
        ? `Conflict: expected version ${result.conflict.expectedVersion}, got ${result.conflict.actualVersion}` 
        : "Update failed" 
    };
  }
  
  // 记录状态转换
  await recordStateUpdate({
    pool,
    tenantId,
    collabRunId,
    sourceRole: triggeredBy,
    updateType: "phase_change",
    payload: { from: fromPhase, to: toPhase, reason },
    version: result.newVersion,
  });
  
  // 广播状态变更
  await broadcastStateUpdate({
    pool,
    tenantId,
    collabRunId,
    sourceRole: triggeredBy,
    updateType: "phase_change",
    payload: { phase: toPhase, previousPhase: fromPhase, reason },
    version: result.newVersion,
  });
  
  return { ok: true, message: `Transitioned to ${toPhase}`, newVersion: result.newVersion };
}

export async function syncCollabPhase(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  toPhase: CollabGlobalPhase;
  triggeredBy: RoleName;
  reason?: string;
  currentRole?: RoleName | null;
}): Promise<{ ok: boolean; message: string; newVersion?: number }> {
  const { pool, tenantId, collabRunId, toPhase, triggeredBy, reason, currentRole } = params;
  const current = await getCollabState({ pool, tenantId, collabRunId });
  if (!current) {
    return { ok: false, message: "Collab state not found" };
  }
  if (current.phase === toPhase && (currentRole === undefined || current.currentRole === currentRole)) {
    return { ok: true, message: `Already in ${toPhase}`, newVersion: current.version };
  }
  if (isValidPhaseTransition(current.phase, toPhase)) {
    return transitionPhase({
      pool,
      tenantId,
      collabRunId,
      fromPhase: current.phase,
      toPhase,
      triggeredBy,
      reason,
      version: current.version,
      redis: params.redis,
      taskId: params.taskId ?? null,
    });
  }

  const result = await updateCollabState({
    pool,
    tenantId,
    collabRunId,
    expectedVersion: current.version,
    updates: {
      phase: toPhase,
      currentRole: currentRole === undefined ? undefined : currentRole,
    },
  });
  if (!result.ok) {
    return {
      ok: false,
      message: result.conflict
        ? `Conflict: expected version ${result.conflict.expectedVersion}, got ${result.conflict.actualVersion}`
        : "Update failed",
    };
  }

  await recordStateUpdate({
    pool,
    tenantId,
    collabRunId,
    sourceRole: triggeredBy,
    updateType: "phase_change",
    payload: {
      from: current.phase,
      to: toPhase,
      reason,
      forced: true,
      currentRole: currentRole ?? current.currentRole ?? null,
    },
    version: result.newVersion,
  });
  await publishCollabStreamSignal({
    redis: params.redis,
    tenantId: params.tenantId,
    collabRunId: params.collabRunId,
    taskId: params.taskId ?? null,
    kind: "state",
  });
  await broadcastStateUpdate({
    pool,
    tenantId,
    collabRunId,
    sourceRole: triggeredBy,
    updateType: "phase_change",
    payload: {
      phase: toPhase,
      previousPhase: current.phase,
      reason,
      forced: true,
      currentRole: currentRole ?? current.currentRole ?? null,
    },
    version: result.newVersion,
  });
  await publishCollabStreamSignal({
    redis: params.redis,
    tenantId,
    collabRunId,
    taskId: params.taskId ?? null,
    kind: "state",
  });
  await publishCollabStreamSignal({
    redis: params.redis,
    tenantId,
    collabRunId,
    taskId: params.taskId ?? null,
    kind: "state",
  });
  return { ok: true, message: `Forced transition to ${toPhase}`, newVersion: result.newVersion };
}

/* ================================================================== */
/*  Role State Sync                                                      */
/* ================================================================== */

/**
 * 更新角色状态
 */
export async function updateRoleState(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  roleName: RoleName;
  status: RoleState["status"];
  currentStepId?: string;
  progress?: number;
  metadata?: Record<string, unknown>;
  version: number;
}): Promise<{ ok: boolean; newVersion: number }> {
  const { pool, tenantId, collabRunId, roleName, status, currentStepId, progress, metadata, version } = params;
  
  const roleUpdate = new Map<RoleName, Partial<RoleState>>();
  roleUpdate.set(roleName, {
    status,
    currentStepId,
    progress,
    metadata,
  });
  
  const result = await updateCollabState({
    pool,
    tenantId,
    collabRunId,
    expectedVersion: version,
    updates: {},
    roleStateUpdates: roleUpdate,
  });
  
  if (result.ok) {
    // 广播角色状态变更
    await broadcastStateUpdate({
      pool,
      tenantId,
      collabRunId,
      sourceRole: roleName,
      updateType: "role_status",
      payload: { roleName, status, currentStepId, progress },
      version: result.newVersion,
    });
    await publishCollabStreamSignal({
      redis: params.redis,
      tenantId,
      collabRunId,
      taskId: params.taskId ?? null,
      kind: "state",
    });
  }
  
  return { ok: result.ok, newVersion: result.newVersion };
}

export async function syncRoleState(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  tenantId: string;
  collabRunId: string;
  taskId?: string | null;
  roleName: RoleName;
  status: RoleState["status"];
  currentStepId?: string;
  progress?: number;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean; newVersion?: number; message: string }> {
  const current = await getCollabState({
    pool: params.pool,
    tenantId: params.tenantId,
    collabRunId: params.collabRunId,
  });
  if (!current) {
    return { ok: false, message: "Collab state not found" };
  }
  const result = await updateRoleState({
    pool: params.pool,
    tenantId: params.tenantId,
    collabRunId: params.collabRunId,
    roleName: params.roleName,
    status: params.status,
    currentStepId: params.currentStepId,
    progress: params.progress,
    metadata: params.metadata,
    version: current.version,
    redis: params.redis,
    taskId: params.taskId ?? null,
  });
  return { ok: result.ok, newVersion: result.newVersion, message: result.ok ? "Role updated" : "Role update failed" };
}

/**
 * 标记步骤完成
 */
export async function markStepCompleted(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  stepId: string;
  executedBy: RoleName;
  version: number;
}): Promise<{ ok: boolean; newVersion: number }> {
  const { pool, tenantId, collabRunId, stepId, executedBy, version } = params;
  
  const result = await updateCollabState({
    pool,
    tenantId,
    collabRunId,
    expectedVersion: version,
    updates: {},
    stepUpdates: {
      addCompleted: [stepId],
      removePending: [stepId],
    },
  });
  
  if (result.ok) {
    await broadcastStateUpdate({
      pool,
      tenantId,
      collabRunId,
      sourceRole: executedBy,
      updateType: "step_progress",
      payload: { stepId, status: "completed" },
      version: result.newVersion,
    });
  }
  
  return { ok: result.ok, newVersion: result.newVersion };
}

/**
 * 标记步骤失败
 */
export async function markStepFailed(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  stepId: string;
  executedBy: RoleName;
  error: string;
  version: number;
}): Promise<{ ok: boolean; newVersion: number }> {
  const { pool, tenantId, collabRunId, stepId, executedBy, error, version } = params;
  
  const result = await updateCollabState({
    pool,
    tenantId,
    collabRunId,
    expectedVersion: version,
    updates: {},
    stepUpdates: {
      addFailed: [stepId],
      removePending: [stepId],
    },
  });
  
  if (result.ok) {
    await broadcastStateUpdate({
      pool,
      tenantId,
      collabRunId,
      sourceRole: executedBy,
      updateType: "error",
      payload: { stepId, status: "failed", error },
      version: result.newVersion,
    });
  }
  
  return { ok: result.ok, newVersion: result.newVersion };
}

/* ================================================================== */
/*  Snapshot & Recovery                                                  */
/* ================================================================== */

/**
 * 创建状态快照
 */
export async function createStateSnapshot(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  reason?: string;
}): Promise<{ snapshotId: string; version: number }> {
  const { pool, tenantId, collabRunId, reason } = params;
  
  const state = await getCollabState({ pool, tenantId, collabRunId });
  if (!state) {
    throw new Error(`Collab state not found: ${collabRunId}`);
  }
  
  const res = await pool.query<{ snapshot_id: string }>(
    `INSERT INTO collab_state_snapshots 
     (tenant_id, collab_run_id, version, state_data, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     RETURNING snapshot_id`,
    [
      tenantId,
      collabRunId,
      state.version,
      JSON.stringify({
        ...state,
        roleStates: Object.fromEntries(state.roleStates),
      }),
      reason ?? null,
    ]
  );
  
  return { snapshotId: res.rows[0].snapshot_id, version: state.version };
}

/**
 * 从快照恢复状态
 */
export async function restoreFromSnapshot(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  snapshotId: string;
}): Promise<{ ok: boolean; restoredVersion: number }> {
  const { pool, tenantId, collabRunId, snapshotId } = params;
  
  const res = await pool.query<{ version: number; state_data: any }>(
    "SELECT version, state_data FROM collab_state_snapshots WHERE tenant_id = $1 AND snapshot_id = $2",
    [tenantId, snapshotId]
  );
  
  if (!res.rowCount) {
    return { ok: false, restoredVersion: 0 };
  }
  
  const { version, state_data } = res.rows[0];
  
  await pool.query(
    `UPDATE collab_global_state 
     SET phase = $3,
         current_turn = $4,
         active_role = $5,
         role_states = $6,
         completed_step_ids = $7,
         failed_step_ids = $8,
         pending_step_ids = $9,
         replan_count = $10,
         last_updated_at = now(),
         version = version + 1
     WHERE tenant_id = $1 AND collab_run_id = $2`,
    [
      tenantId,
      collabRunId,
      state_data.phase,
      state_data.currentTurn,
      state_data.currentRole,
      JSON.stringify(state_data.roleStates),
      JSON.stringify(state_data.completedStepIds),
      JSON.stringify(state_data.failedStepIds),
      JSON.stringify(state_data.pendingStepIds),
      state_data.replanCount,
    ]
  );
  
  return { ok: true, restoredVersion: version };
}
