/**
 * channelAdapterRegistry.ts — 通知频道投递适配器注册表
 *
 * 消除 deliverNotification 中的 switch/case 硬编码分支，
 * 将每种频道的投递逻辑封装为独立的 ChannelDeliveryAdapter，
 * 通过注册表模式动态分发。新增频道只需注册新适配器，无需修改分发逻辑。
 *
 * 设计原则：
 * - 可插拔：运行时动态注册 / 注销适配器
 * - 零硬编码：分发逻辑不包含任何频道名称字面量
 */
import { StructuredLogger } from "@mindpal/shared";

const _logger = new StructuredLogger({ module: "worker:channelAdapterRegistry" });
import type { Pool } from "pg";
import type { Redis as RedisClient } from "ioredis";

// ── 适配器接口 ──────────────────────────────────────────────

/** 通知载荷（传递给适配器的上下文） */
export interface NotificationPayload {
  notification_id: string;
  tenant_id: string;
  space_id: string | null;
  subject_id: string | null;
  channel: string;
  event: string;
  title: string;
  body: string;
  metadata: any;
}

/** 适配器执行上下文 */
export interface DeliveryContext {
  pool: Pool;
  redis?: RedisClient | null;
}

/**
 * 通知频道投递适配器接口。
 * 每种频道（email / inapp / webhook / im / sms / 自定义）实现此接口。
 */
export interface ChannelDeliveryAdapter {
  /** 频道名称（唯一标识，与 notification_queue.channel 字段对齐） */
  readonly channel: string;

  /**
   * 执行投递。
   * 适配器自行决定写入哪张投递表或调用哪个外部管道。
   * 抛出异常表示投递失败，将由上层重试逻辑处理。
   */
  deliver(ctx: DeliveryContext, notification: NotificationPayload): Promise<void>;
}

// ── 注册表 ──────────────────────────────────────────────────

const adapters = new Map<string, ChannelDeliveryAdapter>();

/** 注册一个频道投递适配器（重复注册同名频道将覆盖） */
export function registerChannelAdapter(adapter: ChannelDeliveryAdapter): void {
  adapters.set(adapter.channel, adapter);
  _logger.info("adapter registered", { channel: adapter.channel });
}

/** 注销一个频道适配器 */
export function unregisterChannelAdapter(channel: string): boolean {
  const removed = adapters.delete(channel);
  if (removed) {
    _logger.info("adapter unregistered", { channel });
  }
  return removed;
}

/** 获取指定频道的适配器（不存在返回 null） */
export function getChannelAdapter(channel: string): ChannelDeliveryAdapter | null {
  return adapters.get(channel) ?? null;
}

/** 获取所有已注册的频道名列表 */
export function listRegisteredChannels(): string[] {
  return [...adapters.keys()];
}

/**
 * 按注册表动态分发投递。
 * 替代原 deliverNotification 中的 switch/case。
 */
export async function dispatchDelivery(
  ctx: DeliveryContext,
  notification: NotificationPayload,
): Promise<void> {
  const adapter = adapters.get(notification.channel);
  if (!adapter) {
    _logger.warn("no adapter for channel", {
      channel: notification.channel,
      registeredChannels: listRegisteredChannels(),
    });
    throw new Error(`no_adapter_for_channel:${notification.channel}`);
  }
  await adapter.deliver(ctx, notification);
}
