/**
 * P2-1: 角色动态协同机制
 * 
 * 将固定角色流水线（retriever→guard→executor）升级为动态角色协同：
 * - 支持角色间来回修正、补充、回退
 * - 执行失败、证据不足、reviewer不认可、guard拦截等场景触发动态再规划
 * - 角色可动态加入/退出协作
 * 
 * 核心概念：
 * - CollabTurn: 协作轮次，每轮由一个角色执行
 * - TurnResult: 轮次执行结果，可触发下一轮或重规划
 * - RoleTransition: 角色间的状态转换
 */
import type { Pool } from "pg";
import { isConsensusReached, type ConsensusProposal, type ConsensusVote, StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "api:dynamicCoordinator" });
import { executeReplan, getReplanAttemptCount, type ReplanContext, type ReplanResult, type GuardReviewResult, DEFAULT_REPLAN_CONFIG } from "./collabReplanner";
import type { VerificationResult } from "../../../kernel/verifierAgent";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

export type RoleName = "planner" | "retriever" | "guard" | "executor" | "reviewer" | "arbiter" | string;

export type TurnOutcome = 
  | "continue"       // 继续下一个角色
  | "retry"          // 当前角色重试
  | "rollback"       // 回退到前一个角色
  | "replan"         // 触发重规划
  | "escalate"       // 升级到人工/仲裁
  | "complete"       // 协作完成
  | "abort";         // 协作中止

export type RoleTransitionReason =
  | "step_succeeded"
  | "step_failed"
  | "evidence_insufficient"
  | "guard_rejected"
  | "reviewer_rejected"
  | "timeout"
  | "manual_intervention"
  | "replan_triggered";

export interface CollabTurn {
  turnId: string;
  collabRunId: string;
  turnNumber: number;
  actorRole: RoleName;
  /** 触发此轮的原因 */
  triggerReason: string;
  /** 轮次状态 */
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  /** 轮次结果 */
  outcome?: TurnOutcome;
  /** 输入（来自前一角色的输出） */
  inputDigest?: Record<string, unknown>;
  /** 输出（传递给下一角色） */
  outputDigest?: Record<string, unknown>;
  /** 执行的步骤 */
  stepIds?: string[];
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface RoleTransition {
  fromRole: RoleName | null;
  toRole: RoleName;
  reason: RoleTransitionReason;
  metadata?: Record<string, unknown>;
}

export interface DynamicCollabState {
  collabRunId: string;
  currentTurn: number;
  currentRole: RoleName | null;
  roleHistory: RoleName[];
  /** 待执行的角色队列 */
  pendingRoles: RoleName[];
  /** 已完成角色 */
  completedRoles: Set<RoleName>;
  /** 角色执行统计 */
  roleStats: Map<RoleName, { attempts: number; successes: number; failures: number }>;
  /** 是否处于重规划状态 */
  replanningInProgress: boolean;
  /** 回退次数 */
  rollbackCount: number;
  /** 最大允许回退次数 */
  maxRollbacks: number;
}

/* ================================================================== */
/*  Default Role Flow                                                    */
/* ================================================================== */

/**
 * 默认角色流转规则
 * 从固定流水线升级为可配置的有向图
 */
export const DEFAULT_ROLE_FLOW: Record<RoleName, RoleName[]> = {
  planner: ["retriever", "guard", "executor"],  // planner 完成后可转向多个角色
  retriever: ["guard", "executor"],              // retriever 完成后交给 guard 或直接执行
  guard: ["executor", "reviewer"],               // guard 通过后执行或提交审核
  executor: ["reviewer", "arbiter"],             // executor 完成后可能需要审核
  reviewer: ["executor", "arbiter", "planner"],  // reviewer 可要求重做或升级
  arbiter: ["executor", "planner"],              // arbiter 决策后执行或重规划
};

/**
 * 角色优先级（用于解决冲突）
 */
export const ROLE_PRIORITY: Record<RoleName, number> = {
  arbiter: 100,
  reviewer: 80,
  guard: 60,
  executor: 40,
  retriever: 20,
  planner: 10,
};

/* ================================================================== */
/*  Dynamic Coordination Logic                                           */
/* ================================================================== */

/**
 * 根据当前状态决定下一个角色
 */
export function determineNextRole(params: {
  currentRole: RoleName | null;
  turnOutcome: TurnOutcome;
  roleFlow?: Record<RoleName, RoleName[]>;
  pendingRoles: RoleName[];
  completedRoles: Set<RoleName>;
  failedStepToolRef?: string;
  evidenceScore?: number;
}): RoleTransition | null {
  const { currentRole, turnOutcome, pendingRoles, completedRoles, failedStepToolRef, evidenceScore } = params;
  const roleFlow = params.roleFlow ?? DEFAULT_ROLE_FLOW;
  
  // 协作完成或中止
  if (turnOutcome === "complete" || turnOutcome === "abort") {
    return null;
  }
  
  // 回退逻辑
  if (turnOutcome === "rollback") {
    if (!currentRole) return null;
    // 找到能处理回退的角色
    const rollbackTargets: Record<RoleName, RoleName> = {
      executor: "guard",
      reviewer: "executor",
      arbiter: "reviewer",
      guard: "retriever",
      retriever: "planner",
    };
    const target = rollbackTargets[currentRole];
    if (target) {
      return { fromRole: currentRole, toRole: target, reason: "step_failed" };
    }
    return null;
  }
  
  // 重规划逻辑
  if (turnOutcome === "replan") {
    return { fromRole: currentRole, toRole: "planner", reason: "replan_triggered" };
  }
  
  // 升级到仲裁
  if (turnOutcome === "escalate") {
    return { fromRole: currentRole, toRole: "arbiter", reason: "manual_intervention" };
  }
  
  // 重试当前角色
  if (turnOutcome === "retry") {
    if (currentRole) {
      return { fromRole: currentRole, toRole: currentRole, reason: "step_failed" };
    }
    return null;
  }
  
  // 正常继续 - 从 roleFlow 中选择下一个
  if (turnOutcome === "continue" && currentRole) {
    const candidates = roleFlow[currentRole] ?? [];
    // 优先选择未完成且在待执行队列中的角色
    for (const candidate of candidates) {
      if (pendingRoles.includes(candidate) && !completedRoles.has(candidate)) {
        let reason: RoleTransitionReason = "step_succeeded";
        // 特殊情况：证据不足触发 retriever
        if (candidate === "retriever" && evidenceScore !== undefined && evidenceScore < 0.5) {
          reason = "evidence_insufficient";
        }
        return { fromRole: currentRole, toRole: candidate, reason };
      }
    }
    // 如果没有待执行的，选择第一个未完成的
    for (const candidate of candidates) {
      if (!completedRoles.has(candidate)) {
        return { fromRole: currentRole, toRole: candidate, reason: "step_succeeded" };
      }
    }
  }
  
  // 初始状态：从 pendingRoles 中选择第一个
  if (!currentRole && pendingRoles.length > 0) {
    return { fromRole: null, toRole: pendingRoles[0], reason: "step_succeeded" };
  }
  
  return null;
}

/**
 * 评估是否需要重规划
 */
export function shouldTriggerReplan(params: {
  failureCount: number;
  maxFailures: number;
  evidenceScore?: number;
  minEvidenceScore: number;
  guardRejected: boolean;
  reviewerRejected: boolean;
  rollbackCount: number;
  maxRollbacks: number;
}): { shouldReplan: boolean; reason: string } {
  const { failureCount, maxFailures, evidenceScore, minEvidenceScore, guardRejected, reviewerRejected, rollbackCount, maxRollbacks } = params;
  
  // 连续失败超过阈值
  if (failureCount >= maxFailures) {
    return { shouldReplan: true, reason: `连续失败 ${failureCount} 次，超过阈值 ${maxFailures}` };
  }
  
  // 证据分数过低
  if (evidenceScore !== undefined && evidenceScore < minEvidenceScore) {
    return { shouldReplan: true, reason: `证据分数 ${evidenceScore.toFixed(2)} 低于阈值 ${minEvidenceScore}` };
  }
  
  // Guard 拦截
  if (guardRejected) {
    return { shouldReplan: true, reason: "Guard 拦截，需重新规划安全的执行路径" };
  }
  
  // Reviewer 不认可
  if (reviewerRejected) {
    return { shouldReplan: true, reason: "Reviewer 不认可执行结果，需重新规划" };
  }
  
  // 回退次数过多
  if (rollbackCount >= maxRollbacks) {
    return { shouldReplan: true, reason: `回退次数 ${rollbackCount} 达到上限 ${maxRollbacks}，需完全重规划` };
  }
  
  return { shouldReplan: false, reason: "" };
}

/* ================================================================== */
/*  Turn Management                                                      */
/* ================================================================== */

/**
 * 创建新的协作轮次
 */
export async function createCollabTurn(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  turnNumber: number;
  actorRole: RoleName;
  triggerReason: string;
  inputDigest?: Record<string, unknown>;
}): Promise<CollabTurn> {
  const { pool, tenantId, collabRunId, turnNumber, actorRole, triggerReason, inputDigest } = params;
  
  const res = await pool.query<{ turn_id: string; created_at: string }>(
    `INSERT INTO collab_turns 
     (tenant_id, collab_run_id, turn_number, actor_role, trigger_reason, status, input_digest, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6, now(), now())
     RETURNING turn_id, created_at`,
    [tenantId, collabRunId, turnNumber, actorRole, triggerReason, inputDigest ? JSON.stringify(inputDigest) : null]
  );
  
  return {
    turnId: res.rows[0].turn_id,
    collabRunId,
    turnNumber,
    actorRole,
    triggerReason,
    status: "pending",
    inputDigest,
    createdAt: res.rows[0].created_at,
  };
}

/**
 * 更新轮次状态
 */
export async function updateCollabTurn(params: {
  pool: Pool;
  tenantId: string;
  turnId: string;
  status: CollabTurn["status"];
  outcome?: TurnOutcome;
  outputDigest?: Record<string, unknown>;
  stepIds?: string[];
}): Promise<void> {
  const { pool, tenantId, turnId, status, outcome, outputDigest, stepIds } = params;
  
  const completedAt = ["completed", "failed", "rolled_back"].includes(status) ? "now()" : "NULL";
  const startedAt = status === "running" ? "now()" : "started_at";
  
  await pool.query(
    `UPDATE collab_turns 
     SET status = $3, 
         outcome = $4,
         output_digest = COALESCE($5, output_digest),
         step_ids = COALESCE($6, step_ids),
         started_at = ${startedAt},
         completed_at = ${completedAt},
         updated_at = now()
     WHERE tenant_id = $1 AND turn_id = $2`,
    [tenantId, turnId, status, outcome, outputDigest ? JSON.stringify(outputDigest) : null, stepIds ? JSON.stringify(stepIds) : null]
  );
}

/**
 * 获取协作的轮次历史
 */
export async function getCollabTurnHistory(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
}): Promise<CollabTurn[]> {
  const { pool, tenantId, collabRunId } = params;
  
  const res = await pool.query<{
    turn_id: string;
    collab_run_id: string;
    turn_number: number;
    actor_role: string;
    trigger_reason: string;
    status: string;
    outcome: string | null;
    input_digest: any;
    output_digest: any;
    step_ids: string[] | null;
    started_at: string | null;
    completed_at: string | null;
    created_at: string;
  }>(
    `SELECT * FROM collab_turns 
     WHERE tenant_id = $1 AND collab_run_id = $2 
     ORDER BY turn_number ASC`,
    [tenantId, collabRunId]
  );
  
  return res.rows.map(row => ({
    turnId: row.turn_id,
    collabRunId: row.collab_run_id,
    turnNumber: row.turn_number,
    actorRole: row.actor_role,
    triggerReason: row.trigger_reason,
    status: row.status as CollabTurn["status"],
    outcome: row.outcome as TurnOutcome | undefined,
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    stepIds: row.step_ids ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
  }));
}

/* ================================================================== */
/*  Role Statistics                                                      */
/* ================================================================== */

/**
 * 更新角色统计
 */
export function updateRoleStats(
  stats: Map<RoleName, { attempts: number; successes: number; failures: number }>,
  role: RoleName,
  success: boolean
): void {
  const current = stats.get(role) ?? { attempts: 0, successes: 0, failures: 0 };
  current.attempts += 1;
  if (success) {
    current.successes += 1;
  } else {
    current.failures += 1;
  }
  stats.set(role, current);
}

/**
 * 计算角色的成功率
 */
export function getRoleSuccessRate(
  stats: Map<RoleName, { attempts: number; successes: number; failures: number }>,
  role: RoleName
): number {
  const s = stats.get(role);
  if (!s || s.attempts === 0) return 1; // 默认假设会成功
  return s.successes / s.attempts;
}

/* ================================================================== */
/*  Coordination Events                                                  */
/* ================================================================== */

export type CoordinationEventType = 
  | "role.started"
  | "role.completed"
  | "role.failed"
  | "role.rollback"
  | "role.replan"
  | "role.escalate"
  | "collab.replan.started"
  | "collab.replan.completed"
  | "collab.replan.guard_review"
  | "collab.replan.verified"
  | "collab.replan.escalated";

export interface CoordinationEvent {
  eventType: CoordinationEventType;
  collabRunId: string;
  turnNumber: number;
  actorRole: RoleName;
  transition?: RoleTransition;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

/**
 * 记录协调事件
 */
export async function recordCoordinationEvent(params: {
  pool: Pool;
  tenantId: string;
  event: Omit<CoordinationEvent, "timestamp">;
}): Promise<void> {
  const { pool, tenantId, event } = params;
  
  await pool.query(
    `INSERT INTO collab_coordination_events 
     (tenant_id, collab_run_id, turn_number, event_type, actor_role, transition, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [
      tenantId,
      event.collabRunId,
      event.turnNumber,
      event.eventType,
      event.actorRole,
      event.transition ? JSON.stringify(event.transition) : null,
      event.metadata ? JSON.stringify(event.metadata) : null,
    ]
  );
}

/* ================================================================== */
/*  P2-2: Replan Bridge — 将 replan 决策接入主执行链路                   */
/* ================================================================== */

/**
 * bridgeReplan 返回结果，包含 guard/verifier 闭环信息和 escalate 状态
 */
export interface BridgeReplanResult {
  replanned: boolean;
  /** 是否已自动 escalate 到人工 */
  escalated: boolean;
  /** 连续失败次数 */
  consecutiveFailures: number;
  newSteps?: number;
  strategy?: string;
  /** Guard 审查结果 */
  guardReview?: GuardReviewResult;
  /** Verifier 目标一致性校验结果 */
  verification?: VerificationResult;
  /** 人可读消息 */
  message?: string;
}

/**
 * 当 shouldTriggerReplan 返回 true 时，通过此函数调用 collabReplanner
 * 完成从 决策→执行 的完整链路。
 *
 * 闭环流程：
 * 1. 检查连续 replan 失败次数，超阈值直接 escalate
 * 2. 执行 replan（内含 guard 审查 + verifier 目标一致性校验）
 * 3. guard/verifier 拒绝且达 escalate 边界时自动上报人工
 */
export async function bridgeReplan(params: {
  app: any;
  pool: Pool;
  tenantId: string;
  spaceId: string;
  subject: { tenantId: string; spaceId: string; subjectId: string };
  collabRunId: string;
  taskId: string;
  runId: string;
  turnNumber: number;
  failedRole: RoleName;
  failureReason: string;
  locale: string;
  authorization: string | null;
  traceId: string | null;
  /** “此次”调用者已知的失败次数（可选，不传则从 DB 查） */
  knownFailureCount?: number;
  /** 触发重规划的具体原因 */
  trigger?: string;
  /** 对应 guard 拒绝的原因 */
  guardReason?: string;
  /** 对应 reviewer 反馈 */
  reviewerFeedback?: string;
  /** 已完成的步骤 ID */
  completedStepIds?: string[];
  /** 前一次的计划步骤（用于增量重规划） */
  previousPlanSteps?: any[];
}): Promise<BridgeReplanResult> {
  const {
    app, pool, tenantId, spaceId, subject,
    collabRunId, taskId, runId, turnNumber,
    failedRole, failureReason,
    locale, authorization, traceId,
    guardReason, reviewerFeedback,
    completedStepIds, previousPlanSteps,
  } = params;

  const escalateThreshold = DEFAULT_REPLAN_CONFIG.consecutiveFailureEscalateThreshold;

  // ── 1. 获取历史 replan 次数 ──
  const historicalCount = params.knownFailureCount ?? await getReplanAttemptCount({ pool, tenantId, collabRunId });
  const replanAttempts = historicalCount + 1; // 当前这次算第 N+1 次

  // ── 2. 连续失败超阈值，自动 escalate 到人工 ──
  if (historicalCount >= escalateThreshold) {
    await recordCoordinationEvent({
      pool, tenantId,
      event: {
        eventType: "collab.replan.escalated",
        collabRunId,
        turnNumber,
        actorRole: failedRole,
        metadata: {
          reason: "consecutive_replan_failures",
          failureCount: historicalCount,
          threshold: escalateThreshold,
          failureReason,
        },
      },
    });

    return {
      replanned: false,
      escalated: true,
      consecutiveFailures: historicalCount,
      message: `连续 replan 失败 ${historicalCount} 次（阈值 ${escalateThreshold}），已自动 escalate 到人工`,
    };
  }

  // ── 3. 记录 replan 开始事件 ──
  await recordCoordinationEvent({
    pool, tenantId,
    event: {
      eventType: "collab.replan.started",
      collabRunId,
      turnNumber,
      actorRole: failedRole,
      metadata: { failureReason, replanAttempts, trigger: params.trigger },
    },
  });

  // ── 4. 构建 replan 上下文 ──
  const trigger = (params.trigger ?? "step_failed") as any;
  const replanContext: ReplanContext = {
    collabRunId,
    taskId,
    runId,
    trigger,
    failedStepId: undefined,
    failedToolRef: undefined,
    failureCount: historicalCount + 1,
    guardReason,
    reviewerFeedback,
    previousPlanSteps: previousPlanSteps ?? [],
    completedStepIds: completedStepIds ?? [],
    originalMessage: failureReason,
  };

  try {
    // ── 5. 调用 collabReplanner 执行重规划（内含 guard + verifier 闭环） ──
    const result = await executeReplan({
      app, pool, tenantId, spaceId, subject,
      context: replanContext,
      locale, authorization, traceId,
      replanAttempts,
    });

    // ── 6. 记录 replan 完成事件 ──
    await recordCoordinationEvent({
      pool, tenantId,
      event: {
        eventType: "collab.replan.completed",
        collabRunId,
        turnNumber,
        actorRole: "planner",
        metadata: {
          strategy: result.strategy,
          newStepCount: result.newPlanSteps?.length ?? 0,
          ok: result.ok,
          guardPassed: result.guardReview?.passed ?? null,
          verifierVerdict: result.verification?.verdict ?? null,
          escalated: result.escalated ?? false,
        },
      },
    });

    // ── 7. replan 本身失败（guard/verifier 拒绝）且已达 escalate 边界 ──
    if (!result.ok && replanAttempts >= escalateThreshold) {
      await recordCoordinationEvent({
        pool, tenantId,
        event: {
          eventType: "collab.replan.escalated",
          collabRunId,
          turnNumber,
          actorRole: failedRole,
          metadata: {
            reason: "replan_rejected_at_threshold",
            replanAttempts,
            strategy: result.strategy,
            guardPassed: result.guardReview?.passed,
            verifierVerdict: result.verification?.verdict,
          },
        },
      });

      return {
        replanned: false,
        escalated: true,
        consecutiveFailures: replanAttempts,
        newSteps: 0,
        strategy: result.strategy,
        guardReview: result.guardReview,
        verification: result.verification,
        message: result.message,
      };
    }

    return {
      replanned: result.ok,
      escalated: false,
      consecutiveFailures: result.ok ? 0 : replanAttempts,
      newSteps: result.newPlanSteps?.length ?? 0,
      strategy: result.strategy,
      guardReview: result.guardReview,
      verification: result.verification,
      message: result.message,
    };
  } catch (err) {
    _logger.error("bridgeReplan failed", { collabRunId, error: (err as Error)?.message ?? err });
    return {
      replanned: false,
      escalated: false,
      consecutiveFailures: replanAttempts,
      message: `replan 异常: ${(err as any)?.message ?? "unknown"}`,
    };
  }
}

/* ================================================================== */
/*  P0-协作: 共识投票运行时集成                                      */
/* ================================================================== */

/** 共识超时时长（毫秒，环境变量可覆盖） */
const CONSENSUS_TIMEOUT_MS = Math.max(5000, Number(process.env.CONSENSUS_TIMEOUT_MS ?? "30000"));
/** 共识轮询间隔（毫秒） */
const CONSENSUS_POLL_INTERVAL_MS = Math.max(200, Number(process.env.CONSENSUS_POLL_INTERVAL_MS ?? "1000"));

/**
 * 创建共识提案并写入 DB
 */
export async function proposeConsensus(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  proposedBy: string;
  topic: ConsensusProposal["topic"];
  content: Record<string, unknown>;
  voters: string[];
  quorum?: ConsensusProposal["quorum"];
  deadlineMs?: number;
}): Promise<ConsensusProposal> {
  const { pool, tenantId, collabRunId, proposedBy, topic, content, voters } = params;
  const quorum = params.quorum ?? "majority";
  const deadlineMs = params.deadlineMs ?? CONSENSUS_TIMEOUT_MS;
  const deadline = new Date(Date.now() + deadlineMs).toISOString();
  const now = new Date().toISOString();

  const res = await pool.query<{ proposal_id: string }>(
    `INSERT INTO collab_consensus_proposals
     (tenant_id, collab_run_id, proposed_by, topic, content, voters, quorum, deadline, status, votes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', '[]'::jsonb, now(), now())
     RETURNING proposal_id`,
    [tenantId, collabRunId, proposedBy, topic, JSON.stringify(content),
     JSON.stringify(voters), quorum, deadline],
  );

  const proposal: ConsensusProposal = {
    proposalId: res.rows[0].proposal_id,
    collabRunId,
    proposedBy,
    topic,
    content,
    voters,
    quorum,
    deadline,
    votes: [],
    status: "pending",
    createdAt: now,
  };

  return proposal;
}

/**
 * 提交共识投票
 */
export async function submitConsensusVote(params: {
  pool: Pool;
  tenantId: string;
  proposalId: string;
  vote: ConsensusVote;
}): Promise<void> {
  const { pool, tenantId, proposalId, vote } = params;
  await pool.query(
    `UPDATE collab_consensus_proposals
     SET votes = votes || $3::jsonb,
         updated_at = now()
     WHERE tenant_id = $1 AND proposal_id = $2 AND status = 'pending'`,
    [tenantId, proposalId, JSON.stringify([vote])],
  );
}

/**
 * 读取提案当前状态
 */
async function loadProposal(params: {
  pool: Pool;
  tenantId: string;
  proposalId: string;
}): Promise<ConsensusProposal | null> {
  const { pool, tenantId, proposalId } = params;
  const res = await pool.query<{
    proposal_id: string;
    collab_run_id: string;
    proposed_by: string;
    topic: string;
    content: any;
    voters: string[];
    quorum: string;
    deadline: string;
    votes: any[];
    status: string;
    created_at: string;
  }>(
    `SELECT proposal_id, collab_run_id, proposed_by, topic, content, voters, quorum, deadline, votes, status, created_at
     FROM collab_consensus_proposals
     WHERE tenant_id = $1 AND proposal_id = $2
     LIMIT 1`,
    [tenantId, proposalId],
  );
  if (!res.rowCount) return null;
  const r = res.rows[0];
  return {
    proposalId: r.proposal_id,
    collabRunId: r.collab_run_id,
    proposedBy: r.proposed_by,
    topic: r.topic as ConsensusProposal["topic"],
    content: r.content ?? {},
    voters: Array.isArray(r.voters) ? r.voters : [],
    quorum: r.quorum as ConsensusProposal["quorum"],
    deadline: r.deadline,
    votes: Array.isArray(r.votes) ? r.votes : [],
    status: r.status as ConsensusProposal["status"],
    createdAt: r.created_at,
  };
}

/**
 * 等待共识达成（轮询 + 超时自动 escalate）
 *
 * 返回：
 * - approved: quorum 达成，执行后续操作
 * - rejected: 投票不通过
 * - expired: 超时自动 escalate
 */
export async function awaitConsensus(params: {
  pool: Pool;
  tenantId: string;
  proposalId: string;
  signal?: AbortSignal;
}): Promise<{ result: "approved" | "rejected" | "expired"; proposal: ConsensusProposal }> {
  const { pool, tenantId, proposalId, signal } = params;

  const pollUntil = Date.now() + CONSENSUS_TIMEOUT_MS + 2000; // 额外 2s 容微差

  while (Date.now() < pollUntil) {
    if (signal?.aborted) break;

    const proposal = await loadProposal({ pool, tenantId, proposalId });
    if (!proposal) break;

    // 检查是否已被外部强制结束
    if (proposal.status !== "pending") {
      return {
        result: proposal.status === "approved" ? "approved" : "rejected",
        proposal,
      };
    }

    // 检查共识是否达成
    if (isConsensusReached(proposal)) {
      await pool.query(
        `UPDATE collab_consensus_proposals SET status = 'approved', updated_at = now() WHERE tenant_id = $1 AND proposal_id = $2`,
        [tenantId, proposalId],
      );
      return { result: "approved", proposal: { ...proposal, status: "approved" } };
    }

    // 检查是否所有人已投票但未通过
    const votedCount = proposal.votes.filter((v) => v.decision !== "abstain").length;
    if (votedCount >= proposal.voters.length) {
      await pool.query(
        `UPDATE collab_consensus_proposals SET status = 'rejected', updated_at = now() WHERE tenant_id = $1 AND proposal_id = $2`,
        [tenantId, proposalId],
      );
      return { result: "rejected", proposal: { ...proposal, status: "rejected" } };
    }

    // 检查是否超时
    if (new Date(proposal.deadline).getTime() <= Date.now()) {
      await pool.query(
        `UPDATE collab_consensus_proposals SET status = 'expired', updated_at = now() WHERE tenant_id = $1 AND proposal_id = $2`,
        [tenantId, proposalId],
      );
      return { result: "expired", proposal: { ...proposal, status: "expired" } };
    }

    // 等待下一次轮询
    await new Promise((resolve) => setTimeout(resolve, CONSENSUS_POLL_INTERVAL_MS));
  }

  // 超时 fallback
  const finalProposal = await loadProposal({ pool, tenantId, proposalId });
  if (finalProposal && finalProposal.status === "pending") {
    await pool.query(
      `UPDATE collab_consensus_proposals SET status = 'expired', updated_at = now() WHERE tenant_id = $1 AND proposal_id = $2`,
      [tenantId, proposalId],
    );
  }
  return { result: "expired", proposal: finalProposal ?? {} as ConsensusProposal };
}

/**
 * 高级共识门控：在关键决策点自动发起共识提案并等待结果
 *
 * 用法：在 replan/abort/escalate 决策前调用：
 *   const gate = await consensusGate({ ... });
 *   if (gate.approved) { // 执行后续操作 }
 *   else if (gate.escalated) { // 超时自动升级 }
 */
export async function consensusGate(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  proposedBy: string;
  topic: ConsensusProposal["topic"];
  content: Record<string, unknown>;
  voters: string[];
  quorum?: ConsensusProposal["quorum"];
  signal?: AbortSignal;
}): Promise<{
  approved: boolean;
  escalated: boolean;
  proposal: ConsensusProposal;
}> {
  const { pool, tenantId, collabRunId, proposedBy, topic, content, voters, quorum, signal } = params;

  // 1. 发起提案
  const proposal = await proposeConsensus({
    pool, tenantId, collabRunId, proposedBy, topic, content, voters, quorum,
  });

  // 2. 等待共识
  const { result, proposal: finalProposal } = await awaitConsensus({
    pool, tenantId, proposalId: proposal.proposalId, signal,
  });

  // 3. 超时自动 escalate
  if (result === "expired") {
    // 记录 escalate 事件
    await recordCoordinationEvent({
      pool, tenantId,
      event: {
        eventType: "role.escalate",
        collabRunId,
        turnNumber: 0,
        actorRole: proposedBy,
        metadata: {
          reason: "consensus_timeout",
          topic,
          proposalId: proposal.proposalId,
        },
      },
    });
  }

  return {
    approved: result === "approved",
    escalated: result === "expired",
    proposal: finalProposal,
  };
}

/**
 * 判断某个决策是否需要共识门控
 * 规则：replan / abort / escalate 且参与角色 >= 2 时需要共识
 */
export function requiresConsensus(params: {
  turnOutcome: TurnOutcome;
  participantRoles: string[];
}): boolean {
  const criticalOutcomes: TurnOutcome[] = ["replan", "abort", "escalate"];
  return criticalOutcomes.includes(params.turnOutcome) && params.participantRoles.length >= 2;
}
