/**
 * P2-3: 多智能体通信协议完善
 * 
 * 实现智能体之间的通信协议：
 * - 消息传递（单播、广播、组播）
 * - 请求-响应模式
 * - 事件订阅
 * - 能力发现
 * - 协商与共识
 */
import type { Pool } from "pg";
import type { RoleName } from "./dynamicCoordinator";
import { getCollabBus } from "../../../kernel/collabBus";
import type { CollabMessageEnvelope, CollabMessageType, MessagePriority, MessageStatus } from "@openslin/shared";
import crypto from "node:crypto";

/* ================================================================== */
/*  Types                                                               */
/* ================================================================== */

/** @deprecated 使用 CollabMessageType */
export type MessageType = CollabMessageType;

export type { MessagePriority, MessageStatus } from "@openslin/shared";

export interface AgentMessage {
  messageId: string;
  collabRunId: string;
  fromRole: RoleName;
  toRole: RoleName | null;  // null 表示广播
  messageType: CollabMessageType;
  priority: MessagePriority;
  /** 消息内容 */
  payload: Record<string, unknown>;
  /** 关联的请求消息ID（用于响应） */
  replyTo?: string;
  /** 消息状态 */
  status: MessageStatus;
  /** 过期时间 */
  expiresAt?: string;
  createdAt: string;
  deliveredAt?: string;
  processedAt?: string;
}

export interface HandoffRequest {
  fromRole: RoleName;
  toRole: RoleName;
  taskId: string;
  stepId?: string;
  /** 交接原因 */
  reason: string;
  /** 交接上下文 */
  context: Record<string, unknown>;
  /** 期望的输出 */
  expectedOutput?: Record<string, unknown>;
  /** 优先级 */
  priority: MessagePriority;
}

export interface FeedbackMessage {
  fromRole: RoleName;
  toRole: RoleName;
  feedbackType: "approval" | "rejection" | "revision" | "question" | "suggestion";
  content: string;
  /** 关联的步骤或任务 */
  relatedStepId?: string;
  /** 严重程度 */
  severity: "info" | "warning" | "error";
}

/* ================================================================== */
/*  Capability Discovery                                                 */
/* ================================================================== */

export interface AgentCapability {
  capabilityId: string;
  roleName: RoleName;
  /** 能力类型 */
  capabilityType: "tool" | "knowledge" | "decision" | "execution" | "review";
  /** 能力名称 */
  name: string;
  /** 描述 */
  description?: string;
  /** 能力参数模式 */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** 是否可用 */
  available: boolean;
  /** 负载指标（用于负载均衡） */
  loadFactor?: number;
}

/**
 * 注册智能体能力
 */
export async function registerCapability(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  roleName: RoleName;
  capability: Omit<AgentCapability, "capabilityId" | "roleName">;
}): Promise<AgentCapability> {
  const { pool, tenantId, collabRunId, roleName, capability } = params;
  
  const res = await pool.query<{ capability_id: string }>(
    `INSERT INTO collab_agent_capabilities 
     (tenant_id, collab_run_id, role_name, capability_type, name, description, input_schema, output_schema, available, load_factor, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (tenant_id, collab_run_id, role_name, name) DO UPDATE
     SET capability_type = EXCLUDED.capability_type,
         description = EXCLUDED.description,
         input_schema = EXCLUDED.input_schema,
         output_schema = EXCLUDED.output_schema,
         available = EXCLUDED.available,
         load_factor = EXCLUDED.load_factor,
         updated_at = now()
     RETURNING capability_id`,
    [
      tenantId,
      collabRunId,
      roleName,
      capability.capabilityType,
      capability.name,
      capability.description ?? null,
      capability.inputSchema ? JSON.stringify(capability.inputSchema) : null,
      capability.outputSchema ? JSON.stringify(capability.outputSchema) : null,
      capability.available,
      capability.loadFactor ?? 1.0,
    ]
  );
  
  return {
    ...capability,
    capabilityId: res.rows[0].capability_id,
    roleName,
  };
}

/**
 * 发现具有特定能力的智能体
 */
export async function discoverCapableAgents(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  capabilityType?: string;
  capabilityName?: string;
  onlyAvailable?: boolean;
}): Promise<AgentCapability[]> {
  const { pool, tenantId, collabRunId, capabilityType, capabilityName, onlyAvailable = true } = params;
  
  const res = await pool.query<{
    capability_id: string;
    role_name: string;
    capability_type: string;
    name: string;
    description: string | null;
    input_schema: any;
    output_schema: any;
    available: boolean;
    load_factor: number;
  }>(
    `SELECT * FROM collab_agent_capabilities 
     WHERE tenant_id = $1 AND collab_run_id = $2
       AND ($3::TEXT IS NULL OR capability_type = $3)
       AND ($4::TEXT IS NULL OR name = $4)
       AND ($5::BOOLEAN IS FALSE OR available = true)
     ORDER BY load_factor ASC, role_name ASC`,
    [tenantId, collabRunId, capabilityType ?? null, capabilityName ?? null, onlyAvailable]
  );
  
  return res.rows.map(row => ({
    capabilityId: row.capability_id,
    roleName: row.role_name,
    capabilityType: row.capability_type as AgentCapability["capabilityType"],
    name: row.name,
    description: row.description ?? undefined,
    inputSchema: row.input_schema,
    outputSchema: row.output_schema,
    available: row.available,
    loadFactor: row.load_factor,
  }));
}

/* ================================================================== */
/*  Message Passing                                                      */
/* ================================================================== */

/**
 * 发送消息
 */
export async function sendMessage(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  message: Omit<AgentMessage, "messageId" | "status" | "createdAt">;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, message } = params;
  
  const res = await pool.query<{ message_id: string; created_at: string }>(
    `INSERT INTO collab_agent_messages 
     (tenant_id, collab_run_id, from_role, to_role, message_type, priority, payload, reply_to, status, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, now())
     RETURNING message_id, created_at`,
    [
      tenantId,
      collabRunId,
      message.fromRole,
      message.toRole,
      message.messageType,
      message.priority,
      JSON.stringify(message.payload),
      message.replyTo ?? null,
      message.expiresAt ?? null,
    ]
  );
  
  const saved: AgentMessage = {
    ...message,
    messageId: res.rows[0].message_id,
    status: "pending",
    createdAt: res.rows[0].created_at,
    collabRunId,
  };

  // P1: 写 DB 后同步推送到 CollabBus 实时分发层
  try {
    const bus = getCollabBus();
    if (bus) {
      const collabMsg: CollabMessageEnvelope = {
        messageId: saved.messageId,
        collabRunId,
        tenantId,
        fromRole: message.fromRole,
        toRole: message.toRole ?? null,
        messageType: message.messageType,
        payload: {
          ...message.payload,
          replyTo: message.replyTo,
        },
        sentAt: new Date().toISOString(),
        source: "api",
        datacontenttype: "application/json",
        version: "1.0.0",
        priority: message.priority,
      };
      bus.publish(collabMsg).catch(() => {});
    }
  } catch { /* CollabBus 分发失败不影响 DB 已持久化的消息 */ }

  return saved;
}

/**
 * 获取待处理的消息
 */
export async function getPendingMessages(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  toRole: RoleName;
  limit?: number;
}): Promise<AgentMessage[]> {
  const { pool, tenantId, collabRunId, toRole, limit = 50 } = params;
  
  const res = await pool.query<{
    message_id: string;
    collab_run_id: string;
    from_role: string;
    to_role: string | null;
    message_type: string;
    priority: string;
    payload: any;
    reply_to: string | null;
    status: string;
    expires_at: string | null;
    created_at: string;
    delivered_at: string | null;
    processed_at: string | null;
  }>(
    `SELECT * FROM collab_agent_messages 
     WHERE tenant_id = $1 AND collab_run_id = $2
       AND (to_role = $3 OR to_role IS NULL)
       AND status IN ('pending', 'delivered')
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY 
       CASE priority 
         WHEN 'urgent' THEN 0 
         WHEN 'high' THEN 1 
         WHEN 'normal' THEN 2 
         ELSE 3 
       END ASC,
       created_at ASC
     LIMIT $4`,
    [tenantId, collabRunId, toRole, limit]
  );
  
  return res.rows.map(mapMessageRow);
}

/**
 * 标记消息为已处理
 */
export async function markMessageProcessed(params: {
  pool: Pool;
  tenantId: string;
  messageId: string;
}): Promise<void> {
  await params.pool.query(
    `UPDATE collab_agent_messages 
     SET status = 'processed', processed_at = now()
     WHERE tenant_id = $1 AND message_id = $2`,
    [params.tenantId, params.messageId]
  );
}

/**
 * 发送响应消息
 */
export async function sendResponse(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  originalMessageId: string;
  fromRole: RoleName;
  payload: Record<string, unknown>;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, originalMessageId, fromRole, payload } = params;
  
  // 获取原始消息以确定响应目标
  const original = await pool.query<{ from_role: string }>(
    "SELECT from_role FROM collab_agent_messages WHERE tenant_id = $1 AND message_id = $2",
    [tenantId, originalMessageId]
  );
  
  if (!original.rowCount) {
    throw new Error(`Original message ${originalMessageId} not found`);
  }
  
  return sendMessage({
    pool,
    tenantId,
    collabRunId,
    message: {
      collabRunId,
      fromRole,
      toRole: original.rows[0].from_role,
      messageType: "response",
      priority: "normal",
      payload,
      replyTo: originalMessageId,
    },
  });
}

/* ================================================================== */
/*  Handoff Protocol                                                     */
/* ================================================================== */

/**
 * 发起任务交接
 */
export async function initiateHandoff(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  request: HandoffRequest;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, request } = params;
  
  const message = await sendMessage({
    pool,
    tenantId,
    collabRunId,
    message: {
      collabRunId,
      fromRole: request.fromRole,
      toRole: request.toRole,
      messageType: "handoff",
      priority: request.priority,
      payload: {
        taskId: request.taskId,
        stepId: request.stepId,
        reason: request.reason,
        context: request.context,
        expectedOutput: request.expectedOutput,
      },
    },
  });
  
  return message;
}

/**
 * 确认任务交接
 */
export async function acknowledgeHandoff(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  handoffMessageId: string;
  fromRole: RoleName;
  accepted: boolean;
  reason?: string;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, handoffMessageId, fromRole, accepted, reason } = params;
  
  return sendResponse({
    pool,
    tenantId,
    collabRunId,
    originalMessageId: handoffMessageId,
    fromRole,
    payload: {
      accepted,
      reason,
      acknowledgedAt: new Date().toISOString(),
    },
  });
}

/* ================================================================== */
/*  Feedback Protocol                                                    */
/* ================================================================== */

/**
 * 发送反馈
 */
export async function sendFeedback(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  feedback: FeedbackMessage;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, feedback } = params;
  
  const priority: MessagePriority = 
    feedback.severity === "error" ? "high" :
    feedback.severity === "warning" ? "normal" : "low";
  
  return sendMessage({
    pool,
    tenantId,
    collabRunId,
    message: {
      collabRunId,
      fromRole: feedback.fromRole,
      toRole: feedback.toRole,
      messageType: "feedback",
      priority,
      payload: {
        feedbackType: feedback.feedbackType,
        content: feedback.content,
        relatedStepId: feedback.relatedStepId,
        severity: feedback.severity,
      },
    },
  });
}

/* ================================================================== */
/*  Broadcast & Query                                                    */
/* ================================================================== */

/**
 * 广播消息给所有智能体
 */
export async function broadcast(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  fromRole: RoleName;
  payload: Record<string, unknown>;
  priority?: MessagePriority;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, fromRole, payload, priority = "normal" } = params;
  
  return sendMessage({
    pool,
    tenantId,
    collabRunId,
    message: {
      collabRunId,
      fromRole,
      toRole: null, // null 表示广播
      messageType: "broadcast",
      priority,
      payload,
    },
  });
}

/**
 * 发起查询（等待响应）
 */
export async function queryAgent(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  fromRole: RoleName;
  toRole: RoleName;
  query: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<AgentMessage> {
  const { pool, tenantId, collabRunId, fromRole, toRole, query, timeoutMs } = params;
  
  const expiresAt = timeoutMs 
    ? new Date(Date.now() + timeoutMs).toISOString() 
    : undefined;
  
  return sendMessage({
    pool,
    tenantId,
    collabRunId,
    message: {
      collabRunId,
      fromRole,
      toRole,
      messageType: "query",
      priority: "high",
      payload: query,
      expiresAt,
    },
  });
}

/* ================================================================== */
/*  Consensus Protocol                                                   */
/* ================================================================== */

export interface ConsensusRequest {
  proposalId: string;
  collabRunId: string;
  proposer: RoleName;
  /** 提案类型 */
  proposalType: "plan_approval" | "tool_selection" | "conflict_resolution" | "priority_change";
  /** 提案内容 */
  proposal: Record<string, unknown>;
  /** 需要同意的角色 */
  requiredVoters: RoleName[];
  /** 已投票 */
  votes: Map<RoleName, { approved: boolean; reason?: string; votedAt: string }>;
  /** 截止时间 */
  deadline: string;
  /** 状态 */
  status: "pending" | "approved" | "rejected" | "expired";
}

/**
 * 发起共识提案
 */
export async function initiateConsensus(params: {
  pool: Pool;
  tenantId: string;
  collabRunId: string;
  proposer: RoleName;
  proposalType: ConsensusRequest["proposalType"];
  proposal: Record<string, unknown>;
  requiredVoters: RoleName[];
  deadlineMs: number;
}): Promise<ConsensusRequest> {
  const { pool, tenantId, collabRunId, proposer, proposalType, proposal, requiredVoters, deadlineMs } = params;
  
  const deadline = new Date(Date.now() + deadlineMs).toISOString();
  
  const res = await pool.query<{ proposal_id: string }>(
    `INSERT INTO collab_consensus_proposals 
     (tenant_id, collab_run_id, proposer, proposal_type, proposal, required_voters, votes, deadline, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, 'pending', now())
     RETURNING proposal_id`,
    [
      tenantId,
      collabRunId,
      proposer,
      proposalType,
      JSON.stringify(proposal),
      JSON.stringify(requiredVoters),
      deadline,
    ]
  );
  
  // 向所有需要投票的角色发送通知
  for (const voter of requiredVoters) {
    await sendMessage({
      pool,
      tenantId,
      collabRunId,
      message: {
        collabRunId,
        fromRole: proposer,
        toRole: voter,
        messageType: "request",
        priority: "high",
        payload: {
          type: "consensus_vote_request",
          proposalId: res.rows[0].proposal_id,
          proposalType,
          proposal,
          deadline,
        },
        expiresAt: deadline,
      },
    });
  }
  
  return {
    proposalId: res.rows[0].proposal_id,
    collabRunId,
    proposer,
    proposalType,
    proposal,
    requiredVoters,
    votes: new Map(),
    deadline,
    status: "pending",
  };
}

/**
 * 投票
 */
export async function voteOnConsensus(params: {
  pool: Pool;
  tenantId: string;
  proposalId: string;
  voter: RoleName;
  approved: boolean;
  reason?: string;
}): Promise<{ status: ConsensusRequest["status"]; message: string }> {
  const { pool, tenantId, proposalId, voter, approved, reason } = params;
  
  // 更新投票
  const vote = { approved, reason, votedAt: new Date().toISOString() };
  
  await pool.query(
    `UPDATE collab_consensus_proposals 
     SET votes = votes || $3::jsonb,
         updated_at = now()
     WHERE tenant_id = $1 AND proposal_id = $2`,
    [tenantId, proposalId, JSON.stringify({ [voter]: vote })]
  );
  
  // 检查是否达成共识
  const res = await pool.query<{
    required_voters: string[];
    votes: Record<string, { approved: boolean }>;
    status: string;
    deadline: string;
  }>(
    "SELECT required_voters, votes, status, deadline FROM collab_consensus_proposals WHERE tenant_id = $1 AND proposal_id = $2",
    [tenantId, proposalId]
  );
  
  if (!res.rowCount) {
    return { status: "expired", message: "Proposal not found" };
  }
  
  const { required_voters, votes, deadline } = res.rows[0];
  
  // 检查是否过期
  if (new Date(deadline) < new Date()) {
    await pool.query(
      "UPDATE collab_consensus_proposals SET status = 'expired', updated_at = now() WHERE tenant_id = $1 AND proposal_id = $2",
      [tenantId, proposalId]
    );
    return { status: "expired", message: "Consensus deadline exceeded" };
  }
  
  // 检查是否所有人都已投票
  const allVoted = required_voters.every(v => v in votes);
  if (!allVoted) {
    return { status: "pending", message: "Waiting for more votes" };
  }
  
  // 检查是否全部同意
  const allApproved = required_voters.every(v => votes[v]?.approved);
  const newStatus = allApproved ? "approved" : "rejected";
  
  await pool.query(
    "UPDATE collab_consensus_proposals SET status = $3, updated_at = now() WHERE tenant_id = $1 AND proposal_id = $2",
    [tenantId, proposalId, newStatus]
  );
  
  return { 
    status: newStatus, 
    message: allApproved ? "Consensus reached" : "Consensus rejected" 
  };
}

/* ================================================================== */
/*  Helper Functions                                                     */
/* ================================================================== */

function mapMessageRow(row: any): AgentMessage {
  return {
    messageId: row.message_id,
    collabRunId: row.collab_run_id,
    fromRole: row.from_role,
    toRole: row.to_role,
    messageType: row.message_type as CollabMessageType,
    priority: row.priority as MessagePriority,
    payload: row.payload ?? {},
    replyTo: row.reply_to ?? undefined,
    status: row.status as MessageStatus,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
    processedAt: row.processed_at ?? undefined,
  };
}
