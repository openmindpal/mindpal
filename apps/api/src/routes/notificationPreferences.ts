/**
 * P3-06b: 通知偏好 + 收件箱 API 路由
 *
 * 端点：
 * - GET  /notifications/preferences         — 获取当前用户通知偏好
 * - PUT  /notifications/preferences         — 更新通知偏好
 * - GET  /notifications/inbox               — 获取 inapp 通知列表
 * - GET  /notifications/inbox/unread-count  — 获取未读通知计数
 * - POST /notifications/inbox/:id/read      — 标记单条已读
 * - POST /notifications/inbox/read-all      — 标记全部已读
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { setAuditContext } from "../modules/audit/context";
import { requirePermission, requireSubject } from "../modules/auth/guard";
import {
  getOrCreatePreference,
  updatePreference,
  listInappNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getUnreadCount,
} from "../modules/notifications/preferenceRepo";

export const notificationPreferenceRoutes: FastifyPluginAsync = async (app) => {
  // ── GET 通知偏好 ──────────────────────────────────────────────
  app.get("/notifications/preferences", async (req) => {
    setAuditContext(req, { resourceType: "notification_preference", action: "read" });
    const decision = await requirePermission({ req, resourceType: "notification_preference", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const pref = await getOrCreatePreference({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
    });
    req.ctx.audit!.outputDigest = { preferenceId: pref.preferenceId };
    return { preference: pref };
  });

  // ── PUT 更新通知偏好 ──────────────────────────────────────────
  app.put("/notifications/preferences", async (req) => {
    setAuditContext(req, { resourceType: "notification_preference", action: "update" });
    const decision = await requirePermission({ req, resourceType: "notification_preference", action: "update" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const body = z.object({
      channelEmail: z.boolean().optional(),
      channelInapp: z.boolean().optional(),
      channelIm: z.boolean().optional(),
      channelWebhook: z.boolean().optional(),
      dndEnabled: z.boolean().optional(),
      dndStartTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
      dndEndTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
      dndTimezone: z.string().min(1).max(100).optional(),
      digestEnabled: z.boolean().optional(),
      digestIntervalMinutes: z.number().int().min(5).max(1440).optional(),
      digestMaxBatch: z.number().int().min(1).max(200).optional(),
      rateLimitPerHour: z.number().int().min(1).max(10000).optional(),
      rateLimitPerDay: z.number().int().min(1).max(100000).optional(),
      minSeverity: z.enum(["debug", "info", "warn", "error", "critical"]).optional(),
      mutedEvents: z.array(z.string().max(200)).max(100).optional(),
    }).parse(req.body);

    const pref = await updatePreference({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      update: body,
    });
    req.ctx.audit!.outputDigest = { preferenceId: pref.preferenceId, updated: Object.keys(body) };
    return { preference: pref };
  });

  // ── GET 通知收件箱 ────────────────────────────────────────────
  app.get("/notifications/inbox", async (req) => {
    setAuditContext(req, { resourceType: "notification", action: "inbox.read" });
    const decision = await requirePermission({ req, resourceType: "notification", action: "inbox.read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const q = z.object({
      limit: z.coerce.number().int().positive().max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      unreadOnly: z.coerce.boolean().optional(),
    }).parse(req.query);

    const result = await listInappNotifications({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
      unreadOnly: q.unreadOnly ?? false,
    });
    req.ctx.audit!.outputDigest = { count: result.items.length, total: result.total };
    return { notifications: result.items, total: result.total };
  });

  // ── GET 未读计数 ──────────────────────────────────────────────
  app.get("/notifications/inbox/unread-count", async (req) => {
    const subject = requireSubject(req);
    const count = await getUnreadCount({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
    });
    return { unreadCount: count };
  });

  // ── POST 标记单条已读 ────────────────────────────────────────
  app.post("/notifications/inbox/:notificationId/read", async (req) => {
    setAuditContext(req, { resourceType: "notification", action: "inbox.markRead" });
    const decision = await requirePermission({ req, resourceType: "notification", action: "inbox.markRead" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const params = z.object({ notificationId: z.string().uuid() }).parse(req.params);

    const ok = await markNotificationRead({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
      notificationId: params.notificationId,
    });
    req.ctx.audit!.outputDigest = { notificationId: params.notificationId, marked: ok };
    return { ok };
  });

  // ── POST 标记全部已读 ────────────────────────────────────────
  app.post("/notifications/inbox/read-all", async (req) => {
    setAuditContext(req, { resourceType: "notification", action: "inbox.markAllRead" });
    const decision = await requirePermission({ req, resourceType: "notification", action: "inbox.markAllRead" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    const count = await markAllNotificationsRead({
      pool: app.db,
      tenantId: subject.tenantId,
      subjectId: subject.subjectId,
    });
    req.ctx.audit!.outputDigest = { markedCount: count };
    return { markedCount: count };
  });
};
