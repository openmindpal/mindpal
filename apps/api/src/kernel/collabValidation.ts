/**
 * Collab Orchestrator — 交叉验证 + 动态纠错 + 角色表现评分
 *
 * - runCrossValidationPhase: 相邻Agent两两互验
 * - runDynamicCorrectionPhase: 验证不通过时自动重试
 * - crossValidateAgent: 单对交叉验证
 * - recordRolePerformance / queryRolePerformanceHistory: 角色表现学习
 */
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { LlmSubject } from "../lib/llm";
import { runAgentLoop } from "./agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";
import type { AgentState, CollabResult, CollabOrchestratorParams } from "./collabTypes";
import { writeCollabEnvelope } from "./collabEnvelope";
import { collabConfig } from "@openslin/shared";

// ── 交叉验证执行阶段 ──────────────────────────────────────────

/**
 * P1-4: 在结果汇总阶段执行交叉验证。
 * 相邻 Agent 两两互验：Agent[i] 的输出由 Agent[i+1] 验证。
 */
export async function runCrossValidationPhase(params: {
  agentStates: AgentState[];
  params: CollabOrchestratorParams;
  maxIterationsPerAgent: number;
}): Promise<Array<{ validatedAgent: string; validatorAgent: string; verdict: string; reasoning: string }>> {
  const { agentStates, params: orchestratorParams, maxIterationsPerAgent } = params;
  const doneStates = agentStates.filter(s => s.status === "done" && s.result);
  if (doneStates.length < 2) return [];

  const results: Array<{ validatedAgent: string; validatorAgent: string; verdict: string; reasoning: string }> = [];

  // 相邻 Agent 两两互验
  for (let i = 0; i < doneStates.length - 1; i++) {
    const validated = doneStates[i]!;
    const validator = doneStates[i + 1]!;

    try {
      // 为验证者创建临时 run
      const validatorRunId = crypto.randomUUID();
      const validatorJobId = crypto.randomUUID();
      await orchestratorParams.pool.query(
        `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', now(), now())`,
        [validatorRunId, validatorJobId, orchestratorParams.subject.tenantId],
      );
      await orchestratorParams.pool.query(
        `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
         VALUES ($1, $2, 'collab.cross_validate', $3, $4, $5, 'collab_orchestrator', 'pending', now(), now())`,
        [validatorJobId, orchestratorParams.subject.tenantId, validatorRunId,
         JSON.stringify({ collabRunId: orchestratorParams.collabRunId, validating: validated.agentId }),
         orchestratorParams.subject.subjectId],
      );

      const cv = await crossValidateAgent({
        app: orchestratorParams.app,
        pool: orchestratorParams.pool,
        queue: orchestratorParams.queue,
        subject: orchestratorParams.subject,
        locale: orchestratorParams.locale,
        authorization: orchestratorParams.authorization,
        traceId: orchestratorParams.traceId,
        collabRunId: orchestratorParams.collabRunId,
        validatedAgent: validated,
        validatorAgent: { ...validator, runId: validatorRunId, jobId: validatorJobId },
        maxIterations: maxIterationsPerAgent,
        signal: orchestratorParams.signal,
      });

      results.push({
        validatedAgent: validated.agentId,
        validatorAgent: validator.agentId,
        verdict: cv.verdict,
        reasoning: cv.reasoning,
      });

      orchestratorParams.app.log.info({
        validated: validated.agentId,
        validator: validator.agentId,
        verdict: cv.verdict,
        confidence: cv.confidence,
      }, "[CollabOrchestrator] 交叉验证完成");
    } catch (e: any) {
      orchestratorParams.app.log.warn({ err: e, validated: validated.agentId }, "[CollabOrchestrator] 单对交叉验证失败");
    }
  }

  return results;
}

// ── 动态纠错机制 ──────────────────────────────────────────────

/**
 * P1-2: 动态纠错阶段
 *
 * 当交叉验证结果为 rejected / needs_revision 时：
 * 1. 将验证者的纠错建议注入到失败 Agent 的 goal 中
 * 2. 重新执行该 Agent
 * 3. 再次交叉验证
 * 4. 重复直到通过或达到最大重试次数
 */
export async function runDynamicCorrectionPhase(params: {
  agentStates: AgentState[];
  crossValidationResults: NonNullable<CollabResult["crossValidation"]>;
  params: CollabOrchestratorParams;
  maxIterationsPerAgent: number;
  maxRetries: number;
}): Promise<NonNullable<CollabResult["corrections"]>> {
  const { agentStates, crossValidationResults, params: orchestratorParams, maxIterationsPerAgent, maxRetries } = params;
  const { app, pool, subject } = orchestratorParams;

  const corrections: NonNullable<CollabResult["corrections"]> = [];

  // 找出需要纠错的 Agent
  const needsCorrection = crossValidationResults.filter(
    (cv) => cv.verdict === "rejected" || cv.verdict === "needs_revision",
  );

  if (needsCorrection.length === 0) return corrections;

  app.log.info({
    count: needsCorrection.length,
    agents: needsCorrection.map((cv) => cv.validatedAgent),
  }, "[CollabOrchestrator] 开始动态纠错阶段");

  for (const cv of needsCorrection) {
    const targetState = agentStates.find((s) => s.agentId === cv.validatedAgent);
    const validatorState = agentStates.find((s) => s.agentId === cv.validatorAgent);
    if (!targetState || !validatorState) continue;

    let currentVerdict = cv.verdict;
    let retriesAttempted = 0;
    let corrected = false;
    let lastCorrectionSignature = "";

    for (let retry = 0; retry < maxRetries; retry++) {
      if (orchestratorParams.signal?.aborted) break;

      // 指数退避：第一次重试不延迟，后续按 1s → 2s → 4s → 8s → 10s(cap) 递增
      if (retry > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, retry - 1), 10000);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          if (orchestratorParams.signal) {
            const onAbort = () => { clearTimeout(timer); resolve(); };
            if (orchestratorParams.signal.aborted) { clearTimeout(timer); resolve(); return; }
            orchestratorParams.signal.addEventListener("abort", onAbort, { once: true });
          }
        });
        if (orchestratorParams.signal?.aborted) break;
      }

      retriesAttempted = retry + 1;

      const backoffMs = retry > 0 ? Math.min(1000 * Math.pow(2, retry - 1), 10000) : 0;
      app.log.info({
        event: "collab.correction.retry",
        agentId: targetState.agentId,
        retry: retriesAttempted,
        maxRetries,
        previousVerdict: currentVerdict,
        backoffMs,
      }, "[CollabOrchestrator] 纠错重试");

      // 构建带纠错建议的增强目标
      const correctionGoal = buildCorrectionGoal({
        originalGoal: targetState.goal,
        originalResult: targetState.result?.message ?? "",
        validatorRole: validatorState.role,
        validatorReasoning: cv.reasoning,
        verdict: currentVerdict,
        retryNumber: retriesAttempted,
      });

      // 创建新的 run 进行纠错重试
      const correctionRunId = crypto.randomUUID();
      const correctionJobId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'running', now(), now())`,
        [correctionRunId, correctionJobId, subject.tenantId],
      );
      await pool.query(
        `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
         VALUES ($1, $2, 'collab.correction_retry', $3, $4, $5, 'dynamic_correction', 'running', now(), now())`,
        [correctionJobId, subject.tenantId, correctionRunId,
         JSON.stringify({
           collabRunId: orchestratorParams.collabRunId,
           correctedAgent: targetState.agentId,
           retry: retriesAttempted,
           previousVerdict: currentVerdict,
         }),
         subject.subjectId],
      );

      // 重新执行 Agent
      const correctionResult = await runAgentLoop({
        app, pool, queue: orchestratorParams.queue,
        subject, locale: orchestratorParams.locale,
        authorization: orchestratorParams.authorization,
        traceId: orchestratorParams.traceId,
        goal: correctionGoal,
        runId: correctionRunId,
        jobId: correctionJobId,
        taskId: orchestratorParams.taskId,
        maxIterations: maxIterationsPerAgent,
        signal: orchestratorParams.signal,
      });

      // 更新 Agent 状态（就地修改，供后续流程使用更新后的结果）
      targetState.result = correctionResult;
      targetState.status = correctionResult.ok ? "done" : "failed";

      // 写入纠错结果到 collab_envelopes
      await writeCollabEnvelope({
        pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
        collabRunId: orchestratorParams.collabRunId,
        taskId: orchestratorParams.taskId,
        fromRole: targetState.role,
        toRole: null,
        broadcast: true,
        kind: "agent.correction_result",
        result: correctionResult,
        runId: correctionRunId,
      });

      // 重新交叉验证
      const revalidationRunId = crypto.randomUUID();
      const revalidationJobId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', now(), now())`,
        [revalidationRunId, revalidationJobId, subject.tenantId],
      );
      await pool.query(
        `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
         VALUES ($1, $2, 'collab.revalidation', $3, $4, $5, 'dynamic_correction', 'pending', now(), now())`,
        [revalidationJobId, subject.tenantId, revalidationRunId,
         JSON.stringify({ collabRunId: orchestratorParams.collabRunId, correctedAgent: targetState.agentId, retry: retriesAttempted }),
         subject.subjectId],
      );

      const revalidation = await crossValidateAgent({
        app, pool, queue: orchestratorParams.queue,
        subject, locale: orchestratorParams.locale,
        authorization: orchestratorParams.authorization,
        traceId: orchestratorParams.traceId,
        collabRunId: orchestratorParams.collabRunId,
        validatedAgent: { ...targetState, runId: correctionRunId },
        validatorAgent: { ...validatorState, runId: revalidationRunId, jobId: revalidationJobId },
        maxIterations: Math.min(3, maxIterationsPerAgent),
        signal: orchestratorParams.signal,
      });

      currentVerdict = revalidation.verdict;

      // 基于裁决 + 反馈内容的稳定签名进行"纠错信号未变"检测
      const currentSignature = `${revalidation.verdict}::${revalidation.reasoning}`;
      if (currentSignature === lastCorrectionSignature) {
        app.log.warn({
          event: "collab.correction.goal_unchanged",
          agentId: targetState.agentId,
          retry: retriesAttempted,
          msg: "Correction signal unchanged from previous retry, aborting retry loop",
        }, "[CollabOrchestrator] 纠错信号未变化，中止重试");
        // 仍然记录本轮纠错日志后再中止
        await pool.query(
          `INSERT INTO collab_cross_validation_log
           (tenant_id, collab_run_id, validated_agent, validated_run_id,
            validator_agent, validator_run_id, verdict, confidence, reasoning, revision_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [subject.tenantId, orchestratorParams.collabRunId,
           targetState.agentId, correctionRunId,
           validatorState.agentId, revalidationRunId,
           revalidation.verdict, revalidation.confidence,
           revalidation.reasoning.slice(0, 1000), retriesAttempted],
        ).catch((e: unknown) => {
          app.log.warn({ err: (e as Error)?.message, collabRunId: orchestratorParams.collabRunId }, "[CollabValidation] cross_validation_log insert failed");
        });
        break;
      }
      lastCorrectionSignature = currentSignature;

      // 记录纠错日志到交叉验证表
      await pool.query(
        `INSERT INTO collab_cross_validation_log
         (tenant_id, collab_run_id, validated_agent, validated_run_id,
          validator_agent, validator_run_id, verdict, confidence, reasoning, revision_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [subject.tenantId, orchestratorParams.collabRunId,
         targetState.agentId, correctionRunId,
         validatorState.agentId, revalidationRunId,
         revalidation.verdict, revalidation.confidence,
         revalidation.reasoning.slice(0, 1000), retriesAttempted],
      ).catch((e: unknown) => {
        app.log.warn({ err: (e as Error)?.message, collabRunId: orchestratorParams.collabRunId }, "[CollabValidation] cross_validation_log insert failed");
      });

      app.log.info({
        agentId: targetState.agentId,
        retry: retriesAttempted,
        newVerdict: revalidation.verdict,
        confidence: revalidation.confidence,
      }, "[CollabOrchestrator] 纠错重验证完成");

      if (revalidation.verdict === "approved") {
        corrected = true;
        break;
      }
    }

    app.log.info({
      event: "collab.correction.completed",
      agentId: targetState.agentId,
      originalVerdict: cv.verdict,
      finalVerdict: currentVerdict,
      retriesAttempted,
      corrected,
    }, "[CollabOrchestrator] 单Agent纠错流程完成");

    corrections.push({
      agentId: targetState.agentId,
      originalVerdict: cv.verdict,
      retriesAttempted,
      finalVerdict: currentVerdict,
      corrected,
    });
  }

  app.log.info({
    total: corrections.length,
    corrected: corrections.filter((c) => c.corrected).length,
  }, "[CollabOrchestrator] 动态纠错阶段完成");

  return corrections;
}

/**
 * P1-2: 构建带纠错建议的增强目标
 */
function buildCorrectionGoal(params: {
  originalGoal: string;
  originalResult: string;
  validatorRole: string;
  validatorReasoning: string;
  verdict: string;
  retryNumber: number;
}): string {
  const { originalGoal, originalResult, validatorRole, validatorReasoning, verdict, retryNumber } = params;
  return `${originalGoal}

## ── Correction Required (Attempt ${retryNumber}) ──

Your previous output was reviewed by Agent "${validatorRole}" and was judged as: **${verdict}**.

### Reviewer's Feedback
${validatorReasoning.slice(0, collabConfig("COLLAB_CORRECTION_FEEDBACK_MAX_LEN"))}

### Your Previous Output (Summary)
${originalResult.slice(0, collabConfig("COLLAB_CORRECTION_PREV_OUTPUT_MAX_LEN"))}

### Instructions
- Carefully address the reviewer's feedback
- Fix any errors, omissions, or inaccuracies identified
- Maintain the parts that were correct
- Provide a complete, improved response
- If you disagree with the feedback, explain why with evidence`;
}

// ── 交叉验证 Agent ──────────────────────────────────────────────

/**
 * P1-4: Agent A 的输出由 Agent B 验证质量
 * 在 collectResults 阶段执行，不通过时触发重做
 */
export async function crossValidateAgent(params: {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  collabRunId: string;
  /** 被验证的 Agent */
  validatedAgent: AgentState;
  /** 验证者 Agent */
  validatorAgent: AgentState;
  maxIterations: number;
  signal?: AbortSignal;
}): Promise<{ verdict: "approved" | "rejected" | "needs_revision"; confidence: number; reasoning: string }> {
  const { app, pool, subject, collabRunId, validatedAgent, validatorAgent } = params;

  // 构建验证目标
  const validationGoal = `You are a quality validator. Review the following output from Agent "${validatedAgent.role}":

## Agent's Goal
${validatedAgent.goal}

## Agent's Result
${validatedAgent.result?.message ?? "No message"}
Status: ${validatedAgent.result?.ok ? "succeeded" : "failed"}
Steps: ${(validatedAgent.result?.succeededSteps ?? 0) + (validatedAgent.result?.failedSteps ?? 0)}

## Your Task
Evaluate the quality and completeness of this output. Respond with your assessment.
If the output is satisfactory, confirm it.
If it needs improvement, explain what's missing or incorrect.`;

  // 运行验证者 Agent
  const validatorResult = await runAgentLoop({
    app: params.app,
    pool: params.pool,
    queue: params.queue,
    subject: params.subject,
    locale: params.locale,
    authorization: params.authorization,
    traceId: params.traceId,
    goal: validationGoal,
    runId: validatorAgent.runId,
    jobId: validatorAgent.jobId,
    taskId: "",
    maxIterations: Math.min(3, params.maxIterations),
    signal: params.signal,
  });

  // 从验证者的输出推断结果
  const output = validatorResult.message ?? "";
  const outputLower = output.toLowerCase();
  let verdict: "approved" | "rejected" | "needs_revision" = "approved";
  let confidence = 0.7;

  if (outputLower.includes("reject") || outputLower.includes("fail") || outputLower.includes("拒绝") || outputLower.includes("不通过")) {
    verdict = "rejected";
    confidence = 0.8;
  } else if (outputLower.includes("revis") || outputLower.includes("improv") || outputLower.includes("需要修改") || outputLower.includes("不完整")) {
    verdict = "needs_revision";
    confidence = 0.6;
  }

  // 记录交叉验证日志
  await pool.query(
    `INSERT INTO collab_cross_validation_log (tenant_id, collab_run_id, validated_agent, validated_run_id, validator_agent, validator_run_id, verdict, confidence, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [subject.tenantId, collabRunId, validatedAgent.agentId, validatedAgent.runId,
     validatorAgent.agentId, validatorAgent.runId, verdict, confidence, output.slice(0, 1000)],
  );

  return { verdict, confidence, reasoning: output.slice(0, 500) };
}

// ── 动态角色分配学习 ─────────────────────────────────────────────

/** P1-4: 记录角色表现评分 */
export async function recordRolePerformance(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  agentStates: AgentState[];
  /** 可选：交叉验证结果，用于计算协作分 */
  crossValidation?: Array<{ validatedAgent: string; validatorAgent: string; verdict: string; reasoning: string }>;
  /** 可选：辩论结果，用于计算协作分 */
  debateResult?: { debateId: string; status: string; verdict?: { outcome: string; winnerRole?: string } };
}) {
  for (const state of params.agentStates) {
    const result = state.result;
    const partialEnd = result?.endReason === "max_iterations" || result?.endReason === "max_wall_time";
    const taskCompletion = result?.ok ? 0.9 : (partialEnd ? 0.5 : 0.2);
    const steps = (result?.succeededSteps ?? 0) + (result?.failedSteps ?? 0);
    const efficiency = steps > 0 ? Math.min(1, (result?.succeededSteps ?? 0) / steps) : 0.5;
    const quality = result?.ok ? 0.8 : 0.3;

    // 动态计算协作分：基于交叉验证通过率 + 辩论表现
    let collaborationScore = 0.5; // 基线分
    if (params.crossValidation && params.crossValidation.length > 0) {
      // 作为被验证方：通过=+0.2，拒绝=-0.15，需修订=-0.05
      const asValidated = params.crossValidation.filter(cv => cv.validatedAgent === state.agentId);
      for (const cv of asValidated) {
        if (cv.verdict === "approved") collaborationScore += 0.2;
        else if (cv.verdict === "rejected") collaborationScore -= 0.15;
        else if (cv.verdict === "needs_revision") collaborationScore -= 0.05;
      }
      // 作为验证方：参与验证本身加分
      const asValidator = params.crossValidation.filter(cv => cv.validatorAgent === state.agentId);
      if (asValidator.length > 0) collaborationScore += 0.05;
    }
    if (params.debateResult?.verdict) {
      // 辩论胜出方加分
      if (params.debateResult.verdict.winnerRole === state.role) {
        collaborationScore += 0.15;
      }
    }
    collaborationScore = Math.max(0, Math.min(1, collaborationScore));

    const overall = (taskCompletion * 0.4 + quality * 0.3 + efficiency * 0.2 + collaborationScore * 0.1);

    await params.pool.query(
      `INSERT INTO collab_role_performance (tenant_id, space_id, collab_run_id, agent_id, role, task_completion, quality_score, efficiency_score, collaboration_score, overall_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [params.tenantId, params.spaceId, params.collabRunId, state.agentId, state.role,
       taskCompletion, quality, efficiency, collaborationScore, overall],
    );
  }
}

/** P1-4: 查询角色历史表现（用于赋能角色分配） */
export async function queryRolePerformanceHistory(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  role: string;
  limit?: number;
}): Promise<Array<{ overallScore: number; taskCompletion: number; collabRunId: string }>> {
  const res = await params.pool.query(
    `SELECT overall_score, task_completion, collab_run_id FROM collab_role_performance
     WHERE tenant_id = $1 AND (space_id = $2 OR $2 IS NULL) AND role = $3
     ORDER BY created_at DESC LIMIT $4`,
    [params.tenantId, params.spaceId, params.role, params.limit ?? 10],
  );
  return res.rows.map((r: any) => ({
    overallScore: Number(r.overall_score),
    taskCompletion: Number(r.task_completion),
    collabRunId: String(r.collab_run_id),
  }));
}
