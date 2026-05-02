/**
 * Agent Loop 公共类型定义
 *
 * 核心类型已迁移至 @mindpal/shared，本文件 re-export 并补充本地独有类型。
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type {
  GoalGraph,
  AgentDecision, StepObservation, ExecutionConstraints, LoopBudget,
  AgentLoopResult as SharedAgentLoopResult,
} from "@mindpal/shared";
import type { LlmSubject } from "../lib/llm";
import type { WorkflowQueue } from "../modules/workflow/queue";
import type { VerificationResult } from "./verifierAgent";

/* ── 从 @mindpal/shared re-export 核心类型 ── */
export type {
  AgentDecisionAction, AgentDecision, StepObservation,
  ExecutionConstraints, TokenBudget, CostBudget, LoopBudget,
  DecisionQualityScore,
} from "@mindpal/shared";
export { isBudgetExhausted, recordTokenUsage, recordCostUsage, createDefaultBudget } from "@mindpal/shared";

/* ── 本地扩展类型（比共享包多 verification 字段） ── */
export interface AgentLoopResult extends SharedAgentLoopResult {
  /** P0-2: 验证结果（当 endReason=done 时） */
  verification?: VerificationResult;
}

/* ── 本地独有类型（依赖 Fastify/pg/WorkflowQueue 等框架类型） ── */

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
