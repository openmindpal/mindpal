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
} from "@mindpal/shared";
import { StructuredLogger, tryTransitionAgent, mapOrchestrationToAgent, OrchestrationEventType } from "@mindpal/shared";
import type { AgentPhase, PreflightResult } from "@mindpal/shared";

import { runAgentLoop, type AgentLoopParams, type AgentLoopResult } from "./agentLoop";
import type { LoopState } from "./loopLifecycle";
import { runPlanningPipeline } from "./planningKernel";
import type { WorkflowQueue } from "../modules/workflow/queue";
import { startSpan as otelStartSpan } from "../lib/tracing";

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

  /** 编排预检：预算 / 角色工具策略 / 审批需求评估 */
  preflightCheck(params: {
    pool: Pool;
    runId: string;
    stepId: string;
    tenantId: string;
    toolRef?: string;
    subject?: { subjectId: string; roles?: string[] };
  }): Promise<PreflightResult>;
}

/* ================================================================== */
/*  默认实现                                                           */
/* ================================================================== */

/** 活跃循环跟踪表（runId → AbortController） */
const activeLoops = new Map<string, { controller: AbortController; phase: OrchestrationPhase }>();

/**
 * 校验编排阶段转换是否符合 Agent 状态机约束。
 * 仅记录 warn 日志，不阻塞主流程。
 */
function validatePhaseTransition(fromPhase: string, toPhase: string): void {
  const fromAgent = mapOrchestrationToAgent(fromPhase);
  const toAgent = mapOrchestrationToAgent(toPhase);
  const result = tryTransitionAgent(fromAgent, toAgent);
  if (!result.ok) {
    logger.warn("Agent state machine violation", {
      fromPhase, toPhase, fromAgent, toAgent,
      violation: result.violation?.message,
    });
  }
}

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

  /* ------------------------------------------------------------------ */
  /*  私有编排决策函数（闭包内部，不暴露到接口）                          */
  /* ------------------------------------------------------------------ */

  /**
   * 处理步骤失败/超时：元数据驱动重试或终止决策
   */
  async function handleStepFailure(result: StepExecutionResult): Promise<void> {
    const { runId, stepId, status } = result;
    try {
      // 1. 查询 run 元数据获取重试策略
      const runRes = await pool.query(
        `SELECT input_digest, tenant_id, status as run_status FROM runs WHERE run_id = $1`,
        [runId],
      );
      if (!runRes.rowCount) return;

      const run = runRes.rows[0];
      if (run.run_status === "failed" || run.run_status === "stopped") return; // 已终态

      const limits = (run.input_digest as any)?.limits ?? {};
      const maxRetries = Number(limits.maxRetries ?? 0); // 从元数据读取重试上限

      // 2. 如果错误可恢复且有重试余量
      if (result.error?.recoverable && maxRetries > 0) {
        const retryRes = await pool.query(
          `SELECT COUNT(*)::int AS attempt_count FROM steps
           WHERE run_id = $1 AND tool_ref = $2 AND status = 'failed'`,
          [runId, result.toolRef ?? ""],
        );
        const attempts = retryRes.rows[0]?.attempt_count ?? 0;

        if (attempts < maxRetries) {
          // 元数据允许重试 → 记录决策，不终止（Agent Loop 自身会处理重试）
          logger.info("orchestration:retry_allowed", {
            runId, stepId, attempts, maxRetries, toolRef: result.toolRef,
          });
          return;
        }
      }

      // 3. 不可恢复 或 重试耗尽 → 终止 run
      logger.info("orchestration:run_terminating", {
        runId, stepId,
        reason: status === "timeout" ? "step_timeout" : "step_failed_unrecoverable",
        errorCode: result.error?.code,
      });

      await pool.query(
        `UPDATE runs SET status = 'failed', updated_at = now(), finished_at = now()
         WHERE run_id = $1 AND status NOT IN ('failed', 'stopped', 'succeeded')`,
        [runId],
      );

      // 发布终止事件
      const terminateEvent: OrchestrationEvent = {
        eventType: OrchestrationEventType.RUN_TERMINATED,
        runId, stepId, tenantId: run.tenant_id ?? "", traceId: "",
        timestamp: new Date().toISOString(),
        payload: { reason: result.error?.message ?? status, finalStatus: "failed" },
      };
      app.redis?.publish(
        `orchestration:run_terminated:${runId}`,
        JSON.stringify(terminateEvent),
      ).catch((err: unknown) => {
        app.log.debug({ runId, error: String((err as Error)?.message ?? err) }, "[Orchestration] run_terminated publish failed (best-effort)");
      });
    } catch (err: any) {
      logger.warn("orchestration:handleStepFailure error", { runId, stepId, error: err?.message });
    }
  }

  /**
   * 处理步骤成功：元数据驱动的预算检查
   */
  async function handleStepSuccess(result: StepExecutionResult): Promise<void> {
    const { runId, stepId } = result;
    try {
      // 1. 查询 run 元数据获取预算限制
      const runRes = await pool.query(
        `SELECT input_digest, tenant_id, started_at, status as run_status FROM runs WHERE run_id = $1`,
        [runId],
      );
      if (!runRes.rowCount) return;

      const run = runRes.rows[0];
      if (run.run_status !== "running") return; // 非运行态不检查

      const limits = (run.input_digest as any)?.limits ?? {};
      const maxSteps = limits.maxSteps ? Number(limits.maxSteps) : null;
      const maxWallTimeMs = limits.maxWallTimeMs ? Number(limits.maxWallTimeMs) : null;

      // 2. 检查步骤数预算
      if (maxSteps) {
        const countRes = await pool.query(
          `SELECT COUNT(*)::int AS step_count FROM steps WHERE run_id = $1 AND status NOT IN ('canceled')`,
          [runId],
        );
        if ((countRes.rows[0]?.step_count ?? 0) >= maxSteps) {
          logger.info("orchestration:budget_exceeded_steps", { runId, stepId, maxSteps });
          await pool.query(
            `UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = now()
             WHERE run_id = $1 AND status = 'running'`,
            [runId],
          );
          return;
        }
      }

      // 3. 检查时间预算
      if (maxWallTimeMs && run.started_at) {
        const elapsed = Date.now() - new Date(run.started_at).getTime();
        if (elapsed > maxWallTimeMs) {
          logger.info("orchestration:budget_exceeded_wall_time", { runId, stepId, elapsed, maxWallTimeMs });
          await pool.query(
            `UPDATE runs SET status = 'stopped', updated_at = now(), finished_at = now()
             WHERE run_id = $1 AND status = 'running'`,
            [runId],
          );
          return;
        }
      }

      // 4. 预算未超限 → 记录成功（Agent Loop 自行推进后续步骤）
      logger.info("orchestration:step_completed_ok", { runId, stepId, toolRef: result.toolRef });
    } catch (err: any) {
      logger.warn("orchestration:handleStepSuccess error", { runId, stepId, error: err?.message });
    }
  }

  return {
    async startLoop(params: StartLoopParams): Promise<AgentLoopResult> {
      const { runId } = params;
      const controller = new AbortController();

      // 合并外部信号
      const combinedSignal = params.signal
        ? combineAbortSignals(params.signal, controller.signal)
        : controller.signal;

      activeLoops.set(runId, { controller, phase: OrchestrationPhase.PLANNING });
      validatePhaseTransition(OrchestrationPhase.IDLE, OrchestrationPhase.PLANNING);

      logger.info("orchestration loop starting", { runId, goal: params.goal.slice(0, 100) });

      // ── 轻量级编排层 span（内部 agentLoop 已做细粒度 tracing） ──
      const orchestrationSpan = otelStartSpan("orchestration.loop") as any;
      try { orchestrationSpan.setAttribute?.("orchestration.run_id", runId); } catch { /* noop */ }

      try {
        validatePhaseTransition(OrchestrationPhase.PLANNING, OrchestrationPhase.EXECUTING);
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
        if (entry) {
          validatePhaseTransition(entry.phase, finalPhase);
          entry.phase = finalPhase;
        }

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
        if (entry) {
          validatePhaseTransition(entry.phase, OrchestrationPhase.FAILED);
          entry.phase = OrchestrationPhase.FAILED;
        }
        logger.error("orchestration loop error", { runId, error: err?.message });
        try { orchestrationSpan.setStatus?.({ code: 2, message: err?.message }); } catch { /* noop */ }
        throw err;
      } finally {
        try { orchestrationSpan.end?.(); } catch { /* noop */ }
        // 终态循环延迟清理（给 handleStepResult 留余量）
        setTimeout(() => activeLoops.delete(runId), 30_000);
      }
    },

    async handleStepResult(result: StepExecutionResult): Promise<void> {
      const { runId, stepId, status } = result;

      // 1. 验证事件合法性
      if (!runId || !stepId) {
        logger.warn("handleStepResult: invalid step result — missing runId or stepId", { runId, stepId });
        return;
      }

      // 2. 记录编排事件（可观测性）
      logger.info("orchestration:step_result_received", {
        runId,
        stepId,
        status,
        durationMs: result.durationMs,
        toolRef: result.toolRef,
      });

      // 3. 处理阻塞状态
      if (status === "blocked") {
        logger.info("step blocked, awaiting external resolution", {
          runId,
          stepId,
          blockReason: result.blockReason,
        });
        return;
      }

      // 4. 发出领域事件供下游消费（监控、审计、未来编排决策）
      try {
        const eventPayload: OrchestrationEvent = {
          eventType: OrchestrationEventType.STEP_COMPLETED,
          runId,
          stepId,
          tenantId: "",
          traceId: "",
          timestamp: new Date().toISOString(),
          payload: { status, durationMs: result.durationMs, toolRef: result.toolRef },
        };
        // 通过 Redis Pub/Sub 广播编排事件（复用已有通道）
        app.redis?.publish(
          `orchestration:step_completed:${runId}`,
          JSON.stringify(eventPayload),
        ).catch((err: unknown) => {
          app.log.debug({ runId, error: String((err as Error)?.message ?? err) }, "[Orchestration] step_completed publish failed (best-effort)");
        });
      } catch {
        // best-effort 事件发布，不阻断主流程
      }

      // 5. 编排决策：根据 status 驱动状态收口
      if (status === "failed" || status === "timeout") {
        await handleStepFailure(result);
      } else if (status === "completed") {
        await handleStepSuccess(result);
      }
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

    async preflightCheck(params: {
      pool: Pool;
      runId: string;
      stepId: string;
      tenantId: string;
      toolRef?: string;
      subject?: { subjectId: string; roles?: string[] };
    }) {
      // 委托给独立导出的 preflightCheck 函数
      return preflightCheck(params);
    },

    async cancelLoop(runId: string): Promise<void> {
      const entry = activeLoops.get(runId);
      if (entry) {
        logger.info("cancelling orchestration loop", { runId });
        entry.controller.abort();
        validatePhaseTransition(entry.phase, OrchestrationPhase.CANCELLED);
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

/**
 * 独立导出的 preflightCheck 函数，供 executionKernel 等模块在
 * step 入队前调用，无需持有 OrchestrationKernel 实例。
 */
export async function preflightCheck(params: {
  pool: Pool;
  runId: string;
  stepId: string;
  tenantId: string;
  toolRef?: string;
  subject?: { subjectId: string; roles?: string[] };
}): Promise<PreflightResult> {
  const { pool, runId, stepId, tenantId, toolRef, subject } = params;

  // 1. 预算检查（从 input_digest.limits 元数据读取，统一数据源）
  const runMeta = await pool.query(
    `SELECT r.input_digest, r.started_at, COUNT(s2.step_id)::int AS step_count
     FROM runs r
     LEFT JOIN steps s2 ON s2.run_id = r.run_id AND s2.status NOT IN ('canceled')
     WHERE r.run_id = $1 AND r.tenant_id = $2
     GROUP BY r.run_id`,
    [runId, tenantId],
  );

  if (runMeta.rowCount === 0) {
    return { ok: false, issues: [{ code: "RUN_NOT_FOUND", severity: "error", message: "run_not_found" }] };
  }
  const meta = runMeta.rows[0];
  const limits = (meta.input_digest as any)?.limits ?? {};
  const maxSteps = limits.maxSteps ? Number(limits.maxSteps) : null;
  const maxWallTimeMs = limits.maxWallTimeMs ? Number(limits.maxWallTimeMs) : null;
  const maxTokens = limits.maxTokens ? Number(limits.maxTokens) : null;
  const maxCostUsd = limits.maxCostUsd ? Number(limits.maxCostUsd) : null;

  if (maxSteps && Number(meta.step_count) >= maxSteps) {
    return { ok: false, issues: [{ code: "BUDGET_EXCEEDED_STEPS", severity: "error", message: "budget_exceeded_max_steps" }] };
  }
  if (maxWallTimeMs && meta.started_at) {
    const elapsed = Date.now() - new Date(meta.started_at).getTime();
    if (elapsed > maxWallTimeMs) {
      return { ok: false, issues: [{ code: "BUDGET_EXCEEDED_WALL_TIME", severity: "error", message: "budget_exceeded_wall_time" }] };
    }
  }
  if (maxTokens || maxCostUsd) {
    const usage = await pool.query(
      `SELECT COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost
       FROM model_usage_events WHERE run_id = $1 AND tenant_id = $2`,
      [runId, tenantId],
    );
    const u = usage.rows[0];
    if (maxTokens && Number(u.tokens) >= maxTokens) {
      return { ok: false, issues: [{ code: "BUDGET_EXCEEDED_TOKENS", severity: "error", message: "budget_exceeded_tokens" }] };
    }
    if (maxCostUsd && Number(u.cost) >= maxCostUsd) {
      return { ok: false, issues: [{ code: "BUDGET_EXCEEDED_COST", severity: "error", message: "budget_exceeded_cost" }] };
    }
  }

  // 2. 角色工具策略校验
  if (toolRef && subject?.roles) {
    const roleRows = await pool.query(
      `SELECT role_name, tool_policy FROM collab_roles
       WHERE run_id = $1 AND tenant_id = $2 AND role_name = ANY($3)`,
      [runId, tenantId, subject.roles],
    );
    if (roleRows.rowCount) {
      const allowedTools = new Set<string>();
      for (const r of roleRows.rows) {
        for (const t of (r.tool_policy?.allowedTools ?? [])) allowedTools.add(t);
      }
      if (allowedTools.size > 0 && !allowedTools.has(toolRef) && !allowedTools.has("*")) {
        return {
          ok: false,
          issues: [{
            code: "TOOL_NOT_ALLOWED_FOR_ROLES",
            severity: "error",
            message: `Tool ${toolRef} not allowed for role`,
            details: { toolRef },
          }],
        };
      }
    }
  }

  // 3. 审批需求评估
  if (toolRef) {
    try {
      const { assessToolExecutionRisk } = await import("./approvalRuleEngine");
      const assessment = await assessToolExecutionRisk({
        pool, tenantId, toolRef, inputDraft: {},
      });
      if (assessment.approvalRequired) {
        return {
          ok: true,
          issues: [],
          requiredApprovals: [(assessment as any).suggestedApprover ?? "default"],
        };
      }
    } catch { /* 评估失败不阻断 */ }
  }

  return { ok: true, issues: [] };
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
