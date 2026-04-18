/**
 * Task Queue Routes — 会话级多任务队列 API
 *
 * GET  /orchestrator/session-events         — 会话级持久 SSE 端点
 * GET  /orchestrator/task-queue             — 获取队列快照
 * POST /orchestrator/task-queue/cancel      — 取消任务
 * POST /orchestrator/task-queue/cancel-all  — 取消所有任务
 * POST /orchestrator/task-queue/pause       — 暂停任务
 * POST /orchestrator/task-queue/resume      — 恢复任务
 * POST /orchestrator/task-queue/retry       — 重试失败任务
 * POST /orchestrator/task-queue/retry-repair — 重试并修复依赖链 (P3-14)
 * POST /orchestrator/task-queue/repair-deps  — 修复依赖链断裂 (P3-14)
 * POST /orchestrator/task-queue/reorder     — 调整队列顺序
 * POST /orchestrator/task-queue/priority    — 更新优先级
 * POST /orchestrator/task-queue/foreground  — 切换前台/后台
 * POST /orchestrator/task-queue/dep/create   — 手动创建依赖
 * POST /orchestrator/task-queue/dep/remove   — 移除依赖
 * POST /orchestrator/task-queue/dep/override — 覆盖依赖
 * POST /orchestrator/task-queue/dep/validate — DAG 合法性校验
 * GET  /orchestrator/task-queue/history       — 任务队列历史 (P3-10)
 * GET  /orchestrator/task-queue/stats         — 队列统计 (P3-10)
 * GET  /orchestrator/task-queue/resumable     — 可恢复任务 (P3-10)
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { setAuditContext } from "../../modules/audit/context";
import { Errors } from "../../lib/errors";
import {
  registerSessionConnection,
  getSessionConnection,
  getSessionBusMetrics,
} from "../../lib/sessionEventBus";
import { resolveRequestDlpPolicyContext } from "../../lib/dlpPolicy";
import { finalizeAuditForStream } from "../../plugins/audit";
import { getOrCreateTaskQueueSystem } from "../../kernel/taskQueueFactory";
import type { TaskQueueManager } from "../../kernel/taskQueueManager";
import type { TaskDependencyResolver } from "../../kernel/taskDependencyResolver";
import type { SessionScheduler } from "../../kernel/sessionScheduler";

/* ── Schema ──────────────────────────────────────────────────── */

const sessionEventsQuerySchema = z.object({
  sessionId: z.string().min(1).max(200),
});

const entryIdSchema = z.object({
  entryId: z.string().uuid(),
});

const reorderSchema = z.object({
  entryId: z.string().uuid(),
  newPosition: z.number().int().min(0),
});

const prioritySchema = z.object({
  entryId: z.string().uuid(),
  priority: z.number().int().min(0).max(100),
});

const foregroundSchema = z.object({
  entryId: z.string().uuid(),
  foreground: z.boolean(),
});

const queueQuerySchema = z.object({
  sessionId: z.string().min(1).max(200),
});

const createDepSchema = z.object({
  sessionId: z.string().min(1).max(200),
  fromEntryId: z.string().uuid(),
  toEntryId: z.string().uuid(),
  depType: z.enum(["finish_to_start", "output_to_input", "cancel_cascade"]),
  outputMapping: z.record(z.string(), z.string()).nullable().optional(),
});

const depIdSchema = z.object({
  depId: z.string().uuid(),
});

const validateDagSchema = z.object({
  sessionId: z.string().min(1).max(200),
});

/* ── 路由注册 ─────────────────────────────────────────────────── */

/** 获取或创建绑定在 app 上的 TaskQueueManager 单例（通过统一工厂初始化） */
function getQueueManager(app: any): TaskQueueManager {
  return getOrCreateTaskQueueSystem(app).manager;
}

/** 获取依赖解析器 */
function getDepResolver(app: any): TaskDependencyResolver {
  return getOrCreateTaskQueueSystem(app).depResolver;
}

export const taskQueueRoutes: FastifyPluginAsync = async (app) => {

  /* ═══════════════════════════════════════════════════════════════
   *  GET /orchestrator/session-events — 会话级持久 SSE 端点
   * ═══════════════════════════════════════════════════════════════ */
  app.get("/orchestrator/session-events", async (req, reply) => {
    setAuditContext(req, { resourceType: "orchestrator", action: "session_events" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const query = sessionEventsQuerySchema.parse(req.query);
    const sessionId = query.sessionId;
    const dlpContext = await resolveRequestDlpPolicyContext({
      db: app.db,
      subject,
    });

    // 注册持久 SSE 连接
    const connection = registerSessionConnection({
      req: req as any,
      reply: reply as any,
      sessionId,
      tenantId: subject.tenantId,
      dlpContext,
      onClose: () => finalizeAuditForStream(app, { req, reply }),
    });

    app.log.info({
      traceId: req.ctx.traceId,
      sessionId,
      connectionId: connection.connectionId,
    }, "[session-events] SSE connection established");

    // 发送初始队列快照
    const manager = getQueueManager(app);
    try {
      const snapshot = await manager.getSnapshot(subject.tenantId, sessionId);
      connection.sendEvent("queueSnapshot", snapshot);
    } catch (err) {
      app.log.error({
        traceId: req.ctx.traceId, sessionId, error: String(err),
      }, "[session-events] Failed to send initial snapshot");
    }

    // SSE 连接保持打开，不返回 JSON — reply 已被 openSse 接管
    // Fastify: 标记 reply 已发送（避免 reply.send 报错）
    reply.hijack();
  });

  /* ═══════════════════════════════════════════════════════════════
   *  GET /orchestrator/task-queue — 获取队列快照
   * ═══════════════════════════════════════════════════════════════ */
  app.get("/orchestrator/task-queue", async (req) => {
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const query = queueQuerySchema.parse(req.query);
    const manager = getQueueManager(app);
    const snapshot = await manager.getSnapshot(subject.tenantId, query.sessionId);

    return { ok: true, ...snapshot };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/cancel — 取消单个任务
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/cancel", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "cancel" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = entryIdSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.cancel(body.entryId, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result) {
      throw Errors.badRequest("无法取消任务：任务不存在或已结束");
    }

    app.log.info({
      traceId: req.ctx.traceId, entryId: body.entryId,
    }, "[task-queue] Task cancelled");

    return { ok: true, entry: result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/cancel-all — 取消所有任务
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/cancel-all", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "cancel_all" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z.object({ sessionId: z.string().min(1) }).parse(req.body);
    const manager = getQueueManager(app);
    const count = await manager.cancelAll(subject.tenantId, body.sessionId);

    app.log.info({
      traceId: req.ctx.traceId, sessionId: body.sessionId, count,
    }, "[task-queue] All tasks cancelled");

    return { ok: true, cancelledCount: count };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/pause — 暂停任务
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/pause", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "pause" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = entryIdSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.pause(body.entryId, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result) {
      throw Errors.badRequest("无法暂停任务：任务不存在或不在执行中");
    }

    return { ok: true, entry: result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/resume — 恢复任务
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/resume", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "resume" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = entryIdSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.resume(body.entryId, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result) {
      throw Errors.badRequest("无法恢复任务：任务不存在或不在暂停状态");
    }

    return { ok: true, entry: result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/retry — 重试失败任务
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/retry", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "retry" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = entryIdSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.retry(body.entryId, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result) {
      throw Errors.badRequest("无法重试任务：任务不存在或不在失败状态");
    }

    return { ok: true, entry: result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/retry-repair — 重试并修复依赖链 (P3-14)
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/retry-repair", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "retry_repair" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = entryIdSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.retryWithRepair(body.entryId, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result.entry) {
      throw Errors.badRequest("无法重试任务：任务不存在或不在失败状态");
    }

    app.log.info({
      traceId: req.ctx.traceId, entryId: body.entryId,
      repairedDeps: result.repairedDeps,
      unblockedEntries: result.unblockedEntries,
    }, "[task-queue] Task retried with dependency repair");

    return { ok: true, ...result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/repair-deps — 修复依赖链 (P3-14)
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/repair-deps", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "repair_deps" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = entryIdSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.repairDependencyChain(body.entryId, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    app.log.info({
      traceId: req.ctx.traceId, entryId: body.entryId,
      repairedDeps: result.repairedDeps,
      unblockedEntries: result.unblockedEntries,
    }, "[task-queue] Dependency chain repaired");

    return { ok: true, ...result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/reorder — 调整队列顺序
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/reorder", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "reorder" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = reorderSchema.parse(req.body);
    const manager = getQueueManager(app);
    await manager.reorder(body.entryId, body.newPosition, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    return { ok: true };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/priority — 更新优先级
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/priority", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "priority" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = prioritySchema.parse(req.body);
    const { updatePriority } = await import("../../kernel/taskQueueRepo");
    const result = await updatePriority(app.db, body.entryId, body.priority, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result) {
      throw Errors.badRequest("无法更新优先级：任务不存在");
    }

    return { ok: true, entry: result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/foreground — 切换前台/后台
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/foreground", async (req) => {
    setAuditContext(req, { resourceType: "task_queue", action: "foreground" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = foregroundSchema.parse(req.body);
    const manager = getQueueManager(app);
    const result = await manager.setForeground(body.entryId, body.foreground, {
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
    });

    if (!result) {
      throw Errors.badRequest("无法切换前台/后台：任务不存在");
    }

    return { ok: true, entry: result };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  GET /orchestrator/task-queue/metrics — 会话事件总线指标（调试用）
   * ═══════════════════════════════════════════════════════════════ */
  app.get("/orchestrator/task-queue/metrics", async (req) => {
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const busMetrics = getSessionBusMetrics();
    const { getSchedulerMetrics } = await import("../../kernel/sessionScheduler");
    const schedulerMetrics = getSchedulerMetrics();

    return { ok: true, bus: busMetrics, scheduler: schedulerMetrics };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/dep/create — 手动创建依赖 (P2-09)
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/dep/create", async (req) => {
    setAuditContext(req, { resourceType: "task_dependency", action: "create" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);

    const body = createDepSchema.parse(req.body);
    const resolver = getDepResolver(app);

    const result = await resolver.createDependency({
      tenantId: subject.tenantId,
      sessionId: body.sessionId,
      fromEntryId: body.fromEntryId,
      toEntryId: body.toEntryId,
      depType: body.depType,
      source: "manual",
      outputMapping: (body.outputMapping ?? null) as Record<string, string> | null,
    });

    if (!result.ok) {
      throw Errors.badRequest(result.error);
    }

    app.log.info({
      traceId: req.ctx.traceId,
      depId: result.dep.depId,
      from: body.fromEntryId,
      to: body.toEntryId,
    }, "[task-queue] Dependency created manually");

    return { ok: true, dependency: result.dep };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/dep/remove — 移除依赖 (P2-09)
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/dep/remove", async (req) => {
    setAuditContext(req, { resourceType: "task_dependency", action: "remove" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });

    const body = depIdSchema.parse(req.body);
    const resolver = getDepResolver(app);
    const ok = await resolver.removeDependency(body.depId);

    if (!ok) {
      throw Errors.badRequest("无法移除依赖：依赖不存在");
    }

    return { ok: true };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/dep/override — 覆盖依赖 (P2-09)
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/dep/override", async (req) => {
    setAuditContext(req, { resourceType: "task_dependency", action: "override" });
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });

    const body = depIdSchema.parse(req.body);
    const resolver = getDepResolver(app);
    const dep = await resolver.overrideDependency(body.depId);

    if (!dep) {
      throw Errors.badRequest("无法覆盖依赖：依赖不存在");
    }

    return { ok: true, dependency: dep };
  });

  /* ═══════════════════════════════════════════════════════════════
   *  POST /orchestrator/task-queue/dep/validate — DAG 合法性校验 (P2-09)
   * ═══════════════════════════════════════════════════════════════ */
  app.post("/orchestrator/task-queue/dep/validate", async (req) => {
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);

    const body = validateDagSchema.parse(req.body);
    const resolver = getDepResolver(app);
    const result = await resolver.validateSessionDAG(subject.tenantId, body.sessionId);

    return { ok: true, ...result };
  });

  /* ═════════════════════════════════════════════════════════════
   *  GET /orchestrator/task-queue/history — 任务队列历史 (P3-10)
   * ═════════════════════════════════════════════════════════════ */
  app.get("/orchestrator/task-queue/history", async (req) => {
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const query = z.object({
      sessionId: z.string().min(1).max(200),
      limit: z.coerce.number().int().positive().max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
      status: z.string().optional(),
    }).parse(req.query);

    const { listHistoryEntries } = await import("../../kernel/taskQueueRepo");
    const statusFilter = query.status ? query.status.split(",") as any[] : null;
    const result = await listHistoryEntries(app.db, {
      tenantId: subject.tenantId,
      sessionId: query.sessionId,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
      statusFilter,
    });

    return { ok: true, ...result };
  });

  /* ═════════════════════════════════════════════════════════════
   *  GET /orchestrator/task-queue/stats — 队列统计 (P3-10)
   * ═════════════════════════════════════════════════════════════ */
  app.get("/orchestrator/task-queue/stats", async (req) => {
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const query = queueQuerySchema.parse(req.query);
    const { getSessionQueueStats } = await import("../../kernel/taskQueueRepo");
    const stats = await getSessionQueueStats(app.db, subject.tenantId, query.sessionId);

    return { ok: true, stats };
  });

  /* ═════════════════════════════════════════════════════════════
   *  GET /orchestrator/task-queue/resumable — 可恢复任务 (P3-10)
   * ═════════════════════════════════════════════════════════════ */
  app.get("/orchestrator/task-queue/resumable", async (req) => {
    await requirePermission({ req, ...PERM.ORCHESTRATOR_DISPATCH });
    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const query = queueQuerySchema.parse(req.query);
    const { listResumableEntries, listSessionDependencies } = await import("../../kernel/taskQueueRepo");
    const [entries, dependencies] = await Promise.all([
      listResumableEntries(app.db, subject.tenantId, query.sessionId),
      listSessionDependencies(app.db, subject.tenantId, query.sessionId),
    ]);

    return { ok: true, entries, dependencies };
  });
};
