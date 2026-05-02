/**
 * runs/execution.ts — 重新执行 路由
 */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import type { CapabilityEnvelopeV1 } from "@mindpal/shared";
import { checkCapabilityEnvelopeNotExceedV1, normalizeNetworkPolicy, normalizeLimits, validateCapabilityEnvelopeV1 } from "@mindpal/shared";

import { Errors } from "../../lib/errors";
import { setAuditContext } from "../../modules/audit/context";
import { insertAuditEvent } from "../../modules/audit/auditRepo";
import { requirePermission } from "../../modules/auth/guard";
import { authorizeToolExecution } from "../../kernel/loopPermissionUnified";
import { getToolDefinition } from "../../modules/tools/toolRepo";
import { getEffectiveToolNetworkPolicy } from "../../modules/governance/toolNetworkPolicyRepo";
import { createApproval } from "../../modules/workflow/approvalRepo";
import { assessToolExecutionRisk } from "../../kernel/approvalRuleEngine";
import { decryptSecretPayload } from "../../modules/secrets/envelope";
import { cancelRun, createJobRunStep, getRunForSpace } from "../../modules/workflow/jobRepo";

export const runsExecutionRoutes: FastifyPluginAsync = async (app) => {
  app.post("/runs/:runId/reexec", async (req) => {
    const params = z.object({ runId: z.string().min(3) }).parse(req.params);
    setAuditContext(req, { resourceType: "workflow", action: "run.reexec" });

    const subject = req.ctx.subject!;
    if (!subject.spaceId) throw Errors.badRequest("缺少 spaceId");

    const visible = await getRunForSpace(app.db, subject.tenantId, subject.spaceId, params.runId);
    if (!visible) throw Errors.badRequest("Run 不存在");

    const s0 = await app.db.query(
      `
        SELECT s.input, s.tool_ref
        FROM steps s
        WHERE s.run_id = $1 AND s.seq = 1
        LIMIT 1
      `,
      [visible.runId],
    );
    if (!s0.rowCount) throw Errors.badRequest("Step 不存在");
    let stepInput = s0.rows[0].input as any;
    const enc = await app.db.query(
      "SELECT input_enc_format, input_key_version, input_encrypted_payload FROM steps WHERE run_id = $1 AND seq = 1 LIMIT 1",
      [visible.runId],
    );
    if (enc.rowCount) {
      const encFormat = enc.rows[0].input_enc_format as string | null;
      const keyVersion = enc.rows[0].input_key_version as number | null;
      const encryptedPayload = enc.rows[0].input_encrypted_payload as any;
      const spaceId = stepInput?.spaceId ?? null;
      if (encFormat && keyVersion && encryptedPayload && spaceId) {
        stepInput = await decryptSecretPayload({
          pool: app.db,
          tenantId: subject.tenantId,
          masterKey: app.cfg.secrets.masterKey,
          scopeType: "space",
          scopeId: String(spaceId),
          keyVersion: Number(keyVersion),
          encFormat,
          encryptedPayload,
        });
      }
    }
    const toolRef = (s0.rows[0].tool_ref as string | null) ?? (stepInput?.toolRef as string | undefined) ?? null;
    if (!toolRef) throw Errors.badRequest("缺少 toolRef");

    const toolName = toolRef.split("@")[0] ?? "";
    const def = await getToolDefinition(app.db, subject.tenantId, toolName);
    const scope = stepInput?.toolContract?.scope ?? def?.scope ?? null;
    const resourceType = stepInput?.toolContract?.resourceType ?? def?.resourceType ?? null;
    const action = stepInput?.toolContract?.action ?? def?.action ?? null;
    const idempotencyRequired = stepInput?.toolContract?.idempotencyRequired ?? def?.idempotencyRequired ?? null;
    if (!scope || !resourceType || !action || idempotencyRequired === null) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.badRequest("工具契约缺失");
    }

    // 使用统一权限入口替代单独的 requirePermission 调用
    const authResult = await authorizeToolExecution({
      pool: app.db,
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId!,
      traceId: req.ctx.traceId ?? null,
      runId: params.runId,
      jobId: "",
      resourceType,
      action,
      toolRef,
    });
    if (!authResult.authorized) {
      req.ctx.audit!.errorCategory = "policy_violation";
      throw Errors.forbidden(authResult.errorMessage);
    }
    const decision = authResult.opDecision ?? { decision: "allow" };
    req.ctx.audit!.policyDecision = decision;

    const effPol = await getEffectiveToolNetworkPolicy({ pool: app.db, tenantId: subject.tenantId, spaceId: subject.spaceId ?? undefined, toolRef });
    const effAllowedDomains = effPol?.allowedDomains ?? [];
    const effRules = (effPol as any)?.rules ?? [];
    const effNetworkPolicy = Array.isArray(effRules) && effRules.length ? { allowedDomains: effAllowedDomains, rules: effRules } : { allowedDomains: effAllowedDomains };

    const cap = stepInput?.capabilityEnvelope ?? null;
    if (!cap) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "missing" } };
      throw Errors.badRequest("缺少 capabilityEnvelope");
    }
    const parsed = validateCapabilityEnvelopeV1(cap);
    if (!parsed.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "invalid" } };
      throw Errors.badRequest("capabilityEnvelope 不合法");
    }
    const effLimits = normalizeLimits(stepInput?.limits);
    const effectiveEnvelope: CapabilityEnvelopeV1 = {
      format: "capabilityEnvelope.v1",
      dataDomain: {
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        subjectId: subject.subjectId ?? null,
        toolContract: { scope, resourceType, action, fieldRules: (decision as any).fieldRules ?? null, rowFilters: (decision as any).rowFilters ?? null },
      },
      secretDomain: { connectorInstanceIds: [] },
      egressDomain: { networkPolicy: normalizeNetworkPolicy(effNetworkPolicy) },
      resourceDomain: { limits: effLimits },
    };
    const subset = checkCapabilityEnvelopeNotExceedV1({ envelope: parsed.envelope, effective: effectiveEnvelope });
    if (!subset.ok) {
      req.ctx.audit!.errorCategory = "policy_violation";
      req.ctx.audit!.outputDigest = { capabilityEnvelope: { status: "not_subset", reason: subset.reason } };
      throw Errors.badRequest("capabilityEnvelope 不得扩大权限");
    }
    const finalEnvelope = parsed.envelope;
    stepInput = {
      ...stepInput,
      toolContract: { ...(stepInput?.toolContract ?? {}), fieldRules: finalEnvelope.dataDomain.toolContract.fieldRules ?? null, rowFilters: finalEnvelope.dataDomain.toolContract.rowFilters ?? null },
      limits: finalEnvelope.resourceDomain.limits,
      networkPolicy: finalEnvelope.egressDomain.networkPolicy,
      capabilityEnvelope: finalEnvelope,
    };

    const newIdempotencyKey = uuidv4();
    const { job, run, step } = await createJobRunStep({
      pool: app.db,
      tenantId: subject.tenantId,
      jobType: "tool.execute",
      toolRef,
      policySnapshotRef: decision.snapshotRef,
      idempotencyKey: newIdempotencyKey,
      createdBySubjectId: subject.subjectId,
      trigger: "reexec",
      masterKey: app.cfg.secrets.masterKey,
      input: { ...stepInput, traceId: req.ctx.traceId },
    });
    await app.db.query("UPDATE runs SET reexec_of_run_id = $1, updated_at = now() WHERE tenant_id = $2 AND run_id = $3", [
      visible.runId,
      subject.tenantId,
      run.runId,
    ]);

    const riskAssessment = await assessToolExecutionRisk({
      pool: app.db,
      tenantId: subject.tenantId,
      toolRef,
      inputDraft: (typeof stepInput === "object" && stepInput) ? (stepInput as Record<string, unknown>) : {},
      toolDefinition: {
        riskLevel: ((stepInput?.toolContract?.riskLevel ?? def?.riskLevel) ?? undefined) as any,
        approvalRequired: (stepInput?.toolContract?.approvalRequired ?? def?.approvalRequired) ?? undefined,
        scope: (stepInput?.toolContract?.scope ?? def?.scope) ?? undefined,
      },
    });
    const approvalRequired = riskAssessment.approvalRequired;
    const receipt = { correlation: { requestId: req.ctx.requestId, traceId: req.ctx.traceId, runId: run.runId, stepId: step.stepId }, status: "queued" as const };

    if (approvalRequired) {
      await app.db.query("UPDATE runs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND run_id = $2", [subject.tenantId, run.runId]);
      await app.db.query("UPDATE jobs SET status = 'needs_approval', updated_at = now() WHERE tenant_id = $1 AND job_id = $2", [subject.tenantId, job.jobId]);
      const approval = await createApproval({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId ?? null,
        runId: run.runId,
        stepId: step.stepId,
        requestedBySubjectId: subject.subjectId,
        toolRef,
        policySnapshotRef: decision.snapshotRef ?? null,
        inputDigest: step.inputDigest ?? null,
        assessmentContext: riskAssessment,
      });
      await insertAuditEvent(app.db, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "workflow",
        action: "workflow:reexec",
        policyDecision: decision,
        inputDigest: { fromRunId: visible.runId, toRunId: run.runId, toolRef },
        outputDigest: { status: "needs_approval", approvalId: approval.approvalId },
        idempotencyKey: newIdempotencyKey,
        result: "success",
        traceId: req.ctx.traceId,
        requestId: req.ctx.requestId,
        runId: run.runId,
        stepId: step.stepId,
      });
      req.ctx.audit!.outputDigest = { fromRunId: visible.runId, toRunId: run.runId, status: "needs_approval", approvalId: approval.approvalId };
      return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, approvalId: approval.approvalId, receipt: { ...receipt, status: "needs_approval" as const } };
    }

    const bj = await app.queue.add("step", { jobId: job.jobId, runId: run.runId, stepId: step.stepId }, { attempts: 3, backoff: { type: "exponential", delay: 500 } });
    await app.db.query("UPDATE steps SET queue_job_id = $1, updated_at = now() WHERE step_id = $2", [String(bj.id), step.stepId]);

    await insertAuditEvent(app.db, {
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      resourceType: "workflow",
      action: "workflow:reexec",
      policyDecision: decision,
      inputDigest: { fromRunId: visible.runId, toRunId: run.runId, toolRef },
      outputDigest: { status: "queued" },
      idempotencyKey: newIdempotencyKey,
      result: "success",
      traceId: req.ctx.traceId,
      requestId: req.ctx.requestId,
      runId: run.runId,
      stepId: step.stepId,
    });
    req.ctx.audit!.outputDigest = { fromRunId: visible.runId, toRunId: run.runId, status: "queued" };
    return { jobId: job.jobId, runId: run.runId, stepId: step.stepId, receipt };
  });

};
