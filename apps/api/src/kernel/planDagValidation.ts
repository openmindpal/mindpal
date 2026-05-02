/**
 * Plan DAG 验证 — 从 goalDecomposer.ts 拆分而来
 *
 * 包含：
 * - validatePlanDAG: PlanStep[] 的 DAG 合法性校验
 * - topologicalSortPlan: 拓扑排序
 * - constrainToolAvailability: P2-12 工具可用性约束前置
 * - enforceHighRiskDualApproval: P2-14 高风险写操作双通过
 * - rerankByHistoricalSuccess: P2-11 历史成功经验重排
 */
import type { GoalGraph } from "@mindpal/shared";
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

/** 历史计划条目 */
export interface HistoricalPlan {
  goalSummary: string;
  subGoalOrder: string[];
  successRate: number;
}

/** 匹配结果 */
interface PlanMatch {
  plan: HistoricalPlan;
  similarity: number;
}

/**
 * 将文本拆分为小写 token 集合（按空格、标点分词）
 */
function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,;.!?()\[\]{}|/\\，；。！？（）【】]+/)
      .filter((t) => t.length > 0),
  );
}

/**
 * 计算两个字符串集合的 Jaccard 相似度（|A∩B| / |A∪B|）
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersectionSize = 0;
  for (const item of a) {
    if (b.has(item)) intersectionSize++;
  }
  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * 从历史计划中找到与当前 GoalGraph 最匹配的成功计划。
 * 相似度综合：子目标描述的 Jaccard 重叠度 × successRate 加权。
 */
function findBestMatchingPlan(
  graph: GoalGraph,
  historicalPlans: HistoricalPlan[],
): PlanMatch | undefined {
  // 提取当前图的子目标描述 token 集合
  const currentTokens = new Set<string>();
  for (const sub of graph.subGoals) {
    for (const t of tokenize(sub.description)) {
      currentTokens.add(t);
    }
  }
  // 当前子目标 ID 集合（用于 subGoalOrder 重叠度）
  const currentIds = new Set(graph.subGoals.map((s) => s.goalId));

  let best: PlanMatch | undefined;

  for (const plan of historicalPlans) {
    if (plan.successRate <= 0) continue;

    // 文本相似度：goalSummary + subGoalOrder tokens vs 当前子目标描述 tokens
    const planTokens = tokenize(plan.goalSummary);
    for (const id of plan.subGoalOrder) {
      for (const t of tokenize(id)) {
        planTokens.add(t);
      }
    }
    const textSim = jaccardSimilarity(currentTokens, planTokens);

    // ID 重叠度：历史计划 subGoalOrder 中有多少 ID 存在于当前图
    const orderSet = new Set(plan.subGoalOrder);
    const idOverlap = jaccardSimilarity(currentIds, orderSet);

    // 综合相似度 = 0.5 * 文本相似 + 0.3 * ID重叠 + 0.2 * 成功率
    const similarity = 0.5 * textSim + 0.3 * idOverlap + 0.2 * plan.successRate;

    if (!best || similarity > best.similarity) {
      best = { plan, similarity };
    }
  }

  return best;
}

/**
 * 根据历史计划的 subGoalOrder 调整当前图中子目标的 priority。
 * 仅修改 priority 数值，不改变 dependsOn 边，保持 DAG 合法性。
 */
function applyHistoricalOrder(
  graph: GoalGraph,
  historicalOrder: string[],
): GoalGraph {
  // 建立历史顺序索引 (goalId -> 排序位置)
  const orderIndex = new Map<string, number>();
  for (let i = 0; i < historicalOrder.length; i++) {
    orderIndex.set(historicalOrder[i], i);
  }

  // 深拷贝 subGoals 并按历史顺序调整 priority
  const reorderedSubGoals = graph.subGoals.map((sub) => {
    const historicalPos = orderIndex.get(sub.goalId);
    if (historicalPos !== undefined) {
      // 在历史计划中出现的子目标：按历史顺序设置优先级
      return { ...sub, priority: historicalPos };
    }
    // 未在历史计划中出现的子目标：排到历史列表之后，保持原相对顺序
    return { ...sub, priority: historicalOrder.length + sub.priority };
  });

  return { ...graph, subGoals: reorderedSubGoals };
}

/**
 * P2-11: 历史成功经验重排
 *
 * 参考类似任务的历史成功计划，对新分解结果的子目标优先级重新排序。
 * 使用 Jaccard 文本相似度匹配最佳历史计划，按其 subGoalOrder 调整 priority。
 */
export function rerankByHistoricalSuccess(
  graph: GoalGraph,
  historicalPlans?: HistoricalPlan[],
): { reranked: boolean; reason: string; graph?: GoalGraph } {
  if (!historicalPlans || historicalPlans.length === 0) {
    return { reranked: false, reason: "no_historical_data" };
  }

  // 单子目标无需排序
  if (graph.subGoals.length <= 1) {
    return { reranked: false, reason: "single_subgoal" };
  }

  // 找到最匹配的历史成功计划
  const bestMatch = findBestMatchingPlan(graph, historicalPlans);

  if (!bestMatch || bestMatch.similarity < 0.3) {
    return { reranked: false, reason: "no_similar_plan_found" };
  }

  // 按历史成功计划的子目标顺序调整优先级
  const reorderedGraph = applyHistoricalOrder(graph, bestMatch.plan.subGoalOrder);

  return {
    reranked: true,
    reason: `matched_plan_similarity_${bestMatch.similarity.toFixed(2)}_success_rate_${bestMatch.plan.successRate.toFixed(2)}`,
    graph: reorderedGraph,
  };
}
