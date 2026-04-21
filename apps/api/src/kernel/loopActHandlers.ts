/**
 * Agent Loop — Act Phase Handlers
 *
 * 从 runAgentLoop switch 块提取的 done / tool_call 处理逻辑，
 * 减少主循环文件行数同时保持语义清晰。
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { GoalGraph, WorldState } from "@openslin/shared";
import { ErrorCategory } from "@openslin/shared";
import type { AgentDecision, StepObservation, ExecutionConstraints } from "./loopTypes";
import type { VerificationResult } from "./verifierAgent";
import { verifyGoalCompletion, verifySimple, verifyStepResult, applyStepVerification } from "./verifierAgent";
import { safeTransitionRun } from "./loopStateHelpers";
import { upsertTaskState } from "../modules/memory/repo";
import { finalizeCheckpoint } from "./loopCheckpoint";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { checkAndEnforceIntentBoundary } from "./intentAnchoringService";
import { executeToolCall, waitForStepCompletion } from "./loopToolExecutor";
import { extractFromObservation, evaluateGoalConditions } from "./worldStateExtractor";

/* ================================================================== */
/*  done action handler                                                 */
/* ================================================================== */

export type DoneActionResult =
  | { outcome: "verified"; verification?: VerificationResult }
  | { outcome: "rejected_replan"; knowledgeFeedback: string };

export async function handleDoneAction(params: {
  app: FastifyInstance;
  pool: Pool;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  runId: string;
  loopId: string;
  goal: string;
  iterations: number;
  maxIterations: number;
  defaultModelRef: string | undefined;
  decision: AgentDecision;
  observations: StepObservation[];
  goalGraph: GoalGraph | null;
  worldState: WorldState | null;
  knowledgeContext: string | undefined;
}): Promise<DoneActionResult> {
  const {
    app, pool, subject, locale, authorization, traceId,
    runId, loopId, goal, iterations, maxIterations, defaultModelRef,
    decision, observations, goalGraph, worldState, knowledgeContext,
  } = params;

  // Verifier 独立校验目标满足性
  let verification: VerificationResult | undefined;
  try {
    if (goalGraph && worldState) {
      verification = await verifyGoalCompletion({
        app, subject, locale, authorization, traceId,
        goalGraph, worldState, observations,
        completionSummary: decision.summary ?? "",
        defaultModelRef,
      });
    } else {
      verification = await verifySimple({
        app, subject, locale, authorization, traceId,
        goal, observations,
        completionSummary: decision.summary ?? "",
        defaultModelRef,
      });
    }
  } catch (vErr: any) {
    app.log.warn({ err: vErr?.message, runId }, "[AgentLoop] Verifier 异常（降级为直接 verified）");
  }

  app.log.info({
    runId, loopId, iteration: iterations,
    verdict: verification?.verdict ?? "no_verifier",
    confidence: verification?.confidence,
  }, "[AgentLoop] Verifier 校验结果");

  // 持久化验证日志
  if (verification) {
    pool.query(
      `INSERT INTO goal_verification_log (tenant_id, run_id, graph_id, loop_id, iteration, verdict, confidence, reasoning, criteria_results, suggested_fixes, missing_info, verified_by_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        subject.tenantId, runId,
        goalGraph?.graphId ?? null, loopId, iterations,
        verification.verdict, verification.confidence,
        verification.reasoning,
        JSON.stringify(verification.criteriaResults),
        verification.suggestedFixes ? JSON.stringify(verification.suggestedFixes) : null,
        verification.missingInfo ? JSON.stringify(verification.missingInfo) : null,
        verification.verifiedByModel ?? null,
      ],
    ).catch((e: any) => {
      app.log.warn({ err: e?.message, runId }, "[AgentLoop] 验证日志持久化失败");
    });
  }

  // Verifier 拒绝且还有迭代余量 → 自动 replan
  if (verification?.verdict === "rejected" && iterations < maxIterations - 1) {
    app.log.info({
      runId, iteration: iterations,
      suggestedFixes: verification.suggestedFixes,
      reasoning: verification.reasoning.slice(0, 200),
    }, "[AgentLoop] Verifier 拒绝 done 声明，自动 replan");
    const verifierFeedback = `[VERIFIER REJECTED] ${verification.reasoning}${verification.suggestedFixes?.length ? "\nSuggested fixes: " + verification.suggestedFixes.join("; ") : ""}`;
    return { outcome: "rejected_replan", knowledgeFeedback: (knowledgeContext ?? "") + "\n\n" + verifierFeedback };
  }

  // Verifier 通过或无法判定 → 正常完成
  await safeTransitionRun(pool, runId, "succeeded", { finishedAt: true, log: app.log });
  await upsertTaskState({
    pool,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    runId,
    phase: "succeeded",
    clearBlockReason: true,
    clearNextAction: true,
    clearApprovalStatus: true,
  });
  await finalizeCheckpoint(pool, loopId, "succeeded").catch((e: unknown) => {
    app.log.warn({ err: (e as Error)?.message, loopId }, "[AgentLoop] finalizeCheckpoint(succeeded) failed");
  });
  return { outcome: "verified", verification };
}

/* ================================================================== */
/*  tool_call action handler                                            */
/* ================================================================== */

export type ToolCallActionResult =
  | { outcome: "boundary_paused"; reason: string }
  | { outcome: "validation_failed"; failObs: StepObservation }
  | { outcome: "executed"; obs: StepObservation; succeeded: boolean; worldState: WorldState | null; goalGraph: GoalGraph | null; stepVerification?: import("./verifierAgent").StepVerificationResult };

export async function handleToolCallAction(params: {
  app: FastifyInstance;
  pool: Pool;
  queue: any;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  traceId: string | null;
  runId: string;
  jobId: string;
  loopId: string;
  goal: string;
  iterations: number;
  decision: AgentDecision;
  currentSeq: number;
  executionConstraints: ExecutionConstraints | undefined;
  signal: AbortSignal | undefined;
  worldState: WorldState | null;
  goalGraph: GoalGraph | null;
}): Promise<ToolCallActionResult> {
  const {
    app, pool, queue, subject, traceId, runId, jobId, loopId,
    goal, iterations, decision, currentSeq, executionConstraints, signal, goalGraph,
  } = params;
  let { worldState } = params;

  // 意图边界检查
  const proposedAction = `Execute tool ${decision.toolRef} with input: ${JSON.stringify(decision.inputDraft ?? {}).slice(0, 200)}`;
  const boundaryCheck = await checkAndEnforceIntentBoundary({
    pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
    subjectId: subject.subjectId, runId, stepId: null,
    proposedAction,
    currentContext: `Iteration ${iterations}, Goal: ${goal.slice(0, 100)}`,
  });

  if (boundaryCheck.isViolation && boundaryCheck.shouldPause) {
    app.log.warn({
      runId, iteration: iterations,
      violationType: boundaryCheck.violation?.violationType,
      reason: boundaryCheck.reason,
    }, "[AgentLoop] 检测到意图边界违例，触发熔断");

    await insertAuditEvent(pool, {
      tenantId: subject.tenantId, spaceId: subject.spaceId,
      subjectId: subject.subjectId,
      resourceType: "intent_boundary", action: "violation_detected",
      inputDigest: { proposedAction, decision },
      outputDigest: { violation: boundaryCheck.violation, reason: boundaryCheck.reason },
      result: "denied", traceId: traceId ?? "",
    }).catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, runId }, "[AgentLoop] audit event for intent_boundary failed");
    });

    await safeTransitionRun(pool, runId, "paused", { log: app.log });
    await upsertTaskState({
      pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
      runId, phase: "paused",
      blockReason: `intent_boundary_violation: ${boundaryCheck.reason}`,
      nextAction: "waiting_for_admin_review",
    });
    await finalizeCheckpoint(pool, loopId, "paused").catch((e: unknown) => {
      app.log.warn({ err: (e as Error)?.message, loopId }, "[AgentLoop] finalizeCheckpoint(paused) failed");
    });
    return { outcome: "boundary_paused", reason: boundaryCheck.reason ?? "intent_boundary_violation" };
  }

  // 执行工具调用
  const execResult = await executeToolCall({
    app, pool, queue,
    tenantId: subject.tenantId, spaceId: subject.spaceId,
    subjectId: subject.subjectId, traceId, runId, jobId,
    decision, seq: currentSeq, executionConstraints,
  });

  if (!execResult.ok) {
    const failObs: StepObservation = {
      stepId: "", seq: currentSeq, toolRef: decision.toolRef ?? "",
      status: "failed", outputDigest: { error: execResult.error },
      output: null, errorCategory: ErrorCategory.INPUT_VALIDATION_FAILED, durationMs: null,
    };
    app.log.warn({ runId, toolRef: decision.toolRef, error: execResult.error }, "[AgentLoop] 工具验证失败");
    return { outcome: "validation_failed", failObs };
  }

  // 等待步骤执行完成
  const stepResult = await waitForStepCompletion(pool, execResult.stepId, signal, execResult.executionTimeoutMs);

  const obs: StepObservation = {
    stepId: execResult.stepId, seq: currentSeq,
    toolRef: decision.toolRef ?? "", status: stepResult.status,
    outputDigest: stepResult.outputDigest, output: stepResult.output ?? null,
    errorCategory: stepResult.errorCategory, durationMs: null,
  };

  // WorldState 增量提取
  let updatedGoalGraph = goalGraph;
  if (worldState) {
    worldState = extractFromObservation(obs, worldState);
    if (updatedGoalGraph) updatedGoalGraph = evaluateGoalConditions(updatedGoalGraph, worldState);
  }

  // 行动验证：单步执行结果校验
  let stepVerification: import("./verifierAgent").StepVerificationResult | undefined;
  if (updatedGoalGraph && worldState) {
    stepVerification = verifyStepResult({ observation: obs, goalGraph: updatedGoalGraph, worldState });
    if (stepVerification.passed && stepVerification.matchedGoalId) {
      updatedGoalGraph = applyStepVerification(updatedGoalGraph, stepVerification, obs);
      app.log.info({
        runId, stepId: execResult.stepId, goalId: stepVerification.matchedGoalId,
        passed: true, evidence: stepVerification.evidence.length,
      }, "[AgentLoop] 步骤验证通过，目标节点标记完成");
    } else if (!stepVerification.passed && stepVerification.matchedGoalId) {
      app.log.info({
        runId, stepId: execResult.stepId, goalId: stepVerification.matchedGoalId,
        passed: false, failedCriteria: stepVerification.failedCriteria,
      }, "[AgentLoop] 步骤验证未通过（留待主循环决策是否重试）");
    }
  }

  return { outcome: "executed", obs, succeeded: stepResult.status === "succeeded", worldState, goalGraph: updatedGoalGraph, stepVerification };
}
