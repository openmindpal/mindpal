import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { requirePermission, requireSubject } from "../../modules/auth/guard";
import { clearMemory, createMemoryEntry, deleteMemoryEntry, exportAndClearMemory, exportMemoryEntries, getMemoryEntry, getTaskState, insertMemoryAttachments, listMemoryAttachments, listMemoryAttachmentsBatch, listMemoryEntries, searchMemory, updateMemoryEntry, upsertTaskState, detectMemoryConflicts, arbitrateMemoryConflict, pinMemoryEntry, unpinMemoryEntry } from "../../modules/memory/repo";
import type { WriteIntent, MediaRefInput, MemoryClass, MemoryScope } from "../../modules/memory/repo";
import { clearSessionContext, getSessionContext, listSessionContexts, toSessionContextListItem, upsertSessionContext } from "../../modules/memory/sessionContextRepo";

/** 确认引用 schema */
const confirmationRefSchema = z.object({
  requestId: z.string().min(1),
  turnId: z.string().optional(),
  confirmationType: z.enum(["explicit", "implicit"]).default("implicit"),
});

/** 策略引用 schema */
const policyRefSchema = z.object({
  snapshotRef: z.string().optional(),
});

/** 写入意图 schema */
const writeIntentSchema = z.object({
  policy: z.enum(["confirmed", "approved", "policyAllowed"]),
  approvalId: z.string().optional(),
  confirmationRef: confirmationRefSchema.optional(),
  policyRef: policyRefSchema.optional(),
});

/** 媒体引用 schema */
const mediaRefSchema = z.object({
  mediaId: z.string().uuid(),
  mediaType: z.string().min(1).max(50).optional(),
  caption: z.string().max(500).nullable().optional(),
});

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  app.post("/memory/entries", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        scope: z.enum(["user", "space", "global"]),
        type: z.string().min(1),
        title: z.string().min(1).optional(),
        contentText: z.string().min(1),
        retentionDays: z.number().int().positive().max(365).optional(),
        // P1-3 Memory OS: 记忆三层分类
        memoryClass: z.enum(["episodic", "semantic", "procedural"]).optional(),
        // 使用 writeIntent 声明写入意图
        writeIntent: writeIntentSchema,
        sourceRef: z.any().optional(),
        mediaRefs: z.array(mediaRefSchema).max(20).optional(),
      })
      .parse(req.body);

    // 直接使用 writeIntent
    const writeIntent: WriteIntent = body.writeIntent;

    req.ctx.audit!.inputDigest = {
      scope: body.scope,
      type: body.type,
      titleLen: body.title?.length ?? 0,
      contentLen: body.contentText.length,
      retentionDays: body.retentionDays,
      writePolicy: writeIntent?.policy,
    };

    const ownerSubjectId = body.scope === "user" ? subject.subjectId : null;
    const expiresAt = body.retentionDays ? new Date(Date.now() + body.retentionDays * 24 * 60 * 60 * 1000).toISOString() : null;
    const created = await createMemoryEntry({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      ownerSubjectId,
      scope: body.scope,
      type: body.type,
      title: body.title ?? null,
      contentText: body.contentText,
      retentionDays: body.retentionDays ?? null,
      expiresAt,
      writeIntent,
      subjectId: subject.subjectId,
      sourceRef: body.sourceRef ?? { kind: "conversation" },
      mediaRefs: body.mediaRefs,
      memoryClass: body.memoryClass as MemoryClass | undefined,
    });

    req.ctx.audit!.outputDigest = {
      id: created.entry.id,
      scope: created.entry.scope,
      type: created.entry.type,
      dlpSummary: created.dlpSummary,
      writeProof: created.writeProof ? { policy: created.writeProof.policy, provenAt: created.writeProof.provenAt } : null,
      riskEvaluation: created.riskEvaluation,
    };
    return {
      entry: {
        id: created.entry.id, scope: created.entry.scope, type: created.entry.type,
        title: created.entry.title, createdAt: created.entry.createdAt,
        memoryClass: created.entry.memoryClass,
      },
      riskEvaluation: created.riskEvaluation,
      attachments: created.attachments.map((a) => ({ id: a.id, mediaId: a.mediaId, mediaType: a.mediaType, caption: a.caption })),
    };
  });

  app.get("/memory/entries", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const q = z
      .object({
        scope: z.enum(["user", "space", "global"]).optional(),
        type: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(50).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(req.query);

    const entries = await listMemoryEntries({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      scope: q.scope,
      type: q.type,
      limit: q.limit ?? 20,
      offset: q.offset ?? 0,
    });

    // 批量查询附件数量
    const memoryIds = entries.map((e) => e.id);
    const attachMap = await listMemoryAttachmentsBatch({ pool: app.db, tenantId: subject.tenantId, memoryIds });

    req.ctx.audit!.outputDigest = { count: entries.length, scope: q.scope, type: q.type };
    return {
      entries: entries.map((e) => {
        const atts = attachMap.get(e.id) ?? [];
        return {
          id: e.id, scope: e.scope, type: e.type, title: e.title, createdAt: e.createdAt,
          pinned: e.pinned, pinnedAt: e.pinnedAt,
          attachments: atts.map((a) => ({ id: a.id, mediaId: a.mediaId, mediaType: a.mediaType, caption: a.caption })),
        };
      }),
    };
  });

  app.post("/memory/search", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        query: z.string().min(1),
        scope: z.enum(["user", "space", "global"]).optional(),
        types: z.array(z.string().min(1)).optional(),
        limit: z.number().int().positive().max(20).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { queryLen: body.query.length, scope: body.scope, types: body.types?.slice(0, 10), limit: body.limit ?? 5 };
    const r = await searchMemory({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      query: body.query,
      scope: body.scope,
      types: body.types,
      limit: body.limit ?? 5,
    });
    req.ctx.audit!.outputDigest = { candidateCount: r.evidence.length, types: [...new Set(r.evidence.map((e) => e.type))].slice(0, 10) };
    return { evidence: r.evidence, candidateCount: r.evidence.length };
  });

  app.get("/memory/entries/:id", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const entry = await getMemoryEntry({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, id: params.id });
    if (!entry) throw Errors.badRequest("记忆条目不存在");

    const attachments = await listMemoryAttachments({ pool: app.db, tenantId: subject.tenantId, memoryId: entry.id });

    req.ctx.audit!.outputDigest = { id: entry.id, scope: entry.scope, type: entry.type, attachmentCount: attachments.length };
    return {
      entry: { ...entry, pinned: entry.pinned, pinnedAt: entry.pinnedAt, pinnedBy: entry.pinnedBy },
      attachments: attachments.map((a) => ({ id: a.id, mediaId: a.mediaId, mediaType: a.mediaType, caption: a.caption, displayOrder: a.displayOrder })),
    };
  });

  app.put("/memory/entries/:id", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z
      .object({
        title: z.string().min(1).nullable().optional(),
        contentText: z.string().min(1).optional(),
        type: z.string().min(1).optional(),
        mediaRefs: z.array(mediaRefSchema).max(20).optional(),
      })
      .refine((d) => d.title !== undefined || d.contentText || d.type, { message: "至少需要提供一个可编辑字段" })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { id: params.id, hasTitle: body.title !== undefined, hasContent: Boolean(body.contentText), hasType: Boolean(body.type), hasMediaRefs: Boolean(body.mediaRefs?.length) };

    const result = await updateMemoryEntry({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      id: params.id,
      title: body.title,
      contentText: body.contentText,
      type: body.type,
    });

    if (!result) throw Errors.badRequest("记忆条目不存在或无权编辑");

    // 处理附件更新：如果提供了 mediaRefs，先追加新的附件
    let newAttachments: any[] = [];
    if (body.mediaRefs?.length) {
      newAttachments = await insertMemoryAttachments({
        pool: app.db,
        tenantId: subject.tenantId,
        memoryId: params.id,
        mediaRefs: body.mediaRefs,
      });
    }

    req.ctx.audit!.outputDigest = {
      id: result.entry.id,
      scope: result.entry.scope,
      type: result.entry.type,
      dlpSummary: result.dlpSummary,
      riskEvaluation: result.riskEvaluation,
    };
    return {
      entry: { id: result.entry.id, scope: result.entry.scope, type: result.entry.type, title: result.entry.title, updatedAt: result.entry.updatedAt },
      riskEvaluation: result.riskEvaluation,
      newAttachments: newAttachments.map((a: any) => ({ id: a.id, mediaId: a.mediaId, mediaType: a.mediaType, caption: a.caption })),
    };
  });

  app.delete("/memory/entries/:id", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "delete" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "delete" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const ok = await deleteMemoryEntry({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, id: params.id });

    req.ctx.audit!.outputDigest = { id: params.id, deleted: ok };
    return { deleted: ok };
  });

  app.post("/memory/clear", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "clear" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "clear" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z.object({ scope: z.enum(["user", "space", "global"]) }).parse(req.body);
    const count = await clearMemory({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, scope: body.scope });

    req.ctx.audit!.outputDigest = { scope: body.scope, deletedCount: count };
    return { deletedCount: count };
  });

  app.post("/memory/export", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        scope: z.enum(["user", "space", "global"]).optional(),
        types: z.array(z.string().min(1)).max(50).optional(),
        limit: z.number().int().positive().max(5000).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { scope: body.scope, typeCount: body.types?.length ?? 0, limit: body.limit ?? 1000 };
    const out = await exportMemoryEntries({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      scope: body.scope,
      types: body.types,
      limit: body.limit ?? 1000,
    });

    // 批量查询所有导出记忆的附件
    const memoryIds = out.entries.map((e) => e.id);
    const attachMap = await listMemoryAttachmentsBatch({ pool: app.db, tenantId: subject.tenantId, memoryIds });

    req.ctx.audit!.outputDigest = { exportedCount: out.totalCount };
    return {
      exportedCount: out.totalCount,
      entries: out.entries.map((e) => {
        const atts = attachMap.get(e.id) ?? [];
        return {
          id: e.id, scope: e.scope, type: e.type, title: e.title,
          contentText: e.contentText, createdAt: e.createdAt, updatedAt: e.updatedAt,
          attachments: atts.map((a) => ({ id: a.id, mediaId: a.mediaId, mediaType: a.mediaType, caption: a.caption })),
        };
      }),
    };
  });

  app.post("/memory/export-clear", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "clear" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "clear" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const body = z
      .object({
        scope: z.enum(["user", "space", "global"]),
        types: z.array(z.string().min(1)).max(50).optional(),
        limit: z.number().int().positive().max(5000).optional(),
      })
      .parse(req.body);

    req.ctx.audit!.inputDigest = { scope: body.scope, typeCount: body.types?.length ?? 0, limit: body.limit ?? 1000, redacted: true };
    const out = await exportAndClearMemory({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      scope: body.scope,
      types: body.types,
      limit: body.limit ?? 1000,
    });
    req.ctx.audit!.outputDigest = { scope: body.scope, exportedCount: out.entries.length, deletedCount: out.deletedCount, redacted: true };
    return {
      scope: body.scope,
      exportedCount: out.entries.length,
      deletedCount: out.deletedCount,
      entries: out.entries.map((e) => ({ id: e.id, scope: e.scope, type: e.type, title: e.title, contentText: e.contentText, createdAt: e.createdAt })),
    };
  });

  /* ─── List session contexts (conversation history) ─── */
  app.get("/memory/session-contexts", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).parse(req.query);
    req.ctx.audit!.inputDigest = { limit: query.limit ?? 20 };

    const rows = await listSessionContexts({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      limit: query.limit,
    });

    const items = rows.map((r) => toSessionContextListItem({
      sessionId: r.sessionId,
      context: r.context!,
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    req.ctx.audit!.outputDigest = { count: items.length };
    return { sessions: items };
  });

  app.get("/memory/session-contexts/:sessionId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.params);
    req.ctx.audit!.inputDigest = { sessionIdLen: params.sessionId.length };

    const ctx = await getSessionContext({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      sessionId: params.sessionId,
    });

    req.ctx.audit!.outputDigest = { sessionIdLen: params.sessionId.length, found: Boolean(ctx), messageCount: ctx?.context.messages.length ?? 0, expiresAt: ctx?.expiresAt ?? null };
    return { sessionContext: ctx };
  });

  app.put("/memory/session-contexts/:sessionId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.params);
    const body = z
      .object({
        context: z.object({
          v: z.literal(2),
          messages: z
            .array(
              z.object({
                role: z.enum(["user", "assistant", "system"]),
                content: z.string().min(1).max(20_000),
                at: z.string().min(1).optional(),
              }),
            )
            .max(200),
          summary: z.string().optional(),
          totalTurnCount: z.number().int().nonnegative().optional(),
          sessionState: z.object({
            activeTopic: z.string().optional(),
            userIntent: z.string().optional(),
            entitiesInFocus: z.array(z.string()).optional(),
            constraints: z.array(z.string()).optional(),
            pendingQuestions: z.array(z.string()).optional(),
            riskPoints: z.array(z.string()).optional(),
            lastUpdatedAt: z.string().optional(),
          }).optional(),
        }),
        expiresAt: z.string().min(1).optional(),
        retentionDays: z.number().int().positive().max(365).optional(),
      })
      .parse(req.body);

    let expiresAt: string | null = null;
    if (body.expiresAt) {
      const ms = Date.parse(body.expiresAt);
      if (!Number.isFinite(ms)) throw Errors.badRequest("expiresAt 非法");
      expiresAt = new Date(ms).toISOString();
    } else if (body.retentionDays) {
      expiresAt = new Date(Date.now() + body.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const messageCount = body.context.messages.length;
    const totalChars = body.context.messages.reduce((acc, m) => acc + m.content.length, 0);
    req.ctx.audit!.inputDigest = { sessionIdLen: params.sessionId.length, messageCount, totalChars, expiresAt, retentionDays: body.retentionDays ?? null, expiresAtProvided: Boolean(body.expiresAt) };

    const row = await upsertSessionContext({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      sessionId: params.sessionId,
      context: body.context,
      expiresAt,
    });

    req.ctx.audit!.outputDigest = { sessionIdLen: params.sessionId.length, updatedAt: row.updatedAt, expiresAt: row.expiresAt ?? null };
    return { sessionContext: { sessionId: row.sessionId, expiresAt: row.expiresAt ?? null, updatedAt: row.updatedAt } };
  });

  app.delete("/memory/session-contexts/:sessionId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "delete" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "delete" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ sessionId: z.string().min(1).max(200) }).parse(req.params);
    req.ctx.audit!.inputDigest = { sessionIdLen: params.sessionId.length };

    const cleared = await clearSessionContext({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      sessionId: params.sessionId,
    });

    req.ctx.audit!.outputDigest = { sessionIdLen: params.sessionId.length, cleared };
    return { cleared };
  });

  app.put("/memory/task-states/:runId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "task_state" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "task_state" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ runId: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        stepId: z.string().uuid().optional(),
        phase: z.string().min(1),
        plan: z.any().optional(),
        artifactsDigest: z.any().optional(),
      })
      .parse(req.body);

    const r = await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      stepId: body.stepId ?? null,
      phase: body.phase,
      plan: body.plan,
      artifactsDigest: body.artifactsDigest,
    });

    req.ctx.audit!.outputDigest = { runId: params.runId, phase: r.taskState.phase, dlpSummary: r.dlpSummary };
    return { taskState: r.taskState };
  });

  app.get("/memory/task-states/:runId", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ runId: z.string().uuid() }).parse(req.params);
    const ts = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: params.runId });
    return { taskState: ts };
  });

  /* ─── P1-3 Memory OS: 冲突仲裁触发端点 ─── */
  app.post("/memory/entries/:id/arbitrate", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const routeParams = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      strategy: z.enum(["time_priority", "confidence_priority", "auto_merged", "user_confirmed"]).optional(),
    }).parse(req.body);

    // 获取记忆详情
    const entry = await getMemoryEntry({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, subjectId: subject.subjectId, id: routeParams.id });
    if (!entry) throw Errors.badRequest("记忆条目不存在");

    // 检测冲突
    const conflicts = await detectMemoryConflicts({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      type: entry.type,
      contentText: entry.contentText,
      title: entry.title,
    });

    if (!conflicts.hasConflicts) {
      return { arbitration: null, message: "未检测到冲突" };
    }

    // 执行仲裁
    const result = await arbitrateMemoryConflict({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      newMemory: entry,
      conflictMemories: conflicts.conflicts.map(c => ({
        id: c.id, confidence: 0.5, createdAt: "", contentText: c.snippet, title: c.title,
      })),
      strategy: body.strategy as any,
      arbitratedBy: subject.subjectId,
    });

    req.ctx.audit!.outputDigest = { strategy: result.strategy, winner: result.winnerMemoryId, merged: result.mergedMemoryId };
    return { arbitration: result };
  });

  /* ─── P1-3 Memory OS: 记忆状态统计端点 ─── */
  app.get("/memory/stats", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "read" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "read" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const statsRes = await app.db.query(
      `SELECT
        memory_class,
        COUNT(*) AS count,
        AVG(decay_score) AS avg_decay,
        COUNT(*) FILTER (WHERE distilled_to IS NOT NULL) AS distilled_count,
        COUNT(*) FILTER (WHERE conflict_marker IS NOT NULL AND resolution_status = 'pending') AS pending_conflicts
       FROM memory_entries
       WHERE tenant_id = $1 AND space_id = $2 AND deleted_at IS NULL
       GROUP BY memory_class
       ORDER BY memory_class`,
      [subject.tenantId, subject.spaceId],
    );

    const stats = (statsRes.rows as any[]).map(r => ({
      memoryClass: r.memory_class,
      count: Number(r.count),
      avgDecayScore: Number(Number(r.avg_decay).toFixed(3)),
      distilledCount: Number(r.distilled_count),
      pendingConflicts: Number(r.pending_conflicts),
    }));

    req.ctx.audit!.outputDigest = { classCount: stats.length };
    return { stats };
  });

  /* ─── P1-记忆用户侧管理：置顶/保护标记 ─── */
  app.post("/memory/entries/:id/pin", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const ok = await pinMemoryEntry({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      id: params.id,
    });

    if (!ok) throw Errors.badRequest("记忆条目不存在或无权操作");
    req.ctx.audit!.outputDigest = { id: params.id, pinned: true };
    return { pinned: true };
  });

  app.post("/memory/entries/:id/unpin", async (req) => {
    setAuditContext(req, { resourceType: "memory", action: "write" });
    const decision = await requirePermission({ req, resourceType: "memory", action: "write" });
    req.ctx.audit!.policyDecision = decision;

    const subject = requireSubject(req);
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const ok = await unpinMemoryEntry({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      id: params.id,
    });

    if (!ok) throw Errors.badRequest("记忆条目不存在或无权操作");
    req.ctx.audit!.outputDigest = { id: params.id, pinned: false };
    return { pinned: false };
  });
};
