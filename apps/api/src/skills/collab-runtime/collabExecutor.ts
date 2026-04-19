/**
 * Collab Runtime Executor
 *
 * Extracted from collab-runtime/routes.ts POST endpoint.
 * Encapsulates the execution pipeline:
 *   resolve special tools → create assignments → topological sort →
 *   create steps via execution kernel → permission contexts → enqueue.
 *
 * P2-1.1: 集成 dynamicCoordinator 支持动态角色协同
 *
 * The route handler remains responsible for HTTP parsing, planning,
 * job/run creation, audit output, and response shaping.
 */
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import { Errors } from "../../lib/errors";
import { resolveEffectiveToolRef } from "../../modules/tools/resolve";
import { isToolEnabled } from "../../modules/governance/toolGovernanceRepo";
import { prepareToolStep } from "../../kernel/executionKernel";
import { appendStepToRun } from "../../modules/workflow/jobRepo";
import { enqueueWorkflowStep, setRunAndJobStatus } from "../../modules/workflow/queue";
import { updateCollabRunStatus } from "./modules/collabRepo";
import { appendCollabRunEvent } from "./modules/collabEventRepo";
import { createTaskAssignment, upsertPermissionContext, listTaskAssignments } from "./modules/collabProtocolRepo";
import type { PlanStep } from "../../kernel/planningKernel";
import { initializeCollabState, syncCollabPhase, updateRoleState } from "./modules/stateSync";
import {
  createCollabTurn,
  updateCollabTurn,
  determineNextRole,
  recordCoordinationEvent,
  type RoleName,
  type TurnOutcome,
  type DynamicCollabState,
} from "./modules/dynamicCoordinator";

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

export interface CollabRole {
  roleName: string;
  mode?: string;
  toolPolicy?: { allowedTools?: string[] } | null;
  budget?: any;
}

export interface CollabExecutionParams {
  pool: Pool;
  redis?: { publish(channel: string, message: string): Promise<number> };
  queue: Queue;
  tenantId: string;
  spaceId: string;
  subjectId: string;
  collabRunId: string;
  taskId: string;
  runId: string;
  jobId: string;
  masterKey: string;
  traceId: string;
  planSteps: PlanStep[];
  roles: CollabRole[];
  limits: any;
  message: string;
  correlationId: string;
  arbiterAuto: boolean;
  /** P2-1.1: 启用动态协同模式 */
  dynamicCoordination?: boolean;
  /** Wraps req-level permission check — returns opDecision-like object. */
  checkPermission: (params: { resourceType: string; action: string }) => Promise<{
    snapshotRef?: string;
    fieldRules?: any;
    rowFilters?: any;
    [k: string]: any;
  }>;
}

export type CollabPipelineResult =
  | {
      ok: true;
      retrieverToolRef: string | null;
      createdSteps: any[];
      firstStepId: string;
      updated: any;
    }
  | {
      ok: false;
      reason: "retriever_disabled";
      retrieverToolRef: string;
    };

/* ================================================================== */
/*  Internal: topological sort                                         */
/* ================================================================== */

interface StepNode {
  planStepId: string;
  actorRole: string;
  stepKind: string;
  toolRef: string;
  dependsOn: string[];
}

function topologicalSort(steps: StepNode[]): StepNode[] {
  const nodes = new Map<string, { step: StepNode; in: number; outs: Set<string> }>();
  for (const s of steps) nodes.set(s.planStepId, { step: s, in: 0, outs: new Set<string>() });
  for (const s of steps) {
    for (const d of s.dependsOn) {
      const dep = nodes.get(d);
      const cur = nodes.get(s.planStepId);
      if (!dep || !cur) continue;
      dep.outs.add(s.planStepId);
      cur.in += 1;
    }
  }
  const queue: string[] = Array.from(nodes.entries())
    .filter(([, v]) => v.in === 0)
    .map(([k]) => k)
    .sort();
  const ordered: StepNode[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    const n = nodes.get(id);
    if (!n) continue;
    ordered.push(n.step);
    for (const out of Array.from(n.outs).sort()) {
      const target = nodes.get(out);
      if (!target) continue;
      target.in -= 1;
      if (target.in === 0) queue.push(out);
    }
    queue.sort();
  }
  if (ordered.length !== steps.length) throw Errors.badRequest("协作任务分派存在循环依赖");
  return ordered;
}

function normalizeDependsOnForPlanStep(params: {
  step: PlanStep;
  planStepIds: Set<string>;
  defaultDependency: string | null;
}): string[] {
  const raw = Array.isArray(params.step.dependsOn) ? params.step.dependsOn.map((x) => String(x)) : [];
  const selfId = String(params.step.stepId);
  const deduped = Array.from(new Set(raw.filter((dep) => dep && dep !== selfId && params.planStepIds.has(dep))));
  if (deduped.length) return deduped;
  return params.defaultDependency ? [params.defaultDependency] : [];
}

function getTerminalPlanStepIds(planSteps: PlanStep[]): string[] {
  const ids = planSteps.map((p) => String(p.stepId));
  const referenced = new Set<string>();
  for (const p of planSteps) {
    const deps = Array.isArray(p.dependsOn) ? p.dependsOn : [];
    for (const dep of deps) referenced.add(String(dep));
  }
  return ids.filter((id) => !referenced.has(id));
}

/* ================================================================== */
/*  Main executor                                                      */
/* ================================================================== */

/**
 * Execute the full collab pipeline:
 *   1. Resolve retriever / guard / review tool refs
 *   2. Check retriever is enabled
 *   3. Create task assignments (idempotent — skips if already exist)
 *   4. Build execution pipeline via topological sort
 *   5. Create steps via execution kernel (resolve + admit + append)
 *   6. Build per-role permission contexts
 *   7. Set run/job status → "queued", collab status → "executing"
 *   8. Enqueue the first step
 */
export async function executeCollabPipeline(params: CollabExecutionParams): Promise<CollabPipelineResult> {
  const {
    pool, queue, tenantId, spaceId, subjectId,
    collabRunId, taskId, runId, jobId,
    masterKey, traceId,
    planSteps, roles, limits, message, correlationId, arbiterAuto,
    dynamicCoordination = true,
    checkPermission,
  } = params;

  /* ── 1. Resolve special tool refs (动态查找 retriever，不存在时跳过) ── */
  const retrieverToolRef = await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: "knowledge.search" }).catch(() => null) ?? null;
  const retrieverEnabled = retrieverToolRef ? await isToolEnabled({ pool, tenantId, spaceId, toolRef: retrieverToolRef }) : false;
  const hasRetriever = !!retrieverToolRef && retrieverEnabled;

  const guardToolRef = (await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: "collab.guard" })) ?? "collab.guard@1";
  const reviewToolRef = (await resolveEffectiveToolRef({ pool, tenantId, spaceId, name: "collab.review" })) ?? "collab.review@1";
  const planStepIds = new Set(planSteps.map((p) => String(p.stepId)));
  const terminalPlanStepIds = getTerminalPlanStepIds(planSteps);

  /* ── 2. Create task assignments (if none exist) ── */
  const existingAssignments = await listTaskAssignments({ pool, tenantId, collabRunId, status: null, limit: 200 });
  const hasAssignments = existingAssignments.length > 0;

  if (!hasAssignments) {
    /* retriever 角色：仅当 knowledge.search 可用时纳入 */
    if (hasRetriever) {
      await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "retriever", assignedBy: subjectId, priority: 100,
        inputDigest: { kind: "collab_step", planStepId: "role.retriever", stepKind: "retriever", toolRef: retrieverToolRef, dependsOn: [] } });
    }

    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "guard", assignedBy: subjectId, priority: 90,
      inputDigest: { kind: "collab_step", planStepId: "role.guard", stepKind: "guard", toolRef: guardToolRef, dependsOn: hasRetriever ? ["role.retriever"] : [] } });
    for (let i = 0; i < planSteps.length; i++) {
      const p = planSteps[i]!;
      const dependsOn = normalizeDependsOnForPlanStep({
        step: p,
        planStepIds,
        defaultDependency: "role.guard",
      });
      await createTaskAssignment({ pool, tenantId, collabRunId, taskId,
        assignedRole: String(p.actorRole ?? "executor"), assignedBy: subjectId, priority: 80 - i,
        inputDigest: { kind: "collab_step", planStepId: p.stepId, stepKind: "executor", toolRef: p.toolRef, dependsOn, approvalRequired: Boolean(p.approvalRequired) } });
    }

    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "reviewer", assignedBy: subjectId, priority: 10,
      inputDigest: { kind: "collab_step", planStepId: "role.reviewer", stepKind: "reviewer", toolRef: reviewToolRef, dependsOn: terminalPlanStepIds.length ? terminalPlanStepIds : ["role.guard"] } });
    await createTaskAssignment({ pool, tenantId, collabRunId, taskId, assignedRole: "arbiter", assignedBy: subjectId, priority: 0,
      inputDigest: { kind: "arbiter_decision", planStepId: "role.arbiter", dependsOn: ["role.reviewer"], autoArbiter: arbiterAuto } });
  }

  /* ── 3. Build pipeline via topological sort ── */
  const assignments = hasAssignments
    ? existingAssignments
    : await listTaskAssignments({ pool, tenantId, collabRunId, status: null, limit: 200 });

  const collabSteps: StepNode[] = assignments
    .filter((a) => String((a as any)?.inputDigest?.kind ?? "") === "collab_step")
    .map((a) => ({
      planStepId: String((a as any).inputDigest.planStepId),
      actorRole: String((a as any).assignedRole ?? "executor"),
      stepKind: String((a as any).inputDigest.stepKind ?? "executor"),
      toolRef: String((a as any).inputDigest.toolRef),
      dependsOn: Array.isArray((a as any).inputDigest.dependsOn) ? ((a as any).inputDigest.dependsOn as any[]).map(String) : [],
    }));

  const ordered = topologicalSort(collabSteps);

  const planById = new Map(planSteps.map((p: any) => [String(p.stepId), p]));
  const pipeline = ordered.map((s) => {
    if (s.planStepId === "role.retriever") return { ...s, input: { query: message, limit: 5 } };
    if (s.planStepId === "role.guard") return { ...s, input: { plan: { steps: planSteps }, roles, limits, correlationId, autoArbiter: arbiterAuto } };
    if (s.planStepId === "role.reviewer") return { ...s, input: { mode: "respond" } };
    const p = planById.get(s.planStepId);
    return { ...s, input: (p?.inputDraft ?? {}) as any };
  });

  /* ── 4. Create steps via execution kernel ── */
  const createdSteps: any[] = [];
  const permByRole = new Map<string, any[]>();

  for (let i = 0; i < pipeline.length; i++) {
    const p = pipeline[i]!;

    const { resolved, opDecision, stepInput } = await prepareToolStep({
      pool, tenantId, spaceId, subjectId,
      rawToolRef: String(p.toolRef),
      inputDraft: p.input ?? {},
      checkPermission,
      kind: "agent.run.step",
      traceId,
      extra: {
        collabRunId, taskId,
        planStepId: p.planStepId, actorRole: p.actorRole, stepKind: p.stepKind, dependsOn: p.dependsOn,
        ...(p.stepKind === "guard" ? { autoArbiter: arbiterAuto, correlationId } : {}),
        // P1-2 FIX: 绑定角色权限上下文，供worker执行时校验
        rolePermissionContext: String(p.actorRole ?? "").trim() ? {
          roleName: String(p.actorRole ?? "").trim(),
          allowedTools: permByRole.get(String(p.actorRole ?? "").trim())?.map(tc => tc.toolRef) ?? [],
          policySnapshotRef: null, // will be filled after opDecision
        } : null,
      },
      idempotencyKeyPrefix: "idem-collab",
      runId,
      seq: i + 1,
    });

    // Update rolePermissionContext with actual policySnapshotRef
    if (stepInput.rolePermissionContext) {
      stepInput.rolePermissionContext.policySnapshotRef = opDecision.snapshotRef ?? null;
    }

    const roleKey = String(p.actorRole ?? "").trim();
    if (roleKey) {
      const list = permByRole.get(roleKey) ?? [];
      list.push({
        toolRef: resolved.toolRef,
        toolContract: { scope: resolved.scope, resourceType: resolved.resourceType, action: resolved.action, idempotencyRequired: resolved.idempotencyRequired },
        policySnapshotRef: opDecision.snapshotRef ?? null,
        fieldRules: (opDecision as any).fieldRules ?? null,
        rowFilters: (opDecision as any).rowFilters ?? null,
      });
      permByRole.set(roleKey, list);
    }

    const step = await appendStepToRun({
      pool, tenantId, jobType: "agent.run", runId,
      toolRef: resolved.toolRef, policySnapshotRef: opDecision.snapshotRef,
      masterKey, input: stepInput,
    });
    createdSteps.push(step);
  }

  /* ── 5. Build permission contexts ── */
  for (const [roleName, toolContracts] of permByRole.entries()) {
    if (!roleName) continue;
    const first = toolContracts.length ? toolContracts[0] : null;
    await upsertPermissionContext({
      pool, tenantId, collabRunId, roleName,
      effectivePermissions: { toolContracts },
      fieldRules: null, rowFilters: null,
      policySnapshotRef: first?.policySnapshotRef ?? null,
      expiresAt: null,
    });
  }

  /* ── 6. Set run/job status + enqueue first step ── */
  await setRunAndJobStatus({ pool, tenantId, runId, jobId, runStatus: "queued", jobStatus: "queued" });
  const updated = await updateCollabRunStatus({ pool, tenantId, collabRunId, status: "executing" });
  if (!updated) throw Errors.internal();

  const rootStepIndexes = pipeline
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => !step.dependsOn.length)
    .map(({ index }) => index);
  const rootSteps = (rootStepIndexes.length ? rootStepIndexes : [0])
    .map((index) => ({ pipeline: pipeline[index]!, created: createdSteps[index]! }))
    .filter((item) => item.pipeline && item.created);
  const firstStep = rootSteps[0]?.created ?? createdSteps[0];
  for (const root of rootSteps) {
    await enqueueWorkflowStep({ queue, pool, jobId, runId, stepId: root.created.stepId });
  }

  const roleNames = Array.from(new Set(roles.map((role) => String(role.roleName ?? "").trim()).filter(Boolean)));
  if (createdSteps.length && roleNames.length) {
    const initialState = await initializeCollabState({
      pool,
      redis: params.redis,
      tenantId,
      collabRunId,
      taskId,
      roles: roleNames,
      planStepIds: createdSteps.map((step) => String(step.stepId)),
    });
    let stateVersion = initialState.version;
    const planned = await syncCollabPhase({
      pool,
      redis: params.redis,
      tenantId,
      collabRunId,
      taskId,
      toPhase: "planning",
      triggeredBy: "planner",
      reason: "collab_plan_generated",
    });
    if (planned.ok && planned.newVersion) stateVersion = planned.newVersion;

    const firstRootRole = rootSteps[0]?.pipeline.actorRole ? String(rootSteps[0].pipeline.actorRole) : null;
    const executing = await syncCollabPhase({
      pool,
      redis: params.redis,
      tenantId,
      collabRunId,
      taskId,
      toPhase: "executing",
      triggeredBy: "collab_runtime",
      reason: "collab_pipeline_queued",
      currentRole: firstRootRole,
    });
    if (executing.ok && executing.newVersion) stateVersion = executing.newVersion;

    if (firstRootRole && firstStep?.stepId) {
      const roleUpdate = await updateRoleState({
        pool,
        redis: params.redis,
        tenantId,
        collabRunId,
        taskId,
        roleName: firstRootRole,
        status: "active",
        currentStepId: String(firstStep.stepId),
        progress: 0,
        metadata: {
          queuedRootStepIds: rootSteps.map((root) => String(root.created.stepId)),
          queuedRootPlanStepIds: rootSteps.map((root) => String(root.pipeline.planStepId)),
        },
        version: stateVersion,
      });
      if (roleUpdate.ok) stateVersion = roleUpdate.newVersion;
    }
  }

  await appendCollabRunEvent({
    pool, tenantId, spaceId, collabRunId: updated.collabRunId, taskId,
    type: "collab.run.queued",
    actorRole: "collab_runtime", runId,
    stepId: firstStep.stepId, correlationId,
    payloadDigest: {
      rootStepCount: rootSteps.length,
      rootStepIds: rootSteps.map((root) => String(root.created.stepId)),
      rootPlanStepIds: rootSteps.map((root) => String(root.pipeline.planStepId)),
      firstStepKind: rootSteps[0]?.pipeline.stepKind ?? (hasRetriever ? "retriever" : "guard"),
      firstToolRef: rootSteps[0]?.pipeline.toolRef ?? (hasRetriever ? retrieverToolRef : guardToolRef),
    },
    proposedBy: "planner",  // P2-5.1: 责任链追溯
    executedBy: "collab_runtime",
  });

  /* -- P2-1.1: 动态协同模式初始化 -- */
  if (dynamicCoordination) {
    // 初始化动态协同状态
    const collabState: DynamicCollabState = {
      collabRunId,
      currentTurn: 0,
      currentRole: null,
      roleHistory: [],
      pendingRoles: ["retriever", "guard", "executor", "reviewer", "arbiter"],
      completedRoles: new Set(),
      roleStats: new Map(),
      replanningInProgress: false,
      rollbackCount: 0,
      maxRollbacks: 3,
    };

    // 决定第一个角色
    const firstTransition = determineNextRole({
      currentRole: null,
      turnOutcome: "continue",
      pendingRoles: collabState.pendingRoles,
      completedRoles: collabState.completedRoles,
    });

    if (firstTransition) {
      // 创建第一个轮次
      const turn = await createCollabTurn({
        pool, tenantId, collabRunId,
        turnNumber: 1,
        actorRole: firstTransition.toRole,
        triggerReason: "collab_started",
        inputDigest: { message, stepCount: planSteps.length },
      });

      // 记录协调事件
      await recordCoordinationEvent({
        pool, tenantId,
        event: {
          eventType: "role.started",
          collabRunId,
          turnNumber: 1,
          actorRole: firstTransition.toRole,
          transition: firstTransition,
          metadata: { turnId: turn.turnId, dynamicCoordination: true },
        },
      });

      // 更新轮次状态为 running
      await updateCollabTurn({
        pool, tenantId,
        turnId: turn.turnId,
        status: "running",
        stepIds: rootSteps.map((root) => root.created.stepId),
      });
    }
  }

  return {
    ok: true,
    retrieverToolRef,
    createdSteps,
    firstStepId: firstStep.stepId,
    updated,
  };
}
