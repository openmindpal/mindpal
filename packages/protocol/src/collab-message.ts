/**
 * P2-4: 统一协作协议 Schema
 *
 * 定义多智能体协作运行时的消息传递、共识提案、能力发现、状态同步的标准协议。
 * 所有协作模块必须遵循此协议进行通信。
 *
 * 协议分层：
 *   Layer 1: Message — 基础消息传递
 *   Layer 2: Consensus — 共识提案与投票
 *   Layer 3: Discovery — 能力发现与协商
 *   Layer 4: Sync — 状态同步与一致性
 *   Layer 5: Debate — 自主辩论与仲裁
 */

import { createRegistry, builtInEntry, type RegistryEntry } from './registry.js';

/* ── Collab 配置键注册（三级优先级：governance > env > default） ── */

/** 协作模块配置默认值，可通过环境变量或 governance 热覆盖 */
export const COLLAB_CONFIG_DEFAULTS: Record<string, number> = {
  COLLAB_CONFIDENCE_THRESHOLD: 0.7,     // 辩论收敛最低置信度
  COLLAB_CONSENSUS_THRESHOLD: 0.6,      // 共识度收敛阈值
  COLLAB_DIVERGENCE_CONF_DIFF: 0.15,    // 分歧检测置信度差上限
  COLLAB_DIVERGENCE_MIN_CONF: 0.8,      // 双方收敛最低置信度
  COLLAB_PENALTY_SEVERE: 0.06,          // 事实错误/幻觉惩罚系数
  COLLAB_PENALTY_MILD: 0.03,            // 其他错误类型惩罚系数
  COLLAB_BUS_MAX_IN_FLIGHT: 100,        // 背压最大并发消息数
  COLLAB_BUS_RESUME_THRESHOLD: 0.7,     // 背压恢复消费阈值
  COLLAB_BUS_POLL_MS: 20,               // Redis Stream 轮询间隔(ms)
  COLLAB_AUTO_DEBATE_MAX_ROUNDS: 3,     // 自动辩论最大轮次
  COLLAB_AUTO_DEBATE_MAX_PARTIES: 6,    // 自动辩论最大参与方
  COLLAB_CORRECTION_FEEDBACK_MAX_LEN: 800,   // 纠错建议截断长度
  COLLAB_CORRECTION_PREV_OUTPUT_MAX_LEN: 500, // 上一轮输出截断长度
  COLLAB_ENVELOPE_OBSERVATION_LIMIT: 5, // Envelope 包含的前述结果数
  DEBATE_MAX_ROUNDS: 5,                  // 辩论最大轮次
  DEBATE_CONVERGENCE_THRESHOLD: 0.8,     // 收敛阈值
  DEBATE_MIN_CONFIDENCE: 0.6,            // 最低置信度
  DEBATE_SCORE_DECAY: 0.9,               // 评分衰减
  DEBATE_CORRECTION_BONUS: 0.05,         // 纠错奖励
  DEBATE_CONSENSUS_EVOLUTION_WINDOW: 3,  // 共识演化窗口
  DEBATE_MIN_PARTIES: 2,                 // 辩论最小参与方
  DEBATE_MAX_PARTIES: 10,                // 辩论最大参与方
  COLLAB_BUS_STREAM_MAXLEN: 5000,        // Redis Stream 最大长度
  COLLAB_MAX_CORRECTION_ROUNDS: 3,       // 纠错最大轮次
  COLLAB_MAX_ENVELOPE_SIZE: 1048576,     // Envelope 结果最大字节数 (1MB)
  debateAgentTimeoutMs: 60_000,           // 辩论 Agent 单次执行超时(ms)
};

/* ================================================================== */
/*  Layer 1: Message Protocol                                          */
/* ================================================================== */

/** 消息优先级 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/** 消息状态 */
export type MessageStatus = "pending" | "delivered" | "read" | "processed" | "failed" | "expired";

/** 协作消息类型 — 开放字符串，通过注册表验证 */
export type CollabMessageType = string;

/** 内置协作消息类型注册表条目 */
export const BUILTIN_COLLAB_MESSAGE_TYPES: RegistryEntry[] = [
  // 任务生命周期
  builtInEntry('task.assign', 'collab.task'),
  builtInEntry('task.accept', 'collab.task'),
  builtInEntry('task.reject', 'collab.task'),
  builtInEntry('task.complete', 'collab.task'),
  builtInEntry('task.fail', 'collab.task'),
  // 步骤生命周期
  builtInEntry('step.start', 'collab.step'),
  builtInEntry('step.progress', 'collab.step'),
  builtInEntry('step.complete', 'collab.step'),
  builtInEntry('step.fail', 'collab.step'),
  // 共识协议
  builtInEntry('consensus.propose', 'collab.consensus'),
  builtInEntry('consensus.vote', 'collab.consensus'),
  builtInEntry('consensus.resolve', 'collab.consensus'),
  // 能力发现
  builtInEntry('discovery.query', 'collab.discovery'),
  builtInEntry('discovery.reply', 'collab.discovery'),
  // 状态同步
  builtInEntry('sync.state', 'collab.sync'),
  builtInEntry('sync.ack', 'collab.sync'),
  // 辩论协议
  builtInEntry('debate.open', 'collab.debate'),
  builtInEntry('debate.position', 'collab.debate'),
  builtInEntry('debate.rebuttal', 'collab.debate'),
  builtInEntry('debate.verdict', 'collab.debate'),
  builtInEntry('debate.correction', 'collab.debate'),
  builtInEntry('debate.consensus_evolution', 'collab.debate'),
  builtInEntry('debate.party_join', 'collab.debate'),
  builtInEntry('debate.party_leave', 'collab.debate'),
  // 总线运行时消息
  builtInEntry('agent.result', 'collab.bus'),
  builtInEntry('shared_state.update', 'collab.bus'),
  // 智能体通信协议
  builtInEntry('request', 'collab.agent'),
  builtInEntry('response', 'collab.agent'),
  builtInEntry('notification', 'collab.agent'),
  builtInEntry('broadcast', 'collab.agent'),
  builtInEntry('handoff', 'collab.agent'),
  builtInEntry('feedback', 'collab.agent'),
  builtInEntry('query', 'collab.agent'),
  builtInEntry('ack', 'collab.agent'),
  // 运行恢复协议
  builtInEntry('collab.checkpoint', 'collab.recovery'),
  builtInEntry('collab.resume', 'collab.recovery'),
  builtInEntry('collab.heartbeat_timeout', 'collab.recovery'),
  // 通用
  builtInEntry('escalate', 'collab.general'),
  builtInEntry('heartbeat', 'collab.general'),
];

/** 消息类型注册表 */
export const collabMessageRegistry = createRegistry(BUILTIN_COLLAB_MESSAGE_TYPES);

/** 验证消息类型是否已注册 */
export function isValidCollabMessageType(type: string): boolean {
  return collabMessageRegistry.has(type);
}

/**
 * 统一协作消息信封（CollabMessageEnvelope）
 *
 * 合并自三处独立定义：
 * - packages/shared collabProtocol.ts (CollabMessage)
 * - apps/api/kernel/collabBus.ts (CollabMessage)
 * - apps/api/skills/collab-runtime/modules/agentProtocol.ts (AgentMessage)
 *
 * 所有协作模块统一使用此结构进行通信。
 */
export interface CollabMessageEnvelope {
  /** 消息唯一 ID（UUID v4），必填。用于幂等和去重 */
  messageId: string;
  /** 协作运行 ID，必填。标识本消息所属的协作会话 */
  collabRunId: string;
  /** 租户 ID，必填。多租户隔离标识 */
  tenantId: string;
  /** 发送方角色名称，必填。如 "planner" / "executor" / "reviewer" */
  fromRole: string;
  /** 接收方角色名称，可选。null 表示广播给同 collabRun 下所有角色 */
  toRole: string | null;
  /** 消息类型（统一字段名），必填。取值见 CollabMessageType 枚举 */
  messageType: CollabMessageType;
  /** 消息载荷，必填。业务数据，结构由 messageType 决定 */
  payload: Record<string, unknown>;
  /** 发送时间，必填。ISO 8601 格式，如 "2025-01-01T00:00:00.000Z" */
  sentAt: string;
  /** 消息来源标识，可选。标识产生此消息的子系统，取值如 "api" / "worker" / "runner" / "device-agent" */
  source?: string;
  /** payload 的 MIME 类型，可选。默认 "application/json" */
  datacontenttype?: string;
  /** 消息优先级，可选。默认 "normal"，取值见 MessagePriority */
  priority?: MessagePriority;
  /** 消息状态，可选。用于追踪消息生命周期，取值见 MessageStatus */
  status?: MessageStatus;
  /** 分布式追踪 ID，可选。用于链路追踪关联 */
  traceId?: string;
  /** 协议版本号（semver），必填。当前版本 "1.0.0"，用于兼容性判断 */
  version: string;
  /** 回复目标消息 ID，可选。用于 request-response 模式关联请求消息 */
  replyTo?: string;
  /** 消息过期时间，可选。ISO 8601 格式，超时后消费端应丢弃 */
  expiresAt?: string;
}

/** @deprecated 使用 CollabMessageEnvelope */
export type CollabMessage = CollabMessageEnvelope;

export function toolNameFromRef(toolRef: string): string {
  const value = String(toolRef ?? "").trim();
  if (!value) return "";
  const idx = value.lastIndexOf("@");
  return idx > 0 ? value.slice(0, idx) : value;
}

export function isToolAllowedForPolicy(
  allowedTools: readonly string[] | ReadonlySet<string> | null | undefined,
  toolRef: string | null | undefined,
): boolean {
  if (!allowedTools) return true;
  const currentToolRef = String(toolRef ?? "").trim();
  if (!currentToolRef) return false;
  const currentToolName = toolNameFromRef(currentToolRef);
  const candidates = Array.isArray(allowedTools) ? allowedTools : Array.from(allowedTools.values());
  if (!candidates.length) return true;
  for (const raw of candidates) {
    const candidate = String(raw ?? "").trim();
    if (!candidate) continue;
    if (candidate === currentToolRef) return true;
    if (toolNameFromRef(candidate) === currentToolName) return true;
  }
  return false;
}

/* ================================================================== */
/*  Layer 2: Consensus Protocol                                        */
/* ================================================================== */

/** 共识提案 */
export interface ConsensusProposal {
  proposalId: string;
  collabRunId: string;
  /** 提案发起角色 */
  proposedBy: string;
  /** 提案主题 */
  topic: ConsensusProposalTopic;
  /** 提案内容 */
  content: Record<string, unknown>;
  /** 需要投票的角色列表 */
  voters: string[];
  /** 提案截止时间 */
  deadline: string;
  /** 通过条件：majority | unanimous | any | weighted_majority | supermajority | bft */
  quorum: ConsensusQuorumType;
  /** 当前投票 */
  votes: ConsensusVote[];
  /** 提案状态 */
  status: "pending" | "approved" | "rejected" | "expired" | "withdrawn";
  /** P1-3: 投票权重配置（按角色分配权重，未配置时默认1.0） */
  voterWeights?: Record<string, number>;
  /** P1-3: BFT容错数（仅 quorum=bft 时有效，默认 floor((voters.length-1)/3)） */
  faultTolerance?: number;
  /** 加权投票缓存：totalWeight 避免重复计算 */
  _cachedTotalWeight?: number;
  createdAt: string;
}

/** P1-3: 共识决策类型 — 开放字符串，通过注册表验证 */
export type ConsensusQuorumType = string;

export const BUILTIN_QUORUM_TYPES: RegistryEntry[] = [
  builtInEntry('majority', 'consensus.quorum'),
  builtInEntry('unanimous', 'consensus.quorum'),
  builtInEntry('any', 'consensus.quorum'),
  builtInEntry('weighted_majority', 'consensus.quorum'),
  builtInEntry('supermajority', 'consensus.quorum'),
  builtInEntry('bft', 'consensus.quorum'),
];

export const quorumRegistry = createRegistry(BUILTIN_QUORUM_TYPES);

/** 共识提案主题 — 开放字符串，通过注册表验证 */
export type ConsensusProposalTopic = string;

export const BUILTIN_PROPOSAL_TOPICS: RegistryEntry[] = [
  builtInEntry('replan', 'consensus.topic'),
  builtInEntry('abort', 'consensus.topic'),
  builtInEntry('escalate', 'consensus.topic'),
  builtInEntry('role_change', 'consensus.topic'),
  builtInEntry('resource_allocation', 'consensus.topic'),
];

export const proposalTopicRegistry = createRegistry(BUILTIN_PROPOSAL_TOPICS);

/** 共识投票 */
export interface ConsensusVote {
  voterId: string;
  voterRole: string;
  decision: "approve" | "reject" | "abstain";
  reason?: string;
  /** P1-3: 投票置信度 (0~1)，可用于加权计算 */
  confidence?: number;
  votedAt: string;
}

/** 判断提案是否达成共识（P1-3: 支持加权投票/超级多数/BFT） */
export function isConsensusReached(proposal: ConsensusProposal): boolean {
  if (proposal.deadline && new Date(proposal.deadline) < new Date()) {
    return false; // 提案已过期，视为未达共识
  }

  const { quorum, voters, votes, voterWeights } = proposal;
  const validVotes = votes.filter((v) => v.decision !== "abstain");
  const approveVotes = validVotes.filter((v) => v.decision === "approve");
  const approveCount = approveVotes.length;

  switch (quorum) {
    case "any":
      return approveCount >= 1;
    case "majority":
      return approveCount > voters.length / 2;
    case "unanimous":
      return approveCount === voters.length;
    case "supermajority":
      // >= 2/3 的投票者同意
      return approveCount >= Math.ceil(voters.length * 2 / 3);
    case "weighted_majority": {
      // 加权投票：同意票的权重总和 > 50% 总权重（缓存 totalWeight）
      const weights = voterWeights ?? {};
      if (!proposal._cachedTotalWeight) {
        proposal._cachedTotalWeight = voters.reduce((sum, v) => sum + (weights[v] ?? 1.0), 0);
      }
      const totalWeight = proposal._cachedTotalWeight;
      const approveWeight = approveVotes.reduce(
        (sum, v) => sum + (weights[v.voterRole] ?? weights[v.voterId] ?? 1.0),
        0,
      );
      return approveWeight > totalWeight / 2;
    }
    case "bft": {
      // BFT 简化版：需要 >= 2f+1 票，f = 容错数
      const f = proposal.faultTolerance ?? Math.floor((voters.length - 1) / 3);
      if (voters.length < 4) return approveVotes.length >= voters.length; // 人数不足时退化为全票
      const required = 2 * f + 1;
      return approveCount >= required;
    }
    default:
      return false;
  }
}

/* ================================================================== */
/*  Layer 3: Discovery Protocol                                        */
/* ================================================================== */

/** 角色能力声明 */
export interface RoleCapabilityDeclaration {
  roleName: string;
  /** 支持的步骤类型 */
  stepKinds: string[];
  /** 支持的工具 */
  toolRefs: string[];
  /** 能力标签 */
  capabilities: string[];
  /** 并发限制 */
  maxConcurrency: number;
  /** 是否可用 */
  available: boolean;
  /** 当前负载 (0~1) */
  load: number;
  /** 能力声明时间 */
  declaredAt: string;
}

/** 能力查询请求 */
export interface DiscoveryQuery {
  queryId: string;
  /** 需要的步骤类型 */
  requiredStepKind?: string;
  /** 需要的工具 */
  requiredToolRef?: string;
  /** 需要的能力 */
  requiredCapabilities?: string[];
}

/** 能力查询响应 */
export interface DiscoveryReply {
  queryId: string;
  /** 匹配的角色列表 */
  matchedRoles: RoleCapabilityDeclaration[];
  /** 推荐的角色（按匹配度排序） */
  recommended?: string;
}

/* ================================================================== */
/*  Layer 4: State Sync Protocol                                       */
/* ================================================================== */

/** 协作运行全局状态快照 */
export interface CollabStateSnapshot {
  collabRunId: string;
  /** 状态版本号（单调递增） */
  version: number;
  /** 全局阶段 */
  phase: string;
  /** 各角色当前状态 */
  roleStates: Record<string, {
    status: "idle" | "working" | "blocked" | "completed" | "failed";
    currentStepId?: string;
    lastUpdated: string;
  }>;
  /** 步骤完成情况 */
  stepProgress: Record<string, {
    status: string;
    assignedRole: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
  /** 快照时间 */
  snapshotAt: string;
}

/** 状态同步确认 */
export interface SyncAck {
  collabRunId: string;
  /** 确认的版本号 */
  ackedVersion: number;
  /** 确认方角色 */
  fromRole: string;
  ackedAt: string;
}

/* ================================================================== */
/*  Layer 5: Debate Protocol — 自主辩论与仲裁                         */
/* ================================================================== */

/**
 * 辩论立场：单个 Agent 对某一议题的论点陈述
 * 每个立场包含结论、推理过程和证据引用
 */
export interface DebatePosition {
  /** 立场所属的辩论会话ID */
  debateId: string;
  /** 轮次编号（0-based） */
  round: number;
  /** 发言方角色（可选，与 DebateParty.role 兼容） */
  fromRole?: string;
  /** 核心立场/结论 */
  claim: string;
  /** 推理过程 */
  reasoning: string;
  /** 证据引用（stepId / 工具输出 / 外部知识） */
  evidence: string[];
  /** 对对方上一轮立场的反驳点（round > 0 时有值） */
  rebuttalTo?: string;
  /** 置信度 (0~1) */
  confidence: number;
  /** 提交时间 (ISO 8601) */
  submittedAt: string;
}

/**
 * 辩论轮次：一轮完整的正反方交锋
 * 每轮包含两个立场（正方 + 反方）
 */
export interface DebateRound {
  round: number;
  positions: DebatePosition[];
  /** 本轮是否产生了新的分歧点（用于判断是否需要继续辩论） */
  divergenceDetected: boolean;
}

/**
 * 辩论裁决结果 v2: 支持 N 方辩论结果
 */
export interface DebateVerdict {
  debateId: string;
  /** 仲裁方角色 */
  arbiterRole: string;
  /** 裁决结果 (v2: 新增 multi_synthesis / partial_consensus) */
  outcome: DebateVerdictOutcome;
  /** 胜出方角色（outcome=synthesis 时为综合方案描述） */
  winnerRole?: string;
  /** v2: 多方胜出方角色列表（N方辩论时） */
  winnerRoles?: string[];
  /** 仲裁说明 */
  reasoning: string;
  /** 综合结论（融合双方论点的最终答案） */
  synthesizedConclusion: string;
  /** 各轮评分摘要 (v2: 支持 N 方评分) */
  roundScores: Array<{ round: number; sideAScore: number; sideBScore: number; partyScores?: Record<string, number> }>;
  /** v2: 纠错摘要 */
  correctionSummary?: string;
  /** 仲裁时间 */
  decidedAt: string;
}

/**
 * 辩论会话 v2：支持 N 方辩论 + 动态纠错 + 共识演化
 */
export interface DebateSession {
  debateId: string;
  collabRunId: string;
  /** 辩论议题 */
  topic: string;
  /** N 方辩论参与方列表 */
  parties: DebateParty[];
  /** 最大轮次（环境变量可覆盖） */
  maxRounds: number;
  /** 已完成的轮次 */
  rounds: DebateRound[];
  /** 纠错记录 */
  corrections?: DebateCorrection[];
  /** 共识演化历史 */
  consensusEvolution?: ConsensusEvolutionEntry[];
  /** 最终裁决（辩论结束后填充） */
  verdict?: DebateVerdict;
  /** 辩论状态 */
  status: "in_progress" | "converged" | "max_rounds_reached" | "verdicted" | "aborted";
  /** 创建时间 */
  createdAt: string;
}

/* ================================================================== */
/*  Layer 5b: Debate Protocol v2 — N方辩论 + 动态纠错 + 共识演化       */
/* ================================================================== */

/** v2: 辩论参与方（支持 N 方） */
export interface DebateParty {
  /** 参与方唯一ID */
  partyId: string;
  /** 角色名称 */
  role: string;
  /** 参与方立场标签 */
  stance: string;
  /** 参与方状态 */
  status: "active" | "withdrawn" | "eliminated";
  /** 当前置信度 */
  currentConfidence: number;
  /** 参与起始轮次 */
  joinedAtRound: number;
  /** 资源预算上限 */
  budget?: number;
}

/** v2: 动态纠错记录 */
export interface DebateCorrection {
  /** 纠错ID */
  correctionId: string;
  /** 触发纠错的轮次 */
  triggeredAtRound: number;
  /** 纠错类型 */
  correctionType: CorrectionType;
  /** 被纠错的参与方角色 */
  targetRole: string;
  /** 纠错发起方（arbiter 或其他参与方） */
  correctedBy: string;
  /** 原始错误内容 */
  originalClaim: string;
  /** 纠错说明 */
  correctionReason: string;
  /** 建议的修正内容 */
  suggestedCorrection: string;
  /** 纠错状态 */
  status: "pending" | "accepted" | "rejected" | "superseded";
  /** 证据引用 */
  evidence: string[];
  /** 时间戳 */
  createdAt: string;
}

/** v2: 共识演化条目 */
export interface ConsensusEvolutionEntry {
  /** 演化步骤编号 */
  step: number;
  /** 对应轮次 */
  atRound: number;
  /** 当前共识状态 */
  consensusState: "no_consensus" | "partial_consensus" | "majority_consensus" | "full_consensus";
  /** 各方当前立场摘要 */
  partyPositions: Record<string, { claim: string; confidence: number }>;
  /** 已达成共识的论点 */
  agreedPoints: string[];
  /** 仍存分歧的论点 */
  divergentPoints: string[];
  /** 共识度分数 (0~1) */
  consensusScore: number;
  /** 演化说明 */
  evolutionNote: string;
  /** 时间戳 */
  recordedAt: string;
}

/** 辩论配置（从 approval_rules 动态加载或兜底默认值） */
export interface DebateConfig {
  maxRounds: number;
  convergenceThreshold: number;
  minConfidence: number;
  arbiterModel?: string;
  allowCorrections: boolean;
  requireEvidence: boolean;
  // V2 扩展
  scoreDecay: number;
  correctionBonus: number;
  consensusEvolutionWindow: number;
  divergenceConfDiff: number;
  minParties: number;
  maxParties: number;
}

/** 辩论裁决结果 — 开放字符串，通过注册表验证 */
export type DebateVerdictOutcome = string;

export const BUILTIN_VERDICT_OUTCOMES: RegistryEntry[] = [
  builtInEntry('side_a_wins', 'debate.outcome'),
  builtInEntry('side_b_wins', 'debate.outcome'),
  builtInEntry('synthesis', 'debate.outcome'),
  builtInEntry('inconclusive', 'debate.outcome'),
  builtInEntry('multi_synthesis', 'debate.outcome'),
  builtInEntry('partial_consensus', 'debate.outcome'),
];

export const verdictOutcomeRegistry = createRegistry(BUILTIN_VERDICT_OUTCOMES);

/** 纠错类型 — 开放字符串，通过注册表验证 */
export type CorrectionType = string;

export const BUILTIN_CORRECTION_TYPES: RegistryEntry[] = [
  builtInEntry('factual_error', 'debate.correction'),
  builtInEntry('logical_fallacy', 'debate.correction'),
  builtInEntry('evidence_conflict', 'debate.correction'),
  builtInEntry('hallucination', 'debate.correction'),
  builtInEntry('bias_detected', 'debate.correction'),
];

export const correctionTypeRegistry = createRegistry(BUILTIN_CORRECTION_TYPES);

/* ================================================================== */
/*  Protocol Validation                                                */
/* ================================================================== */

/** 校验消息信封格式 */
export function validateCollabMessage(msg: unknown): { ok: boolean; error?: string } {
  if (!msg || typeof msg !== "object") return { ok: false, error: "消息必须是对象" };
  const m = msg as Record<string, unknown>;
  if (typeof m.messageId !== "string" || !m.messageId) return { ok: false, error: "缺少 messageId" };
  if (typeof m.messageType !== "string" || !m.messageType) return { ok: false, error: "缺少 messageType" };
  if (typeof m.collabRunId !== "string" || !m.collabRunId) return { ok: false, error: "缺少 collabRunId" };
  if (typeof m.tenantId !== "string" || !m.tenantId) return { ok: false, error: "缺少 tenantId" };
  if (typeof m.fromRole !== "string" || !m.fromRole) return { ok: false, error: "缺少 fromRole" };
  if (typeof m.version !== "string" || !m.version) return { ok: false, error: "缺少 version" };
  return { ok: true };
}

/** 校验共识提案格式 */
export function validateConsensusProposal(proposal: unknown): { ok: boolean; error?: string } {
  if (!proposal || typeof proposal !== "object") return { ok: false, error: "提案必须是对象" };
  const p = proposal as Record<string, unknown>;
  if (typeof p.proposalId !== "string") return { ok: false, error: "缺少 proposalId" };
  if (typeof p.proposedBy !== "string") return { ok: false, error: "缺少 proposedBy" };
  if (!Array.isArray(p.voters) || p.voters.length === 0) return { ok: false, error: "voters 不能为空" };
  const validQuorums = ["majority", "unanimous", "any", "weighted_majority", "supermajority", "bft"];
  if (!validQuorums.includes(String(p.quorum))) return { ok: false, error: `无效的 quorum: ${p.quorum}` };
  return { ok: true };
}
