/**
 * Plan DAG 验证 — 从 goalDecomposer.ts 拆分而来
 *
 * 包含：
 * - validatePlanDAG: PlanStep[] 的 DAG 合法性校验
 * - topologicalSortPlan: 拓扑排序
 * - constrainToolAvailability: P2-12 工具可用性约束前置
 * - enforceHighRiskDualApproval: P2-14 高风险写操作双通过
 * - rerankByHistoricalSuccess: P2-11 历史成功经验重排（占位）
 */
import type { GoalGraph } from "@openslin/shared";
import type { PlanStep } from "./planningKernel";

/* ================================================================== */
/*  Plan DAG 验证 (2.4)                                                 */
/* ================================================================== */

export interface PlanDAGValidationResult {
  valid: boolean;
  errors: string[];
  /** 检测到的循环依赖链 */
  cycles?: string[][];
  /** 孤立节点（无入度无出度） */
  isolatedSteps?: string[];
  /** 资源冲突（多个步骤同时写同一工具/资源） */
  resourceConflicts?: Array<{ resource: string; conflictingSteps: string[] }>;
}

/**
 * 验证 PlanStep[] 的 DAG 合法性
 * - 依赖闭合性（所有 dependsOn 引用的 stepId 必须存在）
 * - 循环依赖检测
 * - 资源冲突检测（多个无依赖关系的步骤写同一工具）
 */
export function validatePlanDAG(steps: PlanStep[]): PlanDAGValidationResult {
  const errors: string[] = [];
  const idSet = new Set(steps.map((s) => s.stepId));

  // 1. 依赖闭合性检查
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!idSet.has(dep)) {
        errors.push(`Step "${step.stepId}" (${step.toolRef}) depends on non-existent step "${dep}"`);
      }
    }
  }

  // 2. 拓扑排序检测循环依赖
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();
  for (const step of steps) {
    const validDeps = step.dependsOn.filter((d) => idSet.has(d));
    inDegree.set(step.stepId, validDeps.length);
    for (const dep of validDeps) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(step.stepId);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sortedOrder: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    sortedOrder.push(curr);
    for (const next of adjList.get(curr) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  const cycles: string[][] = [];
  if (sortedOrder.length < steps.length) {
    // 有循环——找出参与循环的节点
    const sortedSet = new Set(sortedOrder);
    const cycleNodes = steps.filter((s) => !sortedSet.has(s.stepId)).map((s) => s.stepId);
    cycles.push(cycleNodes);
    errors.push(`Plan contains circular dependencies involving steps: ${cycleNodes.join(", ")}`);
  }

  // 3. 孤立节点检测
  const hasIncoming = new Set<string>();
  const hasOutgoing = new Set<string>();
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (idSet.has(dep)) {
        hasIncoming.add(step.stepId);
        hasOutgoing.add(dep);
      }
    }
  }
  const isolatedSteps = steps.length > 1
    ? steps.filter((s) => !hasIncoming.has(s.stepId) && !hasOutgoing.has(s.stepId)).map((s) => s.stepId)
    : [];

  // 4. 资源冲突检测（同一 toolRef 的步骤如果没有依赖关系，可能产生冲突）
  const resourceConflicts: Array<{ resource: string; conflictingSteps: string[] }> = [];
  const toolRefGroups = new Map<string, string[]>();
  for (const step of steps) {
    if (!toolRefGroups.has(step.toolRef)) toolRefGroups.set(step.toolRef, []);
    toolRefGroups.get(step.toolRef)!.push(step.stepId);
  }

  // P2-6: 构建 stepMap 以 O(1) 查找代替 steps.find 的 O(n)
  const stepMap = new Map(steps.map((s) => [s.stepId, s]));

  // 构建祖先集合用于判断是否有依赖关系
  const ancestorCache = new Map<string, Set<string>>();
  function getAncestors(stepId: string): Set<string> {
    if (ancestorCache.has(stepId)) return ancestorCache.get(stepId)!;
    const ancestors = new Set<string>();
    const step = stepMap.get(stepId);
    if (step) {
      for (const dep of step.dependsOn) {
        if (idSet.has(dep)) {
          ancestors.add(dep);
          for (const a of getAncestors(dep)) ancestors.add(a);
        }
      }
    }
    ancestorCache.set(stepId, ancestors);
    return ancestors;
  }

  for (const [toolRef, stepIds] of toolRefGroups) {
    if (stepIds.length <= 1) continue;
    // 检查这些步骤之间是否有依赖关系
    const unrelated: string[] = [];
    for (let i = 0; i < stepIds.length; i++) {
      let hasRelation = false;
      for (let j = 0; j < stepIds.length; j++) {
        if (i === j) continue;
        const ancestors = getAncestors(stepIds[j]);
        if (ancestors.has(stepIds[i])) {
          hasRelation = true;
          break;
        }
      }
      if (!hasRelation) {
        // 也检查反方向
        const myAncestors = getAncestors(stepIds[i]);
        const relatedByReverse = stepIds.some((sid, idx) => idx !== i && myAncestors.has(sid));
        if (!relatedByReverse) unrelated.push(stepIds[i]);
      }
    }
    if (unrelated.length > 1) {
      resourceConflicts.push({ resource: toolRef, conflictingSteps: unrelated });
    }
  }

  if (resourceConflicts.length > 0) {
    for (const conflict of resourceConflicts) {
      errors.push(`Potential resource conflict on "${conflict.resource}" between steps: ${conflict.conflictingSteps.join(", ")}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    cycles: cycles.length > 0 ? cycles : undefined,
    isolatedSteps: isolatedSteps.length > 0 ? isolatedSteps : undefined,
    resourceConflicts: resourceConflicts.length > 0 ? resourceConflicts : undefined,
  };
}

/**
 * 对 PlanStep[] 进行拓扑排序，返回执行顺序
 * 如果有循环依赖，返回尽可能多的可执行步骤
 */
export function topologicalSortPlan(steps: PlanStep[]): PlanStep[] {
  const idSet = new Set(steps.map((s) => s.stepId));
  const stepMap = new Map(steps.map((s) => [s.stepId, s]));
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const step of steps) {
    const validDeps = step.dependsOn.filter((d) => idSet.has(d));
    inDegree.set(step.stepId, validDeps.length);
    for (const dep of validDeps) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(step.stepId);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: PlanStep[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    const step = stepMap.get(curr);
    if (step) sorted.push(step);
    for (const next of adjList.get(curr) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  return sorted;
}

/* ================================================================== */
/*  P2-12: 工具可用性约束前置                                              */
/* ================================================================== */

/**
 * P2-12: 工具可用性约束前置
 *
 * 在分解结果中过滤不可用工具，不等到 parse 后再丢弃。
 */
export function constrainToolAvailability(
  graph: GoalGraph,
  availableTools: Set<string>,
): { constrained: boolean; removedTools: string[] } {
  const removedTools: string[] = [];
  let constrained = false;
  for (const sub of graph.subGoals) {
    if (sub.suggestedToolRefs) {
      const before = sub.suggestedToolRefs.length;
      sub.suggestedToolRefs = sub.suggestedToolRefs.filter((t) => {
        // 工具名一般是 "tool.name@version" 格式，去版本后匹配
        const baseName = t.split("@")[0];
        const available = availableTools.has(t) || availableTools.has(baseName);
        if (!available) removedTools.push(t);
        return available;
      });
      if (sub.suggestedToolRefs.length < before) constrained = true;
    }
  }
  return { constrained, removedTools };
}

/* ================================================================== */
/*  P2-14: 高风险写操作双通过检查                                          */
/* ================================================================== */

/**
 * P2-14: 高风险写操作双通过检查
 *
 * 返回是否所有高风险子目标都已标记为需要审批。
 * 如果有未标记的写操作子目标，自动补标。
 */
export function enforceHighRiskDualApproval(
  graph: GoalGraph,
): { enforced: boolean; flaggedGoalIds: string[] } {
  const writeKeywords = ["创建", "新建", "删除", "移除", "更新", "修改", "导入", "发布", "部署",
    "create", "delete", "remove", "update", "import", "publish", "deploy", "drop"];
  const highRiskKeywords = ["删除", "移除", "清空", "重置", "销毁", "批量", "全量",
    "delete", "remove", "drop", "destroy", "reset", "batch"];

  const flaggedGoalIds: string[] = [];
  let enforced = false;

  for (const sub of graph.subGoals) {
    const desc = sub.description.toLowerCase();
    const isWrite = writeKeywords.some((k) => desc.includes(k.toLowerCase()));
    const isHighRisk = highRiskKeywords.some((k) => desc.includes(k.toLowerCase()));

    if (isWrite && isHighRisk) {
      // 强制标记审批
      if (!(sub as any).requiresApproval) {
        (sub as any).requiresApproval = true;
        flaggedGoalIds.push(sub.goalId);
        enforced = true;
      }
    }
  }

  return { enforced, flaggedGoalIds };
}

/* ================================================================== */
/*  P2-11: 历史成功经验重排                                                */
/* ================================================================== */

/**
 * P2-11: 历史成功经验重排（占位接口）
 *
 * 参考类似任务的历史成功计划，对新分解结果重新排序。
 * 当前为占位实现，待历史数据积累后接入 embedding 相似度匹配。
 */
export function rerankByHistoricalSuccess(
  _graph: GoalGraph,
  _historicalPlans?: Array<{ goalSummary: string; subGoalOrder: string[]; successRate: number }>,
): { reranked: boolean; reason: string } {
  // TODO: 接入历史成功计划的 embedding 索引后实现
  // 当前保持原始顺序
  if (!_historicalPlans || _historicalPlans.length === 0) {
    return { reranked: false, reason: "no_historical_data" };
  }
  return { reranked: false, reason: "not_yet_implemented" };
}
