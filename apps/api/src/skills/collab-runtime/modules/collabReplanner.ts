/**
 * P2-2: 协作失败重规划机制
 * 
 * 当以下情况发生时触发重规划：
 * - 执行失败（step failed）
 * - 证据不足（evidence score 低于阈值）
 * - Reviewer 不认可
 * - Guard 拦截
 * 
 * 重规划策略：
 * - 部分重规划：仅重新规划失败的部分
 * - 完全重规划：从头开始重新规划
 * - 降级策略：使用更保守的工具或方法
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { FailureDiagnosis, WorldState } from "@openslin/shared";
import { runPlanningPipeline, type PlanStep } from "../../../kernel/planningKernel";
import { type RoleName, shouldTriggerReplan, recordCoordinationEvent } from "./dynamicCoordinator";
import { verifySimple, evaluateReplanFeasibility, type VerificationResult, type FeasibilityResult } from "../../../kernel/verifierAgent";
import { invokeModelChat, type LlmSubject } from "../../../lib/llm";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type ReplanTrigger = 
  | "step_failed"
  | "evidence_insufficient"
  | "guard_rejected"
  | "reviewer_rejected"
  | "timeout"
  | "max_retries_exceeded"
  | "manual_request";

export type ReplanStrategy = 
  | "partial"      // 仅重规划失败部分
  | "full"         // 完全重规划
  | "degraded"     // 降级策略
  | "abort";       // 放弃执行

export interface ReplanContext {
  collabRunId: string;
  taskId: string;
  runId: string;
  trigger: ReplanTrigger;
  failedStepId?: string;
  failedToolRef?: string;
  failureCount: number;
  evidenceScore?: number;
  guardReason?: string;
  reviewerFeedback?: string;
  previousPlanSteps: PlanStep[];
  completedStepIds: string[];
  originalMessage: string;
  /** P0 阶段一：失败诊断结果，供后续策略自适应使用 */
  diagnosis?: FailureDiagnosis;
  /** P0 阶段二：当前世界状态快照，用于向 LLM 提供实体/事实摘要 */
  worldState?: WorldState;
}

export interface GuardReviewResult {
  /** 审查是否通过 */
  passed: boolean;
  /** 审查推理 */
  reasoning: string;
  /** 被 guard 剔除的步骤索引 */
  rejectedStepIndices: number[];
  /** 风险评估等级 */
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface ReplanResult {
  ok: boolean;
  strategy: ReplanStrategy;
  newPlanSteps: PlanStep[];
  removedStepCount: number;
  message: string;
  degradationApplied?: boolean;
  /** 是否需要人工确认 */
  requiresConfirmation?: boolean;
  /** Guard 审查结果 */
  guardReview?: GuardReviewResult;
  /** Verifier 目标一致性校验结果 */
  verification?: VerificationResult;
  /** 是否已触发 escalate */
  escalated?: boolean;
  /** 可行性预检结果（可选） */
  feasibility?: FeasibilityResult;
}

/** 重规划经验片段：记录一次诊断→策略→结果的闭环 */
export interface ReplanEpisode {
  traceId: string;
  diagnosis: FailureDiagnosis;
  strategy: string;
  outcome: "success" | "failure";
  feasibilityScore?: number;
  timestamp: string;
}

export interface ReplanConfig {
  /** 最大重规划次数 */
  maxReplanAttempts: number;
  /** 触发完全重规划的连续失败次数 */
  fullReplanThreshold: number;
  /** 最小证据分数阈值 */
  minEvidenceScore: number;
  /** 启用降级策略 */
  enableDegradation: boolean;
  /** 降级时排除的高风险工具 */
  degradedExcludeTools: string[];
  /** 是否在重规划前需要人工确认 */
  requireConfirmationBeforeReplan: boolean;
  /** 启用 guard 审查闭环（默认 true） */
  enableGuardReview: boolean;
  /** 启用 verifier 目标一致性校验（默认 true） */
  enableVerification: boolean;
  /** 连续 replan 失败触发 escalate 的阈值 */
  consecutiveFailureEscalateThreshold: number;
}

export const DEFAULT_REPLAN_CONFIG: ReplanConfig = {
  maxReplanAttempts: 3,
  fullReplanThreshold: 2,
  minEvidenceScore: 0.5,
  enableDegradation: true,
  degradedExcludeTools: ["delete", "drop", "truncate", "destroy"],
  requireConfirmationBeforeReplan: false,
  enableGuardReview: true,
  enableVerification: true,
  consecutiveFailureEscalateThreshold: 3,
};

/* ================================================================== */
/*  Replan Strategy Selection                                            */
/* ================================================================== */

/**
 * 根据上下文选择重规划策略
 *
 * 优先级：abort 硬上限 → 诊断驱动 → 连续同类失败升级 → 硬阈值兜底
 */
export function selectReplanStrategy(params: {
  context: ReplanContext;
  config: ReplanConfig;
  replanAttempts: number;
}): ReplanStrategy {
  const { context, config, replanAttempts } = params;

  // 硬上限：超过最大重规划次数，放弃
  if (replanAttempts >= config.maxReplanAttempts) {
    return "abort";
  }

  /* ── 诊断驱动（新增） ── */
  const { diagnosis } = context;
  if (diagnosis) {
    const diagStrategy = mapDiagnosisToStrategy(diagnosis);
    if (diagStrategy) return diagStrategy;
  }

  /* ── 连续同类失败升级（新增） ── */
  // 连续 >= consecutiveFailureEscalateThreshold 次同类失败 → 升级到 abort
  if (context.failureCount >= config.consecutiveFailureEscalateThreshold) {
    return "abort";
  }

  /* ── 硬阈值兜底（保留现有逻辑） ── */

  // Guard 拦截或 Reviewer 不认可，且启用降级
  if ((context.trigger === "guard_rejected" || context.trigger === "reviewer_rejected") && config.enableDegradation) {
    return "degraded";
  }

  // 连续失败达到阈值，完全重规划
  if (context.failureCount >= config.fullReplanThreshold) {
    return "full";
  }

  // 证据不足，需要重新检索
  if (context.trigger === "evidence_insufficient") {
    return "partial";
  }

  // 默认部分重规划
  return "partial";
}

/**
 * 将诊断结果映射为重规划策略；返回 undefined 表示诊断无法决定，回落到后续逻辑。
 */
function mapDiagnosisToStrategy(diagnosis: FailureDiagnosis): ReplanStrategy | undefined {
  switch (diagnosis.failureType) {
    case "permission_denied":
    case "tool_unavailable":
      return "degraded";
    case "precondition_unmet":
      if (diagnosis.isRetryable) return "partial";
      break;
    case "timeout":
      return "partial";
    case "environment_changed":
      return "full";
    default:
      break;
  }
  return undefined;
}

/* ================================================================== */
/*  Replan Execution                                                     */
/* ================================================================== */

/**
 * 执行重规划
 */
export async function executeReplan(params: {
  app: FastifyInstance;
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  context: ReplanContext;
  config?: Partial<ReplanConfig>;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  replanAttempts: number;
}): Promise<ReplanResult> {
  const { app, pool, tenantId, spaceId, subject, context, locale, authorization, traceId, replanAttempts } = params;
  const config = { ...DEFAULT_REPLAN_CONFIG, ...params.config };
  
  // 选择策略
  const strategy = selectReplanStrategy({ context, config, replanAttempts });
  
  // 放弃策略
  if (strategy === "abort") {
    return {
      ok: false,
      strategy: "abort",
      newPlanSteps: [],
      removedStepCount: 0,
      message: `重规划次数已达上限 (${replanAttempts}/${config.maxReplanAttempts})，建议人工介入`,
      requiresConfirmation: true,
    };
  }
  
  // 记录重规划开始事件
  await recordCoordinationEvent({
    pool,
    tenantId,
    event: {
      eventType: "collab.replan.started",
      collabRunId: context.collabRunId,
      turnNumber: 0,
      actorRole: "planner",
      metadata: { trigger: context.trigger, strategy, replanAttempts, failedStepId: context.failedStepId },
    },
  });
  
  let newPlanSteps: PlanStep[] = [];
  let removedStepCount = 0;
  let degradationApplied = false;
  
  try {
    if (strategy === "partial") {
      // 部分重规划：保留已完成的步骤，只重新规划剩余部分
      const remainingMessage = buildPartialReplanMessage(context);
      
      const planResult = await runPlanningPipeline({
        app,
        pool,
        subject,
        spaceId,
        locale,
        authorization,
        traceId,
        userMessage: remainingMessage,
        purpose: "collab-runtime.replan.partial",
        plannerRole: "collaborative agent",
      });
      
      newPlanSteps = planResult.planSteps;
      removedStepCount = context.previousPlanSteps.length - context.completedStepIds.length;
      
    } else if (strategy === "full") {
      // 完全重规划：从头开始
      const fullReplanMessage = buildFullReplanMessage(context);
      
      const planResult = await runPlanningPipeline({
        app,
        pool,
        subject,
        spaceId,
        locale,
        authorization,
        traceId,
        userMessage: fullReplanMessage,
        purpose: "collab-runtime.replan.full",
        plannerRole: "collaborative agent",
      });
      
      newPlanSteps = planResult.planSteps;
      removedStepCount = context.previousPlanSteps.length;
      
    } else if (strategy === "degraded") {
      // 降级策略：排除高风险工具，使用更保守的方法
      const degradedMessage = buildDegradedReplanMessage(context, config.degradedExcludeTools);
      
      const planResult = await runPlanningPipeline({
        app,
        pool,
        subject,
        spaceId,
        locale,
        authorization,
        traceId,
        userMessage: degradedMessage,
        purpose: "collab-runtime.replan.degraded",
        plannerRole: "conservative agent",
      });
      
      // 过滤掉排除的工具
      newPlanSteps = planResult.planSteps.filter(step => {
        const toolName = step.toolRef.split("@")[0] ?? "";
        return !config.degradedExcludeTools.some(excluded => 
          toolName.toLowerCase().includes(excluded.toLowerCase())
        );
      });
      
      removedStepCount = context.previousPlanSteps.length;
      degradationApplied = true;
    }
    
    // 记录重规划完成事件
    await recordCoordinationEvent({
      pool,
      tenantId,
      event: {
        eventType: "collab.replan.completed",
        collabRunId: context.collabRunId,
        turnNumber: 0,
        actorRole: "planner",
        metadata: { 
          strategy, 
          newStepCount: newPlanSteps.length, 
          removedStepCount,
          degradationApplied,
        },
      },
    });
    
    /* ────────────────────────────────────────────── */
    /*  Guard 审查闭环                                */
    /* ────────────────────────────────────────────── */
    let guardReview: GuardReviewResult | undefined;
    if (config.enableGuardReview && newPlanSteps.length > 0) {
      const gr = await reviewNewPlanWithGuard({
        app,
        subject: { tenantId, spaceId, subjectId: subject.subjectId },
        locale,
        authorization,
        traceId,
        newPlanSteps,
        originalMessage: context.originalMessage,
        strategy,
        trigger: context.trigger,
      });
      guardReview = gr;

      await recordCoordinationEvent({
        pool,
        tenantId,
        event: {
          eventType: "collab.replan.guard_review" as any,
          collabRunId: context.collabRunId,
          turnNumber: 0,
          actorRole: "guard",
          metadata: {
            passed: gr.passed,
            riskLevel: gr.riskLevel,
            rejectedCount: gr.rejectedStepIndices.length,
          },
        },
      });

      // Guard 拒绝：高风险计划不允许执行
      if (!gr.passed) {
        return {
          ok: false,
          strategy,
          newPlanSteps: [],
          removedStepCount,
          message: `Guard 审查未通过: ${gr.reasoning}`,
          degradationApplied,
          guardReview: gr,
          requiresConfirmation: true,
        };
      }

      // Guard 部分拒绝：移除被拒绝的步骤
      if (gr.rejectedStepIndices.length > 0) {
        const rejected = new Set(gr.rejectedStepIndices);
        newPlanSteps = newPlanSteps.filter((_, i) => !rejected.has(i));
      }
    }

    /* ────────────────────────────────────────────── */
    /*  Verifier 目标一致性校验                        */
    /* ────────────────────────────────────────────── */
    let verification: VerificationResult | undefined;
    if (config.enableVerification && newPlanSteps.length > 0) {
      const vr = await verifyReplanConsistency({
        app,
        subject: { tenantId, spaceId, subjectId: subject.subjectId },
        locale,
        authorization,
        traceId,
        newPlanSteps,
        originalMessage: context.originalMessage,
        strategy,
      });
      verification = vr;

      await recordCoordinationEvent({
        pool,
        tenantId,
        event: {
          eventType: "collab.replan.verified" as any,
          collabRunId: context.collabRunId,
          turnNumber: 0,
          actorRole: "verifier" as any,
          metadata: {
            verdict: vr.verdict,
            confidence: vr.confidence,
          },
        },
      });

      // Verifier 明确拒绝且置信度高
      if (vr.verdict === "rejected" && vr.confidence >= 0.7) {
        return {
          ok: false,
          strategy,
          newPlanSteps: [],
          removedStepCount,
          message: `Verifier 校验未通过: ${vr.reasoning}`,
          degradationApplied,
          guardReview,
          verification: vr,
          requiresConfirmation: true,
        };
      }
    }

    /* ────────────────────────────────────────────── */
    /*  可行性预检 + ReplanEpisode 记录               */
    /* ────────────────────────────────────────────── */
    let feasibility: FeasibilityResult | undefined;
    if (newPlanSteps.length > 0) {
      // 收集当前可用工具列表（从新计划步骤中提取，作为基线）
      const knownTools = Array.from(new Set(
        context.previousPlanSteps.map(s => s.toolRef.split("@")[0] ?? s.toolRef)
      ));
      feasibility = evaluateReplanFeasibility(newPlanSteps, knownTools);
    }

    // 记录 ReplanEpisode（仅当存在诊断信息时）
    if (context.diagnosis) {
      const episode: ReplanEpisode = {
        traceId: traceId ?? context.collabRunId,
        diagnosis: context.diagnosis,
        strategy,
        outcome: newPlanSteps.length > 0 ? "success" : "failure",
        feasibilityScore: feasibility?.score,
        timestamp: new Date().toISOString(),
      };
      await recordCoordinationEvent({
        pool,
        tenantId,
        event: {
          eventType: "collab.replan.episode" as any,
          collabRunId: context.collabRunId,
          turnNumber: 0,
          actorRole: "planner",
          metadata: episode as any,
        },
      });

      // P0: 持久化重规划经验片段到 replan_episodes 表，用于后续 few-shot 学习
      try {
        await pool.query(
          `INSERT INTO replan_episodes (tenant_id, trace_id, collab_run_id, diagnosis, strategy, outcome, feasibility_score)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [
            tenantId,
            traceId ?? "",
            context.collabRunId ?? null,
            JSON.stringify(context.diagnosis),
            strategy,
            newPlanSteps.length > 0 ? "success" : "failure",
            feasibility?.score ?? null,
          ],
        );
      } catch (episodeErr) {
        // episode 记录失败不影响重规划主流程
        app.log.warn?.({ err: episodeErr }, "[Replanner] replan episode record failed, non-blocking");
      }
    }

    return {
      ok: newPlanSteps.length > 0,
      strategy,
      newPlanSteps,
      removedStepCount,
      message: newPlanSteps.length > 0 
        ? `重规划完成：策略=${strategy}，新步骤=${newPlanSteps.length}` 
        : "重规划未产生有效步骤",
      degradationApplied,
      guardReview,
      verification,
      feasibility,
      requiresConfirmation: config.requireConfirmationBeforeReplan,
    };
    
  } catch (err: any) {
    return {
      ok: false,
      strategy,
      newPlanSteps: [],
      removedStepCount: 0,
      message: `重规划失败: ${err?.message ?? "Unknown error"}`,
    };
  }
}

/* ================================================================== */
/*  Message Builders                                                     */
/* ================================================================== */

/**
 * 构建部分重规划的消息
 *
 * 包含：已完成步骤摘要 + 失败信息 + 诊断摘要 + WorldState 实体/事实摘要
 */
function buildPartialReplanMessage(context: ReplanContext): string {
  const completedSteps = context.previousPlanSteps.filter(
    step => context.completedStepIds.includes(step.stepId)
  );
  
  const completedSummary = completedSteps.length > 0
    ? "\n\n已完成的步骤:\n" + completedSteps.map(s => "- " + s.toolRef).join("\n")
    : "";
  
  let failureInfo = "";
  if (context.failedToolRef) {
    failureInfo = `\n\n失败的工具: ${context.failedToolRef}`;
  }
  if (context.guardReason) {
    failureInfo += `\nGuard 拦截原因: ${context.guardReason}`;
  }
  if (context.reviewerFeedback) {
    failureInfo += `\nReviewer 反馈: ${context.reviewerFeedback}`;
  }

  /* ── 诊断摘要（新增） ── */
  let diagnosisSummary = "";
  if (context.diagnosis) {
    const d = context.diagnosis;
    diagnosisSummary = `\n\n失败诊断:
- 故障类型: ${d.failureType}
- 根因: ${d.rootCause}
- 可重试: ${d.isRetryable ? "是" : "否"}`;
    if (d.suggestedActions.length > 0) {
      diagnosisSummary += `\n- 建议动作: ${d.suggestedActions.map(a => a.type).join(", ")}`;
    }
  }

  /* ── WorldState 实体 + 事实摘要（新增，限制 token 膨胀） ── */
  let worldStateSummary = "";
  if (context.worldState) {
    const ws = context.worldState;
    const entityEntries = Object.values(ws.entities);
    const topEntities = entityEntries.slice(0, 5);
    const topFacts = ws.facts.slice(0, 10);
    if (topEntities.length > 0 || topFacts.length > 0) {
      worldStateSummary = "\n\n当前环境状态:";
      if (topEntities.length > 0) {
        worldStateSummary += "\n实体:\n" + topEntities.map(e => `- [${e.category}] ${e.name}`).join("\n");
        if (entityEntries.length > 5) worldStateSummary += `\n  (... 共 ${entityEntries.length} 个实体)`;
      }
      if (topFacts.length > 0) {
        worldStateSummary += "\n事实:\n" + topFacts.map(f => `- ${f.key}: ${f.value}`).join("\n");
        if (ws.facts.length > 10) worldStateSummary += `\n  (... 共 ${ws.facts.length} 个事实)`;
      }
    }
  }
  
  return `请重新规划以下任务的剩余步骤，避免之前失败的方法:

原始任务: ${context.originalMessage}
${completedSummary}
${failureInfo}
${diagnosisSummary}
${worldStateSummary}

请提供替代方案，使用不同的工具或方法来完成任务。`;
}

/**
 * 构建完全重规划的消息
 */
function buildFullReplanMessage(context: ReplanContext): string {
  let failureContext = "";
  if (context.failureCount > 0) {
    failureContext = `\n\n注意: 之前的计划已失败 ${context.failureCount} 次。`;
  }
  if (context.guardReason) {
    failureContext += `\n被 Guard 拦截: ${context.guardReason}`;
  }
  if (context.reviewerFeedback) {
    failureContext += `\nReviewer 反馈: ${context.reviewerFeedback}`;
  }
  
  return `请重新从头规划以下任务，采用更稳健的方案:

任务: ${context.originalMessage}
${failureContext}

请提供一个更可靠的执行计划。`;
}

/**
 * 构建降级重规划的消息
 */
function buildDegradedReplanMessage(context: ReplanContext, excludeTools: string[]): string {
  return `请使用保守策略重新规划以下任务:

任务: ${context.originalMessage}

约束条件:
- 避免使用高风险操作（如 ${excludeTools.join(", ")}）
- 优先使用只读或低风险的工具
- 如果无法安全完成，请说明原因

${context.guardReason ? `安全提示: ${context.guardReason}` : ""}`;
}

/* ================================================================== */
/*  Replan Decision Helper                                               */
/* ================================================================== */

/**
 * 评估是否应该触发重规划
 */
export function evaluateReplanNeed(params: {
  stepStatus: string;
  stepAttempts: number;
  maxStepAttempts: number;
  evidenceScore?: number;
  guardResult?: { allowed: boolean; reason?: string };
  reviewerResult?: { approved: boolean; feedback?: string };
  config?: Partial<ReplanConfig>;
}): { needsReplan: boolean; trigger: ReplanTrigger; reason: string } {
  const config = { ...DEFAULT_REPLAN_CONFIG, ...params.config };
  const { stepStatus, stepAttempts, maxStepAttempts, evidenceScore, guardResult, reviewerResult } = params;
  
  // 步骤失败且超过最大重试次数
  if (stepStatus === "failed" && stepAttempts >= maxStepAttempts) {
    return { needsReplan: true, trigger: "max_retries_exceeded", reason: `步骤重试 ${stepAttempts} 次仍失败` };
  }
  
  // Guard 拦截
  if (guardResult && !guardResult.allowed) {
    return { needsReplan: true, trigger: "guard_rejected", reason: guardResult.reason ?? "Guard 拦截" };
  }
  
  // Reviewer 不认可
  if (reviewerResult && !reviewerResult.approved) {
    return { needsReplan: true, trigger: "reviewer_rejected", reason: reviewerResult.feedback ?? "Reviewer 不认可" };
  }
  
  // 证据不足
  if (evidenceScore !== undefined && evidenceScore < config.minEvidenceScore) {
    return { needsReplan: true, trigger: "evidence_insufficient", reason: `证据分数 ${evidenceScore.toFixed(2)} 低于阈值` };
  }
  
  return { needsReplan: false, trigger: "step_failed", reason: "" };
}

/* ================================================================== */
/*  Replan State Persistence                                             */
/* ================================================================== */

export interface ReplanRecord {
  replanId: string;
  collabRunId: string;
  trigger: ReplanTrigger;
  strategy: ReplanStrategy;
  previousStepCount: number;
  newStepCount: number;
  success: boolean;
  message: string;
  createdAt: string;
}

/**
 * 记录重规划历史
 */
export async function recordReplanAttempt(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  trigger: ReplanTrigger;
  strategy: ReplanStrategy;
  previousStepCount: number;
  newStepCount: number;
  success: boolean;
  message: string;
}): Promise<ReplanRecord> {
  const { pool, tenantId, collabRunId, trigger, strategy, previousStepCount, newStepCount, success, message } = params;
  
  const res = await pool.query<{ replan_id: string; created_at: string }>(
    `INSERT INTO collab_replan_history 
     (tenant_id, collab_run_id, trigger, strategy, previous_step_count, new_step_count, success, message, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     RETURNING replan_id, created_at`,
    [tenantId, collabRunId, trigger, strategy, previousStepCount, newStepCount, success, message]
  );
  
  return {
    replanId: res.rows[0].replan_id,
    collabRunId,
    trigger,
    strategy,
    previousStepCount,
    newStepCount,
    success,
    message,
    createdAt: res.rows[0].created_at,
  };
}

/**
 * 获取重规划历史
 */
export async function getReplanHistory(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
}): Promise<ReplanRecord[]> {
  const { pool, tenantId, collabRunId } = params;
  
  const res = await pool.query<{
    replan_id: string;
    collab_run_id: string;
    trigger: string;
    strategy: string;
    previous_step_count: number;
    new_step_count: number;
    success: boolean;
    message: string;
    created_at: string;
  }>(
    `SELECT * FROM collab_replan_history 
     WHERE tenant_id = $1 AND collab_run_id = $2 
     ORDER BY created_at ASC`,
    [tenantId, collabRunId]
  );
  
  return res.rows.map(row => ({
    replanId: row.replan_id,
    collabRunId: row.collab_run_id,
    trigger: row.trigger as ReplanTrigger,
    strategy: row.strategy as ReplanStrategy,
    previousStepCount: row.previous_step_count,
    newStepCount: row.new_step_count,
    success: row.success,
    message: row.message,
    createdAt: row.created_at,
  }));
}

/**
 * 获取重规划次数
 */
export async function getReplanAttemptCount(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
}): Promise<number> {
  const { pool, tenantId, collabRunId } = params;
  
  const res = await pool.query<{ count: string }>(
    "SELECT COUNT(*) as count FROM collab_replan_history WHERE tenant_id = $1 AND collab_run_id = $2",
    [tenantId, collabRunId]
  );
  
  return parseInt(res.rows[0]?.count ?? "0", 10);
}

/* ================================================================== */
/*  Guard 审查闭环：对 replan 产出的新步骤进行安全/合规审查         */
/* ================================================================== */

/**
 * 通过独立 LLM 调用（guard purpose）审查重规划产出的新步骤。
 * 检查要点：
 *  - 是否包含破坏性/不可逆操作
 *  - 是否超出任务范围
 *  - 是否重复已失败的策略
 */
async function reviewNewPlanWithGuard(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  newPlanSteps: PlanStep[];
  originalMessage: string;
  strategy: ReplanStrategy;
  trigger: ReplanTrigger;
}): Promise<GuardReviewResult> {
  const { app, subject, locale, authorization, traceId, newPlanSteps, originalMessage, strategy, trigger } = params;

  // 环境变量开关
  if ((process.env.REPLAN_GUARD_REVIEW ?? "1") === "0") {
    return { passed: true, reasoning: "Guard review disabled", rejectedStepIndices: [], riskLevel: "low" };
  }

  const stepsDesc = newPlanSteps.map((s, i) =>
    `[${i}] toolRef=${s.toolRef}, approvalRequired=${!!s.approvalRequired}, desc=${(s as any).description ?? ""}`
  ).join("\n");

  const systemPrompt = `You are a Safety Guard reviewing a re-planned execution plan.
Your job is to identify any dangerous, destructive, or out-of-scope steps.

Reply with EXACTLY ONE JSON block:
\`\`\`guard_review
{
  "passed": true|false,
  "reasoning": "...",
  "rejectedStepIndices": [0, 2],
  "riskLevel": "low|medium|high|critical"
}
\`\`\`

Rules:
- "passed": false ONLY if the entire plan is unacceptable (critical risk)
- "rejectedStepIndices": indices of individual steps that should be removed
- "riskLevel": overall assessment
- Be pragmatic—partial plans with low-risk steps should pass`;

  const userPrompt = `## Original Task
${originalMessage}

## Replan Context
Trigger: ${trigger} | Strategy: ${strategy}

## New Plan Steps (${newPlanSteps.length})
${stepsDesc}

Review this plan for safety and scope compliance.`;

  try {
    const llmResult = await invokeModelChat({
      app, subject, locale, authorization, traceId,
      purpose: "collab.replan.guard",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    return parseGuardReviewOutput(llmResult.outputText ?? "");
  } catch (err: any) {
    // LLM 失败不阻塞流程，降级为通过
    app.log.warn({ err: err?.message }, "[Replan Guard] LLM review failed, defaulting to pass");
    return { passed: true, reasoning: `Guard LLM failed: ${err?.message}`, rejectedStepIndices: [], riskLevel: "medium" };
  }
}

/** 解析 Guard 审查 LLM 输出 */
function parseGuardReviewOutput(output: string): GuardReviewResult {
  const blockMatch = output.match(/```guard_review\s*\n?([\s\S]*?)```/);
  const jsonStr = blockMatch ? blockMatch[1].trim() : output.trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { passed: true, reasoning: "Could not parse guard output, defaulting to pass", rejectedStepIndices: [], riskLevel: "medium" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const validRisks = ["low", "medium", "high", "critical"] as const;
    return {
      passed: typeof parsed.passed === "boolean" ? parsed.passed : true,
      reasoning: String(parsed.reasoning ?? ""),
      rejectedStepIndices: Array.isArray(parsed.rejectedStepIndices)
        ? parsed.rejectedStepIndices.filter((i: any) => typeof i === "number" && i >= 0)
        : [],
      riskLevel: validRisks.includes(parsed.riskLevel) ? parsed.riskLevel : "medium",
    };
  } catch {
    return { passed: true, reasoning: "Guard JSON parse failed, defaulting to pass", rejectedStepIndices: [], riskLevel: "medium" };
  }
}

/* ================================================================== */
/*  Verifier 目标一致性校验：确保 replan 新步骤与原始任务目标一致     */
/* ================================================================== */

/**
 * 通过 verifierAgent.verifySimple 校验重规划产出的新计划是否与原始目标一致。
 * 将新步骤构造为“虚拟观察”，由独立 Verifier LLM 评估。
 */
async function verifyReplanConsistency(params: {
  app: FastifyInstance;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  newPlanSteps: PlanStep[];
  originalMessage: string;
  strategy: ReplanStrategy;
}): Promise<VerificationResult> {
  const { app, subject, locale, authorization, traceId, newPlanSteps, originalMessage, strategy } = params;

  // 环境变量开关
  if ((process.env.REPLAN_VERIFIER ?? "1") === "0") {
    return { verdict: "verified", confidence: 1.0, reasoning: "Replan verifier disabled", criteriaResults: [] };
  }

  // 构造虚拟观察——把新计划步骤包装成 StepObservation 结构
  const fakeObservations = newPlanSteps.map((step, i) => ({
    stepId: step.stepId,
    seq: i + 1,
    toolRef: step.toolRef,
    status: "succeeded" as const,
    output: { planned: true, description: (step as any).description ?? "", strategy },
    outputDigest: { step: step.stepId, toolRef: step.toolRef },
    errorCategory: null,
    durationMs: null,
  }));

  const completionSummary = `Replanned with strategy "${strategy}": ${newPlanSteps.length} new steps targeting: ${newPlanSteps.map(s => s.toolRef).join(", ")}`;

  try {
    const result = await verifySimple({
      app, subject, locale, authorization, traceId,
      goal: originalMessage,
      observations: fakeObservations,
      completionSummary,
    });
    return result;
  } catch (err: any) {
    app.log.warn({ err: err?.message }, "[Replan Verifier] verification failed, defaulting to verified");
    return {
      verdict: "verified",
      confidence: 0.5,
      reasoning: `Replan verifier failed: ${err?.message}`,
      criteriaResults: [],
    };
  }
}
