/**
 * Collab Orchestrator — 公共类型定义
 *
 * 所有协作调度器子模块共享的类型/接口。
 */
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { LlmSubject } from "../lib/llm";
import type { AgentLoopResult } from "./agentLoop";
import type { WorkflowQueue } from "../modules/workflow/queue";

// ── 类型定义 ─────────────────────────────────────────────────────

/** 协作 Agent 角色定义 */
export interface CollabAgentRole {
  /** 角色 ID */
  agentId: string;
  /** 角色名称（LLM 生成） */
  role: string;
  /** 该 Agent 负责的子目标 */
  goal: string;
  /** 依赖哪些其他 Agent 的输出（agentId 列表） */
  dependencies: string[];
  /** 可选依赖（死锁时可跳过的依赖 agentId 列表） */
  optionalDependencies?: string[];
  /** P1-4: 允许使用的工具列表（空=不限制） */
  allowedTools?: string[];
  /** P1-4: 允许访问的资源类型 */
  allowedResources?: string[];
  /** P1-4: LLM 调用次数上限 */
  maxBudget?: number;
}

/** 协作计划（由 LLM 生成） */
export interface CollabPlan {
  /** 参与协作的 Agent 列表 */
  agents: CollabAgentRole[];
  /** 协调策略 */
  strategy: "sequential" | "parallel" | "pipeline";
  /** LLM 给出的策略说明 */
  reasoning: string;
}

/** 单个 Agent 的执行状态 */
export interface AgentState {
  agentId: string;
  role: string;
  goal: string;
  runId: string;
  jobId: string;
  status: "pending" | "running" | "done" | "failed";
  result?: AgentLoopResult;
}

/** 协作执行结果 */
export interface CollabResult {
  ok: boolean;
  endReason: "all_done" | "partial_failure" | "planning_failed" | "error";
  agentResults: Array<{ agentId: string; role: string; ok: boolean; endReason: string; message: string }>;
  message: string;
  /** P1-4: 交叉验证结果 */
  crossValidation?: Array<{ validatedAgent: string; validatorAgent: string; verdict: string; reasoning: string }>;
  /** P1-5: 辩论结果（当Agent间存在分歧时触发） */
  debate?: {
    debateId: string;
    topic: string;
    status: string;
    rounds: number;
    verdict?: { outcome: string; winnerRole?: string; synthesizedConclusion: string };
  };
  /** P1-2: 动态纠错结果 */
  corrections?: Array<{
    agentId: string;
    originalVerdict: string;
    retriesAttempted: number;
    finalVerdict: string;
    corrected: boolean;
  }>;
  /** 协作元数据（降级/纠错耗尽等运行时标记） */
  metadata?: {
    /** 协作执行失败后自动降级为单Agent执行 */
    failoverApplied?: boolean;
    /** 降级选中的Agent信息 */
    failoverAgentId?: string;
    /** 纠错轮次已耗尽（返回最佳可用结果而非报错） */
    correctionExhausted?: boolean;
    /** 各策略中被跳过的失败Agent列表 */
    skippedAgents?: Array<{ agentId: string; role: string; reason: string }>;
  };
}

/** 协作调度参数 */
export interface CollabOrchestratorParams {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** 用户原始目标 */
  goal: string;
  /** 任务 ID（所有 Agent 共享） */
  taskId: string;
  /** 协作运行 ID */
  collabRunId: string;
  /** 每个 Agent 最大迭代次数 */
  maxIterationsPerAgent?: number;
  /** 外部中断信号 */
  signal?: AbortSignal;
  /** P1-4: 是否启用交叉验证 */
  enableCrossValidation?: boolean;
  /** P1-5: 是否启用辩论机制（Agent结果分歧时自动触发） */
  enableDebate?: boolean;
  /** P1-2: 是否启用动态纠错（交叉验证不通过时自动重试） */
  enableDynamicCorrection?: boolean;
  /** P1-2: 最大纠错重试次数（默认2） */
  maxCorrectionRetries?: number;
}

/** 权限委派上下文 */
export interface PermissionDelegation {
  /** 父Agent ID */
  parentAgentId: string;
  /** 子Agent ID */
  childAgentId: string;
  /** 委派的工具子集（必须是父Agent允许范围的子集） */
  delegatedTools: string[];
  /** 委派的资源子集 */
  delegatedResources: string[];
  /** 委派的预算上限（不能超过父Agent剩余预算） */
  delegatedBudget: number;
  /** 行级过滤规则（JSON条件表达式） */
  rowFilters?: Record<string, any>;
  /** 字段级访问规则（允许/禁止的字段列表） */
  fieldRules?: { allow?: string[]; deny?: string[] };
  /** 权限过期时间 */
  expiresAt?: string;
}

export type CollabArbitrationStrategy = "priority" | "vote" | "escalate" | "first_writer_wins";


/** N方辩论参数 */
export interface DebateV2PhaseParams {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: LlmSubject & { spaceId: string };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  collabRunId: string;
  taskId: string;
  /** 辩论议题 */
  topic: string;
  /** N 方参与者 */
  parties: Array<{ agentId: string; role: string; goal: string; stance: string; budget?: number }>;
  /** 仲裁方角色 */
  arbiterRole?: string;
  /** 最大轮次 */
  maxRounds?: number;
  /** 每轮每方最大迭代次数 */
  maxIterationsPerRound?: number;
  /** 是否启用动态纠错 */
  enableCorrection?: boolean;
  /** 共识收敛阈值 */
  consensusThreshold?: number;
  signal?: AbortSignal;
}
