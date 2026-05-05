/**
 * Collaboration Message Protocol Conformance Tests
 *
 * Validates message types, envelope validation, consensus logic and config defaults.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  COLLAB_CONFIG_DEFAULTS,
  validateCollabMessage,
  validateConsensusProposal,
  isConsensusReached,
  toolNameFromRef,
  isToolAllowedForPolicy,
  collabMessageRegistry,
  quorumRegistry,
  proposalTopicRegistry,
  verdictOutcomeRegistry,
  correctionTypeRegistry,
  BUILTIN_COLLAB_MESSAGE_TYPES,
  BUILTIN_QUORUM_TYPES,
  BUILTIN_PROPOSAL_TOPICS,
  BUILTIN_VERDICT_OUTCOMES,
  BUILTIN_CORRECTION_TYPES,
} from '../src/collab-message';
import type {
  CollabMessageType,
  CollabMessageEnvelope,
  ConsensusProposal,
} from '../src/collab-message';

describe('Collaboration Message — CollabMessageType completeness', () => {
  const ALL_MESSAGE_TYPES: CollabMessageType[] = [
    // 任务生命周期
    'task.assign', 'task.accept', 'task.reject', 'task.complete', 'task.fail',
    // 步骤生命周期
    'step.start', 'step.progress', 'step.complete', 'step.fail',
    // 共识协议
    'consensus.propose', 'consensus.vote', 'consensus.resolve',
    // 能力发现
    'discovery.query', 'discovery.reply',
    // 状态同步
    'sync.state', 'sync.ack',
    // 辩论协议
    'debate.open', 'debate.position', 'debate.rebuttal', 'debate.verdict',
    'debate.correction', 'debate.consensus_evolution', 'debate.party_join', 'debate.party_leave',
    // 总线运行时
    'agent.result', 'shared_state.update',
    // 智能体通信
    'request', 'response', 'notification', 'broadcast', 'handoff', 'feedback', 'query', 'ack',
    // 运行恢复
    'collab.checkpoint', 'collab.resume', 'collab.heartbeat_timeout',
    // 通用
    'escalate', 'heartbeat',
  ];

  it('defines exactly 39 message types', () => {
    expect(ALL_MESSAGE_TYPES).toHaveLength(39);
  });

  it('all message types compile as CollabMessageType (type safety)', () => {
    // This test ensures that the type union covers all listed values.
    // If any value were not in CollabMessageType, TypeScript would error at compile time.
    const typeCheck: CollabMessageType[] = ALL_MESSAGE_TYPES;
    expect(typeCheck.length).toBe(39);
  });
});

describe('Collaboration Message — COLLAB_CONFIG_DEFAULTS', () => {
  it('contains required configuration keys', () => {
    const requiredKeys = [
      'COLLAB_CONFIDENCE_THRESHOLD',
      'COLLAB_CONSENSUS_THRESHOLD',
      'COLLAB_BUS_MAX_IN_FLIGHT',
      'COLLAB_BUS_RESUME_THRESHOLD',
      'COLLAB_BUS_POLL_MS',
      'COLLAB_AUTO_DEBATE_MAX_ROUNDS',
      'COLLAB_AUTO_DEBATE_MAX_PARTIES',
      'DEBATE_MAX_ROUNDS',
      'DEBATE_CONVERGENCE_THRESHOLD',
      'DEBATE_MIN_CONFIDENCE',
      'DEBATE_SCORE_DECAY',
      'DEBATE_MIN_PARTIES',
      'DEBATE_MAX_PARTIES',
    ];
    for (const key of requiredKeys) {
      expect(COLLAB_CONFIG_DEFAULTS).toHaveProperty(key);
      expect(typeof COLLAB_CONFIG_DEFAULTS[key]).toBe('number');
    }
  });

  it('all values are numbers', () => {
    for (const [key, value] of Object.entries(COLLAB_CONFIG_DEFAULTS)) {
      expect(typeof value).toBe('number');
    }
  });
});

describe('Collaboration Message — validateCollabMessage', () => {
  const validMsg = {
    messageId: 'msg-001',
    collabRunId: 'run-001',
    tenantId: 'tenant-001',
    fromRole: 'planner',
    toRole: null,
    messageType: 'task.assign',
    payload: {},
    sentAt: '2025-01-01T00:00:00.000Z',
    version: '1.0.0',
  };

  it('accepts valid message envelope', () => {
    expect(validateCollabMessage(validMsg)).toEqual({ ok: true });
  });

  it('rejects null', () => {
    expect(validateCollabMessage(null).ok).toBe(false);
  });

  it('rejects missing messageId', () => {
    const { messageId, ...rest } = validMsg;
    expect(validateCollabMessage(rest).ok).toBe(false);
    expect(validateCollabMessage(rest).error).toContain('messageId');
  });

  it('rejects missing messageType', () => {
    const { messageType, ...rest } = validMsg;
    expect(validateCollabMessage(rest).ok).toBe(false);
  });

  it('rejects missing collabRunId', () => {
    const { collabRunId, ...rest } = validMsg;
    expect(validateCollabMessage(rest).ok).toBe(false);
  });

  it('rejects missing tenantId', () => {
    const { tenantId, ...rest } = validMsg;
    expect(validateCollabMessage(rest).ok).toBe(false);
  });

  it('rejects missing fromRole', () => {
    const { fromRole, ...rest } = validMsg;
    expect(validateCollabMessage(rest).ok).toBe(false);
  });

  it('rejects missing version', () => {
    const { version, ...rest } = validMsg;
    expect(validateCollabMessage(rest).ok).toBe(false);
  });
});

describe('Collaboration Message — validateConsensusProposal', () => {
  const validProposal = {
    proposalId: 'prop-001',
    collabRunId: 'run-001',
    proposedBy: 'planner',
    topic: 'replan',
    content: {},
    voters: ['executor', 'reviewer'],
    deadline: '2025-12-31T23:59:59Z',
    quorum: 'majority',
    votes: [],
    status: 'pending',
    createdAt: '2025-01-01T00:00:00Z',
  };

  it('accepts valid proposal', () => {
    expect(validateConsensusProposal(validProposal).ok).toBe(true);
  });

  it('rejects missing proposalId', () => {
    const { proposalId, ...rest } = validProposal;
    expect(validateConsensusProposal(rest).ok).toBe(false);
  });

  it('rejects empty voters', () => {
    expect(validateConsensusProposal({ ...validProposal, voters: [] }).ok).toBe(false);
  });

  it('rejects invalid quorum type', () => {
    expect(validateConsensusProposal({ ...validProposal, quorum: 'invalid' }).ok).toBe(false);
  });
});

describe('Collaboration Message — isConsensusReached', () => {
  function makeProposal(overrides: Partial<ConsensusProposal>): ConsensusProposal {
    return {
      proposalId: 'p1',
      collabRunId: 'r1',
      proposedBy: 'planner',
      topic: 'replan',
      content: {},
      voters: ['a', 'b', 'c'],
      deadline: new Date(Date.now() + 60000).toISOString(),
      quorum: 'majority',
      votes: [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('majority: reached with >50% approve', () => {
    const proposal = makeProposal({
      quorum: 'majority',
      votes: [
        { voterId: 'a', voterRole: 'a', decision: 'approve', votedAt: '' },
        { voterId: 'b', voterRole: 'b', decision: 'approve', votedAt: '' },
      ],
    });
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it('majority: not reached with <=50%', () => {
    const proposal = makeProposal({
      quorum: 'majority',
      votes: [
        { voterId: 'a', voterRole: 'a', decision: 'approve', votedAt: '' },
        { voterId: 'b', voterRole: 'b', decision: 'reject', votedAt: '' },
      ],
    });
    expect(isConsensusReached(proposal)).toBe(false);
  });

  it('unanimous: requires all voters to approve', () => {
    const proposal = makeProposal({
      quorum: 'unanimous',
      votes: [
        { voterId: 'a', voterRole: 'a', decision: 'approve', votedAt: '' },
        { voterId: 'b', voterRole: 'b', decision: 'approve', votedAt: '' },
        { voterId: 'c', voterRole: 'c', decision: 'approve', votedAt: '' },
      ],
    });
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it('any: one approve is enough', () => {
    const proposal = makeProposal({
      quorum: 'any',
      votes: [{ voterId: 'a', voterRole: 'a', decision: 'approve', votedAt: '' }],
    });
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it('expired deadline returns false', () => {
    const proposal = makeProposal({
      deadline: '2020-01-01T00:00:00Z',
      quorum: 'any',
      votes: [{ voterId: 'a', voterRole: 'a', decision: 'approve', votedAt: '' }],
    });
    expect(isConsensusReached(proposal)).toBe(false);
  });

  it('supermajority: requires >=2/3', () => {
    const proposal = makeProposal({
      quorum: 'supermajority',
      voters: ['a', 'b', 'c'],
      votes: [
        { voterId: 'a', voterRole: 'a', decision: 'approve', votedAt: '' },
        { voterId: 'b', voterRole: 'b', decision: 'approve', votedAt: '' },
      ],
    });
    expect(isConsensusReached(proposal)).toBe(true);
  });
});

describe('Collaboration Message — toolNameFromRef', () => {
  it('extracts tool name from ref with @version', () => {
    expect(toolNameFromRef('echo@1.0.0')).toBe('echo');
  });

  it('returns full string if no @ sign', () => {
    expect(toolNameFromRef('echo')).toBe('echo');
  });

  it('returns empty for empty input', () => {
    expect(toolNameFromRef('')).toBe('');
  });
});

describe('Collaboration Message — isToolAllowedForPolicy', () => {
  it('returns true when allowedTools is null/undefined', () => {
    expect(isToolAllowedForPolicy(null, 'echo@1.0.0')).toBe(true);
    expect(isToolAllowedForPolicy(undefined, 'echo@1.0.0')).toBe(true);
  });

  it('returns true when allowedTools is empty array', () => {
    expect(isToolAllowedForPolicy([], 'echo@1.0.0')).toBe(true);
  });

  it('returns true when tool is in allowed list', () => {
    expect(isToolAllowedForPolicy(['echo@1.0.0'], 'echo@1.0.0')).toBe(true);
  });

  it('matches by tool name ignoring version', () => {
    expect(isToolAllowedForPolicy(['echo@2.0.0'], 'echo@1.0.0')).toBe(true);
  });

  it('returns false when tool not allowed', () => {
    expect(isToolAllowedForPolicy(['math@1.0.0'], 'echo@1.0.0')).toBe(false);
  });

  it('returns false for empty toolRef', () => {
    expect(isToolAllowedForPolicy(['echo'], '')).toBe(false);
  });
});

/* ================================================================== */
/*  Registry CRUD Tests                                                */
/* ================================================================== */

describe('Collaboration Message — collabMessageRegistry CRUD', () => {
  afterEach(() => { collabMessageRegistry.reset(); });

  it('has all builtin message types registered', () => {
    for (const entry of BUILTIN_COLLAB_MESSAGE_TYPES) {
      expect(collabMessageRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register new custom message type', () => {
    collabMessageRegistry.register({ id: 'custom.event', category: 'collab.custom', builtIn: false });
    expect(collabMessageRegistry.has('custom.event')).toBe(true);
  });

  it('get returns registered entry', () => {
    const entry = collabMessageRegistry.get('task.assign');
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('collab.task');
  });

  it('list returns all entries', () => {
    const all = collabMessageRegistry.list();
    expect(all.length).toBeGreaterThanOrEqual(BUILTIN_COLLAB_MESSAGE_TYPES.length);
  });

  it('unregister custom entry succeeds', () => {
    collabMessageRegistry.register({ id: 'temp.type', category: 'collab.temp', builtIn: false });
    expect(collabMessageRegistry.unregister('temp.type')).toBe(true);
    expect(collabMessageRegistry.has('temp.type')).toBe(false);
  });

  it('unregister builtIn entry fails', () => {
    expect(collabMessageRegistry.unregister('task.assign')).toBe(false);
    expect(collabMessageRegistry.has('task.assign')).toBe(true);
  });

  it('reset restores to initial state', () => {
    collabMessageRegistry.register({ id: 'custom.x', category: 'test', builtIn: false });
    collabMessageRegistry.reset();
    expect(collabMessageRegistry.has('custom.x')).toBe(false);
    expect(collabMessageRegistry.has('task.assign')).toBe(true);
  });
});

describe('Collaboration Message — quorumRegistry CRUD', () => {
  afterEach(() => { quorumRegistry.reset(); });

  it('has all builtin quorum types', () => {
    for (const entry of BUILTIN_QUORUM_TYPES) {
      expect(quorumRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom quorum type', () => {
    quorumRegistry.register({ id: 'custom_quorum', category: 'consensus.quorum', builtIn: false });
    expect(quorumRegistry.has('custom_quorum')).toBe(true);
  });

  it('unregister builtIn quorum fails', () => {
    expect(quorumRegistry.unregister('majority')).toBe(false);
  });

  it('reset restores initial state', () => {
    quorumRegistry.register({ id: 'temp_q', category: 'consensus.quorum', builtIn: false });
    quorumRegistry.reset();
    expect(quorumRegistry.has('temp_q')).toBe(false);
    expect(quorumRegistry.has('majority')).toBe(true);
  });
});

describe('Collaboration Message — proposalTopicRegistry CRUD', () => {
  afterEach(() => { proposalTopicRegistry.reset(); });

  it('has all builtin proposal topics', () => {
    for (const entry of BUILTIN_PROPOSAL_TOPICS) {
      expect(proposalTopicRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom topic', () => {
    proposalTopicRegistry.register({ id: 'custom_topic', category: 'consensus.topic', builtIn: false });
    expect(proposalTopicRegistry.has('custom_topic')).toBe(true);
  });

  it('unregister builtIn topic fails', () => {
    expect(proposalTopicRegistry.unregister('replan')).toBe(false);
  });
});

describe('Collaboration Message — verdictOutcomeRegistry CRUD', () => {
  afterEach(() => { verdictOutcomeRegistry.reset(); });

  it('has all builtin verdict outcomes', () => {
    for (const entry of BUILTIN_VERDICT_OUTCOMES) {
      expect(verdictOutcomeRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom outcome', () => {
    verdictOutcomeRegistry.register({ id: 'custom_outcome', category: 'debate.outcome', builtIn: false });
    expect(verdictOutcomeRegistry.has('custom_outcome')).toBe(true);
  });

  it('unregister builtIn outcome fails', () => {
    expect(verdictOutcomeRegistry.unregister('synthesis')).toBe(false);
  });
});

describe('Collaboration Message — correctionTypeRegistry CRUD', () => {
  afterEach(() => { correctionTypeRegistry.reset(); });

  it('has all builtin correction types', () => {
    for (const entry of BUILTIN_CORRECTION_TYPES) {
      expect(correctionTypeRegistry.has(entry.id)).toBe(true);
    }
  });

  it('register custom correction type', () => {
    correctionTypeRegistry.register({ id: 'custom_correction', category: 'debate.correction', builtIn: false });
    expect(correctionTypeRegistry.has('custom_correction')).toBe(true);
  });

  it('unregister builtIn correction type fails', () => {
    expect(correctionTypeRegistry.unregister('factual_error')).toBe(false);
  });
});
