/**
 * P3-1: 端侧执行握手机制增强
 * 
 * Worker 与设备代理之间的增强握手协议：
 * - 能力协商（设备支持的工具列表）
 * - 会话建立与保持
 * - 安全通道验证
 * - 负载均衡与健康检查
 */
import type { Pool } from "pg";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type DeviceCapability = {
  toolRef: string;
  version: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiresUserPresence?: boolean;
  maxConcurrency?: number;
};

export type HandshakePhase = 
  | "init"           // 初始化
  | "capability_exchange"  // 能力交换
  | "policy_sync"    // 策略同步
  | "session_establish"  // 会话建立
  | "ready"          // 就绪
  | "error";         // 错误

export interface DeviceSession {
  sessionId: string;
  deviceId: string;
  tenantId: string;
  /** 会话状态 */
  status: "active" | "idle" | "suspended" | "terminated";
  /** 当前阶段 */
  phase: HandshakePhase;
  /** 设备能力列表 */
  capabilities: DeviceCapability[];
  /** 策略版本 */
  policyVersion: string;
  /** 会话开始时间 */
  startedAt: string;
  /** 最后活动时间 */
  lastActivityAt: string;
  /** 心跳间隔 (ms) */
  heartbeatIntervalMs: number;
  /** 会话超时 (ms) */
  sessionTimeoutMs: number;
  /** 并发执行数 */
  currentConcurrency: number;
  /** 最大并发数 */
  maxConcurrency: number;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

export interface HandshakeRequest {
  deviceId: string;
  deviceToken: string;
  agentVersion: string;
  os: string;
  /** 设备声明的能力 */
  declaredCapabilities: DeviceCapability[];
  /** 请求的心跳间隔 */
  requestedHeartbeatMs?: number;
  /** 设备资源信息 */
  resources?: {
    cpuCores?: number;
    memoryMb?: number;
    diskFreeMb?: number;
  };
}

export interface HandshakeResponse {
  sessionId: string;
  status: "accepted" | "rejected" | "needs_update";
  phase: HandshakePhase;
  /** 服务端确认的能力 */
  confirmedCapabilities: DeviceCapability[];
  /** 当前策略 */
  policy: Record<string, unknown>;
  policyVersion: string;
  /** 确定的心跳间隔 */
  heartbeatIntervalMs: number;
  /** 会话超时 */
  sessionTimeoutMs: number;
  /** 最大并发执行数 */
  maxConcurrency: number;
  /** 拒绝原因 */
  rejectReason?: string;
  /** 需要更新时的最低版本 */
  minAgentVersion?: string;
}

export interface CapabilityNegotiationResult {
  confirmed: DeviceCapability[];
  rejected: Array<{ toolRef: string; reason: string }>;
  missing: string[];  // 平台需要但设备缺失的
}

/* ================================================================== */
/*  Handshake Protocol                                                   */
/* ================================================================== */

/**
 * 处理设备握手请求
 */
export async function processHandshake(params: {
  pool: Pool;
  request: HandshakeRequest;
  minAgentVersion: string;
  defaultHeartbeatMs: number;
  defaultSessionTimeoutMs: number;
  defaultMaxConcurrency: number;
}): Promise<HandshakeResponse> {
  const { pool, request, minAgentVersion, defaultHeartbeatMs, defaultSessionTimeoutMs, defaultMaxConcurrency } = params;
  
  // 1. 验证设备Token
  const device = await verifyDeviceToken({ pool, deviceId: request.deviceId, deviceToken: request.deviceToken });
  if (!device) {
    return {
      sessionId: "",
      status: "rejected",
      phase: "error",
      confirmedCapabilities: [],
      policy: {},
      policyVersion: "",
      heartbeatIntervalMs: 0,
      sessionTimeoutMs: 0,
      maxConcurrency: 0,
      rejectReason: "Invalid device credentials",
    };
  }
  
  // 2. 检查Agent版本
  if (compareVersions(request.agentVersion, minAgentVersion) < 0) {
    return {
      sessionId: "",
      status: "needs_update",
      phase: "error",
      confirmedCapabilities: [],
      policy: {},
      policyVersion: "",
      heartbeatIntervalMs: 0,
      sessionTimeoutMs: 0,
      maxConcurrency: 0,
      rejectReason: `Agent version ${request.agentVersion} is below minimum ${minAgentVersion}`,
      minAgentVersion,
    };
  }
  
  // 3. 获取设备策略
  const policy = await getDevicePolicyForHandshake({ pool, tenantId: device.tenantId, deviceId: request.deviceId });
  
  // 4. 能力协商
  const negotiation = negotiateCapabilities({
    declared: request.declaredCapabilities,
    policy,
  });
  
  // 5. 创建会话
  const heartbeatMs = Math.max(
    1000,
    Math.min(request.requestedHeartbeatMs ?? defaultHeartbeatMs, 60000)
  );
  
  const maxConcurrency = Math.min(
    policy.maxConcurrency ?? defaultMaxConcurrency,
    request.resources?.cpuCores ?? defaultMaxConcurrency
  );
  
  const session = await createDeviceSession({
    pool,
    tenantId: device.tenantId,
    deviceId: request.deviceId,
    capabilities: negotiation.confirmed,
    policyVersion: policy.version,
    heartbeatIntervalMs: heartbeatMs,
    sessionTimeoutMs: defaultSessionTimeoutMs,
    maxConcurrency,
    metadata: {
      agentVersion: request.agentVersion,
      os: request.os,
      resources: request.resources,
      negotiation: {
        rejected: negotiation.rejected,
        missing: negotiation.missing,
      },
    },
  });
  
  return {
    sessionId: session.sessionId,
    status: "accepted",
    phase: "ready",
    confirmedCapabilities: negotiation.confirmed,
    policy: policy.rules,
    policyVersion: policy.version,
    heartbeatIntervalMs: heartbeatMs,
    sessionTimeoutMs: defaultSessionTimeoutMs,
    maxConcurrency,
  };
}

/**
 * 验证设备Token
 */
async function verifyDeviceToken(params: {
  pool: Pool;
  deviceId: string;
  deviceToken: string;
}): Promise<{ tenantId: string; deviceId: string; spaceId: string | null } | null> {
  const { pool, deviceId, deviceToken } = params;
  
  // 计算 token hash
  const crypto = await import("node:crypto");
  const tokenHash = crypto.createHash("sha256").update(deviceToken).digest("hex");
  
  const res = await pool.query<{ tenant_id: string; device_id: string; space_id: string | null }>(
    `SELECT tenant_id, device_id, space_id 
     FROM device_records 
     WHERE device_id = $1 AND device_token_hash = $2 AND status = 'active'`,
    [deviceId, tokenHash]
  );
  
  if (!res.rowCount) return null;
  
  return {
    tenantId: res.rows[0].tenant_id,
    deviceId: res.rows[0].device_id,
    spaceId: res.rows[0].space_id,
  };
}

/**
 * 获取设备策略
 */
async function getDevicePolicyForHandshake(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
}): Promise<{ version: string; rules: Record<string, unknown>; maxConcurrency?: number; allowedTools?: string[] }> {
  const { pool, tenantId, deviceId } = params;
  
  const res = await pool.query<{
    policy_id: string;
    allowed_tools: string[] | null;
    max_concurrency: number | null;
    policy_rules: any;
    updated_at: string;
  }>(
    `SELECT policy_id, allowed_tools, max_concurrency, policy_rules, updated_at
     FROM device_policies 
     WHERE tenant_id = $1 AND device_id = $2`,
    [tenantId, deviceId]
  );
  
  if (!res.rowCount) {
    return { version: "default-v1", rules: {}, maxConcurrency: 5 };
  }
  
  const row = res.rows[0];
  return {
    version: `${row.policy_id}-${new Date(row.updated_at).getTime()}`,
    rules: row.policy_rules ?? {},
    maxConcurrency: row.max_concurrency ?? 5,
    allowedTools: row.allowed_tools ?? undefined,
  };
}

/**
 * 能力协商
 */
export function negotiateCapabilities(params: {
  declared: DeviceCapability[];
  policy: { allowedTools?: string[]; rules: Record<string, unknown> };
}): CapabilityNegotiationResult {
  const { declared, policy } = params;
  const allowedTools = policy.allowedTools;
  
  const confirmed: DeviceCapability[] = [];
  const rejected: Array<{ toolRef: string; reason: string }> = [];
  
  for (const cap of declared) {
    const toolName = cap.toolRef.split("@")[0] ?? cap.toolRef;
    
    // 检查是否在允许列表中
    if (allowedTools && !allowedTools.includes(toolName) && !allowedTools.includes(cap.toolRef)) {
      rejected.push({ toolRef: cap.toolRef, reason: "Not in allowed tools list" });
      continue;
    }
    
    // 检查是否被显式禁用
    const deniedTools = (policy.rules as any)?.deniedTools as string[] | undefined;
    if (deniedTools && (deniedTools.includes(toolName) || deniedTools.includes(cap.toolRef))) {
      rejected.push({ toolRef: cap.toolRef, reason: "Explicitly denied by policy" });
      continue;
    }
    
    confirmed.push(cap);
  }
  
  // 计算缺失的必需能力
  const requiredTools = (policy.rules as any)?.requiredTools as string[] | undefined;
  const confirmedToolRefs = new Set(confirmed.map(c => c.toolRef.split("@")[0]));
  const missing = (requiredTools ?? []).filter(t => !confirmedToolRefs.has(t));
  
  return { confirmed, rejected, missing };
}

/* ================================================================== */
/*  Session Management                                                   */
/* ================================================================== */

/**
 * 创建设备会话
 */
export async function createDeviceSession(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  capabilities: DeviceCapability[];
  policyVersion: string;
  heartbeatIntervalMs: number;
  sessionTimeoutMs: number;
  maxConcurrency: number;
  metadata?: Record<string, unknown>;
}): Promise<DeviceSession> {
  const { pool, tenantId, deviceId, capabilities, policyVersion, heartbeatIntervalMs, sessionTimeoutMs, maxConcurrency, metadata } = params;
  
  const res = await pool.query<{ session_id: string; created_at: string }>(
    `INSERT INTO device_sessions 
     (tenant_id, device_id, status, phase, capabilities, policy_version, 
      heartbeat_interval_ms, session_timeout_ms, max_concurrency, current_concurrency, metadata, created_at, last_activity_at)
     VALUES ($1, $2, 'active', 'ready', $3, $4, $5, $6, $7, 0, $8, now(), now())
     RETURNING session_id, created_at`,
    [tenantId, deviceId, JSON.stringify(capabilities), policyVersion, heartbeatIntervalMs, sessionTimeoutMs, maxConcurrency, metadata ? JSON.stringify(metadata) : null]
  );
  
  const now = res.rows[0].created_at;
  return {
    sessionId: res.rows[0].session_id,
    deviceId,
    tenantId,
    status: "active",
    phase: "ready",
    capabilities,
    policyVersion,
    startedAt: now,
    lastActivityAt: now,
    heartbeatIntervalMs,
    sessionTimeoutMs,
    currentConcurrency: 0,
    maxConcurrency,
    metadata,
  };
}

/**
 * 更新会话活动时间
 */
export async function touchSession(params: {
  pool: Pool;
  tenantId: string;
  sessionId: string;
}): Promise<boolean> {
  const { pool, tenantId, sessionId } = params;
  
  const res = await pool.query(
    `UPDATE device_sessions 
     SET last_activity_at = now()
     WHERE tenant_id = $1 AND session_id = $2 AND status = 'active'`,
    [tenantId, sessionId]
  );
  
  return (res.rowCount ?? 0) > 0;
}

/**
 * 获取会话
 */
export async function getSession(params: {
  pool: Pool;
  tenantId: string;
  sessionId: string;
}): Promise<DeviceSession | null> {
  const { pool, tenantId, sessionId } = params;
  
  const res = await pool.query<{
    session_id: string;
    device_id: string;
    tenant_id: string;
    status: string;
    phase: string;
    capabilities: any;
    policy_version: string;
    created_at: string;
    last_activity_at: string;
    heartbeat_interval_ms: number;
    session_timeout_ms: number;
    current_concurrency: number;
    max_concurrency: number;
    metadata: any;
  }>(
    "SELECT * FROM device_sessions WHERE tenant_id = $1 AND session_id = $2",
    [tenantId, sessionId]
  );
  
  if (!res.rowCount) return null;
  
  const row = res.rows[0];
  return {
    sessionId: row.session_id,
    deviceId: row.device_id,
    tenantId: row.tenant_id,
    status: row.status as DeviceSession["status"],
    phase: row.phase as HandshakePhase,
    capabilities: row.capabilities ?? [],
    policyVersion: row.policy_version,
    startedAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    heartbeatIntervalMs: row.heartbeat_interval_ms,
    sessionTimeoutMs: row.session_timeout_ms,
    currentConcurrency: row.current_concurrency,
    maxConcurrency: row.max_concurrency,
    metadata: row.metadata,
  };
}

/**
 * 终止会话
 */
export async function terminateSession(params: {
  pool: Pool;
  tenantId: string;
  sessionId: string;
  reason: string;
}): Promise<void> {
  const { pool, tenantId, sessionId, reason } = params;
  
  await pool.query(
    `UPDATE device_sessions 
     SET status = 'terminated', 
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         last_activity_at = now()
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId, JSON.stringify({ terminateReason: reason, terminatedAt: new Date().toISOString() })]
  );
}

/**
 * 清理过期会话
 */
export async function cleanupExpiredSessions(params: {
  pool: Pool;
  tenantId?: string;
}): Promise<number> {
  const { pool, tenantId } = params;
  
  const res = await pool.query(
    `UPDATE device_sessions 
     SET status = 'terminated',
         metadata = COALESCE(metadata, '{}'::jsonb) || '{"terminateReason":"timeout"}'::jsonb
     WHERE status = 'active'
       AND ($1::TEXT IS NULL OR tenant_id = $1)
       AND last_activity_at < now() - (session_timeout_ms || ' milliseconds')::interval`,
    [tenantId ?? null]
  );
  
  return res.rowCount ?? 0;
}

/* ================================================================== */
/*  Concurrency Control                                                  */
/* ================================================================== */

/**
 * 尝试获取执行槽位
 */
export async function acquireExecutionSlot(params: {
  pool: Pool;
  tenantId: string;
  sessionId: string;
}): Promise<{ acquired: boolean; currentConcurrency: number; maxConcurrency: number }> {
  const { pool, tenantId, sessionId } = params;
  
  const res = await pool.query<{ current_concurrency: number; max_concurrency: number }>(
    `UPDATE device_sessions 
     SET current_concurrency = current_concurrency + 1,
         last_activity_at = now()
     WHERE tenant_id = $1 AND session_id = $2 
       AND status = 'active' 
       AND current_concurrency < max_concurrency
     RETURNING current_concurrency, max_concurrency`,
    [tenantId, sessionId]
  );
  
  if (!res.rowCount) {
    // 查询当前状态
    const check = await pool.query<{ current_concurrency: number; max_concurrency: number }>(
      "SELECT current_concurrency, max_concurrency FROM device_sessions WHERE tenant_id = $1 AND session_id = $2",
      [tenantId, sessionId]
    );
    if (!check.rowCount) {
      return { acquired: false, currentConcurrency: 0, maxConcurrency: 0 };
    }
    return { acquired: false, currentConcurrency: check.rows[0].current_concurrency, maxConcurrency: check.rows[0].max_concurrency };
  }
  
  return { acquired: true, currentConcurrency: res.rows[0].current_concurrency, maxConcurrency: res.rows[0].max_concurrency };
}

/**
 * 释放执行槽位
 */
export async function releaseExecutionSlot(params: {
  pool: Pool;
  tenantId: string;
  sessionId: string;
}): Promise<void> {
  const { pool, tenantId, sessionId } = params;
  
  await pool.query(
    `UPDATE device_sessions 
     SET current_concurrency = GREATEST(0, current_concurrency - 1),
         last_activity_at = now()
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId]
  );
}

/* ================================================================== */
/*  Health Check                                                         */
/* ================================================================== */

export interface DeviceHealthStatus {
  deviceId: string;
  sessionId: string | null;
  isOnline: boolean;
  lastSeenAt: string | null;
  sessionStatus: DeviceSession["status"] | null;
  currentConcurrency: number;
  maxConcurrency: number;
  capabilities: string[];
  healthScore: number;  // 0-100
}

/**
 * 获取设备健康状态
 */
export async function getDeviceHealth(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
}): Promise<DeviceHealthStatus> {
  const { pool, tenantId, deviceId } = params;
  
  // 获取设备记录
  const deviceRes = await pool.query<{ last_seen_at: string | null }>(
    "SELECT last_seen_at FROM device_records WHERE tenant_id = $1 AND device_id = $2 AND status = 'active'",
    [tenantId, deviceId]
  );
  
  // 获取活跃会话
  const sessionRes = await pool.query<{
    session_id: string;
    status: string;
    current_concurrency: number;
    max_concurrency: number;
    capabilities: any;
    last_activity_at: string;
  }>(
    `SELECT session_id, status, current_concurrency, max_concurrency, capabilities, last_activity_at
     FROM device_sessions 
     WHERE tenant_id = $1 AND device_id = $2 AND status = 'active'
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [tenantId, deviceId]
  );
  
  const lastSeenAt = deviceRes.rows[0]?.last_seen_at ?? null;
  const session = sessionRes.rows[0];
  
  // 计算健康分数
  let healthScore = 0;
  if (lastSeenAt) {
    const lastSeenMs = Date.now() - new Date(lastSeenAt).getTime();
    if (lastSeenMs < 60000) healthScore += 50;
    else if (lastSeenMs < 300000) healthScore += 30;
    else if (lastSeenMs < 900000) healthScore += 10;
  }
  
  if (session) {
    healthScore += 30;
    // 负载情况
    const loadRatio = session.current_concurrency / Math.max(1, session.max_concurrency);
    healthScore += Math.round(20 * (1 - loadRatio));
  }
  
  return {
    deviceId,
    sessionId: session?.session_id ?? null,
    isOnline: !!session && session.status === "active",
    lastSeenAt,
    sessionStatus: session?.status as DeviceSession["status"] | null ?? null,
    currentConcurrency: session?.current_concurrency ?? 0,
    maxConcurrency: session?.max_concurrency ?? 0,
    capabilities: (session?.capabilities ?? []).map((c: any) => c.toolRef),
    healthScore,
  };
}

/* ================================================================== */
/*  Helpers                                                              */
/* ================================================================== */

/**
 * 比较版本号
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(p => parseInt(p, 10) || 0);
  const parts2 = v2.split(".").map(p => parseInt(p, 10) || 0);
  
  const maxLen = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}
