/**
 * Goal Decomposer — 分解质量分析与语义修复
 *
 * 从 goalDecomposer.ts 拆分而来，包含：
 * - P2-9:  分解后静态分析器（analyzeDecompositionQuality）
 * - P2-10: 语义修复器（applySemanticRepairs）
 * - P2-13: Plan Critic / Verifier
 * - P4-2:  PlanningQualityReport 类型定义
 */
import type { GoalGraph } from "@mindpal/shared";
import { validateGoalGraphDAG } from "@mindpal/shared";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** P4-2: 规划质量报告 — 承载 DAG 校验、语义检查、修复记录、风险评分 */
export interface PlanningQualityReport {
  /** 总质量分 0~1 */
  overallScore: number;
  /** 各检查维度得分 */
  dimensions: {
    goalCoverage: number;       // 目标覆盖率
    stepGranularity: number;    // 步骤粒度合理性
    conditionConsistency: number; // 前后置条件一致性
    dagValidity: number;        // DAG 合法性
    toolBinding: number;        // 工具绑定完整性
    evidenceCompleteness: number; // 完成证据完整性
  };
  /** 检测到的问题 */
  issues: PlanIssue[];
  /** P2-10 自动修复记录 */
  repairs: PlanRepair[];
  /** P2-13 critic 评价 */
  criticVerdict: "pass" | "warn" | "fail";
  criticReasons: string[];
}

export interface PlanIssue {
  type: "goal_gap" | "too_coarse" | "too_fine" | "idle_step" | "duplicate_step"
    | "condition_mismatch" | "missing_tool" | "missing_evidence" | "cycle" | "orphan";
  severity: "info" | "warn" | "error";
  goalId?: string;
  message: string;
}

export interface PlanRepair {
  type: "remove_duplicate" | "merge_fine_steps" | "add_dependency" | "fill_evidence" | "prune_idle";
  description: string;
  affected: string[];
  applied: boolean;
}

/* ================================================================== */
/*  文本相似度工具                                                       */
/* ================================================================== */

/** 提取字符串的 bigram 集合 */
function bigramsOf(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 基于预计算 bigram 集合的 Dice 相似度 */
function bigramSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const bg of setA) if (setB.has(bg)) overlap++;
  return (2 * overlap) / (setA.size + setB.size);
}

/** 简单文本相似度（基于 bigram 重叠率） */
function simpleTextSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  return bigramSimilarity(bigramsOf(a), bigramsOf(b));
}

/* ================================================================== */
/*  P2-9: 分解后静态分析器                                                */
/* ================================================================== */

/**
 * P2-9: 分解后静态分析器
 *
 * 不仅校验 DAG，还校验"目标覆盖""步骤粒度""前后置一致性""空转步骤""重复步骤"。
 */
export function analyzeDecompositionQuality(
  graph: GoalGraph,
  originalGoal: string,
): PlanningQualityReport {
  const issues: PlanIssue[] = [];
  const repairs: PlanRepair[] = [];
  const subs = graph.subGoals;

  // ── 1. 目标覆盖检查
  const goalWords = originalGoal.replace(/[^\u4e00-\u9fff\w]/g, " ").split(/\s+/).filter((w) => w.length >= 2);
  const subDescriptions = subs.map((s) => s.description).join(" ");
  const coveredWords = goalWords.filter((w) => subDescriptions.includes(w));
  const goalCoverage = goalWords.length > 0 ? coveredWords.length / goalWords.length : 1;
  if (goalCoverage < 0.5) {
    issues.push({ type: "goal_gap", severity: "warn", message: `目标关键词覆盖率仅 ${(goalCoverage * 100).toFixed(0)}%，可能有遗漏` });
  }

  // ── 2. 步骤粒度检查
  let stepGranularity = 1;
  for (const sub of subs) {
    const descLen = sub.description.length;
    if (descLen > 200) {
      issues.push({ type: "too_coarse", severity: "warn", goalId: sub.goalId, message: `子目标 ${sub.goalId} 描述过长(${descLen}字)，可能需要进一步拆分` });
      stepGranularity -= 0.15;
    }
    if (descLen < 5) {
      issues.push({ type: "too_fine", severity: "info", goalId: sub.goalId, message: `子目标 ${sub.goalId} 描述过短(${descLen}字)，可能拆分过细` });
      stepGranularity -= 0.1;
    }
  }
  stepGranularity = Math.max(0, Math.min(1, stepGranularity));

  // ── 3. 空转步骤检测（无工具、无实质动作）
  for (const sub of subs) {
    const hasTools = sub.suggestedToolRefs && sub.suggestedToolRefs.length > 0;
    const hasSubstance = sub.description.length >= 10;
    if (!hasTools && !hasSubstance) {
      issues.push({ type: "idle_step", severity: "warn", goalId: sub.goalId, message: `子目标 ${sub.goalId} 无工具建议且描述过短，疑似空转` });
      repairs.push({ type: "prune_idle", description: `建议移除空转子目标 ${sub.goalId}`, affected: [sub.goalId], applied: false });
    }
  }

  // ── 4. 重复步骤检测（简单文本相似度）
  const bigramCache = new Map<string, Set<string>>();
  for (const sub of subs) {
    bigramCache.set(sub.goalId, bigramsOf(sub.description));
  }
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const sim = bigramSimilarity(bigramCache.get(subs[i].goalId)!, bigramCache.get(subs[j].goalId)!);
      if (sim > 0.8) {
        issues.push({
          type: "duplicate_step", severity: "warn",
          goalId: subs[j].goalId,
          message: `子目标 ${subs[i].goalId} 和 ${subs[j].goalId} 描述高度相似，可能重复`,
        });
        repairs.push({ type: "remove_duplicate", description: `合并 ${subs[i].goalId} 和 ${subs[j].goalId}`, affected: [subs[i].goalId, subs[j].goalId], applied: false });
      }
    }
  }

  // ── 5. 前后置条件一致性
  let conditionConsistency = 1;
  const allPostconditions = subs.flatMap((s) => (s.postconditions ?? []).map((c) => c.description));
  for (const sub of subs) {
    if (sub.dependsOn.length > 0 && sub.preconditions && sub.preconditions.length > 0) {
      for (const pre of sub.preconditions) {
        const covered = allPostconditions.some((post) => simpleTextSimilarity(pre.description, post) > 0.3);
        if (!covered) {
          issues.push({
            type: "condition_mismatch", severity: "info", goalId: sub.goalId,
            message: `子目标 ${sub.goalId} 的前置条件 "${pre.description.slice(0, 40)}" 未被任何前置步骤的后置条件覆盖`,
          });
          conditionConsistency -= 0.15;
        }
      }
    }
  }
  conditionConsistency = Math.max(0, conditionConsistency);

  // ── 6. 工具绑定完整性
  const subsWithTools = subs.filter((s) => s.suggestedToolRefs && s.suggestedToolRefs.length > 0);
  const toolBinding = subs.length > 0 ? subsWithTools.length / subs.length : 1;
  if (toolBinding < 0.5) {
    issues.push({ type: "missing_tool", severity: "warn", message: `仅 ${(toolBinding * 100).toFixed(0)}% 的子目标绑定了工具，可执行性低` });
  }

  // ── 7. 完成证据完整性
  const subsWithEvidence = subs.filter((s) => s.completionEvidence && s.completionEvidence.length > 0);
  const evidenceCompleteness = subs.length > 0 ? subsWithEvidence.length / subs.length : 1;

  // ── 8. DAG 合法性
  const dagResult = validateGoalGraphDAG(graph);
  const dagValidity = dagResult.valid ? 1 : 0.3;

  // ── P2-13: critic 综合判定
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warn").length;
  let criticVerdict: PlanningQualityReport["criticVerdict"] = "pass";
  const criticReasons: string[] = [];
  if (errorCount > 0) {
    criticVerdict = "fail";
    criticReasons.push(`${errorCount} 个严重问题`);
  }
  if (warnCount >= 3) {
    criticVerdict = criticVerdict === "fail" ? "fail" : "warn";
    criticReasons.push(`${warnCount} 个警告`);
  }
  if (goalCoverage < 0.4) {
    criticVerdict = "fail";
    criticReasons.push(`目标覆盖率过低 (${(goalCoverage * 100).toFixed(0)}%)`);
  }
  if (!dagResult.valid) {
    criticReasons.push("DAG 不合法");
  }

  const overallScore = (
    goalCoverage * 0.25
    + stepGranularity * 0.15
    + conditionConsistency * 0.15
    + dagValidity * 0.2
    + toolBinding * 0.15
    + evidenceCompleteness * 0.1
  );

  return {
    overallScore: Math.max(0, Math.min(1, overallScore)),
    dimensions: { goalCoverage, stepGranularity, conditionConsistency, dagValidity, toolBinding, evidenceCompleteness },
    issues,
    repairs,
    criticVerdict,
    criticReasons,
  };
}

/* ================================================================== */
/*  P2-10: 语义修复器                                                    */
/* ================================================================== */

/**
 * P2-10: 语义修复器 — 对明显过粗、过细、重复、依赖缺失的计划自动修补
 *
 * 基于 analyzeDecompositionQuality 的 repairs 建议执行轻量修复。
 * 只做安全修复（删重复、剪空转），不修改语义。
 */
export function applySemanticRepairs(
  graph: GoalGraph,
  report: PlanningQualityReport,
): { repaired: boolean; removedGoalIds: string[] } {
  const removedGoalIds: string[] = [];
  let repaired = false;

  for (const repair of report.repairs) {
    if (repair.applied) continue;

    if (repair.type === "prune_idle" && repair.affected.length > 0) {
      // 只在多于1个子目标时才剪枝
      if (graph.subGoals.length > 1) {
        const idToRemove = repair.affected[0];
        graph.subGoals = graph.subGoals.filter((g) => g.goalId !== idToRemove);
        // 清理依赖引用
        for (const g of graph.subGoals) {
          g.dependsOn = g.dependsOn.filter((d) => d !== idToRemove);
        }
        removedGoalIds.push(idToRemove);
        repair.applied = true;
        repaired = true;
      }
    }

    if (repair.type === "remove_duplicate" && repair.affected.length >= 2) {
      if (graph.subGoals.length > 1) {
        const [keepId, removeId] = repair.affected;
        // 将指向被删除节点的依赖转移到保留节点
        for (const g of graph.subGoals) {
          g.dependsOn = g.dependsOn.map((d) => d === removeId ? keepId : d);
        }
        graph.subGoals = graph.subGoals.filter((g) => g.goalId !== removeId);
        removedGoalIds.push(removeId);
        repair.applied = true;
        repaired = true;
      }
    }
  }

  return { repaired, removedGoalIds };
}
