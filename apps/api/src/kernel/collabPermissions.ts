/**
 * Collab Orchestrator — 角色权限 + 权限委派 + 冲突仲裁 + 共识决策
 *
 * 包含：
 * - 角色权限持久化与校验（基础 + 预算）
 * - 子Agent权限委派（行级/字段级/过期）
 * - 冲突仲裁器（priority/vote/escalate/first_writer_wins）
 * - 高级共识决策（加权投票 / 超级多数 / BFT）
 */
import type { Pool } from "pg";
import type { LlmSubject } from "../lib/llm";
import { insertAuditEvent } from "../modules/audit/auditRepo";
import type { ConsensusProposal, ConsensusVote, ConsensusQuorumType } from "@openslin/shared";
import { isConsensusReached } from "@openslin/shared";
import crypto from "node:crypto";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "collabPermissions" });
import type { CollabAgentRole, PermissionDelegation, CollabArbitrationStrategy } from "./collabTypes";
import { upsertCollabSharedState } from "./collabEnvelope";
import { queryRolePerformanceHistory } from "./collabValidation";

// ── 仲裁 Agent 系统级权限约束 ────────────────────────

/** 仲裁 Agent 的系统级权限约束 */
export const ARBITER_ROLE_CONSTRAINTS = {
  role: "orchestrator_arbiter",
  maxBudget: null,           // 无预算限制
  allowedTools: ["*"],       // 全部工具
  auditLevel: "strict",      // 严格审计
  canDelegateToOthers: false, // 不能再委派
} as const;

// ── P1-4: 角色权限执行层 ───────────────────────────

/** P1-4: 持久化角色权限到 DB */
export async function persistRolePermissions(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  agents: CollabAgentRole[];
}) {
  for (const agent of params.agents) {
    await params.pool.query(
      `INSERT INTO collab_role_permissions (tenant_id, collab_run_id, agent_id, role, allowed_tools, allowed_resources, max_budget)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, collab_run_id, agent_id) DO UPDATE SET
         role = $4, allowed_tools = $5, allowed_resources = $6, max_budget = $7`,
      [params.tenantId, params.collabRunId, agent.agentId, agent.role,
       agent.allowedTools ?? null, agent.allowedResources ?? null, agent.maxBudget ?? null],
    );
  }
}

/** P1-4: 检查 Agent 是否有权使用某工具（含三级隔离 + 过期检查） */
export async function checkAgentToolPermission(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  agentId: string;
  toolName: string;
  /** 可选: 启用 space 级隔离 */
  spaceId?: string;
}): Promise<{ allowed: boolean; reason?: string }> {
  // 三级隔离查询: tenant + space (通过 JOIN collab_runs) + collabRun
  // 同时 LEFT JOIN collab_permission_contexts 以检查委派过期时间
  const res = await params.pool.query(
    `SELECT crp.allowed_tools, crp.max_budget, crp.used_budget, cpc.expires_at
     FROM collab_role_permissions crp
     JOIN collab_runs cr
       ON cr.collab_run_id = crp.collab_run_id AND cr.tenant_id = crp.tenant_id
     LEFT JOIN collab_permission_contexts cpc
       ON cpc.tenant_id = crp.tenant_id AND cpc.collab_run_id = crp.collab_run_id AND cpc.role_name = crp.agent_id
     WHERE crp.tenant_id = $1 AND crp.collab_run_id = $2 AND crp.agent_id = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [params.tenantId, params.collabRunId, params.agentId, params.spaceId ?? null],
  );
  if (!res.rowCount) return { allowed: true }; // 无权限记录 = 不限制

  const perm = res.rows[0] as Record<string, unknown>;

  // 检查委派权限过期
  if (perm.expires_at && new Date(perm.expires_at as string) < new Date()) {
    return { allowed: false, reason: "permission_delegation_expired" };
  }
  // 检查工具限制
  const allowedTools = perm.allowed_tools as string[] | null;
  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    if (!allowedTools.includes(params.toolName)) {
      return { allowed: false, reason: `Agent ${params.agentId} 无权使用工具 ${params.toolName}` };
    }
  }
  // 检查预算限制
  if (perm.max_budget != null && (perm.used_budget as number) >= (perm.max_budget as number)) {
    return { allowed: false, reason: `Agent ${params.agentId} 已超出预算限制 (${perm.used_budget}/${perm.max_budget})` };
  }
  return { allowed: true };
}

/** P1-4: 增加 Agent 预算使用计数（含三级隔离） */
export async function incrementAgentBudget(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  agentId: string;
  /** 可选: 启用 space 级隔离 */
  spaceId?: string;
}) {
  await params.pool.query(
    `UPDATE collab_role_permissions crp SET used_budget = used_budget + 1
     FROM collab_runs cr
     WHERE cr.collab_run_id = crp.collab_run_id AND cr.tenant_id = crp.tenant_id
       AND crp.tenant_id = $1 AND crp.collab_run_id = $2 AND crp.agent_id = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [params.tenantId, params.collabRunId, params.agentId, params.spaceId ?? null],
  );
}

// ── P1-4-2: 细粒度权限继承与委派 ───────────────

/**
 * P1-4-2: 子Agent权限委派
 *
 * 实现安全的权限继承：
 * 1. 验证父Agent确实拥有被委派的权限
 * 2. 子Agent权限不能超过父Agent
 * 3. 预算从父Agent余额中扣除
 * 4. 全程审计
 */
export async function delegatePermissions(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  delegation: PermissionDelegation;
}): Promise<{ ok: boolean; reason?: string }> {
  const { pool, tenantId, collabRunId, delegation } = params;

  // 0. 仲裁 Agent 禁止委派
  // 查询父Agent的权限（含 role 以检查仲裁约束，JOIN collab_runs 实现 space 隔离）
  const parentRes = await pool.query(
    `SELECT crp.role, crp.allowed_tools, crp.allowed_resources, crp.max_budget, crp.used_budget
     FROM collab_role_permissions crp
     JOIN collab_runs cr
       ON cr.collab_run_id = crp.collab_run_id AND cr.tenant_id = crp.tenant_id
     WHERE crp.tenant_id = $1 AND crp.collab_run_id = $2 AND crp.agent_id = $3`,
    [tenantId, collabRunId, delegation.parentAgentId],
  );
  if (!parentRes.rowCount) {
    return { ok: false, reason: `父Agent ${delegation.parentAgentId} 无权限记录` };
  }

  const parentPerm = parentRes.rows[0] as Record<string, unknown>;
  const parentRole = parentPerm.role as string;

  // 仲裁 Agent 不允许再委派权限
  if (parentRole === ARBITER_ROLE_CONSTRAINTS.role && ARBITER_ROLE_CONSTRAINTS.canDelegateToOthers === false) {
    return { ok: false, reason: "arbiter_cannot_delegate" };
  }
  const parentTools = parentPerm.allowed_tools as string[] | null;
  const parentResources = parentPerm.allowed_resources as string[] | null;
  const parentMaxBudget = parentPerm.max_budget as number | null;
  const parentUsedBudget = (parentPerm.used_budget as number) ?? 0;

  // 2. 验证工具子集合规性
  if (parentTools && parentTools.length > 0) {
    const invalidTools = delegation.delegatedTools.filter((t) => !parentTools.includes(t));
    if (invalidTools.length > 0) {
      return { ok: false, reason: `工具越权: ${invalidTools.join(",")} 不在父Agent允许范围内` };
    }
  }

  // 3. 验证资源子集合规性
  if (parentResources && parentResources.length > 0) {
    const invalidResources = delegation.delegatedResources.filter((r) => !parentResources.includes(r));
    if (invalidResources.length > 0) {
      return { ok: false, reason: `资源越权: ${invalidResources.join(",")} 不在父Agent允许范围内` };
    }
  }

  // 4. 验证预算不超过父Agent剩余
  if (parentMaxBudget != null) {
    const remaining = parentMaxBudget - parentUsedBudget;
    if (delegation.delegatedBudget > remaining) {
      return { ok: false, reason: `预算越权: 请求${delegation.delegatedBudget}，父Agent余额${remaining}` };
    }
  }

  // 5. 创建子Agent权限记录
  await pool.query(
    `INSERT INTO collab_role_permissions (tenant_id, collab_run_id, agent_id, role, allowed_tools, allowed_resources, max_budget)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, collab_run_id, agent_id) DO UPDATE SET
       allowed_tools = $5, allowed_resources = $6, max_budget = $7`,
    [
      tenantId, collabRunId, delegation.childAgentId,
      `child_of_${delegation.parentAgentId}`,
      delegation.delegatedTools.length > 0 ? delegation.delegatedTools : null,
      delegation.delegatedResources.length > 0 ? delegation.delegatedResources : null,
      delegation.delegatedBudget,
    ],
  );

  // 6. 创建细粒度权限上下文（行级/字段级规则）
  await pool.query(
    `INSERT INTO collab_permission_contexts
     (tenant_id, collab_run_id, role_name, effective_permissions, field_rules, row_filters, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, collab_run_id, role_name) DO UPDATE SET
       effective_permissions = $4, field_rules = $5, row_filters = $6, expires_at = $7`,
    [
      tenantId, collabRunId, delegation.childAgentId,
      JSON.stringify({
        parentAgentId: delegation.parentAgentId,
        tools: delegation.delegatedTools,
        resources: delegation.delegatedResources,
        budget: delegation.delegatedBudget,
        delegatedAt: new Date().toISOString(),
      }),
      delegation.fieldRules ? JSON.stringify(delegation.fieldRules) : null,
      delegation.rowFilters ? JSON.stringify(delegation.rowFilters) : null,
      delegation.expiresAt ?? null,
    ],
  );

  // 7. 审计权限委派事件
  insertAuditEvent(pool, {
    subjectId: delegation.parentAgentId,
    tenantId,
    spaceId: undefined,
    resourceType: "agent_runtime",
    action: "collab.permission.delegate",
    inputDigest: {
      collabRunId,
      parentAgent: delegation.parentAgentId,
      childAgent: delegation.childAgentId,
      tools: delegation.delegatedTools,
      resources: delegation.delegatedResources,
      budget: delegation.delegatedBudget,
      fieldRules: delegation.fieldRules,
      rowFilters: delegation.rowFilters,
    },
    outputDigest: { ok: true },
    result: "success",
    traceId: "",
  }).catch((e: unknown) => {
    _logger.warn("audit event for permission delegation failed", { err: (e as Error)?.message, collabRunId });
  });

  return { ok: true };
}

/**
 * P1-4-2: 检查子Agent的细粒度权限（包含行级/字段级）
 */
export async function checkAgentPermissionContext(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  agentId: string;
  /** 要访问的资源类型 */
  resourceType?: string;
  /** 要访问的字段名 */
  fieldName?: string;
  /** 行级过滤条件（用于检查是否匹配 row_filters） */
  rowContext?: Record<string, unknown>;
  /** 可选: 启用 space 级隔离 */
  spaceId?: string;
}): Promise<{ allowed: boolean; reason?: string; effectivePermissions?: unknown }> {
  const { pool, tenantId, collabRunId, agentId } = params;

  // 1. 检查基础工具/资源权限（传递 spaceId 实现三级隔离）
  const toolCheck = params.resourceType
    ? await checkAgentToolPermission({ pool, tenantId, collabRunId, agentId, toolName: params.resourceType, spaceId: params.spaceId })
    : { allowed: true };
  if (!toolCheck.allowed) return toolCheck;

  // 2. 查询细粒度权限上下文（JOIN collab_runs 实现 space 隔离）
  const ctxRes = await pool.query(
    `SELECT cpc.effective_permissions, cpc.field_rules, cpc.row_filters, cpc.expires_at
     FROM collab_permission_contexts cpc
     JOIN collab_runs cr
       ON cr.collab_run_id = cpc.collab_run_id AND cr.tenant_id = cpc.tenant_id
     WHERE cpc.tenant_id = $1 AND cpc.collab_run_id = $2 AND cpc.role_name = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [tenantId, collabRunId, agentId, params.spaceId ?? null],
  );

  if (!ctxRes.rowCount) {
    // 无细粒度规则，仅按基础权限判断
    return { allowed: true };
  }

  const ctx = ctxRes.rows[0] as Record<string, unknown>;

  // 3. 检查过期
  if (ctx.expires_at && new Date(ctx.expires_at as string) < new Date()) {
    return { allowed: false, reason: "permission_delegation_expired" };
  }

  // 4. 字段级检查
  if (params.fieldName && ctx.field_rules) {
    const rules = typeof ctx.field_rules === "string" ? JSON.parse(ctx.field_rules) : ctx.field_rules as Record<string, unknown>;
    const rulesDeny = (rules as Record<string, unknown>).deny;
    const rulesAllow = (rules as Record<string, unknown>).allow;
    if (rulesDeny && Array.isArray(rulesDeny) && rulesDeny.includes(params.fieldName)) {
      return { allowed: false, reason: `字段 ${params.fieldName} 被显式禁止访问` };
    }
    if (rulesAllow && Array.isArray(rulesAllow) && !rulesAllow.includes(params.fieldName)) {
      return { allowed: false, reason: `字段 ${params.fieldName} 不在允许列表中` };
    }
  }

  // 5. 行级检查
  if (params.rowContext && ctx.row_filters) {
    const filters: Record<string, unknown> = typeof ctx.row_filters === "string" ? JSON.parse(ctx.row_filters) : ctx.row_filters as Record<string, unknown>;
    for (const [key, expected] of Object.entries(filters)) {
      if (params.rowContext[key] !== undefined && params.rowContext[key] !== expected) {
        return { allowed: false, reason: `行级过滤不匹配: ${key}=${String(params.rowContext[key])}, 期望=${String(expected)}` };
      }
    }
  }

  return {
    allowed: true,
    effectivePermissions: ctx.effective_permissions,
  };
}

/**
 * P1-4-2: 撤销子Agent的委派权限
 */
export async function revokePermissionDelegation(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  parentAgentId: string;
  childAgentId: string;
  /** 可选: 启用 space 级隔离 */
  spaceId?: string;
}): Promise<void> {
  const { pool, tenantId, collabRunId, parentAgentId, childAgentId } = params;

  // 删除子Agent权限记录（JOIN collab_runs 实现 space 隔离）
  await pool.query(
    `DELETE FROM collab_role_permissions crp
     USING collab_runs cr
     WHERE cr.collab_run_id = crp.collab_run_id AND cr.tenant_id = crp.tenant_id
       AND crp.tenant_id = $1 AND crp.collab_run_id = $2 AND crp.agent_id = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [tenantId, collabRunId, childAgentId, params.spaceId ?? null],
  );

  // 删除细粒度权限上下文（JOIN collab_runs 实现 space 隔离）
  await pool.query(
    `DELETE FROM collab_permission_contexts cpc
     USING collab_runs cr
     WHERE cr.collab_run_id = cpc.collab_run_id AND cr.tenant_id = cpc.tenant_id
       AND cpc.tenant_id = $1 AND cpc.collab_run_id = $2 AND cpc.role_name = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [tenantId, collabRunId, childAgentId, params.spaceId ?? null],
  );

  // 审计撤销事件
  insertAuditEvent(pool, {
    subjectId: parentAgentId,
    tenantId,
    spaceId: undefined,
    resourceType: "agent_runtime",
    action: "collab.permission.revoke",
    inputDigest: { collabRunId, parentAgent: parentAgentId, childAgent: childAgentId },
    outputDigest: { ok: true },
    result: "success",
    traceId: "",
  }).catch((e: unknown) => {
    _logger.warn("audit event for permission revocation failed", { err: (e as Error)?.message, collabRunId, childAgentId });
  });
}

/**
 * P1-4-2: 查询Agent的完整权限链（委派关系 + 有效权限）
 */
export async function getAgentPermissionChain(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  agentId: string;
  /** 可选: 启用 space 级隔离 */
  spaceId?: string;
}): Promise<{
  permissions: { tools: string[] | null; resources: string[] | null; budget: number | null; usedBudget: number };
  context: { fieldRules: unknown; rowFilters: unknown; expiresAt: string | null } | null;
  parentAgent: string | null;
}> {
  const { pool, tenantId, collabRunId, agentId } = params;

  // 查询基础权限（JOIN collab_runs 实现 space 隔离）
  const permRes = await pool.query(
    `SELECT crp.role, crp.allowed_tools, crp.allowed_resources, crp.max_budget, crp.used_budget
     FROM collab_role_permissions crp
     JOIN collab_runs cr
       ON cr.collab_run_id = crp.collab_run_id AND cr.tenant_id = crp.tenant_id
     WHERE crp.tenant_id = $1 AND crp.collab_run_id = $2 AND crp.agent_id = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [tenantId, collabRunId, agentId, params.spaceId ?? null],
  );

  const perm = permRes.rows[0] as Record<string, unknown> | undefined;
  const permRole = perm?.role as string | undefined;
  const parentAgent = permRole?.startsWith("child_of_") ? permRole.replace("child_of_", "") : null;

  // 查询细粒度上下文（JOIN collab_runs 实现 space 隔离）
  const ctxRes = await pool.query(
    `SELECT cpc.effective_permissions, cpc.field_rules, cpc.row_filters, cpc.expires_at
     FROM collab_permission_contexts cpc
     JOIN collab_runs cr
       ON cr.collab_run_id = cpc.collab_run_id AND cr.tenant_id = cpc.tenant_id
     WHERE cpc.tenant_id = $1 AND cpc.collab_run_id = $2 AND cpc.role_name = $3
       AND ($4::text IS NULL OR cr.space_id = $4)`,
    [tenantId, collabRunId, agentId, params.spaceId ?? null],
  );

  const ctx = ctxRes.rows[0] as Record<string, unknown> | undefined;

  return {
    permissions: {
      tools: (perm?.allowed_tools as string[] | null) ?? null,
      resources: (perm?.allowed_resources as string[] | null) ?? null,
      budget: (perm?.max_budget as number | null) ?? null,
      usedBudget: (perm?.used_budget as number) ?? 0,
    },
    context: ctx ? {
      fieldRules: ctx.field_rules,
      rowFilters: ctx.row_filters,
      expiresAt: ctx.expires_at ? String(ctx.expires_at) : null,
    } : null,
    parentAgent,
  };
}

// ── P1-4: 冲突仲裁器 ───────────────────────────────

/**
 * P1-4: 当多个 Agent 对同一资源产生竞争时执行仲裁
 */
export async function arbitrateCollabConflict(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  resourceKey: string;
  competingAgents: Array<{ agentId: string; role: string; priority?: number; value: any }>;
  strategy?: CollabArbitrationStrategy;
}): Promise<{ winnerAgent: string; reasoning: string }> {
  const { pool, tenantId, collabRunId, resourceKey, competingAgents } = params;
  const strategy = params.strategy ?? "first_writer_wins";

  let winnerAgent: string;
  let reasoning: string;

  switch (strategy) {
    case "priority": {
      // 按优先级排序，最高优先级胜出
      const sorted = [...competingAgents].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      winnerAgent = sorted[0]!.agentId;
      reasoning = `优先级仲裁: ${winnerAgent}(优先级=${sorted[0]!.priority ?? 0}) 胜出`;
      break;
    }
    case "first_writer_wins": {
      winnerAgent = competingAgents[0]!.agentId;
      reasoning = `先写者胜出: ${winnerAgent}`;
      break;
    }
    case "escalate":
    default: {
      // 升级到编排器——返回第一个但标记需要人工处理
      winnerAgent = competingAgents[0]!.agentId;
      reasoning = `资源冲突升级: ${competingAgents.map(a => a.agentId).join(",")} 竞争 ${resourceKey}，临时选择 ${winnerAgent}`;
      break;
    }
  }

  // 记录仲裁日志
  await pool.query(
    `INSERT INTO collab_arbitration_log (tenant_id, collab_run_id, resource_key, competing_agents, strategy, winner_agent, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, collabRunId, resourceKey, competingAgents.map(a => a.agentId), strategy, winnerAgent, reasoning],
  );

  // 仲裁审计日志
  insertAuditEvent(pool, {
    subjectId: winnerAgent,
    tenantId,
    spaceId: undefined,
    resourceType: "agent_runtime",
    action: "collab.arbiter.commit",
    inputDigest: {
      collabRunId,
      resourceKey,
      strategy,
      competingAgents: competingAgents.map(a => a.agentId),
    },
    outputDigest: { winnerAgent, reasoning },
    result: "success",
    traceId: "",
  }).catch((e: unknown) => {
    _logger.warn("audit event for arbitration failed", { err: (e as Error)?.message, collabRunId });
  });

  // 将胜出者的值写入共享状态
  await upsertCollabSharedState({
    pool, tenantId, collabRunId, key: resourceKey,
    value: competingAgents.find(a => a.agentId === winnerAgent)!.value,
    updatedByAgent: winnerAgent,
  });

  return { winnerAgent, reasoning };
}

// ── P1-3: 高级共识决策 ──────────────────────────

/**
 * P1-3: 发起共识提案并收集Agent投票
 *
 * 支持多种决策算法：
 * - weighted_majority: 基于角色历史表现自动分配权重
 * - supermajority: 2/3+ 多数决（关键决策使用）
 * - bft: BFT简化版（容忍不超过 1/3 失效节点）
 */
export async function runConsensusRound(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  proposedBy: string;
  topic: ConsensusProposal["topic"];
  content: Record<string, unknown>;
  voters: string[];
  quorum?: ConsensusQuorumType;
  /** 提案超时时间(秒)，默认30s */
  deadlineSeconds?: number;
  /** 手动指定权重（优先于自动计算） */
  manualWeights?: Record<string, number>;
  /** BFT容错数 */
  faultTolerance?: number;
  /** 各Agent的投票决定（调用方已收集） */
  collectedVotes: Array<{ voterId: string; voterRole: string; decision: "approve" | "reject" | "abstain"; reason?: string; confidence?: number }>;
}): Promise<{
  proposalId: string;
  reached: boolean;
  quorum: ConsensusQuorumType;
  voterWeights: Record<string, number>;
  approveCount: number;
  totalVoters: number;
  votes: ConsensusVote[];
}> {
  const {
    pool, tenantId, spaceId, collabRunId, proposedBy, topic,
    content, voters, collectedVotes,
  } = params;
  const quorum = params.quorum ?? "weighted_majority";
  const deadlineSeconds = params.deadlineSeconds ?? 30;

  // P1-3: 自动计算权重（基于角色历史表现）
  let voterWeights: Record<string, number> = params.manualWeights ?? {};
  if (Object.keys(voterWeights).length === 0) {
    voterWeights = await computeVoterWeights({ pool, tenantId, spaceId, voters });
  }

  // 构建提案
  const proposalId = crypto.randomUUID();
  const deadline = new Date(Date.now() + deadlineSeconds * 1000).toISOString();
  const votes: ConsensusVote[] = collectedVotes.map((v) => ({
    voterId: v.voterId,
    voterRole: v.voterRole,
    decision: v.decision,
    reason: v.reason,
    confidence: v.confidence,
    votedAt: new Date().toISOString(),
  }));

  const proposal: ConsensusProposal = {
    proposalId,
    collabRunId,
    proposedBy,
    topic,
    content,
    voters,
    deadline,
    quorum,
    votes,
    status: "pending",
    voterWeights,
    faultTolerance: params.faultTolerance,
    createdAt: new Date().toISOString(),
  };

  // 判断共识结果
  const reached = isConsensusReached(proposal);
  proposal.status = reached ? "approved" : "rejected";

  // 持久化提案到DB
  await pool.query(
    `INSERT INTO collab_consensus_proposals
     (proposal_id, tenant_id, collab_run_id, proposer, proposal_type, proposal,
      required_voters, votes, deadline, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      proposalId, tenantId, collabRunId, proposedBy, topic,
      JSON.stringify({ ...content, quorum, voterWeights, faultTolerance: params.faultTolerance }),
      JSON.stringify(voters), JSON.stringify(votes),
      deadline, proposal.status,
    ],
  );

  return {
    proposalId,
    reached,
    quorum,
    voterWeights,
    approveCount: votes.filter((v) => v.decision === "approve").length,
    totalVoters: voters.length,
    votes,
  };
}

/**
 * P1-3: 基于角色历史表现自动计算投票权重
 */
async function computeVoterWeights(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  voters: string[];
}): Promise<Record<string, number>> {
  const { pool, tenantId, spaceId, voters } = params;
  const weights: Record<string, number> = {};

  for (const voter of voters) {
    try {
      const history = await queryRolePerformanceHistory({
        pool, tenantId, spaceId, role: voter, limit: 10,
      });
      if (history.length > 0) {
        const avgScore = history.reduce((sum: number, h: { overallScore: number }) => sum + h.overallScore, 0) / history.length;
        // 线性映射: overallScore [0,1] -> weight [0.5, 2.0]
        weights[voter] = 0.5 + avgScore * 1.5;
      } else {
        weights[voter] = 1.0;
      }
    } catch {
      weights[voter] = 1.0;
    }
  }

  return weights;
}

/**
 * P1-3: 为仲裁策略添加加权投票支持
 * 当 strategy=vote 时，使用加权投票而非简单多数决
 */
export async function arbitrateWithWeightedVote(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  resourceKey: string;
  competingAgents: Array<{ agentId: string; role: string; value: any }>;
  quorum?: ConsensusQuorumType;
}): Promise<{ winnerAgent: string; reasoning: string; proposalId: string }> {
  const { pool, tenantId, spaceId, collabRunId, resourceKey, competingAgents } = params;
  const quorum = params.quorum ?? "weighted_majority";

  // 每个 Agent 为自己投approve票
  const voters = competingAgents.map((a) => a.role);
  const collectedVotes = competingAgents.map((a) => ({
    voterId: a.agentId,
    voterRole: a.role,
    decision: "approve" as const,
    reason: `为自己的方案投票: ${JSON.stringify(a.value).slice(0, 200)}`,
    confidence: 0.8,
  }));

  // 获取加权结果
  const voterWeights = await computeVoterWeights({ pool, tenantId, spaceId, voters });

  // 找出权重最高的 Agent
  let maxWeight = -1;
  let winnerAgent = competingAgents[0]!.agentId;
  for (const agent of competingAgents) {
    const w = voterWeights[agent.role] ?? 1.0;
    if (w > maxWeight) {
      maxWeight = w;
      winnerAgent = agent.agentId;
    }
  }

  const proposalId = crypto.randomUUID();
  const reasoning = `加权投票仲裁 (${quorum}): ${winnerAgent} 胜出（权重=${maxWeight.toFixed(2)}，分配: ${JSON.stringify(voterWeights)}）`;

  // 记录仲裁日志
  await pool.query(
    `INSERT INTO collab_arbitration_log (tenant_id, collab_run_id, resource_key, competing_agents, strategy, winner_agent, reasoning)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, collabRunId, resourceKey, competingAgents.map((a) => a.agentId), "vote", winnerAgent, reasoning],
  );

  // 持久化提案
  await pool.query(
    `INSERT INTO collab_consensus_proposals
     (proposal_id, tenant_id, collab_run_id, proposer, proposal_type, proposal,
      required_voters, votes, deadline, status)
     VALUES ($1, $2, $3, 'orchestrator', 'resource_allocation', $4, $5, $6, $7, 'approved')`,
    [
      proposalId, tenantId, collabRunId,
      JSON.stringify({ resourceKey, quorum, voterWeights }),
      JSON.stringify(voters), JSON.stringify(collectedVotes),
      new Date(Date.now() + 30000).toISOString(),
    ],
  );

  // 写入胜出者的值
  await upsertCollabSharedState({
    pool, tenantId, collabRunId, key: resourceKey,
    value: competingAgents.find((a) => a.agentId === winnerAgent)!.value,
    updatedByAgent: winnerAgent,
  });

  return { winnerAgent, reasoning, proposalId };
}
