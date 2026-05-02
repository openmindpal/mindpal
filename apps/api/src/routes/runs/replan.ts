/**
 * runs/replan.ts — 动态重规划 API（runtimeStepManager）
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { insertAuditEvent } from "../../modules/audit/auditRepo";
import { requirePermission } from "../../modules/auth/guard";
import { PERM } from "@mindpal/shared";
import { getRunForSpace } from "../../modules/workflow/jobRepo";
import { insertStep, appendStep, removeStep, replanFromCurrent, getEditableSteps, type RuntimeStep } from "../../kernel/runtimeStepManager";

export const runsReplanRoutes: FastifyPluginAsync = async (app) => {
  /** 获取可编辑的步骤列表（pending 状态） */
  app.get("/runs/:runId/steps/editable", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "read" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_READ });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    const steps = await getEditableSteps({ pool: app.db, runId: params.runId });
    req.ctx.audit!.outputDigest = { count: steps.length };
    return { steps };
  });

  /** 在指定位置插入新步骤 */
  app.post("/runs/:runId/steps/insert", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "step.insert" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_STEP_INSERT });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    const body = z.object({
      toolRef: z.string().min(1),
      inputDraft: z.record(z.string(), z.unknown()).optional(),
      actorRole: z.string().optional(),
      approvalRequired: z.boolean().optional(),
      dependsOn: z.array(z.string()).optional(),
      anchorStepId: z.string().uuid().optional(),
      position: z.enum(["before", "after", "append"]).optional(),
      reason: z.string().max(200).optional(),
    }).parse(req.body);

    const result = await insertStep({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      step: {
        toolRef: body.toolRef,
        inputDraft: body.inputDraft ?? {},
        actorRole: body.actorRole ?? "executor",
        approvalRequired: body.approvalRequired ?? false,
        dependsOn: body.dependsOn ?? [],
        kind: "tool",
      },
      anchorStepId: body.anchorStepId,
      position: body.position ?? "append",
      reason: body.reason,
      traceId: req.ctx.traceId,
    });

    if (!result.ok) throw Errors.badRequest(result.message);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "step.inserted",
      policyDecision: decision,
      inputDigest: { runId: params.runId, toolRef: body.toolRef, position: body.position ?? "append" },
      outputDigest: { stepId: result.stepId, seq: result.seq },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: params.runId,
      stepId: result.stepId,
    });

    req.ctx.audit!.outputDigest = { stepId: result.stepId, seq: result.seq };
    return result;
  });

  /** 移除 pending 状态的步骤 */
  app.post("/runs/:runId/steps/:stepId/remove", async (req) => {
    const params = z.object({ runId: z.string().min(3), stepId: z.string().uuid() }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "step.remove" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_STEP_REMOVE });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});

    const result = await removeStep({
      pool: app.db,
      tenantId: subject.tenantId,
      runId: params.runId,
      stepId: params.stepId,
      reason: body.reason,
    });

    if (!result.ok) throw Errors.badRequest(result.message);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "step.removed",
      policyDecision: decision,
      inputDigest: { runId: params.runId, stepId: params.stepId, reason: body.reason },
      outputDigest: { ok: true },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: params.runId,
      stepId: params.stepId,
    });

    req.ctx.audit!.outputDigest = result;
    return result;
  });

  /** 从当前位置重新规划 */
  app.post("/runs/:runId/replan", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "replan" });
    const decision = await requirePermission({ req, ...PERM.WORKFLOW_REPLAN });
    req.ctx.audit!.policyDecision = decision;

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!run) throw Errors.badRequest("Run 不存在");

    const body = z.object({
      currentCursor: z.number().int().min(0),
      newSteps: z.array(z.object({
        toolRef: z.string().min(1),
        inputDraft: z.record(z.string(), z.unknown()).optional(),
        actorRole: z.string().optional(),
        approvalRequired: z.boolean().optional(),
        dependsOn: z.array(z.string()).optional(),
      })).min(1).max(20),
      keepPendingSteps: z.boolean().optional(),
      reason: z.string().max(200).optional(),
    }).parse(req.body);

    const result = await replanFromCurrent({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId: params.runId,
      currentCursor: body.currentCursor,
      newSteps: body.newSteps.map(s => ({
        toolRef: s.toolRef,
        inputDraft: s.inputDraft ?? {},
        actorRole: s.actorRole ?? "executor",
        approvalRequired: s.approvalRequired ?? false,
        dependsOn: s.dependsOn ?? [],
        kind: "tool" as const,
      })),
      keepPendingSteps: body.keepPendingSteps,
      reason: body.reason,
      traceId: req.ctx.traceId,
    });

    if (!result.ok) throw Errors.badRequest(result.message);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "run.replanned",
      policyDecision: decision,
      inputDigest: { runId: params.runId, cursor: body.currentCursor, newStepCount: body.newSteps.length },
      outputDigest: { insertedCount: result.insertedCount, removedCount: result.removedCount, newStepIds: result.newStepIds },
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: params.runId,
    });

    req.ctx.audit!.outputDigest = result;
    return result;
  });
};
