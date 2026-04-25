/**
 * Agent Loop 核心类型定义
 *
 * 从 apps/api/src/kernel/loopTypes.ts 提取的可共享核心类型。
 * 不含框架特定依赖（Fastify、pg Pool 等），仅包含数据结构和纯函数。
 */
import type { GoalGraph } from "./goalGraph";

/* ================================================================== */
/*  Decision & Observation                                               */
/* ================================================================== */

/** LLM 可做出的决策类型 */
export type AgentDecisionAction =
  | "tool_call"           // 执行一个工具
  | "parallel_tool_calls" // 并行执行多个独立工具
  | "replan"              // 重新规划（目标/环境已变）
  | "done"                // 目标已达成
  | "ask_user"            // 需要用户补充信息
  | "abort";              // 无法完成，终止

/** 决策质量评分：衡量 LLM 决策的置信度，支持低置信度重试或模型升级 */
export interface DecisionQualityScore {
  /** 0-1，LLM 返回的置信度（从 LLM 输出中提取，缺省时为 -1 表示未提供） */
  confidence: number;
  /** 当前决策的重试次数 */
  retryCount: number;
  /** 使用的模型标识 */
  modelUsed: string;
  /** 如果是升级后的模型，记录原模型 */
  upgradedFrom?: string;
}

export interface AgentDecision {
  action: AgentDecisionAction;
  /** 当 action=tool_call 时：要调用的工具 */
  toolRef?: string;
  /** 当 action=tool_call 时：工具输入参数 */
  inputDraft?: Record<string, unknown>;
  /** 当 action=parallel_tool_calls 时：并行调用列表 */
  parallelCalls?: Array<{ toolRef: string; inputDraft: Record<string, unknown> }>;
  /** LLM 给出的推理说明（用于审计和展示） */
  reasoning: string;
  /** 当 action=ask_user 时：要问用户的问题 */
  question?: string;
  /** 当 action=done 时：最终摘要 */
  summary?: string;
  /** 当 action=abort 时：终止原因 */
  abortReason?: string;
  /** 决策质量评分（可选增强，不阻塞正常流程） */
  qualityScore?: DecisionQualityScore;
}

export interface StepObservation {
  stepId: string;
  seq: number;
  toolRef: string;
  status: string;
  /** 步骤输出摘要 */
  outputDigest: Record<string, unknown> | null;
  /** 工具实际输出结果（safeOutput，包含 LLM 决策所需的实际数据） */
  output: Record<string, unknown> | null;
  /** 错误类别 */
  errorCategory: string | null;
  /** 执行耗时(ms) */
  durationMs: number | null;
}

/* ================================================================== */
/*  Execution Constraints                                                */
/* ================================================================== */

export interface ExecutionConstraints {
  allowedTools?: string[];
  allowWrites?: boolean;
}

/* ================================================================== */
/*  Budget                                                                */
/* ================================================================== */

/** Token 预算追踪 */
export interface TokenBudget {
  maxTokens: number;
  usedTokens: number;
}

/** 成本预算追踪 */
export interface CostBudget {
  maxCost: number;
  usedCost: number;
  currency: string;
}

/** Agent Loop 综合预算状态 */
export interface LoopBudget {
  /** Token 用量预算（可选，未配置时不限制） */
  tokenBudget?: TokenBudget;
  /** 费用预算（可选，未配置时不限制） */
  costBudget?: CostBudget;
  /** 最大工具执行次数预算（可选） */
  maxToolExecutions?: number;
  /** 已使用的工具执行次数 */
  usedToolExecutions: number;
}

/** 检查预算是否耗尽 */
export function isBudgetExhausted(budget: LoopBudget): { exhausted: boolean; reason?: string } {
  if (budget.tokenBudget && budget.tokenBudget.usedTokens >= budget.tokenBudget.maxTokens) {
    return { exhausted: true, reason: `token_budget_exhausted (${budget.tokenBudget.usedTokens}/${budget.tokenBudget.maxTokens})` };
  }
  if (budget.costBudget && budget.costBudget.usedCost >= budget.costBudget.maxCost) {
    return { exhausted: true, reason: `cost_budget_exhausted (${budget.costBudget.usedCost}/${budget.costBudget.maxCost} ${budget.costBudget.currency})` };
  }
  if (budget.maxToolExecutions != null && budget.usedToolExecutions >= budget.maxToolExecutions) {
    return { exhausted: true, reason: `tool_execution_budget_exhausted (${budget.usedToolExecutions}/${budget.maxToolExecutions})` };
  }
  return { exhausted: false };
}

/** 记录一次 LLM 调用的 Token 消耗 */
export function recordTokenUsage(budget: LoopBudget, tokens: number): void {
  if (budget.tokenBudget) budget.tokenBudget.usedTokens += tokens;
}

/** 记录一次工具执行的成本消耗 */
export function recordCostUsage(budget: LoopBudget, cost: number): void {
  if (budget.costBudget) budget.costBudget.usedCost += cost;
  budget.usedToolExecutions++;
}

/** 创建默认预算状态（从环境变量或配置读取） */
export function createDefaultBudget(): LoopBudget {
  const maxTokens = Number(process.env.AGENT_LOOP_MAX_TOKENS ?? "0") || undefined;
  const maxCost = Number(process.env.AGENT_LOOP_MAX_COST ?? "0") || undefined;
  const maxToolExec = Number(process.env.AGENT_LOOP_MAX_TOOL_EXECUTIONS ?? "0") || undefined;
  return {
    tokenBudget: maxTokens ? { maxTokens, usedTokens: 0 } : undefined,
    costBudget: maxCost ? { maxCost, usedCost: 0, currency: process.env.AGENT_LOOP_COST_CURRENCY ?? "USD" } : undefined,
    maxToolExecutions: maxToolExec,
    usedToolExecutions: 0,
  };
}

/* ================================================================== */
/*  Loop Result                                                          */
/* ================================================================== */

export interface AgentLoopResult {
  ok: boolean;
  /** 循环终止原因 */
  endReason: "done" | "aborted" | "interrupted" | "max_iterations" | "max_wall_time" | "budget_exhausted" | "error" | "ask_user";
  /** 总迭代次数 */
  iterations: number;
  /** 成功完成的步骤数 */
  succeededSteps: number;
  /** 失败的步骤数 */
  failedSteps: number;
  /** LLM 给出的最终摘要/问题 */
  message: string;
  /** 所有步骤观察记录 */
  observations: StepObservation[];
  /** 最终决策 */
  lastDecision: AgentDecision | null;
  /** 持久化循环 ID */
  loopId?: string;
  /** 目标图（完整的分解+进度） */
  goalGraph?: GoalGraph;
  /** 预算使用情况快照 */
  budgetSnapshot?: LoopBudget;
  /** 优雅降级标记：当因资源耗尽退出时，标记为 true 表示已保留中间结果 */
  partialResult?: boolean;
  /** 优雅降级时的进度摘要（已完成的工作总结） */
  progressSummary?: string;
}

/* ================================================================== */
/*  Similarity Strategy                                                */
/* ================================================================== */

/** 相似度计算策略接口 —— 用于意图漂移检测的可插拔算法 */
export interface SimilarityStrategy {
  compute(a: Set<string>, b: Set<string>): number;
  readonly name: string;
}

/* ================================================================== */
/*  WorldState Limits                                                   */
/* ================================================================== */

/** WorldState 大小限制配置 */
export interface WorldStateLimits {
  maxEntities: number;
  maxFacts: number;
  maxRelations: number;
}
