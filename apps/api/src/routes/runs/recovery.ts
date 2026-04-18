/**
 * runs/recovery.ts — 取消/重试/暂停/恢复/跳过 路由
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { insertAuditEvent } from "../../modules/audit/auditRepo";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@openslin/shared";
import { cancelRun, getRunForSpace, listSteps } from "../../modules/workflow/jobRepo";
import { pauseRun, resumeRun, retryFailedStep as retryFailedRunStep, type RecoveryContext } from "../../kernel/runRecovery";
import { getTaskState, upsertTaskState } from "../../modules/memory/repo";
import { buildClosedLoopSummaryV1 } from "../../skills/orchestrator/closedLoopUtils";

export const runsRecoveryRoutes: FastifyPluginAsync = async (app) => {
  app.post("/runs/:runId/cancel", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "cancel" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_CANCEL });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const existing = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!existing) throw Errors.badRequest("Run 不存在");
    if (["succeeded", "failed", "canceled", "compensated"].includes(existing.status)) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.runNotCancelable();
    }
    const run = await cancelRun({ pool: app.db, tenantId: subject.tenantId, runId: params.runId });
    if (!run) throw Errors.badRequest("Run 不存在");
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      phase: "canceled",
      clearBlockReason: true,
      clearNextAction: true,
      clearApprovalStatus: true,
    });
    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.canceled",
      policyDecision: decision,
      outputDigest: { runId: run.runId, status: run.status },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
    });
    req.ctx.audit!.outputDigest = { runId: run.runId, status: run.status };
    return { run };
  });

  app.post("/runs/:runId/retry", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "retry" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_RETRY });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");
    if (run.status !== "failed") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Run 不在 failed 状态");
    }

    const result = await retryFailedRunStep({
      pool: app.db,
      queue: app.queue,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: run.runId,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
    });
    if (!result.ok || !result.stepId || !result.jobId) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest(result.message);
    }

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.retry",
      policyDecision: decision,
      inputDigest: { runId: run.runId, stepId: result.stepId },
      outputDigest: { jobId: result.jobId, status: "queued" },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
      stepId: result.stepId,
    });
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: result.stepId }, status: "queued" as const };
    req.ctx.audit!.outputDigest = receipt;
    return { receipt };
  });

  /* P1-1.2: 暂停运行 */
  app.post("/runs/:runId/pause", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "pause" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_PAUSE });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});

    const ctx: RecoveryContext = {
      pool: app.db,
      queue: app.queue,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
      reason: body.reason,
    };

    const result = await pauseRun(ctx);
    if (!result.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest(result.message);
    }

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.paused",
      policyDecision: decision,
      inputDigest: { runId: params.runId, reason: body.reason },
      outputDigest: { previousStatus: result.previousStatus, newStatus: result.newStatus },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: params.runId,
    });

    req.ctx.audit!.outputDigest = { runId: params.runId, status: result.newStatus };
    return { runId: params.runId, status: result.newStatus, message: result.message };
  });

  /* P1-1.2: 恢复运行 */
  app.post("/runs/:runId/resume", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "resume" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_RESUME });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});

    const ctx: RecoveryContext = {
      pool: app.db,
      queue: app.queue,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      subjectId: subject.subjectId,
      traceId: req.ctx.traceId,
      reason: body.reason,
    };

    const result = await resumeRun(ctx);
    if (!result.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest(result.message);
    }

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.resumed",
      policyDecision: decision,
      inputDigest: { runId: params.runId, reason: body.reason },
      outputDigest: { previousStatus: result.previousStatus, newStatus: result.newStatus, stepId: result.stepId },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: params.runId,
      stepId: result.stepId,
    });

    req.ctx.audit!.outputDigest = { runId: params.runId, status: result.newStatus, stepId: result.stepId };
    return { runId: params.runId, status: result.newStatus, message: result.message, stepId: result.stepId };
  });

  app.post("/runs/:runId/skip", async (req, reply) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "skip" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_RESUME });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    await requirePermission({ req, ...PERM.MEMORY_TASK_STATE });
    const state = await getTaskState({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, runId: params.runId });
    if (!state?.plan) {
      req.ctx.audit!.errorCategory = "policy_violation";
      return reply.status(404).send({ errorCode: "NOT_FOUND", message: { "zh-CN": "TaskState 不存在", "en-US": "TaskState not found" }, traceId: req.ctx.traceId });
    }

    const plan: any = state.plan;
    const stepsPlan: any[] = Array.isArray(plan.steps) ? plan.steps : [];
    const limits = plan.limits && typeof plan.limits === "object" ? plan.limits : {};
    const maxSteps = typeof limits.maxSteps === "number" ? limits.maxSteps : 3;
    const maxWallTimeMs = typeof limits.maxWallTimeMs === "number" ? limits.maxWallTimeMs : 5 * 60 * 1000;
    const artifacts: any = state.artifactsDigest && typeof state.artifactsDigest === "object" ? state.artifactsDigest : {};
    const cursor = typeof artifacts.cursor === "number" && Number.isFinite(artifacts.cursor) ? Math.max(0, Math.floor(artifacts.cursor)) : 0;
    const nextCursor = Math.min(cursor + 1, Math.min(maxSteps, stepsPlan.length));
    const steps = await listSteps(app.db, params.runId);
    const runStatusRes = await app.db.query("SELECT status FROM runs WHERE tenant_id = $1 AND run_id = $2 LIMIT 1", [subject.tenantId, params.runId]);
    const runStatus = runStatusRes.rowCount ? String((runStatusRes.rows[0] as any).status ?? "") : null;
    const closedLoop = buildClosedLoopSummaryV1({ plan, steps, cursor: nextCursor, maxSteps, maxWallTimeMs, runStatus });
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      phase: closedLoop.phase,
      plan,
      artifactsDigest: { ...artifacts, cursor: nextCursor, maxWallTimeMs, maxSteps, closedLoop },
    });

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.skip",
      policyDecision: decision,
      inputDigest: { runId: params.runId, fromCursor: cursor },
      outputDigest: { runId: params.runId, toCursor: nextCursor, phase: closedLoop.phase, nextAction: closedLoop.executionSummary.nextAction },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: params.runId,
    });

    req.ctx.audit!.outputDigest = { runId: params.runId, fromCursor: cursor, toCursor: nextCursor, phase: closedLoop.phase };
    return { runId: params.runId, phase: closedLoop.phase, cursor: nextCursor, nextAction: closedLoop.executionSummary.nextAction, closedLoop };
  });
};
