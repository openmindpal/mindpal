/**
 * Runtime State Machine (S01)
 * Re-exported from @mindpal/protocol - the single source of truth.
 */
export {
  STEP_STATUSES,
  STEP_TERMINAL,
  STEP_BLOCKING,
  STEP_STREAMING,
  STEP_TRANSITIONS,
  RUN_STATUSES,
  RUN_TERMINAL,
  RUN_TRANSITIONS,
  COLLAB_PHASES,
  COLLAB_TERMINAL,
  COLLAB_TRANSITIONS,
  AGENT_PHASES,
  AGENT_TRANSITIONS,
  AGENT_TERMINAL,
  transitionStep,
  transitionRun,
  transitionCollab,
  transitionAgent,
  tryTransitionStep,
  tryTransitionRun,
  tryTransitionCollab,
  tryTransitionAgent,
  isAgentTerminal,
  normalizeStepStatus,
  normalizeRunStatus,
  normalizeCollabPhase,
  checkStateInvariant,
  mapOrchestrationToAgent,
  mapAgentToOrchestration,
} from '@mindpal/protocol';

export type {
  StepStatus,
  RunStatus,
  CollabPhase,
  AgentPhase,
  TransitionViolation,
  TransitionResult,
  StateInvariantViolation,
} from '@mindpal/protocol';
