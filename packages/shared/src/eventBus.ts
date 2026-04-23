/**
 * Unified Event Bus — 共享核心类型
 *
 * P1-01: 统一事件总线核心定义，被 API 和 Worker 共同引用。
 * 运行时实现（Redis Streams）由各进程独立初始化。
 */

// ── 系统事件类型枚举 ─────────────────────────────────────────

/** 系统内所有预定义事件类型 */
export const SystemEventType = {
  // Workflow / Step
  STEP_COMPLETED: "step.completed",
  STEP_FAILED: "step.failed",
  STEP_TIMEOUT: "step.timeout",
  RUN_COMPLETED: "run.completed",
  RUN_FAILED: "run.failed",

  // Agent Loop
  AGENT_LOOP_STARTED: "agent.loop.started",
  AGENT_LOOP_COMPLETED: "agent.loop.completed",
  AGENT_LOOP_ERROR: "agent.loop.error",

  // Skill
  SKILL_REGISTERED: "skill.registered",
  SKILL_UNREGISTERED: "skill.unregistered",
  SKILL_EXECUTION_ERROR: "skill.execution.error",

  // Model
  MODEL_DEGRADED: "model.degraded",
  MODEL_RECOVERED: "model.recovered",
  MODEL_CIRCUIT_OPEN: "model.circuit.open",
  MODEL_CIRCUIT_CLOSED: "model.circuit.closed",

  // Security
  SECURITY_ALERT: "security.alert",
  SECURITY_POLICY_VIOLATION: "security.policy.violation",
  SECURITY_TOKEN_REVOKED: "security.token.revoked",

  // Memory
  MEMORY_PURGED: "memory.purged",
  MEMORY_COMPACTED: "memory.compacted",
  MEMORY_DISTILLED: "memory.distilled",

  // Approval
  APPROVAL_REQUESTED: "approval.requested",
  APPROVAL_GRANTED: "approval.granted",
  APPROVAL_DENIED: "approval.denied",
  APPROVAL_EXPIRED: "approval.expired",

  // Collaboration
  COLLAB_RUN_STARTED: "collab.run.started",
  COLLAB_RUN_COMPLETED: "collab.run.completed",
  COLLAB_STEP_COMPLETED: "collab.step.completed",

  // Device
  DEVICE_CONNECTED: "device.connected",
  DEVICE_DISCONNECTED: "device.disconnected",

  // System
  CONFIG_UPDATED: "config.updated",
  HEALTH_DEGRADED: "health.degraded",
  HEALTH_RECOVERED: "health.recovered",
} as const;

export type SystemEventTypeValue = (typeof SystemEventType)[keyof typeof SystemEventType];

// ── 事件信封 ──────────────────────────────────────────────────

export interface EventEnvelope {
  /** 全局唯一事件 ID (UUID v4) */
  eventId: string;
  /** 频道名称 */
  channel: string;
  /** 事件类型（推荐使用 SystemEventType 枚举值） */
  eventType: string;
  /** 事件负载 */
  payload: Record<string, unknown>;
  /** 租户 ID */
  tenantId: string;
  /** 发送方模块 */
  sourceModule: string;
  /** 事件产生时间戳 (ms since epoch) */
  timestamp: number;
  /** 是否需要消费者确认 */
  requiresAck?: boolean;
}

export type EventHandler = (event: EventEnvelope) => void | Promise<void>;

export interface EventBusSubscription {
  unsubscribe: () => Promise<void>;
}

// ── 频道常量 ──────────────────────────────────────────────────

/** 预定义事件频道 */
export const EventChannels = {
  /** 步骤完成信号 (step.done:{stepId}) */
  STEP_DONE: "step.done",
  /** 设备消息 */
  DEVICE_MESSAGE: "device.message",
  /** 审批事件 */
  APPROVAL_EVENT: "approval.event",
  /** 协作消息 */
  COLLAB_MESSAGE: "collab.message",
  /** 模型健康变化 */
  MODEL_DEGRADATION: "model.degradation",
  /** Agent Loop 事件 */
  AGENT_LOOP_EVENT: "agent.loop",
  /** 记忆生命周期 */
  MEMORY_LIFECYCLE: "memory.lifecycle",
  /** 安全告警 */
  SECURITY_ALERT: "security.alert",
  /** 配置变更 */
  CONFIG_CHANGE: "config.change",
  /** 配置热更新事件（config.updated.{key}） */
  CONFIG_UPDATED: "config.updated",
  /** 系统广播 */
  SYSTEM_BROADCAST: "system.broadcast",
} as const;

export type EventChannelValue = (typeof EventChannels)[keyof typeof EventChannels];

// ── EventBus 接口 ─────────────────────────────────────────────

export interface EventBus {
  /** 发布事件（双写 DB + Redis Streams） */
  publish(event: Omit<EventEnvelope, "eventId" | "timestamp">): Promise<string>;
  /** 订阅某个频道的事件 */
  subscribe(channel: string, handler: EventHandler): Promise<EventBusSubscription>;
  /** 确认消费（用于可靠投递） */
  acknowledge(eventId: string): Promise<void>;
  /** 关闭所有订阅连接 */
  close(): Promise<void>;
}

// ── Redis 频道前缀 ────────────────────────────────────────────

/** EventBus Redis 频道前缀 */
export const EVENT_BUS_CHANNEL_PREFIX = "eventbus:";

/** 构造 Redis 频道名 */
export function eventBusRedisChannel(channel: string): string {
  return `${EVENT_BUS_CHANNEL_PREFIX}${channel}`;
}

/** 构造 step 完成信号的 Redis 频道名 */
export function stepDoneRedisChannel(stepId: string): string {
  return `step:done:${stepId}`;
}

// ── EventBus 后端抽象 ────────────────────────────────────────

/** 事件总线传输后端抽象接口 */
export interface EventBusBackend {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (payload: unknown) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}

/** Pub/Sub 后端（保留接口定义，发布端已统一使用 Streams） */
export interface PubSubBackend extends EventBusBackend {
  type: 'pubsub';
}

/** Streams 后端（新增，用于关键事件，支持 at-least-once 消费语义） */
export interface StreamsBackend extends EventBusBackend {
  type: 'streams';
  /** 从上次消费位置续读所有 pending 但未 ACK 的消息 */
  resumeFromLastAck(channel: string, consumerGroup: string, consumerId: string): Promise<void>;
  /** 确认消息已处理 */
  ack(channel: string, consumerGroup: string, messageId: string): Promise<void>;
}

// ── 事件频道分类（统一使用 Streams） ────────────────────────────

/** 所有事件频道列表 — 统一使用 Redis Streams 投递 */
export const CRITICAL_EVENT_CHANNELS = [
  'step.completed',
  'step.failed',
  'run.completed',
  'run.failed',
  'task.status_changed',
] as const;

/** @deprecated 开发阶段已统一使用 Streams，不再区分关键/非关键 */
export const NON_CRITICAL_EVENT_CHANNELS = [
  'ui.notification',
  'cache.invalidate',
] as const;

/** @deprecated 开发阶段所有事件统一走 Streams，此函数始终返回 true */
export function isCriticalChannel(_channel: string): boolean {
  return true;
}
