/**
 * collabDebateAutoTrigger.ts — 自动分歧检测与辩论触发
 *
 * 从 collabDebate.ts 拆分而来，负责检测 Agent 结果分歧并自动触发辩论。
 */
import type { AgentState, CollabResult, CollabOrchestratorParams } from "./collabTypes";
import { runDebatePhaseV2 } from "./collabDebate";
import { collabConfig } from "@openslin/shared";
import {
  persistDebateSession, persistDebateCorrections,
  persistDebateConsensusEvolution, persistDebateRound,
  persistDebatePosition, persistDebateVerdict,
} from "./collabDebateRepo";

/**
 * P1-5: 检测Agent结果是否存在分歧，如有则自动触发辩论
 */
export async function runDebateIfDivergent(params: {
  agentStates: AgentState[];
  crossValidationResults?: CollabResult["crossValidation"];
  params: CollabOrchestratorParams;
  maxIterationsPerAgent: number;
}): Promise<CollabResult["debate"] | undefined> {
  const { agentStates, crossValidationResults, params: orchestratorParams, maxIterationsPerAgent } = params;
  const doneStates = agentStates.filter((s) => s.status === "done" && s.result?.message);

  let hasDivergence = false;
  let divergenceReason = "";

  if (crossValidationResults && crossValidationResults.length > 0) {
    const rejected = crossValidationResults.filter(
      (cv) => cv.verdict === "rejected" || cv.verdict === "needs_revision",
    );
    if (rejected.length > 0) {
      hasDivergence = true;
      divergenceReason = `交叉验证发现分歧: ${rejected.map((r) => `${r.validatedAgent}被${r.validatorAgent}判定为${r.verdict}`).join("; ")}`;
    }
  }

  if (!hasDivergence && agentStates.length >= 2) {
    if (doneStates.length >= 2) {
      const messages = doneStates.map((s) => (s.result?.message ?? "").toLowerCase());
      const conflictSignals = ["disagree", "不同意", "however", "contradicts", "矛盾", "相反", "incorrect", "错误"];
      const conflictCount = messages.filter((m) => conflictSignals.some((sig) => m.includes(sig))).length;
      if (conflictCount >= 2) {
        hasDivergence = true;
        divergenceReason = `Agent结果包含冲突信号 (${conflictCount}/${doneStates.length} 个 Agent)`;
      }
    }
  }

  if (!hasDivergence) return undefined;

  orchestratorParams.app.log.info({ divergenceReason }, "[CollabOrchestrator] 检测到Agent分歧，触发辩论机制");

  let sideAState: AgentState;
  let sideBState: AgentState;

  if (crossValidationResults && crossValidationResults.length > 0) {
    const firstRejection = crossValidationResults.find(
      (cv) => cv.verdict === "rejected" || cv.verdict === "needs_revision",
    );
    sideAState = agentStates.find((s) => s.agentId === firstRejection?.validatedAgent) ?? agentStates[0]!;
    sideBState = agentStates.find((s) => s.agentId === firstRejection?.validatorAgent) ?? agentStates[1]!;
  } else {
    sideAState = agentStates[0]!;
    sideBState = agentStates[1]!;
  }

  const topic = `Agent结果分歧审议: ${orchestratorParams.goal.slice(0, 200)}

分歧原因: ${divergenceReason}

Side A (${sideAState.role}) 结论: ${sideAState.result?.message?.slice(0, 300) ?? "N/A"}

Side B (${sideBState.role}) 结论: ${sideBState.result?.message?.slice(0, 300) ?? "N/A"}`;

  const debateParties = doneStates.slice(0, collabConfig("COLLAB_AUTO_DEBATE_MAX_PARTIES")).map((state) => ({
    agentId: state.agentId,
    role: state.role,
    goal: state.goal,
    stance: (state.result?.message ?? state.goal).replace(/\s+/g, " ").slice(0, 160) || state.role,
  }));

  const debateSession = await runDebatePhaseV2({
    app: orchestratorParams.app,
    pool: orchestratorParams.pool,
    queue: orchestratorParams.queue,
    subject: orchestratorParams.subject,
    locale: orchestratorParams.locale,
    authorization: orchestratorParams.authorization,
    traceId: orchestratorParams.traceId,
    collabRunId: orchestratorParams.collabRunId,
    taskId: orchestratorParams.taskId,
    topic,
    parties: debateParties.length >= 2 ? debateParties : [
      {
        agentId: sideAState.agentId,
        role: sideAState.role,
        goal: sideAState.goal,
        stance: (sideAState.result?.message ?? sideAState.goal).replace(/\s+/g, " ").slice(0, 160) || sideAState.role,
      },
      {
        agentId: sideBState.agentId,
        role: sideBState.role,
        goal: sideBState.goal,
        stance: (sideBState.result?.message ?? sideBState.goal).replace(/\s+/g, " ").slice(0, 160) || sideBState.role,
      },
    ],
    maxRounds: collabConfig("COLLAB_AUTO_DEBATE_MAX_ROUNDS"),
    maxIterationsPerRound: Math.min(5, maxIterationsPerAgent),
    enableCorrection: orchestratorParams.enableDynamicCorrection !== false,
    signal: orchestratorParams.signal,
  });

  const tenantId = orchestratorParams.subject.tenantId;
  const spaceId = orchestratorParams.subject.spaceId;
  const collabRunId = orchestratorParams.collabRunId;
  const taskId = orchestratorParams.taskId;

  await persistDebateSession({
    pool: orchestratorParams.pool, tenantId, spaceId, collabRunId, taskId,
    session: debateSession, triggerReason: divergenceReason,
  }).catch((e: any) => orchestratorParams.app.log.warn({ err: e }, "[CollabOrchestrator] persistDebateSession 失败"));

  if ((debateSession.corrections?.length ?? 0) > 0) {
    await persistDebateCorrections({
      pool: orchestratorParams.pool, tenantId,
      debateId: debateSession.debateId, corrections: debateSession.corrections ?? [],
    }).catch((e: unknown) => {
      orchestratorParams.app.log.warn({ err: (e as Error)?.message, debateId: debateSession.debateId }, "[CollabOrchestrator] persistDebateCorrections failed");
    });
  }

  if ((debateSession.consensusEvolution?.length ?? 0) > 0) {
    await persistDebateConsensusEvolution({
      pool: orchestratorParams.pool, tenantId,
      debateId: debateSession.debateId, entries: debateSession.consensusEvolution ?? [],
    }).catch((e: unknown) => {
      orchestratorParams.app.log.warn({ err: (e as Error)?.message, debateId: debateSession.debateId }, "[CollabOrchestrator] persistDebateConsensusEvolution failed");
    });
  }

  for (const round of debateSession.rounds) {
    await persistDebateRound({
      pool: orchestratorParams.pool, tenantId, debateId: debateSession.debateId, round,
    }).catch((e: unknown) => {
      orchestratorParams.app.log.warn({ err: (e as Error)?.message, debateId: debateSession.debateId }, "[CollabOrchestrator] persistDebateRound failed");
    });
    for (const position of round.positions) {
      const matchingParty = debateSession.parties.find((party) => party.role === position.fromRole);
      const correctionRefs = (debateSession.corrections ?? [])
        .filter((correction) => correction.targetRole === position.fromRole)
        .map((correction) => correction.correctionId);
      await persistDebatePosition({
        pool: orchestratorParams.pool, tenantId,
        debateId: debateSession.debateId, position,
        partyId: matchingParty?.partyId ?? null,
        rebuttalTargets: position.rebuttalTo ? [position.rebuttalTo] : [],
        correctionRefs,
      }).catch((e: unknown) => {
        orchestratorParams.app.log.warn({ err: (e as Error)?.message, debateId: debateSession.debateId }, "[CollabOrchestrator] persistDebatePosition failed");
      });
    }
  }

  if (debateSession.verdict) {
    await persistDebateVerdict({
      pool: orchestratorParams.pool, tenantId, debateId: debateSession.debateId, verdict: debateSession.verdict,
    }).catch((e: unknown) => {
      orchestratorParams.app.log.warn({ err: (e as Error)?.message, debateId: debateSession.debateId }, "[CollabOrchestrator] persistDebateVerdict failed");
    });
  }

  return {
    debateId: debateSession.debateId,
    topic: debateSession.topic,
    status: debateSession.status,
    rounds: debateSession.rounds.length,
    verdict: debateSession.verdict ? {
      outcome: debateSession.verdict.outcome,
      winnerRole: debateSession.verdict.winnerRole ?? debateSession.verdict.winnerRoles?.[0],
      synthesizedConclusion: debateSession.verdict.synthesizedConclusion,
    } : undefined,
  };
}
