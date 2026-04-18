/**
 * Dispatch — Collab Mode Handler (非流式)
 *
 * 多智能体协作模式：创建 Task + CollabRun，执行规划并入队
 */
import crypto from "node:crypto";
import type { DispatchContext, DispatchResponse } from "./dispatch.schema";
import { buildExecutionReplyText } from "./dispatch.helpers";
import { createOrchestratorTurn } from "./modules/turnRepo";
import { createJobRun } from "../../modules/workflow/jobRepo";
import { upsertTaskState } from "../../modules/memory/repo";
import { runPlanningPipeline } from "../../kernel/planningKernel";
import { createTask } from "../task-manager/modules/taskRepo";
import { requirePermission } from "../../modules/auth/guard";
import { validateToolInput } from "../../modules/tools/validate";
import type { WorkflowQueue } from "../../modules/workflow/queue";
import { admitAndBuildStepEnvelope, buildStepInputPayload, generateIdempotencyKey, resolveAndValidateTool, submitStepToExistingRun } from "../../kernel/executionKernel";

export async function handleCollabMode(ctx: DispatchContext): Promise<DispatchResponse> {
  const { app, req, subject, body, locale, message, conversationId, classification, messageDigest, piSummary, authorization, traceId } = ctx;

  // 创建 Task
  const task = await createTask({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    title: `[协作] ${message.slice(0, 80)}`,
    createdBySubjectId: subject.subjectId,
  });

  // 创建 CollabRun
  const collabRunId = crypto.randomUUID();
  await app.db.query(
    `INSERT INTO collab_runs (tenant_id, collab_run_id, task_id, status, created_by_subject_id)
     VALUES ($1, $2, $3, 'planning', $4)`,
    [subject.tenantId, collabRunId, task.taskId, subject.subjectId]
  );

  // 创建 Job + Run 用于追踪
  const jobRun = await createJobRun({
    pool: app.db,
    tenantId: subject.tenantId,
    jobType: "collab.run",
    runToolRef: "orchestrator.collab@1",
    inputDigest: {
      taskId: task.taskId,
      collabRunId,
      goalDigest: messageDigest,
      mode: "collab",
      constraints: body.constraints ?? null,
    },
    createdBySubjectId: subject.subjectId,
    trigger: "dispatch",
  });

  const runId = jobRun.run.runId;
  const jobId = jobRun.job.jobId;

  // 关联 CollabRun 和 Run
  await app.db.query(
    `UPDATE collab_runs SET primary_run_id = $2 WHERE tenant_id = $1 AND collab_run_id = $3`,
    [subject.tenantId, runId, collabRunId]
  );

  // 初始化任务状态
  await upsertTaskState({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    runId,
    phase: "planning",
    plan: {
      taskId: task.taskId,
      collabRunId,
      goal: message,
      mode: "collab",
        constraints: body.constraints ?? {},
      roles: body.collabConfig?.roles ?? [
        { roleName: "planner", mode: "auto" },
        { roleName: "retriever", mode: "auto" },
        { roleName: "guard", mode: "auto" },
        { roleName: "executor", mode: "auto" },
        { roleName: "reviewer", mode: "auto" },
      ],
    },
  });

  // 注册默认角色
  const defaultRoles = body.collabConfig?.roles ?? [
    { roleName: "planner" },
    { roleName: "retriever" },
    { roleName: "guard" },
    { roleName: "executor" },
    { roleName: "reviewer" },
  ];

  for (const role of defaultRoles) {
    await app.db.query(
      `INSERT INTO collab_agent_roles (tenant_id, collab_run_id, role_name, agent_type, status)
       VALUES ($1, $2, $3, 'llm', 'active')
       ON CONFLICT (tenant_id, collab_run_id, role_name) DO NOTHING`,
      [subject.tenantId, collabRunId, role.roleName]
    );
  }

  // 执行规划
  const planResult = await runPlanningPipeline({
    app,
    pool: app.db,
    subject,
    spaceId: subject.spaceId,
    locale,
    authorization,
    traceId,
    userMessage: message,
    maxSteps: body.constraints?.maxSteps ?? 10,
    purpose: "dispatch.collab",
    plannerRole: "collaborative agent",
    actorRole: "executor",
  });

  let phase = "planning";

  if (planResult.ok && planResult.planSteps.length > 0) {
    phase = "queued";
    await upsertTaskState({
      pool: app.db,
      tenantId: subject.tenantId,
      spaceId: subject.spaceId,
      runId,
      phase,
      plan: {
        taskId: task.taskId,
        collabRunId,
        goal: message,
        mode: "collab",
        constraints: body.constraints ?? {},
        steps: planResult.planSteps,
        stepCount: planResult.planSteps.length,
      },
    });
    const firstPlanStep = planResult.planSteps[0];
    if (firstPlanStep) {
      const resolved = await resolveAndValidateTool({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        rawToolRef: firstPlanStep.toolRef,
      });
      const inputDraft = firstPlanStep.inputDraft ?? {};
      validateToolInput(resolved.version.inputSchema, inputDraft);

      const opDecision = await requirePermission({
        req,
        resourceType: resolved.resourceType,
        action: resolved.action,
      });
      const admitted = await admitAndBuildStepEnvelope({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        resolved,
        opDecision,
      });
      const stepInput = buildStepInputPayload({
        kind: "collab.run.step",
        resolved,
        admitted,
        input: inputDraft,
        idempotencyKey: generateIdempotencyKey({ resolved, prefix: "dispatch-collab", runId, seq: 1 }),
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        subjectId: subject.subjectId,
        traceId,
        extra: { actorRole: "planner", collabRunId },
      });
      const submitResult = await submitStepToExistingRun({
        pool: app.db,
        queue: app.queue as WorkflowQueue,
        tenantId: subject.tenantId,
        resolved,
        opDecision,
        stepInput,
        runId,
        jobId,
        jobType: "collab.run",
        masterKey: app.cfg.secrets.masterKey,
      });
      phase = submitResult.outcome === "needs_approval" ? "needs_approval" : "executing";
      await app.db.query(
        `UPDATE collab_runs SET status = $3, updated_at = now() WHERE tenant_id = $1 AND collab_run_id = $2`,
        [subject.tenantId, collabRunId, phase]
      );
      await upsertTaskState({
        pool: app.db,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        runId,
        stepId: submitResult.stepId,
        phase,
        plan: {
          taskId: task.taskId,
          collabRunId,
          goal: message,
          mode: "collab",
          constraints: body.constraints ?? {},
          steps: planResult.planSteps,
          stepCount: planResult.planSteps.length,
        },
        artifactsDigest: {
          collabRunId,
          ...(submitResult.outcome === "needs_approval" ? { approvalId: submitResult.approvalId ?? null } : { queued: { jobId, stepId: submitResult.stepId } }),
        },
      });
    }
  }

  // 生成基于执行计划的回复文本
  const collabReplyText = buildExecutionReplyText({ locale, userMessage: message, planResult, phase });

  const turn = await createOrchestratorTurn({
    pool: app.db,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId ?? null,
    subjectId: subject.subjectId,
    message: "",
    toolSuggestions: null,
    messageDigest,
    toolSuggestionsDigest: null,
  });

  req.ctx.audit!.outputDigest = {
    mode: "collab",
    turnId: turn.turnId,
    taskId: task.taskId,
    collabRunId,
    runId,
    jobId,
    phase,
    classification: { mode: classification.mode, confidence: classification.confidence, reason: classification.reason },
    planStepCount: planResult.planSteps.length,
    safetySummary: { promptInjection: piSummary },
  };

  return {
    mode: "collab",
    classification,
    conversationId,
    replyText: collabReplyText,
    taskId: task.taskId,
    runId,
    jobId,
    collabRunId,
    phase,
    taskState: {
      phase,
      stepCount: planResult.planSteps.length,
      currentStep: 0,
      needsApproval: phase === "needs_approval",
    },
    turnId: turn.turnId,
  };
}
