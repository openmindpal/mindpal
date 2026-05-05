/**
 * State Machine Conformance Tests
 *
 * Validates transition legality, terminal states, and normalizers for
 * Step, Run, Collab, and Agent state machines.
 */
import { describe, it, expect } from 'vitest';
import {
  STEP_STATUSES,
  STEP_TERMINAL,
  STEP_TRANSITIONS,
  RUN_STATUSES,
  RUN_TERMINAL,
  RUN_TRANSITIONS,
  COLLAB_PHASES,
  COLLAB_TERMINAL,
  COLLAB_TRANSITIONS,
  AGENT_PHASES,
  AGENT_TERMINAL,
  AGENT_TRANSITIONS,
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
  mapOrchestrationToAgent,
  mapAgentToOrchestration,
} from '../src/state-machine';
import type { StepStatus, RunStatus, CollabPhase, AgentPhase } from '../src/state-machine';

describe('State Machine — Step transitions', () => {
  it('pending → running is legal', () => {
    expect(transitionStep('pending', 'running')).toBe('running');
  });

  it('running → succeeded is legal', () => {
    expect(transitionStep('running', 'succeeded')).toBe('succeeded');
  });

  it('running → failed is legal', () => {
    expect(transitionStep('running', 'failed')).toBe('failed');
  });

  it('running → paused is legal (P1-1.1)', () => {
    expect(transitionStep('running', 'paused')).toBe('paused');
  });

  it('succeeded → running is ILLEGAL (terminal state)', () => {
    expect(() => transitionStep('succeeded', 'running')).toThrow();
  });

  it('deadletter → any is ILLEGAL', () => {
    expect(() => transitionStep('deadletter', 'pending')).toThrow();
  });

  it('same state transition is allowed (no-op)', () => {
    expect(transitionStep('running', 'running')).toBe('running');
  });

  it('truly absorbing terminal states (succeeded, deadletter) have no outgoing transitions', () => {
    expect(STEP_TRANSITIONS['succeeded'].size).toBe(0);
    expect(STEP_TRANSITIONS['deadletter'].size).toBe(0);
  });

  it('failed and canceled allow retry transitions (not fully absorbing)', () => {
    expect(STEP_TRANSITIONS['failed'].size).toBeGreaterThan(0);
    expect(STEP_TRANSITIONS['canceled'].size).toBeGreaterThan(0);
  });

  it('STEP_TERMINAL contains expected statuses', () => {
    expect(STEP_TERMINAL.has('succeeded')).toBe(true);
    expect(STEP_TERMINAL.has('failed')).toBe(true);
    expect(STEP_TERMINAL.has('deadletter')).toBe(true);
    expect(STEP_TERMINAL.has('canceled')).toBe(true);
  });

  it('tryTransitionStep returns ok:false for illegal transition', () => {
    const result = tryTransitionStep('succeeded', 'running');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('succeeded');
    expect(result.violation).toBeDefined();
    expect(result.violation!.entity).toBe('step');
  });

  it('tryTransitionStep returns ok:true for legal transition', () => {
    const result = tryTransitionStep('pending', 'running');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('running');
  });
});

describe('State Machine — Run transitions', () => {
  it('created → queued is legal', () => {
    expect(transitionRun('created', 'queued')).toBe('queued');
  });

  it('queued → running is legal', () => {
    expect(transitionRun('queued', 'running')).toBe('running');
  });

  it('running → succeeded is legal', () => {
    expect(transitionRun('running', 'succeeded')).toBe('succeeded');
  });

  it('running → paused is legal (P1-1.1)', () => {
    expect(transitionRun('running', 'paused')).toBe('paused');
  });

  it('succeeded → queued is ILLEGAL (terminal)', () => {
    expect(() => transitionRun('succeeded', 'queued')).toThrow();
  });

  it('RUN_TERMINAL contains expected statuses', () => {
    expect(RUN_TERMINAL.has('succeeded')).toBe(true);
    expect(RUN_TERMINAL.has('failed')).toBe(true);
    expect(RUN_TERMINAL.has('canceled')).toBe(true);
    expect(RUN_TERMINAL.has('stopped')).toBe(true);
    expect(RUN_TERMINAL.has('compensated')).toBe(true);
  });

  it('all terminal states have empty transition sets', () => {
    for (const status of RUN_TERMINAL) {
      // failed can transition to queued/compensating
      if (status === 'failed') continue;
      expect(RUN_TRANSITIONS[status].size).toBe(0);
    }
  });

  it('tryTransitionRun returns correct result for illegal', () => {
    const result = tryTransitionRun('canceled', 'running');
    expect(result.ok).toBe(false);
    expect(result.violation!.entity).toBe('run');
  });
});

describe('State Machine — Collab phase transitions', () => {
  it('planning → executing is legal', () => {
    expect(transitionCollab('planning', 'executing')).toBe('executing');
  });

  it('executing → succeeded is legal', () => {
    expect(transitionCollab('executing', 'succeeded')).toBe('succeeded');
  });

  it('succeeded → executing is ILLEGAL (terminal)', () => {
    expect(() => transitionCollab('succeeded', 'executing')).toThrow();
  });

  it('executing → paused is legal (P1-1.1)', () => {
    expect(transitionCollab('executing', 'paused')).toBe('paused');
  });

  it('COLLAB_TERMINAL contains expected phases', () => {
    expect(COLLAB_TERMINAL.has('succeeded')).toBe(true);
    expect(COLLAB_TERMINAL.has('failed')).toBe(true);
    expect(COLLAB_TERMINAL.has('stopped')).toBe(true);
  });

  it('all terminal phases have empty transition sets', () => {
    for (const phase of COLLAB_TERMINAL) {
      expect(COLLAB_TRANSITIONS[phase].size).toBe(0);
    }
  });
});

describe('State Machine — Agent transitions', () => {
  it('idle → planning is legal', () => {
    expect(transitionAgent('idle', 'planning')).toBe('planning');
  });

  it('planning → thinking is legal', () => {
    expect(transitionAgent('planning', 'thinking')).toBe('thinking');
  });

  it('acting → completed is legal', () => {
    expect(transitionAgent('acting', 'completed')).toBe('completed');
  });

  it('completed → idle is legal (reset)', () => {
    expect(transitionAgent('completed', 'idle')).toBe('idle');
  });

  it('idle → acting is ILLEGAL', () => {
    expect(() => transitionAgent('idle', 'acting')).toThrow();
  });

  it('AGENT_TERMINAL contains completed, failed, timeout', () => {
    expect(AGENT_TERMINAL.has('completed')).toBe(true);
    expect(AGENT_TERMINAL.has('failed')).toBe(true);
    expect(AGENT_TERMINAL.has('timeout')).toBe(true);
    expect(AGENT_TERMINAL.size).toBe(3);
  });

  it('isAgentTerminal works correctly', () => {
    expect(isAgentTerminal('completed')).toBe(true);
    expect(isAgentTerminal('failed')).toBe(true);
    expect(isAgentTerminal('timeout')).toBe(true);
    expect(isAgentTerminal('idle')).toBe(false);
    expect(isAgentTerminal('acting')).toBe(false);
  });

  it('tryTransitionAgent returns ok:false for illegal', () => {
    const result = tryTransitionAgent('idle', 'completed');
    expect(result.ok).toBe(false);
    expect(result.violation!.entity).toBe('agent');
  });

  it('all phases can transition to failed', () => {
    const nonTerminal: AgentPhase[] = ['idle', 'planning', 'thinking', 'deciding', 'acting', 'waiting', 'blocked'];
    for (const phase of nonTerminal) {
      expect(AGENT_TRANSITIONS[phase].has('failed')).toBe(true);
    }
  });
});

describe('State Machine — Normalizers', () => {
  it('normalizeStepStatus handles valid values', () => {
    expect(normalizeStepStatus('pending')).toBe('pending');
    expect(normalizeStepStatus('running')).toBe('running');
    expect(normalizeStepStatus('succeeded')).toBe('succeeded');
  });

  it('normalizeStepStatus maps aliases', () => {
    expect(normalizeStepStatus('created')).toBe('pending');
    expect(normalizeStepStatus('compensating')).toBe('running');
  });

  it('normalizeStepStatus returns null for invalid', () => {
    expect(normalizeStepStatus('bogus')).toBeNull();
    expect(normalizeStepStatus('')).toBeNull();
    expect(normalizeStepStatus(null)).toBeNull();
  });

  it('normalizeRunStatus handles valid values', () => {
    expect(normalizeRunStatus('created')).toBe('created');
    expect(normalizeRunStatus('running')).toBe('running');
  });

  it('normalizeRunStatus returns null for invalid', () => {
    expect(normalizeRunStatus('bogus')).toBeNull();
  });

  it('normalizeCollabPhase handles valid values', () => {
    expect(normalizeCollabPhase('planning')).toBe('planning');
    expect(normalizeCollabPhase('executing')).toBe('executing');
  });

  it('normalizeCollabPhase maps canceled → stopped', () => {
    expect(normalizeCollabPhase('canceled')).toBe('stopped');
  });

  it('normalizeCollabPhase returns null for invalid', () => {
    expect(normalizeCollabPhase('bogus')).toBeNull();
  });
});

describe('State Machine — Orchestration ↔ Agent mapping', () => {
  it('maps orchestration phases to agent phases', () => {
    expect(mapOrchestrationToAgent('idle')).toBe('idle');
    expect(mapOrchestrationToAgent('planning')).toBe('planning');
    expect(mapOrchestrationToAgent('executing')).toBe('acting');
    expect(mapOrchestrationToAgent('reviewing')).toBe('thinking');
    expect(mapOrchestrationToAgent('done')).toBe('completed');
    expect(mapOrchestrationToAgent('failed')).toBe('failed');
  });

  it('defaults unknown orchestration phase to idle', () => {
    expect(mapOrchestrationToAgent('unknown')).toBe('idle');
  });

  it('maps agent phases back to orchestration', () => {
    expect(mapAgentToOrchestration('idle')).toBe('idle');
    expect(mapAgentToOrchestration('planning')).toBe('planning');
    expect(mapAgentToOrchestration('acting')).toBe('executing');
    expect(mapAgentToOrchestration('thinking')).toBe('reviewing');
    expect(mapAgentToOrchestration('completed')).toBe('done');
    expect(mapAgentToOrchestration('failed')).toBe('failed');
    expect(mapAgentToOrchestration('timeout')).toBe('failed');
  });
});

describe('State Machine — Transition table completeness', () => {
  it('every STEP_STATUS has a transition entry', () => {
    for (const status of STEP_STATUSES) {
      expect(STEP_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('every RUN_STATUS has a transition entry', () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('every COLLAB_PHASE has a transition entry', () => {
    for (const phase of COLLAB_PHASES) {
      expect(COLLAB_TRANSITIONS).toHaveProperty(phase);
    }
  });

  it('every AGENT_PHASE has a transition entry', () => {
    for (const phase of AGENT_PHASES) {
      expect(AGENT_TRANSITIONS).toHaveProperty(phase);
    }
  });
});
