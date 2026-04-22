/**
 * Goal Decomposer — LLM 驱动的目标分解引擎
 *
 * 编排骨架：将用户的自然语言 mainGoal 分解为结构化 GoalGraph。
 * 子模块：
 *   - goalDecomposerPrompt.ts   — LLM prompt 构建
 *   - goalDecomposerParser.ts   — JSON 解析 + DAG 验证 + 模板降级
 *   - goalDecomposerComplexity.ts — 复杂度评估与三级策略
 *   - goalDecomposerQuality.ts  — 规划质量报告 / 语义修复
 *   - planDagValidation.ts      — Plan DAG 验证 / 拓扑排序 / 工具约束
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { GoalGraph } from "@openslin/shared";
import { resolveBoolean, resolveNumber } from "@openslin/shared";
import { invokeModelChat, type LlmSubject } from "../lib/llm";
import { analyzeDecompositionQuality, applySemanticRepairs, type PlanningQualityReport } from "./goalDecomposerQuality";
import { buildDecomposePrompt } from "./goalDecomposerPrompt";
import { parseDecompositionOutput, buildSingleGoalFallback } from "./goalDecomposerParser";
import { assessGoalComplexity } from "./goalDecomposerComplexity";

/* ── Re-export 拆分模块，保持外部引用兼容 ── */
export type { PlanningQualityReport, PlanIssue, PlanRepair } from "./goalDecomposerQuality";
export { analyzeDecompositionQuality, applySemanticRepairs } from "./goalDecomposerQuality";
export type { PlanDAGValidationResult } from "./planDagValidation";
export { validatePlanDAG, topologicalSortPlan, constrainToolAvailability, enforceHighRiskDualApproval, rerankByHistoricalSuccess } from "./planDagValidation";
export { buildDecomposePrompt } from "./goalDecomposerPrompt";
export { parseDecompositionOutput, parseConditions, parseCriteria, buildSingleGoalFallback } from "./goalDecomposerParser";
export type { GoalComplexity, DecomposeStrategy } from "./goalDecomposerComplexity";
export { assessGoalComplexity, reloadComplexityConfig } from "./goalDecomposerComplexity";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export interface DecomposeGoalParams {
  app: FastifyInstance;
  pool: Pool;
  subject: LlmSubject;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** 用户原始目标 */
  goal: string;
  /** run_id */
  runId: string;
  /** 可用工具目录（用于让 LLM 了解能力边界） */
  toolCatalog?: string;
  /** 默认模型引用 */
  defaultModelRef?: string;
  /** 最大子目标数 */
  maxSubGoals?: number;
}

export interface DecomposeGoalResult {
  ok: boolean;
  graph: GoalGraph;
  /** 分解失败原因 */
  error?: string;
  /** P4-2: 规划质量报告 */
  planningQualityReport?: PlanningQualityReport;
}

/* ================================================================== */
/*  编排入口                                                            */
/* ==================================================================  */

function finalizeDecompositionResult(params: {
  app: FastifyInstance;
  goal: string;
  result: DecomposeGoalResult;
  allowFallbackOnFailure?: boolean;
}): DecomposeGoalResult {
  const { app, goal, result, allowFallbackOnFailure = true } = params;
  const initialReport = analyzeDecompositionQuality(result.graph, goal);
  const repairResult = applySemanticRepairs(result.graph, initialReport);
  const finalReport = repairResult.repaired
    ? {
        ...analyzeDecompositionQuality(result.graph, goal),
        repairs: initialReport.repairs,
      }
    : initialReport;

  app.metrics.observePlanQualityScore({
    score: finalReport.overallScore,
    dagValid: finalReport.dimensions.dagValidity >= 1,
    repairApplied: repairResult.repaired,
  });

  if (allowFallbackOnFailure && finalReport.criticVerdict === "fail" && finalReport.dimensions.dagValidity < 1) {
    const fallback = buildSingleGoalFallback(result.graph.runId, goal, "quality_guard_failed");
    fallback.planningQualityReport = finalReport;
    return fallback;
  }

  result.planningQualityReport = finalReport;
  return result;
}

/**
 * 分解用户目标为 GoalGraph
 *
 * 调用 LLM 将 mainGoal 分解为子目标（含前/后置条件、成功标准），
 * 构建 DAG 并验证合法性。简单目标降级为单节点。
 */
export async function decomposeGoal(params: DecomposeGoalParams): Promise<DecomposeGoalResult> {
  const {
    app, subject, locale, authorization, traceId,
    goal, runId, toolCatalog, defaultModelRef,
  } = params;
  const maxSubGoals = params.maxSubGoals ?? 8;
  const startMs = Date.now();

  // ── 0. 环境变量开关：禁用 GoalGraph 分解时降级为单节点
  if (!resolveBoolean("AGENT_LOOP_GOAL_DECOMPOSE").value) {
    const r = buildSingleGoalFallback(runId, goal, "disabled_by_env");
    r.planningQualityReport = analyzeDecompositionQuality(r.graph, goal);
    app.metrics.observePlanQualityScore({
      score: r.planningQualityReport.overallScore,
      dagValid: r.planningQualityReport.dimensions.dagValidity >= 1,
      repairApplied: false,
    });
    app.metrics.observeGoalDecompose({ result: "disabled", latencyMs: Date.now() - startMs, subGoalCount: 1, strategy: "single_node" });
    return r;
  }

  // ── 1. P1-4/P1-5: 三级策略 — 评估复杂度
  const assessment = assessGoalComplexity(goal, toolCatalog);
  app.log.debug({ runId, complexity: assessment.complexity, strategy: assessment.strategy, reason: assessment.reason }, "[GoalDecomposer] complexity assessment");

  // ── 2. P1-5 early-exit / P1-4 Level-1: trivial 目标 → 直接模板化，跳过 LLM
  if (assessment.strategy === "early_exit" || assessment.strategy === "template") {
    const r = buildSingleGoalFallback(runId, goal, `${assessment.strategy}: ${assessment.reason}`);
    r.planningQualityReport = analyzeDecompositionQuality(r.graph, goal);
    app.metrics.observePlanQualityScore({
      score: r.planningQualityReport.overallScore,
      dagValid: r.planningQualityReport.dimensions.dagValidity >= 1,
      repairApplied: false,
    });
    app.metrics.observeGoalDecompose({
      result: "ok",
      latencyMs: Date.now() - startMs,
      subGoalCount: 1,
      strategy: assessment.strategy,
    });
    return r;
  }

  // ── 3. P1-4 Level-2 (fast_model) / Level-3 (standard_model): 调用 LLM
  const purpose = assessment.strategy === "fast_model"
    ? "agent.loop.decompose.fast"    // 小模型
    : "agent.loop.decompose";        // 标准模型

  try {
    const systemPrompt = buildDecomposePrompt(toolCatalog);
    const userPrompt = `## User's Goal\n${goal}\n\nMax sub-goals: ${maxSubGoals}\nComplexity hint: ${assessment.complexity}\n\nDecompose this goal into a structured plan.`;
    const timeoutMs = resolveNumber("GOAL_DECOMPOSE_MODEL_TIMEOUT_MS").value;

    const llmResult = await invokeModelChat({
      app,
      subject,
      locale,
      authorization,
      traceId,
      purpose,
      timeoutMs,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      ...(defaultModelRef ? { constraints: { candidates: [defaultModelRef] } } : {}),
    });

    const result = finalizeDecompositionResult({
      app,
      goal,
      result: parseDecompositionOutput(llmResult.outputText ?? "", runId, goal),
    });
    if (result.graph.subGoals.length > maxSubGoals) {
      result.graph.subGoals = result.graph.subGoals.slice(0, maxSubGoals);
      // P1-3: 截断后清理悬空依赖引用（指向已删除子目标的 dependsOn）
      const retainedIds = new Set(result.graph.subGoals.map((s) => s.goalId));
      for (const sub of result.graph.subGoals) {
        sub.dependsOn = sub.dependsOn.filter((depId) => retainedIds.has(depId));
      }
      result.planningQualityReport = analyzeDecompositionQuality(result.graph, goal);
      app.metrics.observePlanQualityScore({
        score: result.planningQualityReport.overallScore,
        dagValid: result.planningQualityReport.dimensions.dagValidity >= 1,
        repairApplied: false,
      });
    }
    result.graph.decomposedByModel = (llmResult.modelRef as string | undefined) ?? defaultModelRef ?? undefined;
    // P0-2: 目标分解指标（策略来自三级评估）
    app.metrics.observeGoalDecompose({
      result: result.ok ? "ok" : "fallback",
      latencyMs: Date.now() - startMs,
      subGoalCount: result.graph.subGoals.length,
      strategy: assessment.strategy,
    });
    return result;
  } catch (err: any) {
    app.log.warn({ err: err?.message, runId, strategy: assessment.strategy }, "[GoalDecomposer] LLM 分解失败，降级为单节点 GoalGraph");
    // P0-2: 目标分解失败指标
    app.metrics.observeGoalDecompose({ result: "error", latencyMs: Date.now() - startMs, subGoalCount: 1, strategy: "single_node" });
    return buildSingleGoalFallback(runId, goal, `llm_error: ${err?.message}`);
  }
}

/**
 * P2-9: 分解后静态分析器 / P2-10: 语义修复器 / P2-13: plan critic
 * P4-2: PlanningQualityReport
 *
 * → 已拆分到 goalDecomposerQuality.ts
 * → 通过文件头部 re-export 保持外部引用兼容
 */

/* Plan DAG 验证 / 拓扑排序 / 工具约束 / 高风险检查 / 历史经验
 * → 已拆分到 planDagValidation.ts
 * → 通过文件头部 re-export 保持外部引用兼容
 */

