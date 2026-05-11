/**
 * EventBus 单例实例 — 激活事件总线运行时
 *
 * 基于 createEventBus() 的 Redis Streams + DB outbox 实现，
 * 在 API 服务启动时初始化一次，全局共享。
 *
 * 设计约束：
 * - 零新增外部依赖：复用现有 ioredis + pg
 * - 发布失败不影响主流程（.catch 降级）
 * - 消费端仅日志 + metrics（不引入新推送通道）
 */
import type { Pool } from "pg";
import type { EventEnvelope } from "@mindpal/shared";
import { SystemEventType, EventChannels, StructuredLogger } from "@mindpal/shared";
import { createEventBus, type ExtendedEventBus } from "./eventBus";

export { SystemEventType, EventChannels };

const logger = new StructuredLogger({ module: "eventBusRuntime" });

// ── 单例 ──────────────────────────────────────────────────

let _instance: ExtendedEventBus | null = null;

/**
 * 初始化全局 EventBus 单例（应在服务启动时调用一次）
 */
export function initEventBus(params: {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number>; xadd(...args: (string | number)[]): Promise<string> };
}): ExtendedEventBus {
  if (_instance) return _instance;
  _instance = createEventBus(params);
  logger.info("EventBus runtime initialized");
  return _instance;
}

/**
 * 获取全局 EventBus 实例（未初始化时返回 null）
 */
export function getEventBus(): ExtendedEventBus | null {
  return _instance;
}

// ── 便捷发布（自动降级） ──────────────────────────────────

/**
 * 安全发布事件 — EventBus 未初始化或发布失败时静默降级
 */
export async function safePublish(event: Omit<EventEnvelope, "eventId" | "timestamp">): Promise<string | null> {
  if (!_instance) return null;
  try {
    return await _instance.publish(event);
  } catch {
    return null;
  }
}

// ── 默认消费端注册（仅日志+metrics） ──────────────────────

/**
 * 注册默认的事件消费者 — 仅做日志记录和指标收集
 * 不引入新的推送通道
 */
export async function registerDefaultConsumers(): Promise<void> {
  if (!_instance) return;

  // 技能执行完成
  await _instance.subscribe(EventChannels.AGENT_LOOP_EVENT, (event: EventEnvelope) => {
    if (event.eventType === SystemEventType.AGENT_LOOP_COMPLETED) {
      logger.info("agent loop completed", {
        event: "agent.loop.completed",
        runId: event.payload.runId,
        iterations: event.payload.iterations,
      });
    } else if (event.eventType === SystemEventType.AGENT_LOOP_ERROR) {
      logger.warn("agent loop error", {
        event: "agent.loop.error",
        runId: event.payload.runId,
        error: event.payload.error,
      });
    }
  }).catch(() => {});

  // 技能执行错误
  await _instance.subscribe("skill.lifecycle", (event: EventEnvelope) => {
    if (event.eventType === SystemEventType.SKILL_EXECUTION_ERROR) {
      logger.warn("skill execution error", {
        event: "skill.execution.error",
        skillId: event.payload.skillId,
        runId: event.payload.runId,
        error: event.payload.error,
      });
    }
  }).catch(() => {});

  // 步骤超时
  await _instance.subscribe(EventChannels.STEP_DONE, (event: EventEnvelope) => {
    if (event.eventType === SystemEventType.STEP_TIMEOUT) {
      logger.warn("step execution timed out", {
        event: "step.timeout",
        runId: event.payload.runId,
        stepId: event.payload.stepId,
      });
    } else if (event.eventType === SystemEventType.STEP_COMPLETED) {
      logger.info("step execution completed", {
        event: "step.completed",
        runId: event.payload.runId,
        stepId: event.payload.stepId,
        durationMs: event.payload.durationMs,
      });
    }
  }).catch(() => {});

  // 配置变更
  await _instance.subscribe(EventChannels.CONFIG_CHANGE, (event: EventEnvelope) => {
    if (event.eventType === SystemEventType.CONFIG_UPDATED) {
      logger.info("configuration updated", {
        event: "config.updated",
        tenantId: event.tenantId,
        configKey: event.payload.configKey,
        version: event.payload.version,
      });
    }
  }).catch(() => {});

  logger.info("Default event consumers registered (logging + metrics only)");
}

// ── 关闭 ──────────────────────────────────────────────────

/**
 * 关闭 EventBus（用于 graceful shutdown）
 */
export async function closeEventBus(): Promise<void> {
  if (!_instance) return;
  try {
    await _instance.close();
  } catch { /* ignore */ }
  _instance = null;
  logger.info("EventBus runtime closed");
}
