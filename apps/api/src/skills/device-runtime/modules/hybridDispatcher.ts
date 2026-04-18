/**
 * P3-2: 混合计算任务下发
 * 
 * 智能分配任务到云端或端侧执行：
 * - 任务路由决策（基于工具类型、设备能力、负载）
 * - 端侧优先策略（敏感数据/本地资源）
 * - 云端降级（设备不可用时）
 * - 负载均衡
 */
import type { Pool } from "pg";
import type { DeviceHealthStatus, DeviceCapability } from "./handshakeProtocol";
import { getDeviceHealth, acquireExecutionSlot } from "./handshakeProtocol";
import { resolveToolAlias, isDeviceToolName } from "@openslin/shared";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type ExecutionTarget = "cloud" | "device" | "hybrid";

export type RoutingDecision = {
  target: ExecutionTarget;
  deviceId?: string;
  sessionId?: string;
  reason: string;
  fallbackTarget?: ExecutionTarget;
  priority: number;
};

export type TaskRequirement = {
  toolRef: string;
  /** 是否需要本地资源 */
  requiresLocalResource: boolean;
  /** 是否包含敏感数据 */
  containsSensitiveData: boolean;
  /** 估算执行时间 (ms) */
  estimatedDurationMs?: number;
  /** 是否需要用户交互 */
  requiresUserInteraction: boolean;
  /** 优先使用端侧 */
  preferDevice: boolean;
  /** 资源需求 */
  resourceNeeds?: {
    cpuIntensive?: boolean;
    memoryMb?: number;
    diskMb?: number;
    networkRequired?: boolean;
  };
};

export interface DispatchContext {
  tenantId: string;
  spaceId: string | null;
  runId: string;
  stepId: string;
  toolRef: string;
  input: Record<string, unknown>;
  requirement: TaskRequirement;
  availableDevices: string[];
}

export interface DispatchResult {
  decision: RoutingDecision;
  deviceExecutionId?: string;
  cloudJobId?: string;
  dispatched: boolean;
  error?: string;
}

/**
 * 工具别名解析：委托给 @openslin/shared 的共享解析器，不再硬编码。
 * 端侧动态注册的别名将通过心跳同步至云端，此处使用默认内置别名作为回退。
 */
function normalizeToolName(toolName: string): string {
  return resolveToolAlias(toolName);
}

/* ================================================================== */
/*  Routing Rules（动态推断）                                            */
/* ================================================================== */

/**
 * 动态路由推断：根据工具名前缀和别名解析自动判定路由目标。
 * - 以 "device." 开头（或别名解析后以 "device." 开头）的工具路由到端侧
 * - 混合执行域（可由运行时注册扩展）
 * - 其余默认路由到云端
 *
 * 不再维护逐个枚举的 TOOL_ROUTING_RULES 静态映射表。
 */

/** 端侧工具域前缀到优先级的映射（可运行时扩展） */
const DEVICE_DOMAIN_PRIORITY: Record<string, number> = {
  "device.file.": 100,
  "device.clipboard.": 95,
  "device.browser.": 90,
  "device.desktop.": 85,
  "device.": 80, // 通用 device 前缀的默认优先级
};

/** 混合执行域前缀（可运行时扩展） */
const HYBRID_DOMAIN_PREFIXES: Set<string> = new Set([
  "document.",
  "image.",
]);

/** 注册新的端侧工具域优先级 */
export function registerDeviceDomainPriority(prefix: string, priority: number): void {
  DEVICE_DOMAIN_PRIORITY[prefix] = priority;
}

/** 注册混合执行域 */
export function registerHybridDomain(prefix: string): void {
  HYBRID_DOMAIN_PREFIXES.add(prefix);
}

/**
 * 动态推断工具路由规则
 */
function inferRoutingRule(toolName: string): { defaultTarget: ExecutionTarget; priority: number } {
  const normalized = normalizeToolName(toolName);

  // 1. 检查是否为端侧工具（精确域前缀匹配优先，再 fallback 到通用 device. 前缀）
  if (isDeviceToolName(normalized) || isDeviceToolName(toolName)) {
    let bestPriority = DEVICE_DOMAIN_PRIORITY["device."] ?? 80;
    for (const [prefix, prio] of Object.entries(DEVICE_DOMAIN_PRIORITY)) {
      if (prefix !== "device." && normalized.startsWith(prefix)) {
        bestPriority = Math.max(bestPriority, prio);
      }
    }
    return { defaultTarget: "device", priority: bestPriority };
  }

  // 2. 检查是否为混合执行域
  for (const prefix of HYBRID_DOMAIN_PREFIXES) {
    if (normalized.startsWith(prefix) || toolName.startsWith(prefix)) {
      return { defaultTarget: "hybrid", priority: 70 };
    }
  }

  // 3. 默认云端
  return { defaultTarget: "cloud", priority: 50 };
}

/**
 * 分析任务需求
 */
export function analyzeTaskRequirement(params: {
  toolRef: string;
  input: Record<string, unknown>;
}): TaskRequirement {
  const { toolRef, input } = params;
  const toolName = toolRef.split("@")[0] ?? toolRef;
  const normalizedToolName = normalizeToolName(toolName);
  
  // 检查是否需要本地资源
  const requiresLocalResource = normalizedToolName.startsWith("device.") || 
    Boolean((input as any)?.localPath) ||
    Boolean((input as any)?.filePath);
  
  // 检查是否包含敏感数据
  const containsSensitiveData = Boolean(
    (input as any)?.password ||
    (input as any)?.secret ||
    (input as any)?.credential ||
    (input as any)?.apiKey
  );
  
  // 检查是否需要用户交互
  const requiresUserInteraction = Boolean(
    (input as any)?.requireConfirm ||
    (input as any)?.userPresence ||
    toolName.includes("confirm") ||
    toolName.includes("approve")
  );
  
  // 优先使用端侧
  const preferDevice = requiresLocalResource || containsSensitiveData || requiresUserInteraction;
  
  return {
    toolRef,
    requiresLocalResource,
    containsSensitiveData,
    requiresUserInteraction,
    preferDevice,
    resourceNeeds: {
      cpuIntensive: normalizedToolName.includes("process") || normalizedToolName.includes("analyze"),
      networkRequired: normalizedToolName.includes("api") || normalizedToolName.includes("http"),
    },
  };
}

/* ================================================================== */
/*  Routing Decision                                                     */
/* ================================================================== */

/**
 * 做出路由决策
 */
export async function makeRoutingDecision(params: {
  pool: Pool;
  context: DispatchContext;
}): Promise<RoutingDecision> {
  const { pool, context } = params;
  const { toolRef, requirement, availableDevices, tenantId } = context;
  const toolName = toolRef.split("@")[0] ?? toolRef;
  const normalizedToolName = normalizeToolName(toolName);
  
  // 1. 动态推断工具路由规则
  const rule = inferRoutingRule(normalizedToolName);
  const defaultTarget = rule.defaultTarget;
  const priority = rule.priority;
  
  // 2. 必须在端侧执行的情况
  if (requirement.requiresLocalResource) {
    if (availableDevices.length === 0) {
      return {
        target: "cloud",
        reason: "需要本地资源但无可用设备，降级到云端（可能失败）",
        fallbackTarget: undefined,
        priority,
      };
    }
    
    // 选择最佳设备
    const deviceSelection = await selectBestDevice({
      pool,
      tenantId,
      devices: availableDevices,
      toolRef,
      requirement,
    });
    
    if (deviceSelection) {
      return {
        target: "device",
        deviceId: deviceSelection.deviceId,
        sessionId: deviceSelection.sessionId,
        reason: `需要本地资源，选择设备 ${deviceSelection.deviceId}`,
        fallbackTarget: "cloud",
        priority,
      };
    }
    
    return {
      target: "cloud",
      reason: "需要本地资源但所有设备不可用，降级到云端",
      fallbackTarget: undefined,
      priority,
    };
  }
  
  // 3. 包含敏感数据时优先端侧
  if (requirement.containsSensitiveData && availableDevices.length > 0) {
    const deviceSelection = await selectBestDevice({
      pool,
      tenantId,
      devices: availableDevices,
      toolRef,
      requirement,
    });
    
    if (deviceSelection) {
      return {
        target: "device",
        deviceId: deviceSelection.deviceId,
        sessionId: deviceSelection.sessionId,
        reason: "包含敏感数据，优先在端侧处理",
        fallbackTarget: "cloud",
        priority: priority + 20,
      };
    }
  }
  
  // 4. 需要用户交互时必须端侧
  if (requirement.requiresUserInteraction) {
    if (availableDevices.length === 0) {
      return {
        target: "cloud",
        reason: "需要用户交互但无可用设备，任务可能失败",
        priority,
      };
    }
    
    const deviceSelection = await selectBestDevice({
      pool,
      tenantId,
      devices: availableDevices,
      toolRef,
      requirement,
    });
    
    if (deviceSelection) {
      return {
        target: "device",
        deviceId: deviceSelection.deviceId,
        sessionId: deviceSelection.sessionId,
        reason: "需要用户交互，使用端侧执行",
        priority: priority + 30,
      };
    }
  }
  
  // 5. 混合模式：根据负载决定
  if (defaultTarget === "hybrid" && availableDevices.length > 0) {
    const deviceSelection = await selectBestDevice({
      pool,
      tenantId,
      devices: availableDevices,
      toolRef,
      requirement,
    });
    
    if (deviceSelection && deviceSelection.healthScore > 70) {
      return {
        target: "device",
        deviceId: deviceSelection.deviceId,
        sessionId: deviceSelection.sessionId,
        reason: "混合模式：设备健康度高，使用端侧执行",
        fallbackTarget: "cloud",
        priority,
      };
    }
    
    return {
      target: "cloud",
      reason: "混合模式：使用云端执行",
      fallbackTarget: availableDevices.length > 0 ? "device" : undefined,
      priority,
    };
  }
  
  // 6. 默认云端执行
  return {
    target: defaultTarget === "device" ? "cloud" : defaultTarget,
    reason: `默认路由：${defaultTarget}`,
    fallbackTarget: availableDevices.length > 0 ? "device" : undefined,
    priority,
  };
}

/**
 * 选择最佳设备
 */
async function selectBestDevice(params: {
  pool: Pool;
  tenantId: string;
  devices: string[];
  toolRef: string;
  requirement: TaskRequirement;
}): Promise<{ deviceId: string; sessionId: string; healthScore: number } | null> {
  const { pool, tenantId, devices, toolRef } = params;
  
  const candidates: Array<DeviceHealthStatus & { score: number }> = [];
  
  for (const deviceId of devices) {
    const health = await getDeviceHealth({ pool, tenantId, deviceId });
    
    if (!health.isOnline || !health.sessionId) continue;
    
    // 检查设备是否支持该工具
    const toolName = toolRef.split("@")[0] ?? toolRef;
    const hasCapability = health.capabilities.some(cap => 
      cap === toolRef || cap.startsWith(toolName)
    );
    
    if (!hasCapability) continue;

    // 检查设备实际能力报告（如果有）—— 避免向不具备硬件能力的设备下发任务
    const capReportOk = await checkDeviceCapabilityReport({ pool, tenantId, deviceId, toolName: normalizeToolName(toolName) });
    if (!capReportOk) continue;
    
    // 检查并发容量
    if (health.currentConcurrency >= health.maxConcurrency) continue;
    
    // 计算综合分数
    let score = health.healthScore;
    // 负载越低分数越高
    const loadRatio = health.currentConcurrency / Math.max(1, health.maxConcurrency);
    score += Math.round(30 * (1 - loadRatio));
    
    candidates.push({ ...health, score });
  }
  
  if (candidates.length === 0) return null;
  
  // 按分数排序，选择最高的
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  
  return {
    deviceId: best.deviceId,
    sessionId: best.sessionId!,
    healthScore: best.healthScore,
  };
}

/* ================================================================== */
/*  Task Dispatch                                                        */
/* ================================================================== */

/**
 * 分发任务
 */
export async function dispatchTask(params: {
  pool: Pool;
  context: DispatchContext;
  queue: any;  // WorkflowQueue
}): Promise<DispatchResult> {
  const { pool, context, queue } = params;
  
  // 1. 做出路由决策
  const decision = await makeRoutingDecision({ pool, context });
  
  // 2. 根据决策分发
  if (decision.target === "device" && decision.deviceId && decision.sessionId) {
    return await dispatchToDevice({ pool, context, decision });
  }
  
  if (decision.target === "cloud") {
    return await dispatchToCloud({ pool, context, decision, queue });
  }
  
  // 3. 混合模式尝试
  if (decision.target === "hybrid") {
    // 先尝试端侧
    if (decision.deviceId && decision.sessionId) {
      const deviceResult = await dispatchToDevice({ pool, context, decision });
      if (deviceResult.dispatched) return deviceResult;
    }
    // 降级到云端
    return await dispatchToCloud({ pool, context, decision: { ...decision, target: "cloud" }, queue });
  }
  
  return {
    decision,
    dispatched: false,
    error: "Unknown dispatch target",
  };
}

/**
 * 分发到设备
 */
async function dispatchToDevice(params: {
  pool: Pool;
  context: DispatchContext;
  decision: RoutingDecision;
}): Promise<DispatchResult> {
  const { pool, context, decision } = params;
  
  if (!decision.deviceId || !decision.sessionId) {
    return {
      decision,
      dispatched: false,
      error: "No device selected",
    };
  }
  
  try {
    // 获取执行槽位
    const slot = await acquireExecutionSlot({
      pool,
      tenantId: context.tenantId,
      sessionId: decision.sessionId,
    });
    
    if (!slot.acquired) {
      return {
        decision,
        dispatched: false,
        error: `Device at capacity: ${slot.currentConcurrency}/${slot.maxConcurrency}`,
      };
    }
    
    // 创建设备执行记录
    const execRes = await pool.query<{ device_execution_id: string }>(
      `INSERT INTO device_executions 
       (tenant_id, device_id, session_id, run_id, step_id, tool_ref, input, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', now())
       RETURNING device_execution_id`,
      [
        context.tenantId,
        decision.deviceId,
        decision.sessionId,
        context.runId,
        context.stepId,
        context.toolRef,
        JSON.stringify(context.input),
      ]
    );
    
    return {
      decision,
      deviceExecutionId: execRes.rows[0].device_execution_id,
      dispatched: true,
    };
    
  } catch (err: any) {
    return {
      decision,
      dispatched: false,
      error: err?.message ?? "Device dispatch failed",
    };
  }
}

/**
 * 分发到云端
 */
async function dispatchToCloud(params: {
  pool: Pool;
  context: DispatchContext;
  decision: RoutingDecision;
  queue: any;
}): Promise<DispatchResult> {
  const { pool, context, decision, queue } = params;
  
  try {
    // 创建云端执行任务
    const jobRes = await pool.query<{ job_id: string }>(
      `INSERT INTO workflow_jobs 
       (tenant_id, space_id, job_type, run_id, step_id, tool_ref, input, status, created_at)
       VALUES ($1, $2, 'tool.execute', $3, $4, $5, $6, 'queued', now())
       RETURNING job_id`,
      [
        context.tenantId,
        context.spaceId,
        context.runId,
        context.stepId,
        context.toolRef,
        JSON.stringify(context.input),
      ]
    );
    
    // 入队
    if (queue?.enqueue) {
      await queue.enqueue({
        jobId: jobRes.rows[0].job_id,
        jobType: "tool.execute",
        payload: {
          runId: context.runId,
          stepId: context.stepId,
          toolRef: context.toolRef,
          input: context.input,
        },
      });
    }
    
    return {
      decision,
      cloudJobId: jobRes.rows[0].job_id,
      dispatched: true,
    };
    
  } catch (err: any) {
    return {
      decision,
      dispatched: false,
      error: err?.message ?? "Cloud dispatch failed",
    };
  }
}

/* ================================================================== */
/*  Load Balancing                                                       */
/* ================================================================== */

/**
 * 获取可用设备列表（按负载排序）
 */
export async function getAvailableDevices(params: {
  pool: Pool;
  tenantId: string;
  spaceId?: string | null;
  toolRef?: string;
}): Promise<Array<{ deviceId: string; healthScore: number; loadRatio: number }>> {
  const { pool, tenantId, spaceId, toolRef } = params;
  
  const res = await pool.query<{
    device_id: string;
    session_id: string;
    current_concurrency: number;
    max_concurrency: number;
    capabilities: any;
    last_activity_at: string;
  }>(
    `SELECT ds.device_id, ds.session_id, ds.current_concurrency, ds.max_concurrency, 
            ds.capabilities, ds.last_activity_at
     FROM device_sessions ds
     JOIN device_records dr ON ds.device_id = dr.device_id AND ds.tenant_id = dr.tenant_id
     WHERE ds.tenant_id = $1 
       AND ds.status = 'active'
       AND dr.status = 'active'
       AND ($2::TEXT IS NULL OR dr.space_id = $2)
     ORDER BY (ds.current_concurrency::float / GREATEST(1, ds.max_concurrency)) ASC`,
    [tenantId, spaceId ?? null]
  );
  
  const toolName = toolRef?.split("@")[0];
  
  return res.rows
    .filter(row => {
      if (!toolRef) return true;
      const caps = row.capabilities as DeviceCapability[] ?? [];
      return caps.some(c => c.toolRef === toolRef || c.toolRef.startsWith(toolName + "@"));
    })
    .map(row => ({
      deviceId: row.device_id,
      healthScore: calculateHealthScore(row.last_activity_at, row.current_concurrency, row.max_concurrency),
      loadRatio: row.current_concurrency / Math.max(1, row.max_concurrency),
    }));
}

function calculateHealthScore(lastActivityAt: string, currentConcurrency: number, maxConcurrency: number): number {
  let score = 50;
  
  // 活跃度
  const lastMs = Date.now() - new Date(lastActivityAt).getTime();
  if (lastMs < 30000) score += 25;
  else if (lastMs < 60000) score += 15;
  else if (lastMs < 180000) score += 5;
  
  // 负载
  const loadRatio = currentConcurrency / Math.max(1, maxConcurrency);
  score += Math.round(25 * (1 - loadRatio));
  
  return Math.min(100, score);
}

/* ================================================================== */
/*  Device Capability Check                                              */
/* ================================================================== */

/**
 * 工具名前缀到能力报告字段的映射。
 * 如果工具前缀匹配某个规则，检查对应的能力报告字段是否为 true。
 */
const TOOL_CAPABILITY_CHECKS: Array<{ prefix: string; check: (report: any) => boolean }> = [
  { prefix: "device.browser.", check: (r) => r?.software?.hasBrowser === true },
  { prefix: "device.desktop.", check: (r) => r?.software?.hasDesktopGui === true },
  { prefix: "device.clipboard.", check: (r) => r?.software?.hasClipboard === true },
  { prefix: "device.vision.", check: (r) => r?.hardware?.hasCamera === true },
  { prefix: "device.camera.", check: (r) => r?.hardware?.hasCamera === true },
  { prefix: "device.gpu.", check: (r) => r?.hardware?.hasGpu === true },
  { prefix: "device.audio.", check: (r) => r?.hardware?.hasMicrophone === true },
  { prefix: "device.screen.", check: (r) => r?.hardware?.screen !== null && r?.hardware?.screen !== undefined },
];

/**
 * 检查设备的能力报告是否支持指定工具。
 * 如果设备未上报能力报告，默认允许。
 */
async function checkDeviceCapabilityReport(params: {
  pool: Pool;
  tenantId: string;
  deviceId: string;
  toolName: string;
}): Promise<boolean> {
  const { pool, tenantId, deviceId, toolName } = params;

  // 查找是否有匹配的能力检查规则
  const matchingCheck = TOOL_CAPABILITY_CHECKS.find((c) => toolName.startsWith(c.prefix));
  if (!matchingCheck) return true; // 无匹配规则→默认允许

  try {
    const res = await pool.query<{ metadata: any }>(
      `SELECT metadata FROM device_records WHERE tenant_id = $1 AND device_id = $2 LIMIT 1`,
      [tenantId, deviceId],
    );
    const metadata = res.rows[0]?.metadata;
    if (!metadata?.capabilityReport) return true; // 未上报过能力报告→默认允许

    return matchingCheck.check(metadata.capabilityReport);
  } catch {
    return true; // 查询失败→非致命，默认允许
  }
}
