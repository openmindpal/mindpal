import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Errors } from "../lib/errors";
import { setAuditContext } from "../modules/audit/context";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { enqueueAuditOutboxForRequest } from "../modules/audit/requestOutbox";
import { requirePermission } from "../modules/auth/guard";
import { upsertTaskState } from "../modules/memory/repo";
import { getRunForSpace, listSteps } from "../modules/workflow/jobRepo";
import { addDecision, getApproval, listApprovals, getApprovalSigningKey, computeInputSignature } from "../modules/workflow/approvalRepo";
import { enqueueWorkflowStep } from "../modules/workflow/queue";


function verifyInputSignature(inputDigest: unknown, signature: string, secretKey: string): boolean {
  const expected = computeInputSignature(inputDigest, secretKey);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function resolveApprovalStep(pool: Pool, runId: string, stepId: string | null) {
  if (stepId) {
    const r = await pool.query("SELECT step_id, tool_ref, policy_snapshot_ref, input_digest, input FROM steps WHERE step_id = $1 LIMIT 1", [stepId]);
    if (r.rowCount) return r.rows[0] as any;
  }
  const r = await pool.query("SELECT step_id, tool_ref, policy_snapshot_ref, input_digest, input FROM steps WHERE run_id = $1 ORDER BY seq ASC LIMIT 1", [runId]);
  return r.rowCount ? (r.rows[0] as any) : null;
}

async function assertApprovalBindingOk(pool: Pool, tenantId: string, approvalId: string, runId: string, stepId: string | null) {
  const s = await resolveApprovalStep(pool, runId, stepId);
  if (!s) return { ok: false as const, reason: "step_missing" as const };
  const bindingOk = await pool.query(
    `
      SELECT 1
      FROM approvals a
      WHERE a.tenant_id = $1
        AND a.approval_id = $2
        AND a.run_id = $3
        AND a.tool_ref IS NOT DISTINCT FROM $4
        AND a.policy_snapshot_ref IS NOT DISTINCT FROM $5
        AND a.input_digest IS NOT DISTINCT FROM $6
      LIMIT 1
    `,
    [tenantId, approvalId, runId, s.tool_ref ?? null, s.policy_snapshot_ref ?? null, s.input_digest ?? null],
  );
  return { ok: Boolean(bindingOk.rowCount) as true | false, step: s };
}

export const approvalRoutes: FastifyPluginAsync = async (app) => {
  app.get("/approvals", async (req) => {
    setAuditContext(req, { resourceType: "workflow", action: "approval.list" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workflow", action: "approve" });
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const q = z.object({ status: z.string().optional(), limit: z.coerce.number().int().positive().max(200).optional() }).parse(req.query);
    const items = await listApprovals({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId, status: q.status, limit: q.limit ?? 50 });
    req.ctx.audit!.outputDigest = { count: items.length, status: q.status ?? null };
    return { items };
  });

  app.get("/approvals/:approvalId", async (req) => {
    const params = z.object({ approvalId: z.string().min(10) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "approval.get" });
    req.ctx.audit!.policyDecision = await requirePermission({ req, resourceType: "workflow", action: "approve" });
    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const approval = await getApproval({ pool: app.db, tenantId: subject.tenantId, approvalId: params.approvalId });
    if (!approval) throw Errors.badRequest("Approval 不存在");
    if (approval.spaceId && approval.spaceId !== subject.spaceId) throw Errors.badRequest("Approval 不存在");
    const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, approval.runId);
    if (!run) throw Errors.badRequest("Run 不存在");
    const steps = await listSteps(app.db, run.runId);
    req.ctx.audit!.outputDigest = { approvalId: approval.approvalId, runId: run.runId, status: approval.status, stepCount: steps.length };
    return { approval, run, steps };
  });

  app.post("/approvals/:approvalId/decisions", async (req, reply) => {
    const params = z.object({ approvalId: z.string().min(10) }).parse(req.params);
    const body = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().max(500).optional() }).parse(req.body);
    setAuditContext(req, { resourceType: "workflow", action: "approval.decided", requireOutbox: true });

    req.ctx.audit!.policyDecision = await requirePermission({
      req,
      resourceType: "workflow",
      action: body.decision === "approve" ? "approve" : "reject",
    });

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");
    const existing = await getApproval({ pool: app.db, tenantId: subject.tenantId, approvalId: params.approvalId });
    if (!existing) throw Errors.badRequest("Approval 不存在");
    if (existing.spaceId && existing.spaceId !== subject.spaceId) throw Errors.badRequest("Approval 不存在");
    if (existing.status !== "pending") {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("Approval 不在 pending 状态");
    }

    // ── 元数据驱动：审批人角色验证（角色列表来自规则引擎 effect.approverRoles）──
    const requiredApproverRoles: string[] =
      Array.isArray(existing.assessmentContext?.approverRoles)
        ? existing.assessmentContext.approverRoles
        : [];
    if (requiredApproverRoles.length > 0) {
      const roleRes = await app.db.query(
        `SELECT r.name FROM role_bindings rb
         JOIN roles r ON r.id = rb.role_id
         WHERE rb.subject_id = $1 AND r.tenant_id = $2`,
        [subject.subjectId, subject.tenantId],
      );
      const subjectRoleNames = new Set(roleRes.rows.map((r: any) => String(r.name)));
      if (!requiredApproverRoles.some((r: string) => subjectRoleNames.has(r))) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.forbidden(
          `审批需要角色 [${requiredApproverRoles.join(", ")}]，当前用户不匹配`
        );
      }
    }

    if (body.decision === "approve") {
      const run = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, existing.runId);
      if (!run) throw Errors.badRequest("Run 不存在");
      if (run.status !== "needs_approval") {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.badRequest("Run 不在 needs_approval 状态");
      }

      const binding = await assertApprovalBindingOk(app.db, subject.tenantId, existing.approvalId, existing.runId, existing.stepId ?? null);
      if (!binding.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        await insertAuditEvent(app.db, {
          subjectId: subject.subjectId,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          resourceType: "approval",
          action: "approval:binding_mismatch",
          policyDecision: req.ctx.audit!.policyDecision,
          inputDigest: { approvalId: existing.approvalId, runId: existing.runId },
          outputDigest: { status: "rejected", reason: "binding_mismatch" },
          result: "error",
          traceId: req.ctx.traceId,
          requestId: req.ctx.requestId,
          runId: existing.runId,
          stepId: existing.stepId ?? undefined,
        });
        req.ctx.audit!.outputDigest = { decision: "approve", status: "rejected", reason: "binding_mismatch" };
        return reply.status(409).send({
          errorCode: "APPROVAL_BINDING_MISMATCH",
          message: { "zh-CN": "审批绑定内容与待执行步骤不一致", "en-US": "Approval binding mismatch" },
          traceId: req.ctx.traceId,
          requestId: req.ctx.requestId,
        });
      }

      // --- HMAC Binding 验证 ---
      if (existing.inputSignature) {
        const signingKey = getApprovalSigningKey();
        if (!verifyInputSignature(existing.inputDigest, existing.inputSignature, signingKey)) {
          await insertAuditEvent(app.db, {
            subjectId: subject.subjectId,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            resourceType: "approval",
            action: "approval:binding_tampered",
            policyDecision: req.ctx.audit!.policyDecision,
            inputDigest: { approvalId: existing.approvalId, runId: existing.runId },
            outputDigest: { status: "rejected", reason: "binding_tampered" },
            result: "error",
            traceId: req.ctx.traceId,
            requestId: req.ctx.requestId,
            runId: existing.runId,
            stepId: existing.stepId ?? undefined,
          });
          req.ctx.audit!.errorCategory = "policy_violation";
          return reply.status(403).send({
            error: "approval_binding_tampered",
            message: "Input digest signature verification failed",
          });
        }
      }

      const stepInput = binding.step?.input as any;
      if (stepInput?.toolContract?.scope === "write" && !stepInput?.idempotencyKey) {
        req.ctx.audit!.errorCategory = "policy_violation";
        throw Errors.badRequest("缺少 idempotency-key");
      }
    }

    const client = await app.db.connect();
    let committed = false;
    let deferredEnqueue: { jobId: string; runId: string; stepId: string } | null = null;
    let deferredResponse: { approval: any; decision: any; receipt: any } | null = null;
    try {
      await client.query("BEGIN");
      const decided = await addDecision({
        pool: client,
        tenantId: subject.tenantId,
        approvalId: params.approvalId,
        decision: body.decision,
        reason: body.reason ?? null,
        decidedBySubjectId: subject.subjectId,
      });
      if (!decided) throw Errors.badRequest("Approval 不存在");
      if (!decided.ok) {
        req.ctx.audit!.errorCategory = "policy_violation";
        if ("reason" in decided && decided.reason === "duplicate_approver") {
          throw Errors.badRequest("双人审批需要不同审批人");
        }
        throw Errors.badRequest("Approval 不在 pending 状态");
      }

      if (body.decision === "approve") {
        if (!decided.finalized) {
          await upsertTaskState({
            pool: client as any,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            runId: existing.runId,
            phase: "needs_approval",
            approvalStatus: "pending",
          });
          const receipt = {
            correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, approvalId: decided.approval.approvalId, runId: existing.runId },
            status: "awaiting_additional_approval" as const,
            approvalsCollected: decided.approvalsCollected,
            approvalsRemaining: decided.approvalsRemaining,
            requiredApprovals: decided.requiredApprovals,
          };
          req.ctx.audit!.outputDigest = { decision: "approve", receipt };
          await enqueueAuditOutboxForRequest({ client, req, deferSkip: true });
          await client.query("COMMIT");
          req.ctx.audit!.skipAuditWrite = true;
          return { approval: decided.approval, decision: decided.decision, receipt };
        }

        const run = await getRunForSpace(client as any, subject.tenantId, subject.spaceId, existing.runId);
        if (!run) throw Errors.badRequest("Run 不存在");

        const jobRes = await client.query("SELECT job_id FROM jobs WHERE tenant_id = $1 AND run_id = $2 ORDER BY created_at DESC LIMIT 1", [subject.tenantId, run.runId]);
        if (!jobRes.rowCount) throw Errors.badRequest("Job 不存在");
        const jobId = jobRes.rows[0].job_id as string;
        const step = await resolveApprovalStep(client as any, run.runId, existing.stepId ?? null);
        if (!step) throw Errors.badRequest("Step 不存在");
        const stepId = step.step_id as string;

        await client.query("UPDATE runs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
        await client.query("UPDATE jobs SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, jobId]);
        await client.query(
          "UPDATE steps SET status = 'pending', updated_at = now(), finished_at = NULL, deadlettered_at = NULL, queue_job_id = NULL WHERE step_id = $1",
          [stepId],
        );
        const stepInput2 = step.input as any;
        if (stepInput2?.collabRunId) {
          await client.query("UPDATE collab_runs SET status = 'executing', updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2", [
            subject.tenantId,
            String(stepInput2.collabRunId),
          ]);
        }

        const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, approvalId: decided.approval.approvalId, runId: run.runId, stepId }, status: "queued" as const };
        req.ctx.audit!.outputDigest = { decision: "approve", receipt };
        await enqueueAuditOutboxForRequest({ client, req, deferSkip: true });
        await upsertTaskState({
          pool: client as any,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId: run.runId,
          stepId,
          phase: "queued",
          approvalStatus: "approved",
          clearBlockReason: true,
          clearNextAction: true,
        });
        await client.query("COMMIT");
        committed = true;
        deferredEnqueue = { jobId, runId: run.runId, stepId };
        deferredResponse = { approval: decided.approval, decision: decided.decision, receipt };
      }

      if (!deferredResponse) {
        await client.query("UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE tenant_id = $1 AND run_id = $2", [
        subject.tenantId,
        existing.runId,
        ]);
        await client.query("UPDATE steps SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status IN ('pending','running')", [
        existing.runId,
        ]);
        await client.query("UPDATE jobs SET status = 'canceled', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, existing.runId]);

        const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, approvalId: decided.approval.approvalId, runId: existing.runId }, status: "canceled" as const };
        req.ctx.audit!.outputDigest = { decision: "reject", receipt };
        await enqueueAuditOutboxForRequest({ client, req, deferSkip: true });
        await upsertTaskState({
          pool: client as any,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId: existing.runId,
          phase: "canceled",
          approvalStatus: "rejected",
          clearBlockReason: true,
          clearNextAction: true,
        });
        await client.query("COMMIT");
        committed = true;
        req.ctx.audit!.skipAuditWrite = true;
        return { approval: decided.approval, decision: decided.decision, receipt };
      }
    } catch (e) {
      if (!committed) {
        try {
          await client.query("ROLLBACK");
        } catch {
        }
      }
      throw e;
    } finally {
      client.release();
    }

    if (deferredEnqueue && deferredResponse) {
      try {
        await enqueueWorkflowStep({
          queue: app.queue,
          pool: app.db,
          jobId: deferredEnqueue.jobId,
          runId: deferredEnqueue.runId,
          stepId: deferredEnqueue.stepId,
          tenantId: subject.tenantId,
        });
      } catch (enqueueErr) {
        await app.db.query(
          "UPDATE runs SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND run_id = $2 AND status = 'queued'",
          [subject.tenantId, deferredEnqueue.runId],
        ).catch(() => undefined);
        await app.db.query(
          "UPDATE jobs SET status = 'failed', updated_at = now() WHERE tenant_id = $1 AND job_id = $2 AND status = 'queued'",
          [subject.tenantId, deferredEnqueue.jobId],
        ).catch(() => undefined);
        await app.db.query(
          `UPDATE steps
           SET status = 'failed',
               updated_at = now(),
               finished_at = now(),
               error_category = 'queue_error',
               last_error = $2,
               queue_job_id = NULL
           WHERE step_id = $1 AND status = 'pending'`,
          [deferredEnqueue.stepId, enqueueErr instanceof Error ? enqueueErr.message : "workflow_enqueue_failed"],
        ).catch(() => undefined);
        await upsertTaskState({
          pool: app.db,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          runId: deferredEnqueue.runId,
          stepId: deferredEnqueue.stepId,
          phase: "failed",
          blockReason: "workflow_enqueue_failed_after_approval",
          nextAction: "retry_run",
          approvalStatus: "approved",
        }).catch(() => undefined);
        try {
          await insertAuditEvent(app.db, {
            subjectId: subject.subjectId,
            tenantId: subject.tenantId,
            spaceId: subject.spaceId,
            resourceType: "workflow",
            action: "run.enqueue_failed",
            inputDigest: { approvalId: deferredResponse.approval.approvalId, runId: deferredEnqueue.runId, stepId: deferredEnqueue.stepId },
            outputDigest: { jobId: deferredEnqueue.jobId, status: "failed", reason: "queue_enqueue_failed" },
            result: "error",
            traceId: req.ctx.traceId,
            requestId: req.ctx.requestId,
            runId: deferredEnqueue.runId,
            stepId: deferredEnqueue.stepId,
          });
        } catch {
        }
        req.ctx.audit!.errorCategory = "infra";
        throw Errors.serviceNotReady("工作流队列暂不可用");
      }

      try {
        await insertAuditEvent(app.db, {
          subjectId: subject.subjectId,
          tenantId: subject.tenantId,
          spaceId: subject.spaceId,
          resourceType: "workflow",
          action: "run.enqueued",
          inputDigest: { approvalId: deferredResponse.approval.approvalId, runId: deferredEnqueue.runId, stepId: deferredEnqueue.stepId },
          outputDigest: { jobId: deferredEnqueue.jobId, status: "queued" },
          result: "success",
          traceId: req.ctx.traceId,
          requestId: req.ctx.requestId,
          runId: deferredEnqueue.runId,
          stepId: deferredEnqueue.stepId,
        });
      } catch {
      }

      req.ctx.audit!.skipAuditWrite = true;
      return deferredResponse;
    }
  });
};
