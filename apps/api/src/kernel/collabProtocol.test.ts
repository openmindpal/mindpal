/**
 * P1-4 验证：多智能体协作协议 — 消息验证、共识投票、CollabBus
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ================================================================== */
/*  CollabProtocol 验证函数                                             */
/* ================================================================== */

import {
  validateCollabMessage,
  validateConsensusProposal,
  isConsensusReached,
  createDebateSession,
  isDebateConverged,
  type CollabMessage,
  type ConsensusProposal,
  type DebateSession,
  type DebatePosition,
  type DebateRound,
} from "@openslin/shared";

describe("validateCollabMessage", () => {
  it("合法消息通过验证", () => {
    const msg: CollabMessage = {
      messageId: "m-1",
      messageType: "task.assign",
      collabRunId: "cr-1",
      tenantId: "tenant-001",
      fromRole: "planner",
      toRole: "executor",
      payload: { task: "分析数据" },
      sentAt: new Date().toISOString(),
      version: "1.0.0",
    };
    const result = validateCollabMessage(msg);
    expect(result.ok).toBe(true);
  });

  it("缺少必要字段时失败", () => {
    const result = validateCollabMessage({ messageId: "m-1" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("null 输入失败", () => {
    const result = validateCollabMessage(null);
    expect(result.ok).toBe(false);
  });
});

describe("validateConsensusProposal", () => {
  it("合法提案通过验证", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-1",
      collabRunId: "cr-1",
      proposedBy: "agent_1",
      topic: "replan",
      content: { reason: "环境变化" },
      voters: ["agent_1", "agent_2"],
      votes: [],
      quorum: "majority",
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const result = validateConsensusProposal(proposal);
    expect(result.ok).toBe(true);
  });

  it("无效输入失败", () => {
    const result = validateConsensusProposal("not_an_object");
    expect(result.ok).toBe(false);
  });
});

describe("isConsensusReached", () => {
  it("approve 投票数达到 quorum 时共识达成", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-1",
      collabRunId: "cr-1",
      proposedBy: "agent_1",
      topic: "abort",
      content: {},
      voters: ["a1", "a2"],
      votes: [
        { voterId: "a1", voterRole: "executor", decision: "approve", reason: "同意", votedAt: "" },
        { voterId: "a2", voterRole: "reviewer", decision: "approve", reason: "同意", votedAt: "" },
      ],
      quorum: "majority",
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it("投票不足时共识未达成", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-1",
      collabRunId: "cr-1",
      proposedBy: "agent_1",
      topic: "replan",
      content: {},
      voters: ["a1", "a2", "a3"],
      votes: [
        { voterId: "a1", voterRole: "exec", decision: "approve", reason: "", votedAt: "" },
      ],
      quorum: "unanimous",
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    expect(isConsensusReached(proposal)).toBe(false);
  });

  it("reject 投票不计入 quorum", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-1",
      collabRunId: "cr-1",
      proposedBy: "agent_1",
      topic: "escalate",
      content: {},
      voters: ["a1", "a2", "a3"],
      votes: [
        { voterId: "a1", voterRole: "exec", decision: "approve", reason: "", votedAt: "" },
        { voterId: "a2", voterRole: "exec", decision: "reject", reason: "反对", votedAt: "" },
        { voterId: "a3", voterRole: "exec", decision: "approve", reason: "", votedAt: "" },
      ],
      quorum: "unanimous",
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    expect(isConsensusReached(proposal)).toBe(false);
  });

  // P1-3: 新共识算法测试
  it("supermajority: 2/3+ 同意时通过", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-super",
      collabRunId: "cr-1",
      proposedBy: "a1",
      topic: "replan",
      content: {},
      voters: ["a1", "a2", "a3"],
      votes: [
        { voterId: "a1", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a2", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a3", voterRole: "exec", decision: "reject", votedAt: "" },
      ],
      quorum: "supermajority",
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it("supermajority: 不足2/3时不通过", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-super-fail",
      collabRunId: "cr-1",
      proposedBy: "a1",
      topic: "replan",
      content: {},
      voters: ["a1", "a2", "a3", "a4"],
      votes: [
        { voterId: "a1", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a2", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a3", voterRole: "exec", decision: "reject", votedAt: "" },
        { voterId: "a4", voterRole: "exec", decision: "reject", votedAt: "" },
      ],
      quorum: "supermajority",
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    // 2/4 = 50% < 2/3, 不通过
    expect(isConsensusReached(proposal)).toBe(false);
  });

  it("weighted_majority: 权重高的角色同意即胜出", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-weighted",
      collabRunId: "cr-1",
      proposedBy: "a1",
      topic: "resource_allocation",
      content: {},
      voters: ["senior", "junior1", "junior2"],
      votes: [
        { voterId: "s1", voterRole: "senior", decision: "approve", votedAt: "" },
        { voterId: "j1", voterRole: "junior1", decision: "reject", votedAt: "" },
        { voterId: "j2", voterRole: "junior2", decision: "reject", votedAt: "" },
      ],
      quorum: "weighted_majority",
      voterWeights: { senior: 3.0, junior1: 1.0, junior2: 1.0 },
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    // senior权重3.0 > (3+1+1)/2=2.5, 通过
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it("weighted_majority: 权重不足时不通过", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-weighted-fail",
      collabRunId: "cr-1",
      proposedBy: "a1",
      topic: "resource_allocation",
      content: {},
      voters: ["senior", "junior1", "junior2"],
      votes: [
        { voterId: "s1", voterRole: "senior", decision: "reject", votedAt: "" },
        { voterId: "j1", voterRole: "junior1", decision: "approve", votedAt: "" },
        { voterId: "j2", voterRole: "junior2", decision: "approve", votedAt: "" },
      ],
      quorum: "weighted_majority",
      voterWeights: { senior: 3.0, junior1: 1.0, junior2: 1.0 },
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    // junior1+junior2权重2.0 < 2.5, 不通过
    expect(isConsensusReached(proposal)).toBe(false);
  });

  it("bft: 4个节点容忍1个拜占庭故障 (f=1, 需要2f+1=3票)", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-bft",
      collabRunId: "cr-1",
      proposedBy: "a1",
      topic: "abort",
      content: {},
      voters: ["a1", "a2", "a3", "a4"],
      votes: [
        { voterId: "a1", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a2", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a3", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a4", voterRole: "exec", decision: "reject", votedAt: "" },
      ],
      quorum: "bft",
      faultTolerance: 1,
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    // 3 >= 2*1+1=3, 通过
    expect(isConsensusReached(proposal)).toBe(true);
  });

  it("bft: 投票不足2f+1时不通过", () => {
    const proposal: ConsensusProposal = {
      proposalId: "p-bft-fail",
      collabRunId: "cr-1",
      proposedBy: "a1",
      topic: "abort",
      content: {},
      voters: ["a1", "a2", "a3", "a4"],
      votes: [
        { voterId: "a1", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a2", voterRole: "exec", decision: "approve", votedAt: "" },
        { voterId: "a3", voterRole: "exec", decision: "reject", votedAt: "" },
        { voterId: "a4", voterRole: "exec", decision: "reject", votedAt: "" },
      ],
      quorum: "bft",
      faultTolerance: 1,
      deadline: new Date().toISOString(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    // 2 < 3, 不通过
    expect(isConsensusReached(proposal)).toBe(false);
  });
});

/* ================================================================== */
/*  Debate Protocol — Layer 5                                          */
/* ================================================================== */

describe("createDebateSession", () => {
  it("创建初始辩论会话", () => {
    const session = createDebateSession({
      debateId: "d-1",
      collabRunId: "cr-1",
      topic: "应该用 React 还是 Vue",
      parties: [
        { partyId: "side_a", role: "architect", stance: "pro" },
        { partyId: "side_b", role: "frontend_lead", stance: "con" },
      ],
      arbiter: "tech_director",
    });
    expect(session.debateId).toBe("d-1");
    expect(session.sideA).toBe("architect");
    expect(session.sideB).toBe("frontend_lead");
    expect(session.arbiter).toBe("tech_director");
    expect(session.status).toBe("in_progress");
    expect(session.rounds).toHaveLength(0);
    expect(session.maxRounds).toBeGreaterThanOrEqual(1);
  });

  it("支持自定义最大轮次", () => {
    const session = createDebateSession({
      debateId: "d-2",
      collabRunId: "cr-2",
      topic: "test",
      parties: [
        { partyId: "side_a", role: "a", stance: "pro" },
        { partyId: "side_b", role: "b", stance: "con" },
      ],
      arbiter: "c",
      maxRounds: 5,
    });
    expect(session.maxRounds).toBe(5);
  });
});

describe("isDebateConverged", () => {
  const makeSession = (rounds: DebateRound[]): DebateSession => ({
    debateId: "d-test",
    collabRunId: "cr-test",
    topic: "test",
    sideA: "a",
    sideB: "b",
    arbiter: "c",
    maxRounds: 3,
    rounds,
    status: "in_progress",
    createdAt: new Date().toISOString(),
  });

  const makePosition = (role: string, confidence: number): DebatePosition => ({
    debateId: "d-test",
    round: 0,
    fromRole: role,
    claim: "test claim",
    reasoning: "test reasoning",
    evidence: [],
    confidence,
    submittedAt: new Date().toISOString(),
  });

  it("无轮次时未收敛", () => {
    expect(isDebateConverged(makeSession([]))).toBe(false);
  });

  it("最近一轮有分歧时未收敛", () => {
    const session = makeSession([{
      round: 0,
      positions: [makePosition("a", 0.9), makePosition("b", 0.9)],
      divergenceDetected: true,
    }]);
    expect(isDebateConverged(session)).toBe(false);
  });

  it("双方置信度低于阈值时未收敛", () => {
    const session = makeSession([{
      round: 0,
      positions: [makePosition("a", 0.5), makePosition("b", 0.9)],
      divergenceDetected: false,
    }]);
    expect(isDebateConverged(session)).toBe(false);
  });

  it("双方置信度达标且无分歧时收敛", () => {
    const session = makeSession([{
      round: 1,
      positions: [makePosition("a", 0.85), makePosition("b", 0.9)],
      divergenceDetected: false,
    }]);
    expect(isDebateConverged(session)).toBe(true);
  });

  it("自定义置信度阈值", () => {
    const session = makeSession([{
      round: 0,
      positions: [makePosition("a", 0.6), makePosition("b", 0.6)],
      divergenceDetected: false,
    }]);
    // 默认 0.7 阈值下未收敛
    expect(isDebateConverged(session)).toBe(false);
    // 降低阈值后收敛
    expect(isDebateConverged(session, 0.5)).toBe(true);
  });
});

/* ================================================================== */
/*  Debate Protocol — 辩论轮次推进深度测试                              */
/* ================================================================== */

describe("Debate Round Progression（辩论轮次推进）", () => {
  const makePosition = (role: string, confidence: number, claim = "test claim", rebuttalTo?: string): DebatePosition => ({
    debateId: "d-rp",
    round: 0,
    fromRole: role,
    claim,
    reasoning: "test reasoning",
    evidence: ["evidence-1"],
    confidence,
    rebuttalTo,
    submittedAt: new Date().toISOString(),
  });

  const makeRound = (round: number, confA: number, confB: number, divergence: boolean): DebateRound => ({
    round,
    positions: [
      { ...makePosition("architect", confA, `R${round} claim A`), round },
      { ...makePosition("frontend_lead", confB, `R${round} claim B`), round },
    ],
    divergenceDetected: divergence,
  });

  it("多轮辩论：3 轮均有分歧时始终未收敛", () => {
    const session = createDebateSession({
      debateId: "d-multi-diverge",
      collabRunId: "cr-1",
      topic: "React vs Vue",
      parties: [
        { partyId: "side_a", role: "architect", stance: "pro" },
        { partyId: "side_b", role: "frontend_lead", stance: "con" },
      ],
      arbiter: "tech_director",
      maxRounds: 3,
    });

    // 模拟 3 轮辩论，每轮均有分歧
    for (let i = 0; i < 3; i++) {
      session.rounds.push(makeRound(i, 0.7, 0.6, true));
      expect(isDebateConverged(session)).toBe(false);
    }
    expect(session.rounds).toHaveLength(3);
  });

  it("多轮辩论：第 2 轮收敛（双方置信度升至 0.85+，无分歧）", () => {
    const session = createDebateSession({
      debateId: "d-converge-r2",
      collabRunId: "cr-2",
      topic: "技术选型",
      parties: [
        { partyId: "side_a", role: "a", stance: "pro" },
        { partyId: "side_b", role: "b", stance: "con" },
      ],
      arbiter: "c",
      maxRounds: 5,
    });

    // Round 0: 分歧
    session.rounds.push(makeRound(0, 0.6, 0.5, true));
    expect(isDebateConverged(session)).toBe(false);

    // Round 1: 置信度上升但仍有分歧
    session.rounds.push(makeRound(1, 0.8, 0.75, true));
    expect(isDebateConverged(session)).toBe(false);

    // Round 2: 收敛 — 双方高置信度 + 无分歧
    session.rounds.push(makeRound(2, 0.9, 0.88, false));
    expect(isDebateConverged(session)).toBe(true);
  });

  it("置信度单方达标但有分歧 → 未收敛", () => {
    const session = createDebateSession({
      debateId: "d-one-side",
      collabRunId: "cr-3",
      topic: "test",
      parties: [{ partyId: "side_a", role: "a", stance: "pro" }, { partyId: "side_b", role: "b", stance: "con" }],
      arbiter: "c",
    });
    session.rounds.push(makeRound(0, 0.95, 0.95, true));
    expect(isDebateConverged(session)).toBe(false);
  });

  it("仅检查最新一轮（历史轮次有分歧不影响收敛判定）", () => {
    const session = createDebateSession({
      debateId: "d-latest-only",
      collabRunId: "cr-4",
      topic: "test",
      parties: [{ partyId: "side_a", role: "a", stance: "pro" }, { partyId: "side_b", role: "b", stance: "con" }],
      arbiter: "c",
    });
    // Round 0: 强分歧
    session.rounds.push(makeRound(0, 0.3, 0.4, true));
    // Round 1: 收敛
    session.rounds.push(makeRound(1, 0.85, 0.9, false));
    // isDebateConverged 只看最后一轮
    expect(isDebateConverged(session)).toBe(true);
  });

  it("单个 position 置信度恰好等于阈值", () => {
    const session = createDebateSession({
      debateId: "d-boundary",
      collabRunId: "cr-5",
      topic: "test",
      parties: [{ partyId: "side_a", role: "a", stance: "pro" }, { partyId: "side_b", role: "b", stance: "con" }],
      arbiter: "c",
    });
    // 默认阈值 0.7，两方恰好 0.7
    session.rounds.push(makeRound(0, 0.7, 0.7, false));
    expect(isDebateConverged(session)).toBe(true);

    // 一方低于阈值
    session.rounds.push(makeRound(1, 0.69, 0.7, false));
    expect(isDebateConverged(session)).toBe(false);
  });

  it("DebateSession 状态流转模拟", () => {
    const session = createDebateSession({
      debateId: "d-flow",
      collabRunId: "cr-flow",
      topic: "状态流转测试",
      parties: [{ partyId: "side_a", role: "a", stance: "pro" }, { partyId: "side_b", role: "b", stance: "con" }],
      arbiter: "c",
      maxRounds: 3,
    });

    expect(session.status).toBe("in_progress");

    // 模拟 maxRounds 耗尽
    for (let i = 0; i < 3; i++) {
      session.rounds.push(makeRound(i, 0.5, 0.5, true));
    }
    // 手动检查：轮次用完且未收敛
    if (session.rounds.length >= session.maxRounds && !isDebateConverged(session)) {
      session.status = "max_rounds_reached";
    }
    expect(session.status).toBe("max_rounds_reached");

    // 仲裁后变为 verdicted
    session.verdict = {
      debateId: session.debateId,
      arbiterRole: "c",
      outcome: "synthesis",
      reasoning: "双方各有道理",
      synthesizedConclusion: "综合方案",
      roundScores: [{ round: 0, sideAScore: 0.6, sideBScore: 0.5 }],
      decidedAt: new Date().toISOString(),
    };
    session.status = "verdicted";
    expect(session.status).toBe("verdicted");
    expect(session.verdict.outcome).toBe("synthesis");
  });

  it("辩论中止（aborted）状态", () => {
    const session = createDebateSession({
      debateId: "d-abort",
      collabRunId: "cr-abort",
      topic: "abort test",
      parties: [{ partyId: "side_a", role: "a", stance: "pro" }, { partyId: "side_b", role: "b", stance: "con" }],
      arbiter: "c",
    });

    session.status = "aborted";
    // 中止后不应有 verdict
    expect(session.verdict).toBeUndefined();
    expect(session.status).toBe("aborted");
  });

  it("立场包含反驳引用（round > 0）", () => {
    const posA = makePosition("a", 0.8, "A 的论点");
    const posB = makePosition("b", 0.7, "B 反驳 A", "A 的论点");

    expect(posB.rebuttalTo).toBe("A 的论点");
    expect(posA.rebuttalTo).toBeUndefined();
  });
});

/* ================================================================== */
/*  CollabBus — 消息发布/订阅                                           */
/* ================================================================== */

import { publishCollabMessage, publishAgentResult, publishSharedStateUpdate, getCollabBus, closeCollabBus } from "./collabBus";

type TurnOutcome = "continue" | "retry" | "rollback" | "replan" | "escalate" | "complete" | "abort";

function requiresConsensus(params: { turnOutcome: TurnOutcome; participantRoles: string[] }): boolean {
  const criticalOutcomes: TurnOutcome[] = ["replan", "abort", "escalate"];
  return criticalOutcomes.includes(params.turnOutcome) && params.participantRoles.length >= 2;
}

/* ================================================================== */
/*  Consensus Runtime — 共识门控决策                                     */
/* ================================================================== */

describe("requiresConsensus", () => {
  it("replan + 2+ 角色时需要共识", () => {
    expect(requiresConsensus({ turnOutcome: "replan", participantRoles: ["agent_1", "agent_2"] })).toBe(true);
  });

  it("abort + 2+ 角色时需要共识", () => {
    expect(requiresConsensus({ turnOutcome: "abort", participantRoles: ["a", "b", "c"] })).toBe(true);
  });

  it("escalate + 2+ 角色时需要共识", () => {
    expect(requiresConsensus({ turnOutcome: "escalate", participantRoles: ["x", "y"] })).toBe(true);
  });

  it("continue 不需要共识", () => {
    expect(requiresConsensus({ turnOutcome: "continue", participantRoles: ["a", "b"] })).toBe(false);
  });

  it("retry 不需要共识", () => {
    expect(requiresConsensus({ turnOutcome: "retry", participantRoles: ["a", "b"] })).toBe(false);
  });

  it("单角色不需要共识（即使是 replan）", () => {
    expect(requiresConsensus({ turnOutcome: "replan", participantRoles: ["solo"] })).toBe(false);
  });

  it("空角色列表不需要共识", () => {
    expect(requiresConsensus({ turnOutcome: "abort", participantRoles: [] })).toBe(false);
  });
});

describe("publishCollabMessage", () => {
  let mockPool: any;
  let mockRedis: any;

  beforeEach(() => {
    mockPool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    mockRedis = { publish: vi.fn(async () => 1) };
    // 初始化全局 CollabBus 实例
    getCollabBus({ pool: mockPool, redis: mockRedis });
  });

  afterEach(async () => {
    await closeCollabBus();
  });

  it("通过全局 CollabBus 实例发布消息", async () => {
    await publishCollabMessage({
      pool: mockPool,
      redis: mockRedis,
      message: {
        collabRunId: "cr-1",
        tenantId: "t1",
        fromAgent: "agent_1",
        fromRole: "planner",
        toRole: "executor",
        kind: "task.assign",
        payload: { task: "test" },
        timestamp: Date.now(),
      },
    });

    // DB 持久化被调用（通过全局实例的 Layer 3）
    expect(mockPool.query).toHaveBeenCalled();
  });

  it("全局实例未初始化时抛错", async () => {
    await closeCollabBus();
    await expect(
      publishCollabMessage({
        pool: mockPool,
        redis: undefined,
        message: {
          collabRunId: "cr-1",
          tenantId: "t1",
          fromAgent: "agent_2",
          fromRole: "executor",
          toRole: null,
          kind: "task.complete",
          payload: { result: "done" },
          timestamp: Date.now(),
        },
      }),
    ).rejects.toThrow("CollabBus global instance not initialized");
  });
});

describe("publishAgentResult", () => {
  let mockPool: any;
  let mockRedis: any;

  beforeEach(() => {
    mockPool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    mockRedis = { publish: vi.fn(async () => 1) };
    getCollabBus({ pool: mockPool, redis: mockRedis });
  });

  afterEach(async () => {
    await closeCollabBus();
  });

  it("发布 Agent 结果并持久化", async () => {
    await publishAgentResult({
      pool: mockPool,
      redis: mockRedis,
      tenantId: "t1",
      spaceId: "s1",
      collabRunId: "cr-1",
      taskId: "task-1",
      fromAgent: "agent_1",
      fromRole: "researcher",
      result: { ok: true, endReason: "done" },
      runId: "run-1",
    });

    expect(mockPool.query).toHaveBeenCalled();
  });
});

describe("publishSharedStateUpdate", () => {
  let mockPool: any;
  let mockRedis: any;

  beforeEach(() => {
    mockPool = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) };
    mockRedis = { publish: vi.fn(async () => 1) };
    getCollabBus({ pool: mockPool, redis: mockRedis });
  });

  afterEach(async () => {
    await closeCollabBus();
  });

  it("发布共享状态更新", async () => {
    await publishSharedStateUpdate({
      pool: mockPool,
      redis: mockRedis,
      tenantId: "t1",
      collabRunId: "cr-1",
      key: "shared_progress",
      version: 2,
      updatedByAgent: "agent_1",
      updatedByRole: "executor",
    });

    expect(mockPool.query).toHaveBeenCalled();
  });
});
