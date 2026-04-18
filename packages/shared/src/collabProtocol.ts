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

/* ================================================================== */
/*  Layer 1: Message Protocol                                          */
/* ================================================================== */

/** 协作消息类型 */
export type CollabMessageType =
  | "task.assign"       // 任务分配
  | "task.accept"       // 任务接受
  | "task.reject"       // 任务拒绝
  | "task.complete"     // 任务完成
  | "task.fail"         // 任务失败
  | "step.start"        // 步骤开始
  | "step.progress"     // 步骤进度
  | "step.complete"     // 步骤完成
  | "step.fail"         // 步骤失败
  | "consensus.propose" // 共识提案
  | "consensus.vote"    // 共识投票
  | "consensus.resolve" // 共识决议
  | "discovery.query"   // 能力查询
  | "discovery.reply"   // 能力应答
  | "sync.state"        // 状态同步
  | "sync.ack"          // 同步确认
  | "debate.open"       // 辩论开始
  | "debate.position"   // 辩论立场陈述
  | "debate.rebuttal"   // 辩论反驳
  | "debate.verdict"    // 仲裁裁决
  | "debate.correction" // v2: 动态纠错消息
  | "debate.consensus_evolution" // v2: 共识演化通知
  | "debate.party_join"  // v2: N方辩论参与方加入
  | "debate.party_leave" // v2: N方辩论参与方退出
  | "escalate"          // 问题上报
  | "heartbeat";        // 心跳

/** 协作消息信封 */
export interface CollabMessage {
  /** 消息唯一ID */
  messageId: string;
  /** 消息类型 */
  type: CollabMessageType;
  /** 协作运行ID */
  collabRunId: string;
  /** 发送方角色 */
  fromRole: string;
  /** 接收方角色（* 表示广播） */
  toRole: string;
  /** 关联的 taskId */
  taskId?: string;
  /** 关联的 stepId */
  stepId?: string;
  /** 消息载荷 */
  payload: Record<string, unknown>;
  /** 发送时间 (ISO 8601) */
  sentAt: string;
  /** 追踪ID */
  traceId?: string;
  /** 因果关系：引用触发此消息的前序 messageId */
  causedBy?: string;
  /** 消息版本（用于幂等和去重） */
  version: number;
}

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

/** v2: 创建 N 方辩论会话 */
export function createDebateSessionV2(params: {
  debateId: string;
  collabRunId: string;
  topic: string;
  parties: Array<{ partyId: string; role: string; stance: string; budget?: number }>;
  arbiter: string;
  maxRounds?: number;
}): DebateSession {
  const maxRounds = params.maxRounds ?? Math.max(1, Number(process.env.DEBATE_MAX_ROUNDS ?? "5"));
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
  ).length * 0.06;
  const mildPenalty = corrections.filter(
    c => c.correctionType !== "factual_error" && c.correctionType !== "hallucination",
  ).length * 0.03;
  const correctionPenalty = severePenalty + mildPenalty;

  // 置信度方差因子：各方置信度越接近，共识度越高
  const confidenceVariance = positions.length > 1
    ? positions.reduce((s, p) => s + Math.pow(p.confidence - avgConfidence, 2), 0) / positions.length
    : 0;
  const alignmentFactor = Math.max(0.5, 1 - confidenceVariance * 2);

  return Math.max(0, Math.min(1, avgConfidence * divergenceFactor * alignmentFactor - correctionPenalty));
}

/** v2: 检查 N 方辩论是否已收敛 */
export function isDebateConvergedV2(
  session: DebateSession,
  confidenceThreshold = 0.7,
  consensusThreshold = 0.6,
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

/**
 * 创建辩论会话初始状态
 */
/** @deprecated 使用 createDebateSessionV2 代替（v1 wrapper） */
export function createDebateSession(params: {
  debateId: string;
  collabRunId: string;
  topic: string;
  sideA: string;
  sideB: string;
  arbiter: string;
  maxRounds?: number;
}): DebateSession {
  return createDebateSessionV2({
    debateId: params.debateId,
    collabRunId: params.collabRunId,
    topic: params.topic,
    parties: [
      { partyId: "side_a", role: params.sideA, stance: "pro" },
      { partyId: "side_b", role: params.sideB, stance: "con" },
    ],
    arbiter: params.arbiter,
    maxRounds: params.maxRounds,
  });
}

/**
 * 检测辩论是否已收敛（双方立场趋同，无新分歧点）
 * 当最近一轮未检测到分歧，且双方置信度均 >= threshold 时视为收敛
 */
/** @deprecated 使用 isDebateConvergedV2 代替（v1 wrapper） */
export function isDebateConverged(
  session: DebateSession,
  confidenceThreshold = 0.7,
): boolean {
  return isDebateConvergedV2(session, confidenceThreshold);
}

/* ================================================================== */
/*  Protocol Validation                                                */
/* ================================================================== */

/** 校验消息信封格式 */
export function validateCollabMessage(msg: unknown): { ok: boolean; error?: string } {
  if (!msg || typeof msg !== "object") return { ok: false, error: "消息必须是对象" };
  const m = msg as Record<string, unknown>;
  if (typeof m.messageId !== "string" || !m.messageId) return { ok: false, error: "缺少 messageId" };
  if (typeof m.type !== "string" || !m.type) return { ok: false, error: "缺少 type" };
  if (typeof m.collabRunId !== "string" || !m.collabRunId) return { ok: false, error: "缺少 collabRunId" };
  if (typeof m.fromRole !== "string" || !m.fromRole) return { ok: false, error: "缺少 fromRole" };
  if (typeof m.toRole !== "string" || !m.toRole) return { ok: false, error: "缺少 toRole" };
  if (typeof m.version !== "number") return { ok: false, error: "缺少 version" };
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
