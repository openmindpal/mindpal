/**
 * Redis Streams 后端 — 关键事件的可靠投递实现
 *
 * 使用 XADD / XREADGROUP / XACK 实现 at-least-once 消费语义。
 * 消费者掉线后重启可通过 `resumeFromLastAck` 从断点续消费。
 */
import type Redis from "ioredis";
import type { StreamsBackend } from "@mindpal/shared";
import { StructuredLogger } from "@mindpal/shared";

type StreamReadResult = [string, [string, string[]][]][] | null;

const _logger = new StructuredLogger({ module: "worker:redisStreamsBus" });

export interface RedisStreamsBusOptions {
  redis: Redis;
  /** Consumer Group 名称，如 'mindpal-worker-group' */
  consumerGroup: string;
  /** Consumer ID，如 'worker-<hostname>-<pid>' */
  consumerId: string;
  /** 流最大长度，默认 10000（近似裁剪） */
  maxStreamLength?: number;
  /** XREADGROUP BLOCK 超时毫秒，默认 5000 */
  blockTimeoutMs?: number;
  /** 每次 XREADGROUP 最大条数，默认 10 */
  readCount?: number;
}

/** Redis Stream key 前缀 */
const STREAM_PREFIX = "eventstream:";

function streamKey(channel: string): string {
  return `${STREAM_PREFIX}${channel}`;
}

export class RedisStreamsBus implements StreamsBackend {
  readonly type = "streams" as const;

  private readonly redis: Redis;
  readonly consumerGroup: string;
  readonly consumerId: string;
  private readonly maxStreamLength: number;
  private readonly blockTimeoutMs: number;
  private readonly readCount: number;

  /** 每个 channel 的读取循环 abort flag */
  private readonly abortControllers = new Map<string, { aborted: boolean }>();
  /** 活跃的 channel handler 映射 */
  private readonly channelHandlers = new Map<string, (payload: unknown) => void>();
  /** 全局关闭标志 */
  private closed = false;

  constructor(opts: RedisStreamsBusOptions) {
    this.redis = opts.redis;
    this.consumerGroup = opts.consumerGroup;
    this.consumerId = opts.consumerId;
    this.maxStreamLength = opts.maxStreamLength ?? 10_000;
    this.blockTimeoutMs = opts.blockTimeoutMs ?? 5_000;
    this.readCount = opts.readCount ?? 10;
  }

  // ── publish ────────────────────────────────────────────────

  async publish(channel: string, payload: unknown): Promise<void> {
    const key = streamKey(channel);
    const data = JSON.stringify(payload);
    await this.redis.xadd(key, "MAXLEN", "~", String(this.maxStreamLength), "*", "payload", data);
    _logger.info("stream.publish", { channel, streamKey: key });
  }

  // ── subscribe ──────────────────────────────────────────────

  async subscribe(channel: string, handler: (payload: unknown) => void): Promise<void> {
    const key = streamKey(channel);

    // 1. 确保 Consumer Group 存在（忽略 BUSYGROUP 错误）
    await this.ensureConsumerGroup(key);

    // 2. 注册 handler
    this.channelHandlers.set(channel, handler);

    // 3. 启动读取循环
    const ctrl = { aborted: false };
    this.abortControllers.set(channel, ctrl);
    this.readLoop(channel, key, ctrl).catch((e) => {
      if (!ctrl.aborted && !this.closed) {
        _logger.error("stream read loop unexpected exit", { channel, error: String(e) });
      }
    });

    _logger.info("stream.subscribe", { channel, consumerGroup: this.consumerGroup, consumerId: this.consumerId });
  }

  // ── unsubscribe ────────────────────────────────────────────

  async unsubscribe(channel: string): Promise<void> {
    const ctrl = this.abortControllers.get(channel);
    if (ctrl) ctrl.aborted = true;
    this.abortControllers.delete(channel);
    this.channelHandlers.delete(channel);
    _logger.info("stream.unsubscribe", { channel });
  }

  // ── resumeFromLastAck ──────────────────────────────────────

  async resumeFromLastAck(channel: string, consumerGroup: string, consumerId: string): Promise<void> {
    const key = streamKey(channel);
    await this.ensureConsumerGroup(key);

    _logger.info("stream.resumeFromLastAck.start", { channel, consumerGroup, consumerId });

    // 读取所有 pending（id = "0" 表示从最早的 pending 开始）
    let processed = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const results = await this.redis.call(
        "XREADGROUP", "GROUP", consumerGroup, consumerId,
        "COUNT", "100",
        "STREAMS", key, "0",
      ) as StreamReadResult;

      if (!results || results.length === 0) break;
      const [, entries] = results[0];
      if (!entries || entries.length === 0) break;

      const handler = this.channelHandlers.get(channel);
      for (const [msgId, fields] of entries) {
        const payload = this.parseFields(fields);
        if (handler) {
          try {
            await Promise.resolve(handler(payload));
          } catch (e) {
            _logger.warn("stream.resume handler error", { channel, msgId, error: String(e) });
          }
        }
        await this.redis.xack(key, consumerGroup, msgId);
        processed++;
      }
    }

    _logger.info("stream.resumeFromLastAck.done", { channel, processed });
  }

  // ── ack ────────────────────────────────────────────────────

  async ack(channel: string, consumerGroup: string, messageId: string): Promise<void> {
    const key = streamKey(channel);
    await this.redis.xack(key, consumerGroup, messageId);
  }

  // ── close ──────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
    // 停止所有读取循环
    for (const [, ctrl] of this.abortControllers) {
      ctrl.aborted = true;
    }
    this.abortControllers.clear();
    this.channelHandlers.clear();
    _logger.info("stream bus closed");
  }

  // ── 内部方法 ───────────────────────────────────────────────

  private async ensureConsumerGroup(key: string): Promise<void> {
    try {
      // MKSTREAM: 若 stream 不存在则自动创建
      await this.redis.xgroup("CREATE", key, this.consumerGroup, "$", "MKSTREAM");
    } catch (e: unknown) {
      // BUSYGROUP = group already exists，安全忽略
      if (e instanceof Error && e.message.includes("BUSYGROUP")) return;
      throw e;
    }
  }

  /**
   * 持续读取循环：XREADGROUP GROUP <group> <consumer> BLOCK <ms> COUNT <n> STREAMS <key> >
   * 新消息使用 ">" 读取；处理后立即 XACK。
   */
  private async readLoop(channel: string, key: string, ctrl: { aborted: boolean }): Promise<void> {
    while (!ctrl.aborted && !this.closed) {
      try {
        const results = await this.redis.call(
          "XREADGROUP", "GROUP", this.consumerGroup, this.consumerId,
          "BLOCK", String(this.blockTimeoutMs),
          "COUNT", String(this.readCount),
          "STREAMS", key, ">",
        ) as StreamReadResult;

        if (!results || results.length === 0) continue;

        const [, entries] = results[0];
        if (!entries || entries.length === 0) continue;

        const handler = this.channelHandlers.get(channel);
        for (const [msgId, fields] of entries) {
          const payload = this.parseFields(fields);
          if (handler) {
            try {
              await Promise.resolve(handler(payload));
            } catch (e) {
              _logger.warn("stream handler error (will retry on restart)", {
                channel, msgId, error: String(e),
              });
              // 不 XACK → 重启后会重新消费（at-least-once）
              continue;
            }
          }
          // 处理成功，确认
          await this.redis.xack(key, this.consumerGroup, msgId);
        }
      } catch (e) {
        if (ctrl.aborted || this.closed) break;
        _logger.warn("stream readLoop transient error, retrying in 1s", {
          channel, error: String(e),
        });
        await this.sleep(1_000);
      }
    }
  }

  /** 解析 XREADGROUP 返回的 field-value 数组 → payload */
  private parseFields(fields: string[]): unknown {
    // fields = ["payload", "{...json...}"]
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i] === "payload") {
        try {
          return JSON.parse(fields[i + 1]);
        } catch {
          return fields[i + 1];
        }
      }
    }
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
