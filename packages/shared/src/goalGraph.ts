/**
 * GoalGraph — 结构化目标图定义
 *
 * 替代 Agent Loop 中的 `goal: string` 纯文本表示，
 * 引入多层目标分解、前/后置条件、成功标准和完成证据。
 *
 * 设计原则：
 * - 一棵有向无环的目标子树（mainGoal → subGoals → sub-subGoals）
 * - 每个子目标可声明前/后置条件、成功标准
 * - 完成证据用于 Verifier 独立校验
 * - GoalGraph 可持久化到 DB，跨 checkpoint 恢复
 */
import { validateDAG, topologicalSortGeneric, type DagNode } from "./dagUtils";

/* ================================================================== */
/*  基础类型                                                            */
/* ================================================================== */

/** 条件（前置/后置）— 以自然语言 + 可选结构化断言描述 */
export interface GoalCondition {
  /** 人类可读的条件描述 */
  description: string;
  /** 可选的结构化断言类型 */
  assertionType?:
    | "entity_exists"       // 某实体存在
    | "entity_state"        // 某实体处于特定状态
    | "relation_holds"      // 某关系成立
    | "fact_true"           // 某事实为真
    | "output_contains"     // 输出包含特定内容
    | "regex_match"         // 正则匹配
    | "numeric_range"       // 数值范围判定
    | "temporal_after"      // 时间在某时刻之后
    | "temporal_before"     // 时间在某时刻之前
    | "custom";             // 自定义（由 Verifier 解释）
  /** 结构化断言参数（按 assertionType 不同含义不同） */
  assertionParams?: Record<string, unknown>;
  /** 条件是否已满足（运行时由 WorldState Extractor / Verifier 更新） */
  satisfied?: boolean;
  /** 最后一次评估时间 */
  evaluatedAt?: string;
}

/** 成功标准 — 判断子目标是否完成的标准 */
export interface SuccessCriterion {
  /** 标准唯一 ID */
  criterionId: string;
  /** 人类可读描述 */
  description: string;
  /** 权重（0-1），多条标准时加权判定 */
  weight: number;
  /** 是否必须（必须标准不满足 → 整体不通过） */
  required: boolean;
  /** 运行时是否已满足 */
  met?: boolean;
  /** 满足时的证据引用 */
  evidenceRef?: string;
  /** 多条标准聚合策略：all=全部满足, any=任一满足, threshold=满足度达阈值 */
  strategy?: 'all' | 'any' | 'threshold';
  /** 仅 strategy='threshold' 时生效，满足比例阈值（0-1） */
  thresholdValue?: number;
}

/** 完成证据 — Verifier 校验的具体证据项 */
export interface CompletionEvidence {
  /** 证据唯一 ID */
  evidenceId: string;
  /** 证据类型 */
  type:
    | "tool_output"        // 工具执行输出
    | "entity_snapshot"    // 实体状态快照
    | "user_confirmation"  // 用户确认
    | "metric_value"       // 指标数值
    | "text_match"         // 文本匹配
    | "custom";            // 自定义
  /** 证据来源（stepId / entityId / 其他引用） */
  sourceRef: string;
  /** 证据摘要 */
  summary: string;
  /** 证据详细数据 */
  data?: Record<string, unknown>;
  /** 关联的成功标准 ID */
  criterionId?: string;
  /** 采集时间 */
  collectedAt: string;
}

/* ================================================================== */
/*  子目标节点                                                          */
/* ================================================================== */

/** 子目标与上级之间的边类型 */
export type GoalEdgeType = "sequential" | "conditional" | "parallel";

/** 子目标状态 */
export type SubGoalStatus =
  | "pending"       // 未开始
  | "in_progress"   // 执行中
  | "completed"     // 已完成（Verifier 确认）
  | "failed"        // 失败
  | "blocked"       // 被前置条件阻塞
  | "skipped";      // 跳过（不再需要）

/** 子目标节点 */
export interface SubGoal {
  /** 子目标唯一 ID */
  goalId: string;
  /** 父目标 ID（根目标为 null） */
  parentGoalId: string | null;
  /** 依赖的其他子目标 ID（完成后本目标才可开始） */
  dependsOn: string[];
  /** 边类型：顺序执行 / 条件分支 / 并行执行（默认 sequential） */
  edgeType: GoalEdgeType;
  /** 当 edgeType='conditional' 时的条件表达式（自然语言 + 可选结构化断言） */
  condition?: string;
  /** 子目标描述 */
  description: string;
  /** 预期使用的工具（可选 hint，规划器可覆盖） */
  suggestedToolRefs?: string[];
  /** 前置条件 */
  preconditions: GoalCondition[];
  /** 后置条件（完成后应满足的条件） */
  postconditions: GoalCondition[];
  /** 成功标准 */
  successCriteria: SuccessCriterion[];
  /** 完成证据（运行时收集） */
  completionEvidence: CompletionEvidence[];
  /** 当前状态 */
  status: SubGoalStatus;
  /** 优先级（0 = 最高） */
  priority: number;
  /** 预估复杂度（1-10，LLM 分解时给出） */
  estimatedComplexity?: number;
  /** 实际执行的 step seqs */
  executedStepSeqs?: number[];
  /** 状态更新时间 */
  updatedAt?: string;
  /** 完成级别（运行时由条件评估器填充） */
  completionLevel?: 'full' | 'partial' | 'failed';
}

/* ================================================================== */
/*  GoalGraph 主结构                                                    */
/* ================================================================== */

/** GoalGraph 状态 */
export type GoalGraphStatus =
  | "draft"           // 刚创建，未分解
  | "decomposed"      // LLM 已分解子目标
  | "executing"       // 正在执行
  | "verifying"       // Verifier 校验中
  | "completed"       // 全部完成
  | "failed"          // 失败
  | "replanning";     // 重新规划中

/** 目标图 — 一次 Agent Loop 执行的完整目标结构 */
export interface GoalGraph {
  /** 目标图唯一 ID */
  graphId: string;
  /** 关联的 run_id */
  runId: string;
  /** 原始用户目标（纯文本，兼容现有 goal: string） */
  mainGoal: string;
  /** 分解后的子目标列表（有序：按 DAG 拓扑序） */
  subGoals: SubGoal[];
  /** 全局前置条件（执行前就需满足的环境条件） */
  globalPreconditions: GoalCondition[];
  /** 全局成功标准（所有子目标完成后的整体校验） */
  globalSuccessCriteria: SuccessCriterion[];
  /** 全局完成证据 */
  globalCompletionEvidence: CompletionEvidence[];
  /** 目标图状态 */
  status: GoalGraphStatus;
  /** LLM 分解时的推理说明 */
  decompositionReasoning?: string;
  /** 分解使用的模型 */
  decomposedByModel?: string;
  /** 版本号（每次 replan 递增） */
  version: number;
  /** 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/* ================================================================== */
/*  工具函数                                                            */
/* ================================================================== */

/**
 * 创建一个空的 GoalGraph（未分解状态）
 */
export function createGoalGraph(runId: string, mainGoal: string, graphId?: string): GoalGraph {
  const now = new Date().toISOString();
  return {
    graphId: graphId ?? crypto.randomUUID(),
    runId,
    mainGoal,
    subGoals: [],
    globalPreconditions: [],
    globalSuccessCriteria: [],
    globalCompletionEvidence: [],
    status: "draft",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 获取当前可执行的子目标（支持 sequential/conditional/parallel 边类型）
 *
 * - sequential: 所有 dependsOn 子目标完成后才可执行
 * - parallel: 不等待兄弟节点，只等待显式 dependsOn 完成即可激活
 * - conditional: 依赖完成且条件已满足时才可执行
 */
export function getExecutableSubGoals(graph: GoalGraph): SubGoal[] {
  const completedIds = new Set(
    graph.subGoals.filter((g) => g.status === "completed" || g.status === "skipped").map((g) => g.goalId),
  );
  return graph.subGoals.filter((g) => {
    if (g.status !== "pending") return false;
    // 所有显式依赖已完成
    if (!g.dependsOn.every((dep) => completedIds.has(dep))) return false;
    // 所有前置条件已满足（或无前置条件）
    if (g.preconditions.length > 0 && !g.preconditions.every((pc) => pc.satisfied)) return false;
    // conditional 边：需要条件表达式已满足（通过前置条件绑定判定）
    if (g.edgeType === "conditional" && g.condition) {
      // condition 表达式存在且前置条件为空时视为未满足（待 WorldState Evaluator 填充）
      if (g.preconditions.length === 0) return false;
    }
    return true;
  });
}

/**
 * 计算 GoalGraph 的完成进度（0-1）
 */
export function computeGoalProgress(graph: GoalGraph): number {
  if (graph.subGoals.length === 0) return 0;
  const completed = graph.subGoals.filter((g) => g.status === "completed" || g.status === "skipped").length;
  return completed / graph.subGoals.length;
}

/**
 * 检查 GoalGraph 是否所有子目标已完成
 */
export function isGoalGraphComplete(graph: GoalGraph): boolean {
  if (graph.subGoals.length === 0) return false;
  return graph.subGoals.every((g) => g.status === "completed" || g.status === "skipped");
}

/**
 * 验证 GoalGraph DAG 的合法性（无循环依赖、无悬空引用）
 * 委托 dagUtils.validateDAG 实现核心 Kahn 算法，额外检查 parentGoalId 合法性。
 */
export function validateGoalGraphDAG(graph: GoalGraph): {
  valid: boolean;
  errors: string[];
} {
  // 将 SubGoal 映射为通用 DagNode
  const dagNodes: DagNode[] = graph.subGoals.map((g) => ({
    id: g.goalId,
    dependsOn: g.dependsOn,
  }));

  const result = validateDAG(dagNodes);
  const errors = [...result.errors];

  // GoalGraph 特有的 parentGoalId 合法性检查
  const idSet = new Set(graph.subGoals.map((g) => g.goalId));
  for (const g of graph.subGoals) {
    if (g.parentGoalId && !idSet.has(g.parentGoalId)) {
      errors.push(`SubGoal "${g.goalId}" has non-existent parentGoalId "${g.parentGoalId}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 获取按拓扑序排列的子目标 ID 列表
 * 委托 dagUtils.topologicalSortGeneric 实现，使用子目标优先级作为排序权重。
 *
 * parallel 边类型的节点优先级获得增强（权重降低）以尽早激活，
 * conditional 边类型的节点优先级降低（权重增加）以推迟执行。
 */
export function topologicalSort(graph: GoalGraph): string[] {
  const dagNodes: DagNode[] = graph.subGoals.map((g) => ({
    id: g.goalId,
    dependsOn: g.dependsOn,
  }));
  const priorityMap = new Map(graph.subGoals.map((g) => {
    let weight = g.priority;
    if (g.edgeType === "parallel") weight = Math.max(0, weight - 1);      // 并行节点提前激活
    if (g.edgeType === "conditional") weight = weight + 1;                 // 条件节点推迟
    return [g.goalId, weight];
  }));
  return topologicalSortGeneric(dagNodes, (id) => priorityMap.get(id) ?? 0);
}

/**
 * 获取同一父节点下的并行子目标组（edgeType=parallel）
 * 功能目标：Agent Loop 可一次性并行激活同组 parallel 子目标
 */
export function getParallelSubGoalGroups(graph: GoalGraph): Map<string | null, SubGoal[]> {
  const groups = new Map<string | null, SubGoal[]>();
  for (const g of graph.subGoals) {
    if (g.edgeType !== "parallel" || g.status !== "pending") continue;
    const key = g.parentGoalId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(g);
  }
  return groups;
}
