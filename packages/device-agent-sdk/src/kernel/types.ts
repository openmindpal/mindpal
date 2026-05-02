import type { AuditEvidenceRef } from "@mindpal/shared";

/**
 * Device-OS 内核公共类型定义
 * @layer kernel
 */

// ── 设备身份 ─────────────────────────────────────────────────

export type DeviceType = "desktop" | "mobile" | "iot" | "robot" | "vehicle" | "home" | "gateway";

export type DeviceAgentConfig = {
  apiBase: string;
  deviceId: string;
  deviceToken: string;
  enrolledAt: string;
  deviceType: DeviceType;
  os: string;
  agentVersion: string;
};

// ── 能力命名规范 ─────────────────────────────────────────────
// 统一格式：device.<domain>.<action>[@<version>]
// 例如：device.file.read@1, device.browser.open@1

export type ToolRef = string; // device.<domain>.<action>[@version]

export function parseToolRef(toolRef: ToolRef): { name: string; version: string | null } {
  const idx = toolRef.indexOf("@");
  if (idx <= 0) return { name: toolRef, version: null };
  return { name: toolRef.slice(0, idx), version: toolRef.slice(idx + 1) };
}

export function toolName(toolRef: ToolRef): string {
  return parseToolRef(toolRef).name;
}

// ── 能力描述符 ────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface CapabilityDescriptor {
  /** 工具引用，格式 device.<domain>.<action> */
  toolRef: ToolRef;
  /** 输入 JSON Schema（可选） */
  inputSchema?: Record<string, unknown>;
  /** 输出 JSON Schema（可选） */
  outputSchema?: Record<string, unknown>;
  /** 风险等级 */
  riskLevel: RiskLevel;
  /** 资源需求声明 */
  resourceRequirements?: {
    memoryMb?: number;
    cpuPercent?: number;
    diskMb?: number;
    networkRequired?: boolean;
  };
  /** 并发限制（0=无限制） */
  concurrencyLimit?: number;
  /** 能力版本 */
  version?: string;
  /** 标签（用于查询过滤） */
  tags?: string[];
  /** 描述 */
  description?: string;
}

// ── 任务状态机 ────────────────────────────────────────────────

export type TaskState =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "timed_out";

export const TASK_STATE_TRANSITIONS: Record<TaskState, TaskState[]> = {
  pending:   ["claimed", "canceled", "timed_out"],
  claimed:   ["running", "canceled", "timed_out"],
  running:   ["succeeded", "failed", "canceled", "timed_out"],
  succeeded: [],
  failed:    [],
  canceled:  [],
  timed_out: [],
};

export function isTerminalState(state: TaskState): boolean {
  return TASK_STATE_TRANSITIONS[state].length === 0;
}

export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return TASK_STATE_TRANSITIONS[from].includes(to);
}

// ── 插件状态机 ────────────────────────────────────────────────

export type PluginState =
  | "unloaded"
  | "initializing"
  | "registered"
  | "healthchecking"
  | "ready"
  | "executing"
  | "disposing"
  | "disposed"
  | "upgrading"
  | "rollingBack"
  | "error";

// ── 审计事件 ─────────────────────────────────────────────────

export type AuditEventType =
  | "tool.execute.start"
  | "tool.execute.success"
  | "tool.execute.failed"
  | "tool.execute.denied"
  | "auth.verify"
  | "auth.token.rotate"
  | "policy.check"
  | "policy.cache.sync"
  | "session.start"
  | "session.end"
  | "session.heartbeat"
  | "plugin.init"
  | "plugin.dispose"
  | "plugin.healthcheck"
  | "device.enroll"
  | "device.pair"
  | "device.revoke"
  | "evidence.upload"
  | "replay.trace";

/** 设备端审计证据引用（从 @mindpal/shared 统一导入） */
export type EvidenceRef = AuditEvidenceRef;

export interface AuditEvent {
  eventId: string;
  timestamp: string;
  eventType: AuditEventType;
  deviceId: string;
  toolRef?: string;
  toolName?: string;
  executionId?: string;
  callerId?: string;
  status?: "success" | "failed" | "denied";
  errorCategory?: string;
  durationMs?: number;
  inputDigest?: Record<string, unknown>;
  outputDigest?: Record<string, unknown>;
  policyDigest?: Record<string, unknown>;
  evidenceRefs?: EvidenceRef[];
  parentEventId?: string;
  traceChain?: string[];
  extra?: Record<string, unknown>;
}

// ── 消息信封 ─────────────────────────────────────────────────

export interface MessageEnvelope {
  /** 消息类型 */
  type: string;
  /** 关联 ID（用于请求-响应配对） */
  correlationId: string;
  /** 时间戳 */
  timestamp: number;
  /** 载荷 */
  payload: Record<string, unknown>;
  /** 回复目标（可选） */
  replyTo?: string;
  /** 幂等键（可选） */
  idempotencyKey?: string;
  /** TTL 毫秒（可选） */
  ttlMs?: number;
}

// ── 插件资源限制 ─────────────────────────────────────────────

export interface PluginResourceLimits {
  /** 内存上限（MB） */
  maxMemoryMb?: number;
  /** CPU 配额（百分比 0-100） */
  maxCpuPercent?: number;
  /** 最大并发执行数 */
  maxConcurrency?: number;
  /** 单次执行最大超时（ms） */
  maxExecutionTimeMs?: number;
}

// ── 插件接口（增强版） ──────────────────────────────────────

export interface DeviceToolPlugin {
  /** 插件唯一名称 */
  name: string;
  /** 本插件处理的工具名前缀 */
  toolPrefixes: string[];
  /** 本插件支持的工具名列表（可选，用于显示） */
  toolNames?: string[];
  /** 本插件声明的能力列表 */
  capabilities?: CapabilityDescriptor[];
  /** 资源限制声明（默认，适用于桌面端） */
  resourceLimits?: PluginResourceLimits;
  /** 按设备类型差异化资源限制配置 */
  deviceTypeResourceProfiles?: Partial<Record<DeviceType, PluginResourceLimits>>;
  /** 本插件关注的消息主题前缀（可选） */
  messageTopics?: string[];
  /** 插件版本 */
  version?: string;
  /** 插件来源：builtin=内置 / external=外部目录加载 */
  source?: "builtin" | "external";
  /** 外部插件清单（仅 source=external 时存在，用于签名校验） */
  manifest?: import("./pluginSandbox").PluginManifest;

  // ── 生命周期方法 ────────────────────────────────────────
  /** 初始化（连接硬件、加载驱动等） */
  init?(): Promise<void>;
  /** 健康检查 */
  healthcheck?(): Promise<{ healthy: boolean; details?: Record<string, unknown> }>;
  /** 执行工具 */
  execute(ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
  /** 接收跨设备消息（可选） */
  onMessage?(ctx: DeviceMessageContext): Promise<void>;
  /** 销毁（断开连接、释放资源） */
  dispose?(): Promise<void>;
  /** 升级（热更新） */
  upgrade?(newVersion: string): Promise<void>;
  /** 回滚 */
  rollback?(previousVersion: string): Promise<void>;
}

// ── 插件执行上下文 ──────────────────────────────────────────

export interface ToolExecutionContext {
  cfg: { apiBase: string; deviceToken: string };
  execution: { deviceExecutionId: string; toolRef: string; input?: any };
  toolName: string;
  input: Record<string, any>;
  policy: any;
  requireUserPresence: boolean;
  confirmFn: (q: string) => Promise<boolean>;
}

export interface ToolExecutionResult {
  status: "succeeded" | "failed";
  errorCategory?: string;
  outputDigest?: any;
  evidenceRefs?: string[];
}

export interface DeviceMessageContext {
  messageId: string;
  fromDeviceId: string | null;
  topic: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

// ── 策略类型 ─────────────────────────────────────────────────

export type DeviceClaimEnvelope = {
  execution: { deviceExecutionId: string; toolRef: string; input?: any };
  requireUserPresence?: boolean;
  policy?: any;
  policyDigest?: any;
};

export interface CachedPolicy {
  allowedTools?: string[] | null;
  filePolicy?: any;
  networkPolicy?: any;
  uiPolicy?: any;
  evidencePolicy?: any;
  clipboardPolicy?: any;
  limits?: any;
  /** 工具级灰度开关：{ "device.browser.open": true, "device.desktop.launch": false } */
  toolFeatureFlags?: Record<string, boolean> | null;
  /** 工具级降级规则 */
  degradationRules?: Record<string, { fallbackTool?: string; errorCategory: string; message?: string }> | null;
  /** 熔断器配置 */
  circuitBreakerConfig?: { failureThreshold?: number; halfOpenWindowMs?: number; halfOpenMaxAttempts?: number } | null;
}

export interface PolicyCacheEntry {
  deviceId: string;
  policy: CachedPolicy;
  policyDigest: string;
  cachedAt: string;
  expiresAt: string;
  version: number;
}

// ── 调用方身份 ──────────────────────────────────────────────

export interface CallerIdentity {
  callerId: string;
  callerType: "api" | "local" | "plugin";
  tenantId?: string;
  subjectId?: string;
  verifiedAt: string;
  expiresAt?: string;
}

// ── 设备能力探测报告（从插件层提升到内核类型，供SDK解耦使用） ──

export interface DeviceCapabilityReport {
  probedAt: string;
  platform: NodeJS.Platform;
  arch: string;
  totalMemoryMb: number;
  freeMemoryMb: number;
  cpuCores: number;
  hardware: Record<string, unknown>;
  software: Record<string, unknown>;
  network: Record<string, unknown>;
}
