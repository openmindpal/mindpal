/**
 * P2-6 验证：OS 基础设施 — 事件总线、Webhook 验签、分布式追踪
 */
import { describe, it, expect, vi } from "vitest";

/* ================================================================== */
/*  EventBus — 发布/订阅/确认                                           */
/* ================================================================== */

import { createEventBus, type EventBus, type EventEnvelope } from "../lib/eventBus";

describe("createEventBus", () => {
  it("publish 写入 DB + Redis 并返回 eventId", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as any;
    const redis = { publish: vi.fn(async () => 1) } as any;
    const bus = createEventBus({ pool, redis });

    const eventId = await bus.publish({
      channel: "step.complete",
      eventType: "step_done",
      payload: { stepId: "s-1", status: "succeeded" },
      tenantId: "t1",
      sourceModule: "agentLoop",
    });

    expect(typeof eventId).toBe("string");
    expect(eventId.length).toBeGreaterThan(0);
    // DB outbox 写入
    expect(pool.query).toHaveBeenCalled();
    // Redis 发布
    expect(redis.publish).toHaveBeenCalled();
    const redisCall = redis.publish.mock.calls[0];
    expect(redisCall[0]).toContain("step.complete");
  });

  it("Redis 不可用时仅写 DB（不抛异常）", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as any;
    const bus = createEventBus({ pool }); // 无 redis

    const eventId = await bus.publish({
      channel: "device.message",
      eventType: "device_online",
      payload: { deviceId: "d-1" },
      tenantId: "t1",
      sourceModule: "deviceRuntime",
    });

    expect(typeof eventId).toBe("string");
    expect(pool.query).toHaveBeenCalled();
  });

  it("subscribe 注册处理器", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as any;
    const bus = createEventBus({ pool });

    const received: EventEnvelope[] = [];
    const sub = await bus.subscribe("test.channel", (event) => {
      received.push(event);
    });

    expect(sub).toHaveProperty("unsubscribe");
    expect(typeof sub.unsubscribe).toBe("function");
  });

  it("acknowledge 更新 DB 确认状态", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) } as any;
    const bus = createEventBus({ pool });

    await bus.acknowledge("event-123");
    expect(pool.query).toHaveBeenCalled();
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql.toLowerCase()).toContain("event");
  });
});

/* ================================================================== */
/*  Webhook 验签                                                       */
/* ================================================================== */

import {
  computeHmacSha256,
  safeCompare,
  verifyWebhookSignature,
  verifyTimestamp,
} from "../lib/webhookVerification";

describe("computeHmacSha256", () => {
  it("计算 HMAC-SHA256", () => {
    const sig = computeHmacSha256("secret123", "hello world");
    expect(typeof sig).toBe("string");
    expect(sig.length).toBe(64); // SHA256 hex = 64 chars
  });

  it("相同输入产生相同签名", () => {
    const a = computeHmacSha256("key", "body");
    const b = computeHmacSha256("key", "body");
    expect(a).toBe(b);
  });

  it("不同密钥产生不同签名", () => {
    const a = computeHmacSha256("key1", "body");
    const b = computeHmacSha256("key2", "body");
    expect(a).not.toBe(b);
  });
});

describe("safeCompare", () => {
  it("相同字符串返回 true", () => {
    expect(safeCompare("abc123", "abc123")).toBe(true);
  });

  it("不同字符串返回 false", () => {
    expect(safeCompare("abc123", "def456")).toBe(false);
  });

  it("不同长度返回 false", () => {
    expect(safeCompare("short", "longer_string")).toBe(false);
  });

  it("空字符串相等", () => {
    expect(safeCompare("", "")).toBe(true);
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "my-webhook-secret";
  const body = '{"event":"test"}';

  it("body 模式验签通过", () => {
    const sig = computeHmacSha256(secret, body);
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: sig,
      config: { secret, signatureScheme: "body", signatureHeader: "x-sig", timestampHeader: "x-ts" },
    });
    expect(result.valid).toBe(true);
  });

  it("timestamp_body 模式验签通过", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = computeHmacSha256(secret, `${ts}.${body}`);
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: sig,
      timestamp: ts,
      config: { secret, signatureScheme: "timestamp_body", signatureHeader: "x-sig", timestampHeader: "x-ts" },
    });
    expect(result.valid).toBe(true);
  });

  it("错误签名被拒绝", () => {
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: "wrong_signature",
      config: { secret, signatureScheme: "body", signatureHeader: "x-sig", timestampHeader: "x-ts" },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectReason).toBe("invalid_signature");
  });

  it("GitHub sha256= 前缀格式兼容", () => {
    const sig = computeHmacSha256(secret, body);
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: `sha256=${sig}`,
      config: { secret, signatureScheme: "body", signatureHeader: "x-sig", timestampHeader: "x-ts" },
    });
    expect(result.valid).toBe(true);
  });

  it("缺少签名返回 missing_header", () => {
    const result = verifyWebhookSignature({
      rawBody: body,
      signature: "",
      config: { secret, signatureScheme: "body", signatureHeader: "x-sig", timestampHeader: "x-ts" },
    });
    expect(result.valid).toBe(false);
    expect(result.rejectReason).toBe("missing_header");
  });
});

describe("verifyTimestamp", () => {
  it("当前时间戳验证通过", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = verifyTimestamp({ timestamp: now });
    expect(result.valid).toBe(true);
  });

  it("过期时间戳被拒绝（重放攻击）", () => {
    const old = Math.floor(Date.now() / 1000) - 600; // 10分钟前
    const result = verifyTimestamp({ timestamp: old, toleranceSec: 300 });
    expect(result.valid).toBe(false);
    expect(result.rejectReason).toBe("replay_attack");
  });

  it("自动检测毫秒级时间戳", () => {
    const nowMs = Date.now();
    const result = verifyTimestamp({ timestamp: nowMs });
    expect(result.valid).toBe(true);
  });

  it("无效时间戳被拒绝", () => {
    const result = verifyTimestamp({ timestamp: "not_a_number" });
    expect(result.valid).toBe(false);
  });
});

/* ================================================================== */
/*  分布式追踪工具                                                      */
/* ================================================================== */

import {
  attachJobTraceCarrier,
  injectTraceToPayload,
  extractTraceFromPayload,
  getTraceHeaders,
} from "../lib/tracing";

describe("attachJobTraceCarrier", () => {
  it("OTel 未启用时原样返回 data", () => {
    const data = { jobId: "j-1", task: "test" };
    const result = attachJobTraceCarrier(data);
    expect(result).toHaveProperty("jobId", "j-1");
    // OTel 未启用时不注入 __trace，直接返回原对象
    expect(result).toBe(data);
  });
});

describe("injectTraceToPayload / extractTraceFromPayload", () => {
  it("注入 traceId 到 payload", () => {
    const payload: Record<string, unknown> = { msg: "hello" };
    const injected = injectTraceToPayload(payload, "trace-abc-123");
    expect(injected).toHaveProperty("traceId", "trace-abc-123");
    expect(injected.msg).toBe("hello");
  });

  it("extractTraceFromPayload 返回 OTel Context", () => {
    const extracted = extractTraceFromPayload({ msg: "no trace" });
    // OTel 未启用时返回 context.active()（一个 OTel Context 对象）
    expect(extracted).toBeDefined();
  });
});

describe("getTraceHeaders", () => {
  it("返回包含 trace 信息的 HTTP headers", () => {
    const headers = getTraceHeaders("trace-xyz");
    expect(headers).toHaveProperty("x-trace-id", "trace-xyz");
  });

  it("无 traceId 时返回空对象", () => {
    const headers = getTraceHeaders();
    expect(typeof headers).toBe("object");
    // OTel 未启用时不注入传播头
    expect(Object.keys(headers).filter(k => k !== "x-trace-id").length).toBe(0);
  });
});
