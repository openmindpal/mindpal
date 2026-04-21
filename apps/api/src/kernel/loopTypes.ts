/**
 * Agent Loop 公共类型定义
 *
 * 从 agentLoop.ts 提取，供 kernel 内部各模块共享。
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { GoalGraph } from "@openslin/shared";
import type { LlmSubject } from "../lib/llm";
import type { WorkflowQueue } from "../modules/workflow/queue";
import type { VerificationResult } from "./verifierAgent";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** LLM 可做出的决策类型 */
export type AgentDecisionAction =
  | "tool_call"           // 执行一个工具
  | "parallel_tool_calls" // 并行执行多个独立工具
  | "replan"              // 重新规划（目标/环境已变）
  | "done"                // 目标已达成
  | "ask_user"            // 需要用户补充信息
  | "abort";              // 无法完成，终止

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

export interface AgentLoopParams {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** 用户原始目标 */
  goal: string;
  /** 运行 ID */
  runId: string;
  /** 作业 ID */
  jobId: string;
  /** 任务 ID */
  taskId: string;
  /** 最大迭代次数（防死循环） */
  maxIterations?: number;
  /** 最大执行时间(ms) */
  maxWallTimeMs?: number;
  /** 外部中断信号 */
  signal?: AbortSignal;
  /** 用户中途发来的新消息（用于干预） */
  userIntervention?: string;
  /** 用户选择的默认模型 ref（优先路由到此模型，避免选中不支持 chat 的多模态模型） */
  defaultModelRef?: string;
  /** 执行约束：限制 Agent Loop 可调用的工具与写操作 */
  executionConstraints?: ExecutionConstraints;
  /** 调度优先级（越小越优先，默认 5） */
  priority?: number;
  /** 回调：每步完成后通知调用方（支持异步，循环会等待回调完成后再继续下一步） */
  onStepComplete?: (obs: StepObservation, decision: AgentDecision) => void | Promise<void>;
  /** 回调：循环结束后通知 */
  onLoopEnd?: (result: AgentLoopResult) => void;
  /** P0-1: 从 checkpoint 恢复时的 loopId（非首次启动时提供） */
  resumeLoopId?: string;
  /** P0-1: 从 checkpoint 恢复的初始状态 */
  resumeState?: {
    iteration: number;
    currentSeq: number;
    succeededSteps: number;
    failedSteps: number;
    observations: StepObservation[];
    lastDecision: AgentDecision | null;
    toolDiscoveryCache?: Record<string, unknown> | null;
    memoryContext?: string | null;
    taskHistory?: string | null;
    knowledgeContext?: string | null;
    /** 策略上下文：上次中断时的动态策略信息 */
    strategyContext?: string | null;
  };
}

export interface ExecutionConstraints {
  allowedTools?: string[];
  allowWrites?: boolean;
}

/* ================================================================== */
/*  预算控制 (Budget)                                                    */
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
  /** P0-1: 持久化循环 ID */
  loopId?: string;
  /** P0-2: 验证结果（当 endReason=done 时） */
  verification?: VerificationResult;
  /** P0-2: 目标图（完整的分解+进度） */
  goalGraph?: GoalGraph;
  /** P0-2: 预算使用情况快照 */
  budgetSnapshot?: LoopBudget;
}
