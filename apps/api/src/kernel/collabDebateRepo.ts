/**
 * collabDebateRepo.ts — 辩论持久化 CRUD
 *
 * 从 collabDebate.ts 拆分而来，负责辩论会话、立场、轮次、裁决、
 * 纠错记录、共识演化记录的持久化写入。
 */
import type { Pool } from "pg";
import {
  computeDebateConsensusScore,
  type DebateSession, type DebatePosition, type DebateRound,
  type DebateVerdict, type DebateCorrection, type ConsensusEvolutionEntry,
} from "@mindpal/shared";

// ── 持久化：辩论会话 ──────────────────────────────────────

/** 持久化辩论会话到 DB */
export async function persistDebateSession(params: {
  pool: Pool;
  tenantId: string;
  spaceId: string | null;
  collabRunId: string;
  taskId: string;
  session: DebateSession;
  triggerReason?: string;
}): Promise<void> {
  const { pool, tenantId, spaceId, collabRunId, taskId, session, triggerReason } = params;
  const consensusScore = computeDebateConsensusScore(session);
  const debateVersion = session.parties.length > 0 ? 2 : 1;
  await pool.query(
    `INSERT INTO collab_debate_sessions
     (debate_id, tenant_id, space_id, collab_run_id, task_id, topic,
      side_a_role, side_b_role, arbiter_role, max_rounds, actual_rounds,
      status, trigger_reason, verdict_outcome, verdict_winner_role, synthesized_conclusion,
      completed_at, parties, corrections, consensus_evolution, debate_version, consensus_score, updated_at)
     VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
     ON CONFLICT (debate_id) DO UPDATE SET
       actual_rounds = $11, status = $12, verdict_outcome = $14,
       verdict_winner_role = $15, synthesized_conclusion = $16,
       completed_at = $17, parties = $18, corrections = $19,
       consensus_evolution = $20, debate_version = $21,
       consensus_score = $22, updated_at = now()`,
    [
      session.debateId, tenantId, spaceId, collabRunId, taskId, session.topic,
      session.parties[0]?.role ?? '', session.parties[1]?.role ?? '', 'orchestrator_arbiter', session.maxRounds,
      session.rounds.length, session.status, triggerReason ?? null,
      session.verdict?.outcome ?? null, session.verdict?.winnerRole ?? session.verdict?.winnerRoles?.[0] ?? null,
      session.verdict?.synthesizedConclusion ?? null,
      session.status === "in_progress" ? null : new Date().toISOString(),
      JSON.stringify(session.parties),
      JSON.stringify(session.corrections ?? []),
      JSON.stringify(session.consensusEvolution ?? []),
      debateVersion,
      consensusScore,
    ],
  );
}

// ── 持久化：立场 ──────────────────────────────────────────

/** 持久化辩论立场到 DB */
export async function persistDebatePosition(params: {
  pool: Pool;
  tenantId: string;
  debateId: string;
  position: DebatePosition;
  agentRunId?: string;
  partyId?: string | null;
  rebuttalTargets?: string[];
  correctionRefs?: string[];
}): Promise<void> {
  const { pool, tenantId, debateId, position, agentRunId, partyId, rebuttalTargets, correctionRefs } = params;
  await pool.query(
    `INSERT INTO collab_debate_positions
     (tenant_id, debate_id, round, from_role, claim, reasoning, evidence, rebuttal_to, confidence, agent_run_id, submitted_at, party_id, rebuttal_targets, correction_refs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      tenantId, debateId, position.round, position.fromRole,
      position.claim, position.reasoning, JSON.stringify(position.evidence),
      position.rebuttalTo ?? null, position.confidence,
      agentRunId ?? null, position.submittedAt,
      partyId ?? null,
      JSON.stringify(rebuttalTargets ?? (position.rebuttalTo ? [position.rebuttalTo] : [])),
      JSON.stringify(correctionRefs ?? []),
    ],
  );
}

// ── 持久化：轮次 ──────────────────────────────────────────

/** 持久化辩论轮次摘要到 DB */
export async function persistDebateRound(params: {
  pool: Pool;
  tenantId: string;
  debateId: string;
  round: DebateRound;
}): Promise<void> {
  const { pool, tenantId, debateId, round: r } = params;
  const sideAConf = r.positions[0]?.confidence ?? null;
  const sideBConf = r.positions[1]?.confidence ?? null;
  await pool.query(
    `INSERT INTO collab_debate_rounds
     (tenant_id, debate_id, round, divergence_detected, side_a_confidence, side_b_confidence)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (debate_id, round) DO UPDATE SET
       divergence_detected = $4, side_a_confidence = $5, side_b_confidence = $6`,
    [tenantId, debateId, r.round, r.divergenceDetected, sideAConf, sideBConf],
  );
}

// ── 持久化：裁决 ──────────────────────────────────────────

/** 持久化辩论裁决到 DB */
export async function persistDebateVerdict(params: {
  pool: Pool;
  tenantId: string;
  debateId: string;
  verdict: DebateVerdict;
  arbiterRunId?: string;
}): Promise<void> {
  const { pool, tenantId, debateId, verdict, arbiterRunId } = params;
  const partyScores = verdict.roundScores.reduce<Record<string, number>>((acc, round) => {
    for (const [role, score] of Object.entries(round.partyScores ?? {})) {
      acc[role] = Math.max(acc[role] ?? 0, score);
    }
    return acc;
  }, {});
  const consensusScore =
    Object.keys(partyScores).length > 1
      ? Object.values(partyScores).reduce((sum, score) => sum + score, 0) / Object.keys(partyScores).length
      : ((verdict.roundScores[verdict.roundScores.length - 1]?.sideAScore ?? 0)
        + (verdict.roundScores[verdict.roundScores.length - 1]?.sideBScore ?? 0)) / 2;
  await pool.query(
    `INSERT INTO collab_debate_verdicts
     (tenant_id, debate_id, arbiter_role, outcome, winner_role, reasoning,
      synthesized_conclusion, round_scores, arbiter_run_id, decided_at, winner_roles, party_scores, correction_summary, consensus_score)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (debate_id) DO UPDATE SET
       outcome = $4, winner_role = $5, reasoning = $6,
       synthesized_conclusion = $7, round_scores = $8, decided_at = $10,
       winner_roles = $11, party_scores = $12, correction_summary = $13, consensus_score = $14`,
    [
      tenantId, debateId, verdict.arbiterRole, verdict.outcome,
      verdict.winnerRole ?? verdict.winnerRoles?.[0] ?? null, verdict.reasoning,
      verdict.synthesizedConclusion, JSON.stringify(verdict.roundScores),
      arbiterRunId ?? null, verdict.decidedAt,
      JSON.stringify(verdict.winnerRoles ?? (verdict.winnerRole ? [verdict.winnerRole] : [])),
      JSON.stringify(partyScores),
      verdict.correctionSummary ?? "",
      consensusScore,
    ],
  );
}

// ── 持久化：纠错 ──────────────────────────────────────────

export async function persistDebateCorrections(params: {
  pool: Pool;
  tenantId: string;
  debateId: string;
  corrections: DebateCorrection[];
}): Promise<void> {
  const { pool, tenantId, debateId, corrections } = params;
  await pool.query(`DELETE FROM debate_corrections WHERE debate_id = $1 AND tenant_id = $2`, [debateId, tenantId]);
  for (const correction of corrections) {
    await pool.query(
      `INSERT INTO debate_corrections
       (correction_id, debate_id, tenant_id, triggered_at_round, correction_type, target_role, corrected_by,
        original_claim, correction_reason, suggested_correction, status, evidence, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        correction.correctionId, debateId, tenantId,
        correction.triggeredAtRound, correction.correctionType,
        correction.targetRole, correction.correctedBy,
        correction.originalClaim, correction.correctionReason,
        correction.suggestedCorrection, correction.status,
        JSON.stringify(correction.evidence ?? []),
        correction.createdAt,
      ],
    );
  }
}

// ── 持久化：共识演化 ──────────────────────────────────────

export async function persistDebateConsensusEvolution(params: {
  pool: Pool;
  tenantId: string;
  debateId: string;
  entries: ConsensusEvolutionEntry[];
}): Promise<void> {
  const { pool, tenantId, debateId, entries } = params;
  await pool.query(`DELETE FROM debate_consensus_evolution WHERE debate_id = $1 AND tenant_id = $2`, [debateId, tenantId]);
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO debate_consensus_evolution
       (debate_id, tenant_id, step, at_round, consensus_state, party_positions, agreed_points, divergent_points, consensus_score, evolution_note, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        debateId, tenantId, entry.step, entry.atRound, entry.consensusState,
        JSON.stringify(entry.partyPositions), JSON.stringify(entry.agreedPoints),
        JSON.stringify(entry.divergentPoints), entry.consensusScore,
        entry.evolutionNote, entry.recordedAt,
      ],
    );
  }
}
