/**
 * Orchestration Kernel — Agent 循环的单一控制平面
 *
 * 职责边界：
 * - 意图识别与工具发现
 * - 目标分解与规划
 * - 状态机管理（IDLE → PLANNING → EXECUTING → REVIEWING → DONE）
 * - 执行调度（向 Worker 派发任务）
 * - 结果汇总与验证
 * - 处理 Worker 上报的 StepExecutionResult 事件
 *
 * 不负责：
 * - 沙箱执行（委托给 Worker/Runner 的 SandboxExecutor）
 * - 数据持久化细节（委托给 Repo 层）
 * - HTTP 请求路由（委托给 Fastify 路由层）
 *
 * 设计原则：
 * - 编排决策权单一来源：Worker 不再决定"下一步做什么"
 * - 事件驱动：Worker 通过 StepExecutionResult 上报结果，Kernel 驱动状态转换
 * - 委托实现：接口层调用现有 kernel 模块（agentLoop、planningKernel 等）
 */
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type {
  GoalGraph,
  WorldState,
  StepExecutionResult,
  OrchestrationEvent,
  OrchestrationEventType,
} from "@openslin/shared";
import { StructuredLogger } from "@openslin/shared";

import { runAgentLoop, type AgentLoopParams, type AgentLoopResult } from "./agentLoop";
import type { LoopState } from "./loopLifecycle";
import { runPlanningPipeline } from "./planningKernel";
import type { WorkflowQueue } from "../modules/workflow/queue";

const logger = new StructuredLogger({ module: "orchestrationKernel" });

/* ================================================================== */
/*  编排状态枚举                                                        */
/* ================================================================== */

/** 编排内核状态机 */
export enum OrchestrationPhase {
  /** 空闲 —— 等待新的 Agent 循环请求 */
  IDLE = "idle",
  /** 规划中 —— 意图识别、目标分解、工具发现 */
  PLANNING = "planning",
  /** 执行中 —— Agent Loop 正在运行 */
  EXECUTING = "executing",
  /** 审查中 —— 验证目标完成情况 */
  REVIEWING = "reviewing",
  /** 完成 */
  DONE = "done",
  /** 失败 */
  FAILED = "failed",
  /** 已取消 */
  CANCELLED = "cancelled",
}

/* ================================================================== */
/*  核心接口                                                           */
/* ================================================================== */

/** 启动循环参数 */
export interface StartLoopParams {
  app: FastifyInstance;
  pool: Pool;
  queue: WorkflowQueue;
  subject: { tenantId: string; spaceId: string; subjectId: string; roles?: string[] };
  locale: string;
  authorization: string | null;
  traceId: string | null;
  goal: string;
  runId: string;
  jobId: string;
  taskId: string;
  /** 外部中断信号 */
  signal?: AbortSignal;
  /** 用户中途干预消息 */
  userIntervention?: string;
  /** 指定默认模型 */
  defaultModelRef?: string;
  /** 执行约束 */
  executionConstraints?: { allowedTools?: string[]; allowWrites?: boolean };
  /** 调度优先级 */
  priority?: number;
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 最大执行时间(ms) */
  maxWallTimeMs?: number;
  /** 回调：步骤完成 */
  onStepComplete?: AgentLoopParams["onStepComplete"];
  /** 回调：循环结束 */
  onLoopEnd?: AgentLoopParams["onLoopEnd"];
  /** 恢复已有循环 */
  resumeLoopId?: string;
  resumeState?: AgentLoopParams["resumeState"];
}

/** 循环状态快照 */
export interface LoopStateSnapshot {
  runId: string;
  phase: OrchestrationPhase;
  iterations: number;
  succeededSteps: number;
  failedSteps: number;
  goalGraph?: GoalGraph;
  worldState?: WorldState;
}

/** Orchestration Kernel 接口 */
export interface IOrchestrationKernel {
  /** 启动新的 Agent 循环 */
  startLoop(params: StartLoopParams): Promise<AgentLoopResult>;

  /** 处理 Worker 上报的步骤执行结果，驱动编排状态转换 */
  handleStepResult(result: StepExecutionResult): Promise<void>;

  /** 获取当前循环状态快照 */
  getLoopState(runId: string): Promise<LoopStateSnapshot | null>;

  /** 取消正在执行的循环 */
  cancelLoop(runId: string): Promise<void>;
}

/* ================================================================== */
/*  默认实现                                                           */
/* ================================================================== */

/** 活跃循环跟踪表（runId → AbortController） */
const activeLoops = new Map<string, { controller: AbortController; phase: OrchestrationPhase }>();

/**
 * 创建 Orchestration Kernel 实例。
 *
 * 将现有的 runAgentLoop、planningKernel 等模块组合为统一控制平面。
 * Worker 完成步骤后通过 handleStepResult 上报，Kernel 驱动后续流转。
 */
export function createOrchestrationKernel(deps: {
  pool: Pool;
  app: FastifyInstance;
}): IOrchestrationKernel {
  const { pool, app } = deps;

  return {
    async startLoop(params: StartLoopParams): Promise<AgentLoopResult> {
      const { runId } = params;
      const controller = new AbortController();

      // 合并外部信号
      const combinedSignal = params.signal
        ? combineAbortSignals(params.signal, controller.signal)
        : controller.signal;

      activeLoops.set(runId, { controller, phase: OrchestrationPhase.PLANNING });

      logger.info("orchestration loop starting", { runId, goal: params.goal.slice(0, 100) });

      try {
        activeLoops.get(runId)!.phase = OrchestrationPhase.EXECUTING;

        const result = await runAgentLoop({
          ...params,
          signal: combinedSignal,
        } as AgentLoopParams);

        // 根据结果设置终态
        const finalPhase = result.ok
          ? OrchestrationPhase.DONE
          : result.endReason === "ask_user"
            ? OrchestrationPhase.IDLE
            : OrchestrationPhase.FAILED;

        const entry = activeLoops.get(runId);
        if (entry) entry.phase = finalPhase;

        logger.info("orchestration loop completed", {
          runId,
          endReason: result.endReason,
          iterations: result.iterations,
          succeededSteps: result.succeededSteps,
          failedSteps: result.failedSteps,
        });

        return result;
      } catch (err: any) {
        const entry = activeLoops.get(runId);
        if (entry) entry.phase = OrchestrationPhase.FAILED;
        logger.error("orchestration loop error", { runId, error: err?.message });
        throw err;
      } finally {
        // 终态循环延迟清理（给 handleStepResult 留余量）
        setTimeout(() => activeLoops.delete(runId), 30_000);
      }
    },

    async handleStepResult(result: StepExecutionResult): Promise<void> {
      const { runId, stepId, status } = result;

      logger.info("handling step result", {
        runId,
        stepId,
        status,
        durationMs: result.durationMs,
        toolRef: result.toolRef,
      });

      /**
       * 当前 Agent Loop（agentLoop.ts）通过 Redis Pub/Sub 的 `step:done:{stepId}`
       * 频道接收步骤完成信号，并从 DB 确认终态。
       *
       * 此方法作为编排内核的标准入口，未来将替代 Redis Pub/Sub 的隐式通知：
       * 1. 验证事件合法性（runId/stepId 存在性、状态转换合法性）
       * 2. 更新编排内核内存中的 LoopState
       * 3. 根据步骤结果驱动下一步决策（继续/重试/终止/升级审批）
       *
       * TODO: 将 agentLoop.ts 中的 waitForStepCompletion (Redis polling) 迁移到此事件驱动模型
       */

      if (result.status === "blocked") {
        logger.info("step blocked, awaiting external resolution", {
          runId,
          stepId,
          blockReason: result.blockReason,
        });
        // 阻塞步骤不驱动后续决策——等待审批/设备/仲裁解除后再继续
        return;
      }

      // 当前阶段：事件记录 + 日志可观测
      // 后续阶段：替换 Redis Pub/Sub，直接驱动 Agent Loop 的 Think-Decide-Act
    },

    async getLoopState(runId: string): Promise<LoopStateSnapshot | null> {
      const entry = activeLoops.get(runId);
      if (!entry) {
        // 从 DB 查询历史循环状态
        const res = await pool.query(
          "SELECT status, input_digest FROM runs WHERE run_id = $1 LIMIT 1",
          [runId],
        );
        if (!res.rowCount) return null;
        const run = res.rows[0];
        return {
          runId,
          phase: mapRunStatusToPhase(String(run.status ?? "")),
          iterations: 0,
          succeededSteps: 0,
          failedSteps: 0,
        };
      }

      // 从活跃循环中获取状态
      // 完整迭代计数等详情需要从 checkpoint 表读取
      const cpRes = await pool.query(
        "SELECT iteration, succeeded_steps, failed_steps FROM loop_checkpoints WHERE run_id = $1 ORDER BY updated_at DESC LIMIT 1",
        [runId],
      );
      const cp = cpRes.rowCount ? cpRes.rows[0] : null;

      return {
        runId,
        phase: entry.phase,
        iterations: Number(cp?.iteration ?? 0),
        succeededSteps: Number(cp?.succeeded_steps ?? 0),
        failedSteps: Number(cp?.failed_steps ?? 0),
      };
    },

    async cancelLoop(runId: string): Promise<void> {
      const entry = activeLoops.get(runId);
      if (entry) {
        logger.info("cancelling orchestration loop", { runId });
        entry.controller.abort();
        entry.phase = OrchestrationPhase.CANCELLED;
      } else {
        // 尝试通过 DB 标记取消（针对非本进程的循环）
        logger.info("cancelling loop via DB (not in active map)", { runId });
        await pool.query(
          "UPDATE runs SET status = 'canceled', updated_at = now(), finished_at = COALESCE(finished_at, now()) WHERE run_id = $1 AND status NOT IN ('succeeded', 'failed', 'canceled', 'stopped')",
          [runId],
        );
      }
    },
  };
}

/* ================================================================== */
/*  辅助函数                                                           */
/* ================================================================== */

/** 将 DB 中的 run status 映射为编排阶段 */
function mapRunStatusToPhase(status: string): OrchestrationPhase {
  switch (status) {
    case "created":
    case "queued":
      return OrchestrationPhase.PLANNING;
    case "running":
      return OrchestrationPhase.EXECUTING;
    case "paused":
    case "needs_approval":
    case "needs_device":
    case "needs_arbiter":
      return OrchestrationPhase.REVIEWING;
    case "succeeded":
      return OrchestrationPhase.DONE;
    case "failed":
    case "stopped":
      return OrchestrationPhase.FAILED;
    case "canceled":
      return OrchestrationPhase.CANCELLED;
    default:
      return OrchestrationPhase.IDLE;
  }
}

/** 合并两个 AbortSignal（任一触发即 abort） */
function combineAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
