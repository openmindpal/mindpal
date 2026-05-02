/**
 * Unified Execution Submission Kernel.
 *
 * Extracts the common "resolve → validate → admit → build step → submit → enqueue"
 * pipeline that was previously duplicated across:
 *   - orchestrator/routes.execute.ts
 *   - orchestrator/routes.closedLoop.ts
 *   - agent-runtime/routes.ts
 *   - collab-runtime/routes.ts
 *   - routes/tools.ts (POST /tools/:toolRef/execute)
 *
 * Each runtime still owns its own request parsing, planning, and response shaping.
 * This kernel provides three composable phases:
 *   Phase 1 — resolveAndValidateTool()
 *   Phase 2 — admitAndBuildStepInput()
 *   Phase 3 — submitToolStep()
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { CapabilityEnvelopeV1 } from "@mindpal/shared";
import { StructuredLogger } from "@mindpal/shared";

import { Errors } from "../lib/errors";

const _kernelLogger = new StructuredLogger({ module: "executionKernel" });
import { getLatestReleasedToolVersion, getToolDefinition, getToolVersionByRef, type ToolDefinition, type ToolVersion } from "../modules/tools/toolRepo";
import { resolveEffectiveToolRef } from "../modules/tools/resolve";
import { isToolEnabled } from "../modules/governance/toolGovernanceRepo";
import { admitToolExecution, networkPolicyDigest, type ExecutionAdmissionResult } from "../modules/tools/executionAdmission";
import { validateToolInput } from "../modules/tools/validate";
import { createApproval } from "../modules/workflow/approvalRepo";
import { appendStepToRun, createJobRunStep } from "../modules/workflow/jobRepo";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../modules/workflow/queue";
import { insertAuditEvent } from "../modules/audit/auditRepo";

import { runPreExecutionChecks, type CheckpointContext, type GovernanceCheckpoint } from "./governanceCheckpoint";
import { assessToolExecutionRisk } from "./approvalRuleEngine";
import { markStepNeedsApproval, updateInputDigest } from "./stepRepo";
import { preflightCheck } from "./orchestrationKernel";
import { authorizeToolExecution, type AuthorizationResult } from "./loopPermissionUnified";

/* ================================================================== */
/*  Phase 1 — Resolve & Validate Tool                                  */
/* ================================================================== */

export interface ResolveToolParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  /** Raw tool reference (may or may not include @version). */
  rawToolRef: string;
}

export interface ResolvedTool {
  toolName: string;
  toolRef: string;
  version: ToolVersion;
  definition: ToolDefinition;
  scope: "read" | "write";
  resourceType: string;
  action: string;
  idempotencyRequired: boolean;
  /** 工具执行超时时间(毫秒)，来自 tool_definitions.execution_timeout_ms */
  executionTimeoutMs: number;
}

/**
 * Phase 1: Resolve a raw tool reference into a fully validated tool context.
 *
 * Steps:
 *  1. Parse toolName from rawToolRef
 *  2. Resolve effective toolRef if no @version
 *  3. Validate version exists and status is "released"
 *  4. Validate tool is enabled for the scope (tenant+space)
 *  5. Validate tool definition contract is complete
 *
 * Throws AppError on any validation failure.
 */
export async function resolveAndValidateTool(params: ResolveToolParams): Promise<ResolvedTool> {
  const { pool, tenantId, spaceId, rawToolRef } = params;

  const idx = rawToolRef.lastIndexOf("@");
  const toolName = idx > 0 ? rawToolRef.slice(0, idx) : rawToolRef;

  // Resolve effective toolRef
  let toolRef = idx > 0 ? rawToolRef : await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: toolName });
  if (!toolRef) {
    throw Errors.notFound("工具版本");
  }

  // Validate version
  let version = await getToolVersionByRef(pool, tenantId, toolRef);
  if (!version) {
    throw Errors.notFound("工具版本");
  }
  if (version.status !== "released") {
    throw Errors.badRequest("工具未发布");
  }

  // Validate enabled
  let enabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef });
  if (!enabled && idx <= 0) {
    const latest = await getLatestReleasedToolVersion(pool, tenantId, toolName);
    const latestRef = latest?.toolRef ?? null;
    if (latestRef && latestRef !== toolRef) {
      const latestEnabled = await isToolEnabled({ pool, tenantId, spaceId, toolRef: latestRef });
      if (latestEnabled && latest) {
        toolRef = latestRef;
        version = latest;
        enabled = true;
      }
    }
  }
  if (!enabled) {
    throw Errors.toolDisabled();
  }

  // Validate contract
  const definition = await getToolDefinition(pool, tenantId, toolName);
  if (!definition) {
    throw Errors.badRequest("工具定义不存在");
  }
  const { scope, resourceType, action, idempotencyRequired } = definition;
  if (!scope || !resourceType || !action || idempotencyRequired === null) {
    throw Errors.badRequest("工具契约缺失");
  }

  return {
    toolName,
    toolRef,
    version,
    definition,
    scope: scope as "read" | "write",
    resourceType,
    action,
    idempotencyRequired: Boolean(idempotencyRequired),
    executionTimeoutMs: definition.executionTimeoutMs ?? 120_000,
  };
}

/* ================================================================== */
/*  Phase 2 — Admit & Build Step Input                                 */
/* ================================================================== */

export interface AdmitToolParams {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  resolved: ResolvedTool;
  /** Permission decision from requirePermission(). */
  opDecision: { snapshotRef?: string; fieldRules?: any; rowFilters?: any; [k: string]: any };
  /** Runtime-supplied limits (e.g. from request body). */
  limits?: any;
  /** Optional requested capability envelope from client. */
  requestedCapabilityEnvelope?: any;
  /** Whether the caller must provide a capability envelope. */
  requireRequestedEnvelope?: boolean;
  /** 若调用方已完成统一权限检查（authorizeToolExecution），跳过重复治理检查 */
  preAuthorized?: boolean;
}

export interface AdmittedTool {
  envelope: CapabilityEnvelopeV1;
  limits: any;
  networkPolicy: any;
  networkPolicyDigest: ReturnType<typeof networkPolicyDigest>;
  effectiveEnvelope: CapabilityEnvelopeV1;
}

/**
 * Phase 2: Run execution admission and build the capability envelope.
 *
 * Delegates to admitToolExecution and returns the resolved envelope,
 * limits, and network policy. Throws on admission failure.
 */
export async function admitAndBuildStepEnvelope(params: AdmitToolParams): Promise<AdmittedTool> {
  const { pool, tenantId, spaceId, subjectId, resolved, opDecision } = params;

  // ── P0-2: 运行时治理检查点（准入阶段） ──
  // 当调用来源已完成统一权限检查时（preAuthorized），跳过重复治理检查
  if (!params.preAuthorized && spaceId && subjectId) {
    const govCtx: CheckpointContext = {
      tenantId,
      spaceId,
      subjectId,
      runId: "",  // 尚未创建 run，留空
      toolRef: resolved.toolRef,
      input: params.limits ?? {},
    };
    try {
      const checkpoint = await runPreExecutionChecks({ pool, context: govCtx });
      if (!checkpoint.overallPassed && checkpoint.blockingFailures > 0) {
        const blockingResults = checkpoint.results.filter(r => !r.passed && r.blocking);
        const firstBlocking = blockingResults[0];
        if (firstBlocking?.checkType === "policy" && firstBlocking.metadata?.requiresApproval) {
          // 策略要求审批 —— 不阻止，交由后续 approval 流程处理
        } else {
          throw Errors.badRequest(
            firstBlocking?.message ?? "治理检查未通过"
          );
        }
      }
    } catch (err: any) {
      // 治理检查本身的 Errors 直接抛出，其它异常按 fail-closed 处理
      if (err?.httpStatus) throw err;
      // ── 降级审计：记录治理检查基础设施异常，确保可追溯 ──
      const degradedDetail = {
        tenantId,
        spaceId,
        subjectId,
        toolRef: resolved.toolRef,
        errorMessage: err?.message ?? "unknown",
        errorName: err?.name ?? "Error",
        degradedAt: new Date().toISOString(),
      };
      _kernelLogger.error(
        "governance pre-check failed (degraded)",
        degradedDetail as Record<string, unknown>,
      );
      // 异步写入审计表（降级记录），不阻塞主流程
      insertAuditEvent(pool, {
        tenantId,
        spaceId,
        subjectId,
        resourceType: "governance",
        action: "pre_check.degraded",
        inputDigest: degradedDetail,
        outputDigest: { degraded: true },
        result: "error",
        traceId: "",
      }).catch(() => { /* 审计写入失败不影响主流程 */ });
      throw Errors.badRequest("治理检查不可用，已拒绝执行");
    }
  }

  const admitted = await admitToolExecution({
    pool,
    tenantId,
    spaceId,
    subjectId,
    toolRef: resolved.toolRef,
    toolContract: {
      scope: resolved.scope,
      resourceType: resolved.resourceType,
      action: resolved.action,
      fieldRules: opDecision.fieldRules ?? null,
      rowFilters: opDecision.rowFilters ?? null,
    },
    limits: params.limits ?? {},
    requestedCapabilityEnvelope: params.requestedCapabilityEnvelope ?? null,
    requireRequestedEnvelope: params.requireRequestedEnvelope ?? false,
  });

  if (!admitted.ok) {
    const reason = admitted.reason;
    if (reason === "missing") throw Errors.badRequest("缺少 capabilityEnvelope");
    if (reason === "invalid") throw Errors.badRequest("capabilityEnvelope 不合法");
    throw Errors.badRequest("capabilityEnvelope 不得扩大权限");
  }

  return {
    envelope: admitted.envelope,
    limits: admitted.limits,
    networkPolicy: admitted.networkPolicy,
    networkPolicyDigest: admitted.networkPolicyDigest,
    effectiveEnvelope: admitted.effectiveEnvelope,
  };
}

/**
 * Build the canonical step input payload.
 * Used by all runtimes to construct the step input stored in the DB.
 */
export function buildStepInputPayload(params: {
  kind: string;
  resolved: ResolvedTool;
  admitted: AdmittedTool;
  input: any;
  idempotencyKey?: string | null;
  tenantId: string;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string;
  /** Extra fields merged into the step input (e.g. planStepId, actorRole, dependsOn). */
  extra?: Record<string, any>;
}): Record<string, any> {
  const { kind, resolved, admitted, input, idempotencyKey, tenantId, spaceId, subjectId, traceId, extra } = params;
  return {
    ...(extra ?? {}),
    kind,
    toolRef: resolved.toolRef,
    idempotencyKey: idempotencyKey ?? undefined,
    toolContract: {
      scope: resolved.scope,
      resourceType: resolved.resourceType,
      action: resolved.action,
      idempotencyRequired: resolved.idempotencyRequired,
      riskLevel: resolved.definition.riskLevel,
      approvalRequired: resolved.definition.approvalRequired,
      sourceLayer: resolved.definition.sourceLayer,
      fieldRules: admitted.envelope.dataDomain.toolContract.fieldRules ?? null,
      rowFilters: admitted.envelope.dataDomain.toolContract.rowFilters ?? null,
    },
    input,
    limits: admitted.limits,
    networkPolicy: admitted.networkPolicy,
    capabilityEnvelope: admitted.envelope,
    tenantId,
    spaceId,
    subjectId,
    traceId,
  };
}

/* ================================================================== */
/*  Phase 3 — Submit & Enqueue Tool Step                               */
/* ================================================================== */

export interface SubmitNewRunParams {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  resolved: ResolvedTool;
  opDecision: { snapshotRef?: string; [k: string]: any };
  stepInput: Record<string, any>;
  idempotencyKey?: string | null;
  createdBySubjectId?: string;
  trigger: string;
  masterKey?: string;
  jobType?: string;
}

export interface SubmitStepToRunParams {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  resolved: ResolvedTool;
  opDecision: { snapshotRef?: string; [k: string]: any };
  stepInput: Record<string, any>;
  runId: string;
  jobId: string;
  masterKey?: string;
  jobType?: string;
}

export type SubmitResult =
  | {
      outcome: "queued";
      jobId: string;
      runId: string;
      stepId: string;
      idempotencyKey?: string | null;
    }
  | {
      outcome: "needs_approval";
      jobId: string;
      runId: string;
      stepId: string;
      approvalId: string;
      idempotencyKey?: string | null;
    };

export function buildApprovalInputDigest(params: {
  inputDigest: any;
  resolved: ResolvedTool;
  requiredApprovals: number;
}): Record<string, any> | null {
  const baseInputDigest =
    params.inputDigest && typeof params.inputDigest === "object" && !Array.isArray(params.inputDigest)
      ? params.inputDigest
      : null;

  if (params.requiredApprovals <= 1) {
    return baseInputDigest ?? params.inputDigest ?? null;
  }

  return {
    ...(baseInputDigest ?? {}),
    approvalPolicy: {
      ...(baseInputDigest?.approvalPolicy && typeof baseInputDigest.approvalPolicy === "object" ? baseInputDigest.approvalPolicy : {}),
      requiredApprovals: params.requiredApprovals,
    },
  };
}

/**
 * Phase 3a: Create a new Run + Job + Step, then enqueue or request approval.
 *
 * Used by orchestrator/dispatch/execute and routes/tools.ts execute.
 */
export async function submitNewToolRun(params: SubmitNewRunParams): Promise<SubmitResult> {
  const { pool, queue, tenantId, resolved, opDecision, stepInput, createdBySubjectId, trigger, masterKey } = params;
  const jobType = params.jobType ?? "tool.execute";
  const idempotencyKey = params.idempotencyKey ?? undefined;

  const { job, run, step } = await createJobRunStep({
    pool,
    tenantId,
    jobType,
    toolRef: resolved.toolRef,
    policySnapshotRef: opDecision.snapshotRef,
    idempotencyKey,
    createdBySubjectId,
    trigger,
    masterKey,
    input: stepInput,
  });

  return await _handleApprovalOrEnqueue({
    pool, queue, tenantId, resolved, opDecision, step, run, job,
    idempotencyKey: idempotencyKey ?? null,
    spaceId: stepInput.spaceId ?? null,
    subjectId: stepInput.subjectId ?? null,
    traceId: stepInput.traceId ?? null,
    requestId: null,
  });
}

/**
 * Phase 3b: Append a step to an existing Run, then enqueue or request approval.
 *
 * Used by closed-loop and agent-runtime.
 */
export async function submitStepToExistingRun(params: SubmitStepToRunParams): Promise<SubmitResult> {
  const { pool, queue, tenantId, resolved, opDecision, stepInput, runId, jobId, masterKey } = params;
  const jobType = params.jobType ?? "agent.run";

  const step = await appendStepToRun({
    pool,
    tenantId,
    jobType,
    runId,
    toolRef: resolved.toolRef,
    policySnapshotRef: opDecision.snapshotRef,
    masterKey,
    input: stepInput,
  });

  return await _handleApprovalOrEnqueue({
    pool, queue, tenantId, resolved, opDecision, step, run: { runId }, job: { jobId },
    idempotencyKey: stepInput.idempotencyKey ?? null,
    spaceId: stepInput.spaceId ?? null,
    subjectId: stepInput.subjectId ?? null,
    traceId: stepInput.traceId ?? null,
    requestId: null,
  });
}

/* ------------------------------------------------------------------ */
/*  Internal: approval-or-enqueue                                      */
/* ------------------------------------------------------------------ */

async function _handleApprovalOrEnqueue(params: {
  pool: Pool;
  queue: Queue;
  tenantId: string;
  resolved: ResolvedTool;
  opDecision: any;
  step: any;
  run: any;
  job: any;
  idempotencyKey: string | null;
  spaceId: string | null;
  subjectId: string | null;
  traceId: string | null;
  requestId: string | null;
}): Promise<SubmitResult> {
  const { pool, queue, tenantId, resolved, opDecision, step, run, job, idempotencyKey, spaceId, subjectId, traceId, requestId } = params;
  const runId = run.runId ?? run.run_id;
  const jobId = job.jobId ?? job.job_id;
  const stepId = step.stepId ?? step.step_id;

  // ── 编排预检：预算 / 角色工具策略 / 审批需求评估 ──
  let preflightResult: import("@mindpal/shared").PreflightResult | null = null;
  try {
    preflightResult = await preflightCheck({
      pool, runId, stepId, tenantId,
      toolRef: resolved.toolRef,
      subject: subjectId ? { subjectId } : undefined,
    });

    // 将预检结果写入 step metadata，供 Worker 侧读取
    await pool.query(
      `UPDATE steps SET input_digest = jsonb_set(
         COALESCE(input_digest, '{}'::jsonb),
         '{preflight_result}',
         $1::jsonb,
         true
       ) WHERE step_id = $2`,
      [JSON.stringify(preflightResult), stepId],
    );

    // 预检不通过：停止 run 并标记 step 失败
    if (!preflightResult.ok) {
      _kernelLogger.warn("preflight rejected", { runId, stepId, reason: preflightResult.issues[0]?.message ?? "preflight_denied" });
      await pool.query(
        "UPDATE steps SET status = 'failed', updated_at = now(), finished_at = now() WHERE step_id = $1",
        [stepId],
      );
      await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "stopped", jobStatus: "stopped" });
      return { outcome: "queued", jobId, runId, stepId, idempotencyKey } as SubmitResult;
    }
  } catch (preflightErr: any) {
    // 预检失败不阻断主流程，记录日志后继续
    _kernelLogger.warn("preflightCheck failed (degraded, continuing)", {
      runId, stepId, error: preflightErr?.message ?? String(preflightErr),
    });
  }

  // ── 规则引擎为单一真相源：一次调用同时产出决策和上下文 ──
  const assessment = await assessToolExecutionRisk({
    pool,
    tenantId,
    toolRef: resolved.toolRef,
    inputDraft: (typeof step.inputDigest === "object" && step.inputDigest) ? step.inputDigest : {},
    toolDefinition: resolved.definition ? {
      riskLevel: resolved.definition.riskLevel,
      approvalRequired: resolved.definition.approvalRequired,
      scope: resolved.definition.scope ?? undefined,
    } : undefined,
  });
  const approvalRequired = assessment.approvalRequired;
  const approvalInputDigest = buildApprovalInputDigest({
    inputDigest: step.inputDigest,
    resolved,
    requiredApprovals: assessment.requiredApprovals,
  });

  // 预检要求审批时，强制进入审批流程
  if ((preflightResult?.requiredApprovals?.length ?? 0) > 0 || approvalRequired) {
    await markStepNeedsApproval(pool, stepId);
    if (JSON.stringify(step.inputDigest ?? null) !== JSON.stringify(approvalInputDigest ?? null)) {
      await updateInputDigest(pool, { stepId, runId, inputDigest: approvalInputDigest });
      step.inputDigest = approvalInputDigest;
      run.inputDigest = approvalInputDigest;
    }
    await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "needs_approval", jobStatus: "needs_approval" });
    const approval = await createApproval({
      pool,
      tenantId,
      spaceId,
      runId,
      stepId,
      requestedBySubjectId: subjectId ?? "",
      toolRef: resolved.toolRef,
      policySnapshotRef: opDecision.snapshotRef ?? null,
      inputDigest: approvalInputDigest,
      assessmentContext: assessment,  // 直接传递，无需二次调用
    });
    await insertAuditEvent(pool, {
      subjectId: subjectId ?? undefined,
      tenantId,
      spaceId: spaceId ?? undefined,
      resourceType: "workflow",
      action: "approval.requested",
      policyDecision: opDecision,
      inputDigest: { approvalId: approval.approvalId, toolRef: resolved.toolRef },
      outputDigest: { status: "pending", runId, stepId },
      idempotencyKey: idempotencyKey ?? undefined,
      result: "success",
      traceId: traceId ?? "",
      requestId: requestId ?? undefined,
      runId,
      stepId,
    });
    return { outcome: "needs_approval", jobId, runId, stepId, approvalId: approval.approvalId, idempotencyKey };
  }

  await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "queued", jobStatus: "queued" });
  await enqueueWorkflowStep({ queue, pool, jobId, runId, stepId });
  return { outcome: "queued", jobId, runId, stepId, idempotencyKey };
}

/* ================================================================== */
/*  Convenience: prepareToolStep — resolve + validate + admit + build  */
/* ================================================================== */

export interface PrepareToolStepParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string | null;
  rawToolRef: string;
  inputDraft: any;
  /** Wraps the caller's permission check — returns opDecision-like object. */
  checkPermission?: (p: { resourceType: string; action: string }) => Promise<{
    snapshotRef?: string;
    fieldRules?: any;
    rowFilters?: any;
    [k: string]: any;
  }>;
  kind: string;
  traceId: string;
  extra?: Record<string, any>;
  idempotencyKeyPrefix?: string;
  runId?: string;
  seq?: number;
  limits?: any;
  preAuthorized?: boolean;
  /** 若提供 runId + jobId，可直接使用统一权限入口 authorizeToolExecution */
  jobId?: string;
}

export interface PreparedToolStep {
  resolved: ResolvedTool;
  opDecision: { snapshotRef?: string; fieldRules?: any; rowFilters?: any; [k: string]: any };
  admitted: AdmittedTool;
  stepInput: Record<string, any>;
  idempotencyKey: string | null;
}

/**
 * Convenience: resolve → validate input → permission check → admit → build step input.
 *
 * Consolidates the 5-step pattern repeated across dispatch.handleExecute,
 * dispatch.handleCollab, agent-runtime/routes, and collabExecutor into
 * a single kernel call. Callers only need to pass the result to
 * submitStepToExistingRun / submitNewToolRun / appendStepToRun afterwards.
 */
export async function prepareToolStep(params: PrepareToolStepParams): Promise<PreparedToolStep> {
  const {
    pool, tenantId, spaceId, subjectId,
    rawToolRef, inputDraft, checkPermission,
    kind, traceId, extra,
    idempotencyKeyPrefix, runId, seq,
    limits,
  } = params;
  let preAuthorized = params.preAuthorized;

  // Phase 1: resolve tool ref (name → version → enabled → contract)
  const resolved = await resolveAndValidateTool({ pool, tenantId, spaceId, rawToolRef });

  // Validate input against schema
  validateToolInput(resolved.version.inputSchema, inputDraft);

  // Permission check — 优先使用统一权限入口 authorizeToolExecution
  let opDecision: { snapshotRef?: string; fieldRules?: any; rowFilters?: any; [k: string]: any };
  if (checkPermission) {
    opDecision = await checkPermission({ resourceType: resolved.resourceType, action: resolved.action });
  } else if (subjectId) {
    const authResult = await authorizeToolExecution({
      pool, subjectId, tenantId, spaceId,
      traceId, runId: runId ?? "", jobId: params.jobId ?? "",
      resourceType: resolved.resourceType, action: resolved.action,
      toolRef: resolved.toolRef, limits: limits ?? {},
    });
    if (!authResult.authorized) {
      throw Errors.forbidden(authResult.errorMessage);
    }
    opDecision = authResult.opDecision ?? { decision: "allow" };
    // 治理检查已在 authorizeToolExecution 内完成，标记 preAuthorized
    preAuthorized = true;
  } else {
    throw Errors.unauthorized("zh-CN");
  }

  // Phase 2: admit & build envelope
  const admitted = await admitAndBuildStepEnvelope({
    pool, tenantId, spaceId, subjectId,
    resolved, opDecision,
    limits: limits ?? {},
    preAuthorized,
  });

  // Idempotency key
  const idempotencyKey = generateIdempotencyKey({
    resolved,
    prefix: idempotencyKeyPrefix ?? "prep",
    runId,
    seq,
  });

  // Build step input payload
  const stepInput = buildStepInputPayload({
    kind, resolved, admitted,
    input: inputDraft, idempotencyKey,
    tenantId, spaceId, subjectId, traceId,
    extra,
  });

  return { resolved, opDecision, admitted, stepInput, idempotencyKey };
}

/* ================================================================== */
/*  Lightweight Inline Admission                                       */
/* ================================================================== */

export interface InlineAdmissionParams {
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  /** Raw tool reference (may include @version). */
  toolRef: string;
}

export interface InlineAdmissionResult {
  /** Whether the inline execution is admitted. */
  admitted: boolean;
  /** Human-readable reason when admission is denied. */
  reason?: string;
  /** Resolved tool metadata (available when admitted). */
  resolvedMeta?: {
    toolName: string;
    scope: string;
    resourceType: string;
    action: string;
    riskLevel: string;
  };
}

/**
 * Lightweight admission check for the **inline execution path**.
 *
 * Inline tools (scope=read, riskLevel=low, or safe-write whitelist) run
 * synchronously inside the answer-mode request cycle. They intentionally
 * skip the heavy Phase-3 pipeline (BullMQ enqueue / async approval / full
 * 7×3 governance checkpoint matrix) to preserve sub-second response
 * latency.
 *
 * Governance gates applied:
 *   1. **Phase-1 resolveAndValidateTool** — tool existence, version status,
 *      enabled check, and contract completeness (single source of truth,
 *      eliminates prior duplicated inline logic).
 *   2. **Basic RBAC permission** — generic `tool/execute` + specific
 *      `resourceType/action` via `authorize()` (ABAC policy cache).
 *
 * What is intentionally **omitted** (compared to
 * `admitAndBuildStepEnvelope` / `submitNewToolRun`):
 *   - Capability envelope construction (inline tools don't need an
 *     envelope because they never leave the API process boundary).
 *   - BullMQ job/step creation & enqueue.
 *   - Asynchronous approval flow.
 *   - Full `runPreExecutionChecks` 7-category governance checkpoint
 *     (inline tools are limited to read / low-risk by design).
 *
 * @returns `{ admitted: true }` when all checks pass, otherwise
 *          `{ admitted: false, reason }` with a denial reason.
 */
export async function admitInlineExecution(
  params: InlineAdmissionParams,
): Promise<InlineAdmissionResult> {
  const { pool, tenantId, spaceId, subjectId, toolRef } = params;

  // ── 1. Phase-1 复用：工具解析、版本校验、启用检查、契约完整性 ──
  let resolved: ResolvedTool;
  try {
    resolved = await resolveAndValidateTool({ pool, tenantId, spaceId, rawToolRef: toolRef });
  } catch (err: unknown) {
    const appErr = err as { httpStatus?: number; message?: string };
    const reason = appErr?.message ?? "resolve_failed";
    // ── 审计日志：记录 Phase-1 拒绝 ──
    insertAuditEvent(pool, {
      subjectId, tenantId, spaceId,
      resourceType: "tool", action: "inline_execute",
      toolRef,
      result: "denied",
      traceId: "",
      inputDigest: { reason, subject: subjectId, resource: toolRef },
    }).catch(() => {});
    return { admitted: false, reason };
  }

  const { toolName, scope, resourceType, action } = resolved;
  const riskLevel = resolved.definition.riskLevel;

  // ── 2. Basic RBAC: generic tool/execute permission ──
  const { authorize } = await import("../modules/auth/authz");
  const { buildAbacEvaluationRequestFromContext } = await import("../modules/auth/guard");

  const buildAbac = (rt: string, act: string) =>
    buildAbacEvaluationRequestFromContext({
      subject: { subjectId, tenantId, spaceId },
      resourceType: rt,
      action: act,
      environment: {
        userAgent: "inline-tool/dispatch",
        deviceType: "server",
        attributes: { runtime: "inline_tool" },
      },
    });

  const genericDecision = await authorize({
    pool, subjectId, tenantId, spaceId,
    resourceType: "tool", action: "execute",
    abacRequest: buildAbac("tool", "execute"),
  });
  if (genericDecision.decision !== "allow") {
    // ── 审计日志：记录 RBAC 拒绝 ──
    insertAuditEvent(pool, {
      subjectId, tenantId, spaceId,
      resourceType: "tool", action: "execute",
      toolRef,
      result: "denied",
      traceId: "",
      inputDigest: { reason: "rbac_denied:tool/execute", subject: subjectId, resource: toolRef, requestedAction: "execute", matchedPolicy: (genericDecision as Record<string, unknown>).snapshotRef ?? null },
      policySnapshotRef: (genericDecision as Record<string, unknown>).snapshotRef as string | undefined,
    }).catch(() => {});
    return { admitted: false, reason: "rbac_denied:tool/execute" };
  }

  // ── 3. Basic RBAC: specific resourceType/action permission ──
  const specificDecision = await authorize({
    pool, subjectId, tenantId, spaceId,
    resourceType, action,
    abacRequest: buildAbac(resourceType, action),
  });
  if (specificDecision.decision !== "allow") {
    // ── 审计日志：记录 RBAC 拒绝 ──
    insertAuditEvent(pool, {
      subjectId, tenantId, spaceId,
      resourceType, action,
      toolRef,
      result: "denied",
      traceId: "",
      inputDigest: { reason: `rbac_denied:${resourceType}/${action}`, subject: subjectId, resource: toolRef, requestedAction: action, matchedPolicy: (specificDecision as Record<string, unknown>).snapshotRef ?? null },
      policySnapshotRef: (specificDecision as Record<string, unknown>).snapshotRef as string | undefined,
    }).catch(() => {});
    return { admitted: false, reason: `rbac_denied:${resourceType}/${action}` };
  }

  return {
    admitted: true,
    resolvedMeta: {
      toolName,
      scope,
      resourceType,
      action,
      riskLevel: riskLevel ?? "low",
    },
  };
}

/* ================================================================== */
/*  Convenience: full pipeline in one call                             */
/* ================================================================== */

/**
 * Generate an idempotency key for a write tool if needed.
 */
export function generateIdempotencyKey(params: {
  resolved: ResolvedTool;
  existingKey?: string | null;
  prefix: string;
  runId?: string;
  seq?: number;
}): string | null {
  if (params.existingKey) return params.existingKey;
  if (params.resolved.scope === "write" && params.resolved.idempotencyRequired) {
    if (params.runId) return `${params.prefix}-${params.runId}-${params.seq ?? 1}`;
    return `${params.prefix}-${Date.now()}`;
  }
  return null;
}
