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

import { resolveNumber } from "./runtimeConfig";

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
};

/** 获取协作模块配置值，自动走 governance > env > default 三级解析 */
export function collabConfig(key: string): number {
  const defaultVal = COLLAB_CONFIG_DEFAULTS[key] ?? 0;
  return resolveNumber(key, undefined, undefined, defaultVal).value;
}

/* ================================================================== */
/*  Layer 1: Message Protocol                                          */
/* ================================================================== */

/** 消息优先级 */
export type MessagePriority = "low" | "normal" | "high" | "urgent";

/** 消息状态 */
export type MessageStatus = "pending" | "delivered" | "read" | "processed" | "failed" | "expired";

/** 协作消息类型（统一三处定义的全部消息种类） */
export type CollabMessageType =
  // ── 任务生命周期 ──
  | "task.assign"       // 任务分配
  | "task.accept"       // 任务接受
  | "task.reject"       // 任务拒绝
  | "task.complete"     // 任务完成
  | "task.fail"         // 任务失败
  // ── 步骤生命周期 ──
  | "step.start"        // 步骤开始
  | "step.progress"     // 步骤进度
  | "step.complete"     // 步骤完成
  | "step.fail"         // 步骤失败
  // ── 共识协议 ──
  | "consensus.propose" // 共识提案
  | "consensus.vote"    // 共识投票
  | "consensus.resolve" // 共识决议
  // ── 能力发现 ──
  | "discovery.query"   // 能力查询
  | "discovery.reply"   // 能力应答
  // ── 状态同步 ──
  | "sync.state"        // 状态同步
  | "sync.ack"          // 同步确认
  // ── 辩论协议 ──
  | "debate.open"       // 辩论开始
  | "debate.position"   // 辩论立场陈述
  | "debate.rebuttal"   // 辩论反驳
  | "debate.verdict"    // 仲裁裁决
  | "debate.correction" // v2: 动态纠错消息
  | "debate.consensus_evolution" // v2: 共识演化通知
  | "debate.party_join"  // v2: N方辩论参与方加入
  | "debate.party_leave" // v2: N方辩论参与方退出
  // ── 总线运行时消息 (来自 collabBus) ──
  | "agent.result"            // Agent Loop 执行结果
  | "shared_state.update"     // 共享状态变更通知
  // ── 智能体通信协议 (来自 agentProtocol) ──
  | "request"           // 请求消息
  | "response"          // 响应消息
  | "notification"      // 通知消息
  | "broadcast"         // 广播消息
  | "handoff"           // 任务交接
  | "feedback"          // 反馈消息
  | "query"             // 查询消息
  | "ack"               // 确认消息
  // ── 运行恢复协议 ──
  | "collab.checkpoint"       // 协作运行检查点
  | "collab.resume"           // 协作运行恢复
  | "collab.heartbeat_timeout" // 协作运行心跳超时
  // ── 通用 ──
  | "escalate"          // 问题上报
  | "heartbeat";        // 心跳

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
  topic: "replan" | "abort" | "escalate" | "role_change" | "resource_allocation";
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
  createdAt: string;
}

/** P1-3: 共识决策类型 */
export type ConsensusQuorumType =
  | "majority"        // 简单多数决: >50%
  | "unanimous"       // 全票通过: 100%
  | "any"             // 任一同意: >=1
  | "weighted_majority" // 加权多数决: 加权投票总和 >50% 加权总量
  | "supermajority"   // 超级多数决: >=2/3
  | "bft";            // BFT简化版: 需要 >= 2f+1 票，f=容错数

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
      // 加权投票：同意票的权重总和 > 50% 总权重
      const weights = voterWeights ?? {};
      const totalWeight = voters.reduce((sum, v) => sum + (weights[v] ?? 1.0), 0);
      const approveWeight = approveVotes.reduce(
        (sum, v) => sum + (weights[v.voterRole] ?? weights[v.voterId] ?? 1.0),
        0,
      );
      return approveWeight > totalWeight / 2;
    }
    case "bft": {
      // BFT 简化版：需要 >= 2f+1 票，f = 容错数
      const f = proposal.faultTolerance ?? Math.floor((voters.length - 1) / 3);
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
  /** 发言方角色 */
  fromRole: string;
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
 * 辩论轮次：一轮完整的正反方交锑
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
  outcome: "side_a_wins" | "side_b_wins" | "synthesis" | "inconclusive" | "multi_synthesis" | "partial_consensus";
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
  /** v1 参与方（正方/反方）—— 保持后向兼容 */
  sideA: string;
  sideB: string;
  /** 仲裁方 */
  arbiter: string;
  /** v2: N 方辩论参与方列表 */
  parties?: DebateParty[];
  /** 最大轮次（环境变量可覆盖） */
  maxRounds: number;
  /** 已完成的轮次 */
  rounds: DebateRound[];
  /** v2: 纠错记录 */
  corrections?: DebateCorrection[];
  /** v2: 共识演化历史 */
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
  correctionType: "factual_error" | "logical_fallacy" | "evidence_conflict" | "hallucination" | "bias_detected";
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

/** 获取辩论配置默认值（运行时读取，支持governance热更新） */
export function getDebateConfigDefaults(): DebateConfig {
  return {
    maxRounds: collabConfig("DEBATE_MAX_ROUNDS"),
    convergenceThreshold: collabConfig("DEBATE_CONVERGENCE_THRESHOLD"),
    minConfidence: collabConfig("DEBATE_MIN_CONFIDENCE"),
    allowCorrections: true,
    requireEvidence: true,
    scoreDecay: collabConfig("DEBATE_SCORE_DECAY"),
    correctionBonus: collabConfig("DEBATE_CORRECTION_BONUS"),
    consensusEvolutionWindow: collabConfig("DEBATE_CONSENSUS_EVOLUTION_WINDOW"),
    divergenceConfDiff: collabConfig("COLLAB_DIVERGENCE_CONF_DIFF"),
    minParties: collabConfig("DEBATE_MIN_PARTIES"),
    maxParties: collabConfig("DEBATE_MAX_PARTIES"),
  };
}

/** @deprecated 使用 getDebateConfigDefaults()，此静态版本不支持 governance 热更新 */
export const DEBATE_CONFIG_DEFAULTS: DebateConfig = getDebateConfigDefaults();

/** 创建 N 方辩论会话 */
export function createDebateSession(params: {
  debateId: string;
  collabRunId: string;
  topic: string;
  parties: Array<{ partyId: string; role: string; stance: string; budget?: number }>;
  arbiter: string;
  maxRounds?: number;
}): DebateSession {
  const maxRounds = params.maxRounds ?? Math.max(1, collabConfig("DEBATE_MAX_ROUNDS"));
  const parties: DebateParty[] = params.parties.map(p => ({
    partyId: p.partyId,
    role: p.role,
    stance: p.stance,
    status: "active",
    currentConfidence: 0.5,
    joinedAtRound: 0,
    budget: p.budget,
  }));
  return {
    debateId: params.debateId,
    collabRunId: params.collabRunId,
    topic: params.topic,
    sideA: parties[0]?.role ?? "party_0",
    sideB: parties[1]?.role ?? "party_1",
    arbiter: params.arbiter,
    parties,
    maxRounds,
    rounds: [],
    corrections: [],
    consensusEvolution: [],
    status: "in_progress",
    createdAt: new Date().toISOString(),
  };
}

/** v2: 计算 N 方辩论的共识度 */
export function computeDebateConsensusScore(session: DebateSession): number {
  if (session.rounds.length === 0) return 0;
  const lastRound = session.rounds[session.rounds.length - 1]!;
  const positions = lastRound.positions;
  if (positions.length <= 1) return 1;

  // 基于置信度和分歧度计算共识分数
  const avgConfidence = positions.reduce((s, p) => s + p.confidence, 0) / positions.length;

  // 分歧因子：渐进式降低而非陡降（0.5 而非 0.3，避免单轮分歧就导致共识度骤降）
  const divergenceFactor = lastRound.divergenceDetected ? 0.5 : 1.0;

  // 纠错惩罚：区分严重程度——事实错误/幻觉惩罚更重，偏见/证据冲突较轻
  const corrections = session.corrections ?? [];
  const severePenalty = corrections.filter(
    c => c.correctionType === "factual_error" || c.correctionType === "hallucination",
  ).length * collabConfig("COLLAB_PENALTY_SEVERE");
  const mildPenalty = corrections.filter(
    c => c.correctionType !== "factual_error" && c.correctionType !== "hallucination",
  ).length * collabConfig("COLLAB_PENALTY_MILD");
  const correctionPenalty = severePenalty + mildPenalty;

  // 置信度方差因子：各方置信度越接近，共识度越高
  const confidenceVariance = positions.length > 1
    ? positions.reduce((s, p) => s + Math.pow(p.confidence - avgConfidence, 2), 0) / positions.length
    : 0;
  const alignmentFactor = Math.max(0.5, 1 - confidenceVariance * 2);

  return Math.max(0, Math.min(1, avgConfidence * divergenceFactor * alignmentFactor - correctionPenalty));
}

/** 检查 N 方辩论是否已收敛 */
export function isDebateConverged(
  session: DebateSession,
  confidenceThreshold = collabConfig("COLLAB_CONFIDENCE_THRESHOLD"),
  consensusThreshold = collabConfig("COLLAB_CONSENSUS_THRESHOLD"),
): boolean {
  if (session.rounds.length === 0) return false;
  const lastRound = session.rounds[session.rounds.length - 1]!;
  if (lastRound.divergenceDetected) return false;

  // 所有活跃参与方置信度均达标
  const allConfident = lastRound.positions.every(p => p.confidence >= confidenceThreshold);
  if (!allConfident) return false;

  // 共识度达标
  const consensusScore = computeDebateConsensusScore(session);
  return consensusScore >= consensusThreshold;
}

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
