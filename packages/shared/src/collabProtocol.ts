/**
 * Collaboration Message Protocol (S12)
 * Re-exported from @mindpal/protocol - the single source of truth.
 *
 * Additional runtime functions (collabConfig, getDebateConfigDefaults, createDebateSession,
 * computeDebateConsensusScore, isDebateConverged) remain here as they depend on
 * the shared runtimeConfig module.
 */

// Re-export all protocol-layer types and pure functions
export {
  toolNameFromRef,
  isToolAllowedForPolicy,
  isConsensusReached,
  validateCollabMessage,
  validateConsensusProposal,
} from '@mindpal/protocol';

export type {
  MessagePriority,
  MessageStatus,
  CollabMessageType,
  CollabMessageEnvelope,
  CollabMessage,
  ConsensusProposal,
  ConsensusQuorumType,
  ConsensusVote,
  RoleCapabilityDeclaration,
  DiscoveryQuery,
  DiscoveryReply,
  CollabStateSnapshot,
  SyncAck,
  DebatePosition,
  DebateRound,
  DebateVerdict,
  DebateSession,
  DebateParty,
  DebateCorrection,
  ConsensusEvolutionEntry,
  DebateConfig,
} from '@mindpal/protocol';

// ── Runtime functions that depend on shared/runtimeConfig ──

import { resolveNumber } from "./runtimeConfig";
import type {
  DebateConfig,
  DebateSession,
  DebateParty,
  DebateCorrection,
} from '@mindpal/protocol';

/** 协作模块配置默认值，可通过环境变量或 governance 热覆盖 */
export const COLLAB_CONFIG_DEFAULTS: Record<string, number> = {
  COLLAB_CONFIDENCE_THRESHOLD: 0.7,
  COLLAB_CONSENSUS_THRESHOLD: 0.6,
  COLLAB_DIVERGENCE_CONF_DIFF: 0.15,
  COLLAB_DIVERGENCE_MIN_CONF: 0.8,
  COLLAB_PENALTY_SEVERE: 0.06,
  COLLAB_PENALTY_MILD: 0.03,
  COLLAB_BUS_MAX_IN_FLIGHT: 100,
  COLLAB_BUS_RESUME_THRESHOLD: 0.7,
  COLLAB_BUS_POLL_MS: 20,
  COLLAB_AUTO_DEBATE_MAX_ROUNDS: 3,
  COLLAB_AUTO_DEBATE_MAX_PARTIES: 6,
  COLLAB_CORRECTION_FEEDBACK_MAX_LEN: 800,
  COLLAB_CORRECTION_PREV_OUTPUT_MAX_LEN: 500,
  COLLAB_ENVELOPE_OBSERVATION_LIMIT: 5,
  DEBATE_MAX_ROUNDS: 5,
  DEBATE_CONVERGENCE_THRESHOLD: 0.8,
  DEBATE_MIN_CONFIDENCE: 0.6,
  DEBATE_SCORE_DECAY: 0.9,
  DEBATE_CORRECTION_BONUS: 0.05,
  DEBATE_CONSENSUS_EVOLUTION_WINDOW: 3,
  DEBATE_MIN_PARTIES: 2,
  DEBATE_MAX_PARTIES: 10,
  COLLAB_BUS_STREAM_MAXLEN: 5000,
  COLLAB_MAX_CORRECTION_ROUNDS: 3,
  COLLAB_MAX_ENVELOPE_SIZE: 1048576,
  debateAgentTimeoutMs: 60_000,
};

/** 获取协作模块配置值，自动走 governance > env > default 三级解析 */
export function collabConfig(key: string): number {
  const defaultVal = COLLAB_CONFIG_DEFAULTS[key] ?? 0;
  return resolveNumber(key, undefined, undefined, defaultVal).value;
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

/** 创建 N 方辩论会话 */
export function createDebateSession(params: {
  debateId: string;
  collabRunId: string;
  topic: string;
  parties: Array<{ partyId: string; role: string; stance: string; budget?: number }>;
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

  const avgConfidence = positions.reduce((s, p) => s + p.confidence, 0) / positions.length;
  const divergenceFactor = lastRound.divergenceDetected ? 0.5 : 1.0;

  const corrections = session.corrections ?? [];
  const severePenalty = corrections.filter(
    c => c.correctionType === "factual_error" || c.correctionType === "hallucination",
  ).length * collabConfig("COLLAB_PENALTY_SEVERE");
  const mildPenalty = corrections.filter(
    c => c.correctionType !== "factual_error" && c.correctionType !== "hallucination",
  ).length * collabConfig("COLLAB_PENALTY_MILD");
  const correctionPenalty = severePenalty + mildPenalty;

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

  const allConfident = lastRound.positions.every(p => p.confidence >= confidenceThreshold);
  if (!allConfident) return false;

  const consensusScore = computeDebateConsensusScore(session);
  return consensusScore >= consensusThreshold;
}
