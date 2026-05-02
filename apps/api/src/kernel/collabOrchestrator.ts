/**
 * Collab Orchestrator — 多 Agent Loop 实例协作调度器（薄入口层）
 *
 * OS 思维：Agent Loop 是进程（process），CollabOrchestrator 是调度器（scheduler）。
 * 每个 Agent 是一个独立 runAgentLoop 实例，有特定角色和子目标。
 * Agent 间通过共享 DB（collab_envelopes）+ 事件通知进行通信。
 *
 * 协调策略由 LLM 决定（通过 CollabPlan），不硬编码调度逻辑。
 *
 * 设计约束：
 * - Agent Loop 本身零改动，只是被多次实例化
 * - 复用现有 task/run/step 模型
 * - 每个 Agent 有独立 runId，共享 taskId
 * - 通过 DB 共享状态和消息
 *
 * ── 模块拆分 ──
 * 本文件为薄调度入口，核心逻辑已拆分至：
 * - collabTypes.ts       — 公共类型定义
 * - collabEnvelope.ts    — Envelope 读写 + 共享状态 CRUD
 * - collabPlanner.ts     — 协作规划 + 单Agent回退
 * - collabStrategies.ts  — 执行策略（sequential/parallel/pipeline）
 * - collabValidation.ts  — 交叉验证 + 动态纠错 + 角色表现
 * - collabPermissions.ts — 角色权限 + 委派 + 仲裁 + 共识
 * - collabDebate.ts      — 辩论辅助 + N方辩论引擎 + 动态纠错 + 共识演化
 */
import crypto from "node:crypto";
import { upsertTaskState } from "../modules/memory/repo";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import { setCollabRunPrimaryRun, updateCollabRunStatus } from "../modules/agentRuntime/collabRepo";

// ── re-export 所有子模块的公共 API ──────────────────────────────

export type {
  CollabAgentRole, CollabPlan, AgentState, CollabResult,
  CollabOrchestratorParams, PermissionDelegation, CollabArbitrationStrategy,
  DebateV2PhaseParams,
} from "./collabTypes";

export {
  writeCollabEnvelope, readCollabEnvelopes, buildEnvelopeContext,
  upsertCollabSharedState, readCollabSharedState,
} from "./collabEnvelope";

export { planCollaboration, runSingleAgentFallback } from "./collabPlanner";

export { executeSequential, executeParallel, executePipeline } from "./collabStrategies";

export {
  runCrossValidationPhase, runDynamicCorrectionPhase,
  crossValidateAgent, recordRolePerformance, queryRolePerformanceHistory,
} from "./collabValidation";

export {
  persistRolePermissions, checkAgentToolPermission, incrementAgentBudget,
  delegatePermissions, checkAgentPermissionContext,
  revokePermissionDelegation, getAgentPermissionChain,
  arbitrateCollabConflict, runConsensusRound, arbitrateWithWeightedVote,
} from "./collabPermissions";

export { runDebateIfDivergent } from "./collabDebateAutoTrigger";
export { runDebatePhaseV2 } from "./collabDebate";

// ── 内部 import ────────────────────────────────────────────────

import type { CollabOrchestratorParams, CollabResult, AgentState } from "./collabTypes";
import { planCollaboration, runSingleAgentFallback } from "./collabPlanner";
import { executeSequential, executeParallel, executePipeline } from "./collabStrategies";
import { runCrossValidationPhase, runDynamicCorrectionPhase, recordRolePerformance } from "./collabValidation";
import { persistRolePermissions } from "./collabPermissions";
import { runDebateIfDivergent } from "./collabDebateAutoTrigger";

// ── 协作执行主入口 ──────────────────────────────────────────────

/**
 * 运行多 Agent 协作。
 * 根据 CollabPlan 的策略编排多个 Agent Loop 实例。
 */
export async function runCollabOrchestrator(params: CollabOrchestratorParams): Promise<CollabResult> {
  const {
    app, pool, queue, subject, locale, authorization, traceId,
    goal, taskId, collabRunId, signal,
  } = params;
  const maxIterationsPerAgent = params.maxIterationsPerAgent ?? 10;

  app.log.info({ taskId, collabRunId, goal: goal.slice(0, 100) }, "[CollabOrchestrator] 开始协作");

  // 1. 让 LLM 制定协作计划
  const { discoverEnabledTools } = await import("../modules/agentContext");
  const toolDiscovery = await discoverEnabledTools({ pool, tenantId: subject.tenantId, spaceId: subject.spaceId, locale });

  const plan = await planCollaboration({
    app, subject, locale, authorization, traceId, goal,
    toolCatalog: toolDiscovery.catalog,
  });

  if (!plan || plan.agents.length < 2) {
    app.log.warn({ taskId, collabRunId }, "[CollabOrchestrator] 协作规划失败，回退到单 Agent");
    return runSingleAgentFallback(params);
  }

  // P1-4: 持久化角色权限到 DB（供 Agent 执行时校验）
  await persistRolePermissions({ pool, tenantId: subject.tenantId, collabRunId, agents: plan.agents }).catch((e: any) =>
    app.log.warn({ err: e }, "[CollabOrchestrator] persistRolePermissions 失败（降级）"),
  );

  app.log.info({
    taskId, collabRunId,
    strategy: plan.strategy,
    agentCount: plan.agents.length,
    agents: plan.agents.map((a) => ({ id: a.agentId, role: a.role })),
  }, "[CollabOrchestrator] 协作计划");

  // 2. 为每个 Agent 创建独立的 Run
  const agentStates: AgentState[] = [];
  for (const agent of plan.agents) {
    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    await pool.query(
      `INSERT INTO runs (run_id, job_id, tenant_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pending', now(), now())`,
      [runId, jobId, subject.tenantId],
    );

    await pool.query(
      `INSERT INTO jobs (job_id, tenant_id, job_type, run_id, input_digest, created_by_subject_id, trigger, status, created_at, updated_at)
       VALUES ($1, $2, 'collab.agent', $3, $4, $5, 'collab_orchestrator', 'pending', now(), now())`,
      [jobId, subject.tenantId, runId, JSON.stringify({
        agentId: agent.agentId,
        role: agent.role,
        goal: agent.goal,
        collabRunId,
        taskId,
      }), subject.subjectId],
    );

    agentStates.push({
      agentId: agent.agentId,
      role: agent.role,
      goal: agent.goal,
      runId,
      jobId,
      status: "pending",
    });
  }

  // 3. 按策略编排执行
  let failoverApplied = false;
  try {
    switch (plan.strategy) {
      case "parallel":
        await executeParallel(agentStates, params, maxIterationsPerAgent);
        break;
      case "pipeline":
        await executePipeline(agentStates, plan.agents, params, maxIterationsPerAgent);
        break;
      case "sequential":
      default:
        await executeSequential(agentStates, params, maxIterationsPerAgent);
        break;
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    app.log.warn({ err: errMsg, taskId, collabRunId, strategy: plan.strategy }, "[CollabOrchestrator] collab_failover: 协作执行异常，降级为单Agent执行");

    // 保留已完成的部分结果
    const completedResults = agentStates.filter((s) => s.status === "done");

    // 选择表现评分最高的Agent作为降级执行者；若无已完成的则选第一个Agent
    const primaryAgent = completedResults.length > 0
      ? completedResults[0]!
      : agentStates[0]!;

    try {
      const fallbackResult = await runSingleAgentFallback(params);
      failoverApplied = true;

      insertAuditEvent(pool, {
        subjectId: subject.subjectId,
        tenantId: subject.tenantId,
        spaceId: subject.spaceId,
        resourceType: "memory",
        action: "collab.failover",
        inputDigest: {
          collabRunId,
          originalStrategy: plan.strategy,
          failoverAgentId: primaryAgent.agentId,
          error: errMsg.slice(0, 500),
          completedAgentCount: completedResults.length,
        },
        outputDigest: { ok: fallbackResult.ok },
        result: fallbackResult.ok ? "success" : "error",
        traceId: traceId ?? "",
      }).catch((e: unknown) => {
        app.log.warn({ err: (e as Error)?.message, collabRunId }, "[CollabOrchestrator] failover audit event failed");
      });

      return {
        ...fallbackResult,
        metadata: {
          ...fallbackResult.metadata,
          failoverApplied: true,
          failoverAgentId: primaryAgent.agentId,
        },
      };
    } catch (fallbackErr: unknown) {
      // 降级也失败，返回原始错误 + 降级失败信息
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      app.log.error({ err: fallbackMsg, taskId, collabRunId }, "[CollabOrchestrator] 降级单Agent执行也失败");
      await updateCollabRunStatus({ pool, tenantId: subject.tenantId, collabRunId, status: "failed" });
      return {
        ok: false,
        endReason: "error",
        agentResults: agentStates.map((s) => ({
          agentId: s.agentId, role: s.role,
          ok: s.status === "done", endReason: s.result?.endReason ?? s.status,
          message: s.result?.message ?? "",
        })),
        message: `协作执行异常: ${errMsg}；降级也失败: ${fallbackMsg}`,
        metadata: { failoverApplied: true },
      };
    }
  }

  // 4. 汇总结果
  const allDone = agentStates.every((s) => s.status === "done");
  const anyFailed = agentStates.some((s) => s.status === "failed");

  const finalPhase = allDone ? "succeeded" : anyFailed ? "partial_failure" : "completed";
  await upsertTaskState({
    pool, tenantId: subject.tenantId, spaceId: subject.spaceId,
    runId: agentStates[0].runId,
    phase: finalPhase,
  });

  insertAuditEvent(pool, {
    subjectId: subject.subjectId,
    tenantId: subject.tenantId,
    spaceId: subject.spaceId,
    resourceType: "memory",
    action: "task_state.upsert",
    inputDigest: {
      runId: agentStates[0].runId,
      phase: finalPhase,
      source: "collabOrchestrator",
      collabRunId,
      agentCount: agentStates.length,
    },
    outputDigest: {
      allDone,
      anyFailed,
      completedCount: agentStates.filter((s) => s.status === "done").length,
    },
    result: "success",
    traceId: traceId ?? "",
  }).catch((e: unknown) => {
    app.log.warn({ err: (e as Error)?.message, collabRunId }, "[CollabOrchestrator] audit event failed");
  });

  await setCollabRunPrimaryRun({
    pool, tenantId: subject.tenantId, collabRunId,
    primaryRunId: agentStates[0]?.runId ?? null,
  });
  await updateCollabRunStatus({
    pool, tenantId: subject.tenantId, collabRunId,
    status: allDone ? "completed" : anyFailed ? "failed" : "executing",
  });

  // P1-4: 交叉验证
  let crossValidationResults: CollabResult["crossValidation"] = undefined;
  if (params.enableCrossValidation && allDone && agentStates.length >= 2) {
    crossValidationResults = await runCrossValidationPhase({
      agentStates, params, maxIterationsPerAgent,
    }).catch((e: any) => {
      app.log.warn({ err: e }, "[CollabOrchestrator] 交叉验证阶段异常（降级跳过）");
      return undefined;
    });
  }

  // P1-2: 动态纠错
  let correctionResults: CollabResult["corrections"] = undefined;
  if (params.enableDynamicCorrection && crossValidationResults && crossValidationResults.length > 0) {
    correctionResults = await runDynamicCorrectionPhase({
      agentStates, crossValidationResults, params, maxIterationsPerAgent,
      maxRetries: params.maxCorrectionRetries ?? 2,
    }).catch((e: any) => {
      app.log.warn({ err: e }, "[CollabOrchestrator] 动态纠错阶段异常（降级跳过）");
      return undefined;
    });
  }

  // P1-5: 辩论机制
  let debateResult: CollabResult["debate"] = undefined;
  if (params.enableDebate && allDone && agentStates.length >= 2) {
    debateResult = await runDebateIfDivergent({
      agentStates, crossValidationResults, params, maxIterationsPerAgent,
    }).catch((e: any) => {
      app.log.warn({ err: e }, "[CollabOrchestrator] 辩论阶段异常（降级跳过）");
      return undefined;
    });
  }

  // P1-4: 记录角色表现评分（传入交叉验证和辩论结果以动态计算协作分）
  recordRolePerformance({
    pool, tenantId: subject.tenantId, spaceId: subject.spaceId, collabRunId, agentStates,
    crossValidation: crossValidationResults,
    debateResult: debateResult,
  }).catch((e: any) => app.log.warn({ err: e }, "[CollabOrchestrator] recordRolePerformance 失败"));

  return {
    ok: allDone,
    endReason: allDone ? "all_done" : "partial_failure",
    agentResults: agentStates.map((s) => ({
      agentId: s.agentId, role: s.role,
      ok: s.status === "done",
      endReason: s.result?.endReason ?? s.status,
      message: s.result?.message ?? "",
    })),
    message: allDone
      ? `所有 ${agentStates.length} 个 Agent 均完成任务`
      : `${agentStates.filter((s) => s.status === "done").length}/${agentStates.length} 个 Agent 完成`,
    crossValidation: crossValidationResults,
    debate: debateResult,
    corrections: correctionResults,
    metadata: {
      ...(failoverApplied ? { failoverApplied: true } : {}),
      ...((correctionResults as (typeof correctionResults) & { correctionExhausted?: boolean })?.correctionExhausted
        ? { correctionExhausted: true }
        : {}),
    },
  };
}
