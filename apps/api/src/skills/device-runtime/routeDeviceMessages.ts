/**
 * Device Messages API Routes
 *
 * 端点：
 * - POST /device-agent/messages      — 发送消息（用户/系统 → 设备 / topic / 广播）
 * - GET  /device-agent/messages/pending — 设备拉取未读消息（离线降级）
 * - POST /device-agent/messages/ack   — 设备确认消费
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { PERM } from "@mindpal/shared";
import { getDeviceRecord } from "./modules/deviceRepo";
import {
  sendDirectMessage,
  publishTopicMessage,
  broadcastMessage,
  getPendingMessages,
  ackPendingMessages,
  type DeviceMessage,
} from "./modules/deviceMessageBus";
import { pushToDevice } from "./deviceWsRegistry";
import {
  sendD2DMessage,
  getMessageStatus,
  type SendD2DParams,
} from "./modules/crossDeviceBus";

function requireDevice(req: any) {
  const device = req.ctx.device;
  if (!device) throw Errors.unauthorized(req.ctx.locale);
  return device as { deviceId: string; tenantId: string; spaceId: string | null };
}

export const deviceMessageRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /device-agent/messages — 发送消息 ────────────────────
  app.post("/device-agent/messages", async (req) => {
    setAuditContext(req, { resourceType: "device_message", action: "send" });

    const body = z
      .object({
        // 直连
        toDeviceId: z.string().uuid().optional(),
        // topic 发布
        topic: z.string().min(1).max(200).optional(),
        // 广播标志
        broadcast: z.boolean().optional(),
        // 消息负载
        payload: z.record(z.string(), z.any()),
      })
      .parse(req.body);

    // 至少指定一种目标
    if (!body.toDeviceId && !body.topic && !body.broadcast) {
      throw Errors.badRequest("至少指定 toDeviceId / topic / broadcast 之一");
    }

    // 鉴权：来自 User（Bearer）或 Device（Device token）
    let fromDeviceId: string | null = null;
    let tenantId: string;

    const device = (req.ctx as any).device;
    if (device) {
      fromDeviceId = device.deviceId;
      tenantId = device.tenantId;
    } else {
      const subject = requireSubject(req);
      const decision = await requirePermission({ req, ...PERM.DEVICE_MESSAGE_SEND });
      req.ctx.audit!.policyDecision = decision;
      tenantId = subject.tenantId;
    }

    // 验证目标设备存在
    if (body.toDeviceId) {
      const target = await getDeviceRecord({ pool: app.db, tenantId, deviceId: body.toDeviceId });
      if (!target || target.status !== "active") throw Errors.badRequest("目标设备不存在或未激活");
    }

    const msg: DeviceMessage = {
      messageId: crypto.randomUUID(),
      tenantId,
      fromDeviceId,
      toDeviceId: body.toDeviceId ?? null,
      topic: body.topic ?? null,
      payload: body.payload,
      createdAt: Date.now(),
    };

    // 分发消息
    if (body.toDeviceId) {
      await sendDirectMessage({ redis: app.redis, message: msg });
      // 也尝试通过 WS 推送（低延迟）
      pushToDevice(body.toDeviceId, { type: "device_message", payload: msg });
    }
    if (body.topic) {
      await publishTopicMessage({ redis: app.redis, message: { ...msg, toDeviceId: null } });
    }
    if (body.broadcast) {
      await broadcastMessage({ redis: app.redis, message: { ...msg, toDeviceId: null, topic: null } });
    }

    req.ctx.audit!.outputDigest = {
      messageId: msg.messageId,
      toDeviceId: body.toDeviceId ?? null,
      topic: body.topic ?? null,
      broadcast: body.broadcast ?? false,
    };

    return { messageId: msg.messageId, sent: true };
  });

  // ── POST /device-agent/messages/d2d — D2D 增强消息（at-least-once + 投递追踪） ────
  app.post("/device-agent/messages/d2d", async (req) => {
    setAuditContext(req, { resourceType: "device_message", action: "d2d.send" });

    const body = z
      .object({
        routingKind: z.enum(["direct", "topic", "broadcast", "multicast"]).default("direct"),
        toDeviceId: z.string().uuid().optional(),
        toDeviceIds: z.array(z.string().uuid()).max(50).optional(),
        topic: z.string().min(1).max(200).optional(),
        category: z.string().max(100).default("default"),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
        payload: z.record(z.string(), z.any()),
        requireAck: z.boolean().default(false),
        ttlMs: z.number().int().min(0).default(0),
        correlationId: z.string().uuid().optional(),
        replyTo: z.string().uuid().optional(),
      })
      .parse(req.body);

    // 至少指定一种目标
    if (!body.toDeviceId && !body.topic && body.routingKind !== "broadcast" && !body.toDeviceIds?.length) {
      throw Errors.badRequest("至少指定 toDeviceId / toDeviceIds / topic 或使用 broadcast 路由");
    }

    let fromDeviceId: string | null = null;
    let tenantId: string;

    const device = (req.ctx as any).device;
    if (device) {
      fromDeviceId = device.deviceId;
      tenantId = device.tenantId;
    } else {
      const subject = requireSubject(req);
      const decision = await requirePermission({ req, ...PERM.DEVICE_MESSAGE_SEND });
      req.ctx.audit!.policyDecision = decision;
      tenantId = subject.tenantId;
    }

    const sendParams: SendD2DParams = {
      tenantId,
      fromDeviceId,
      routingKind: body.routingKind,
      toDeviceId: body.toDeviceId ?? null,
      toDeviceIds: body.toDeviceIds,
      topic: body.topic ?? null,
      category: body.category,
      priority: body.priority,
      payload: body.payload,
      requireAck: body.requireAck,
      ttlMs: body.ttlMs,
      correlationId: body.correlationId ?? null,
      replyTo: body.replyTo ?? null,
    };

    const envelope = await sendD2DMessage({ pool: app.db, redis: app.redis, msg: sendParams });

    // 也尝试通过 WS 推送（低延迟）
    if (body.toDeviceId) {
      pushToDevice(body.toDeviceId, { type: "d2d_message", payload: envelope });
    }

    req.ctx.audit!.outputDigest = {
      messageId: envelope.messageId,
      routingKind: envelope.routingKind,
      status: envelope.status,
    };

    return {
      messageId: envelope.messageId,
      status: envelope.status,
      routingKind: envelope.routingKind,
      createdAt: envelope.createdAt,
      expiresAt: envelope.expiresAt || null,
    };
  });

  // ── POST /device-agent/messages/d2d/batch — 批量 D2D 发送 ─────────
  app.post("/device-agent/messages/d2d/batch", async (req) => {
    setAuditContext(req, { resourceType: "device_message", action: "d2d.batch_send" });

    const body = z
      .object({
        messages: z.array(
          z.object({
            toDeviceId: z.string().uuid(),
            payload: z.record(z.string(), z.any()),
            category: z.string().max(100).default("default"),
            priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
            requireAck: z.boolean().default(false),
          }),
        ).min(1).max(50),
      })
      .parse(req.body);

    let fromDeviceId: string | null = null;
    let tenantId: string;

    const device = (req.ctx as any).device;
    if (device) {
      fromDeviceId = device.deviceId;
      tenantId = device.tenantId;
    } else {
      const subject = requireSubject(req);
      const decision = await requirePermission({ req, ...PERM.DEVICE_MESSAGE_SEND });
      req.ctx.audit!.policyDecision = decision;
      tenantId = subject.tenantId;
    }

    const results: Array<{ messageId: string; toDeviceId: string; status: string }> = [];
    for (const m of body.messages) {
      try {
        const env = await sendD2DMessage({
          pool: app.db,
          redis: app.redis,
          msg: {
            tenantId,
            fromDeviceId,
            routingKind: "direct",
            toDeviceId: m.toDeviceId,
            category: m.category,
            priority: m.priority,
            payload: m.payload,
            requireAck: m.requireAck,
          },
        });
        pushToDevice(m.toDeviceId, { type: "d2d_message", payload: env });
        results.push({ messageId: env.messageId, toDeviceId: m.toDeviceId, status: env.status });
      } catch (err: any) {
        results.push({ messageId: "", toDeviceId: m.toDeviceId, status: `error:${err?.message ?? "unknown"}` });
      }
    }

    req.ctx.audit!.outputDigest = { sentCount: results.filter((r) => r.status !== "").length };
    return { results };
  });

  // ── GET /device-agent/messages/:id/status — 消息投递状态查询 ────
  app.get("/device-agent/messages/:id/status", async (req) => {
    setAuditContext(req, { resourceType: "device_message", action: "status" });

    const { id: messageId } = req.params as { id: string };
    if (!messageId) throw Errors.badRequest("messageId is required");

    let tenantId: string;
    const device = (req.ctx as any).device;
    if (device) {
      tenantId = device.tenantId;
    } else {
      const subject = requireSubject(req);
      await requirePermission({ req, ...PERM.DEVICE_MESSAGE_READ });
      tenantId = subject.tenantId;
    }

    const status = await getMessageStatus({ pool: app.db, messageId, tenantId });
    if (!status) throw Errors.notFound();

    return status;
  });

  // ── GET /device-agent/messages/pending — 设备拉取未读 ────────
  app.get("/device-agent/messages/pending", async (req) => {
    setAuditContext(req, { resourceType: "device_message", action: "device.poll" });
    const device = requireDevice(req);
    const q = z.object({ limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);

    const msgs = await getPendingMessages({
      redis: app.redis,
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      limit: q.limit ?? 50,
    });

    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, count: msgs.length };
    return { messages: msgs };
  });

  // ── POST /device-agent/messages/ack — 设备确认消费 ───────────
  app.post("/device-agent/messages/ack", async (req) => {
    setAuditContext(req, { resourceType: "device_message", action: "device.ack" });
    const device = requireDevice(req);
    const body = z.object({ count: z.number().int().min(1).max(500) }).parse(req.body);

    const removed = await ackPendingMessages({
      redis: app.redis,
      tenantId: device.tenantId,
      deviceId: device.deviceId,
      count: body.count,
    });

    req.ctx.audit!.outputDigest = { deviceId: device.deviceId, removed };
    return { acknowledged: removed };
  });
};
