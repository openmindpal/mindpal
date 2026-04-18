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
  };
}

export interface ExecutionConstraints {
  allowedTools?: string[];
  allowWrites?: boolean;
}

export interface AgentLoopResult {
  ok: boolean;
  /** 循环终止原因 */
  endReason: "done" | "aborted" | "interrupted" | "max_iterations" | "max_wall_time" | "error" | "ask_user";
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
}
