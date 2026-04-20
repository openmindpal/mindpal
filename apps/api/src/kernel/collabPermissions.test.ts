import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  insertAuditEvent,
  upsertCollabSharedState,
  queryRolePerformanceHistory,
  isConsensusReachedMock,
} = vi.hoisted(() => ({
  insertAuditEvent: vi.fn(async () => {}),
  upsertCollabSharedState: vi.fn(async () => {}),
  queryRolePerformanceHistory: vi.fn(async () => []),
  isConsensusReachedMock: vi.fn(),
}));

vi.mock("../modules/audit/auditRepo", () => ({
  insertAuditEvent,
}));

vi.mock("./collabEnvelope", () => ({
  upsertCollabSharedState,
}));

vi.mock("./collabValidation", () => ({
  queryRolePerformanceHistory,
}));

vi.mock("@openslin/shared", async (importOriginal) => {
  const original = await importOriginal<typeof import("@openslin/shared")>();
  return {
    ...original,
    isConsensusReached: isConsensusReachedMock,
    StructuredLogger: class {
      info() {}
      warn() {}
      error() {}
    },
  };
});

import {
  persistRolePermissions,
  checkAgentToolPermission,
  delegatePermissions,
  revokePermissionDelegation,
  arbitrateCollabConflict,
  runConsensusRound,
} from "./collabPermissions";

/* ================================================================== */
/*  persistRolePermissions                                             */
/* ================================================================== */

describe("persistRolePermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("基础写入：正确插入多个 Agent 的权限记录", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    } as any;

    await persistRolePermissions({
      pool,
      tenantId: "t1",
      collabRunId: "cr-1",
      agents: [
        { agentId: "a1", role: "researcher", goal: "研究", dependencies: [], allowedTools: ["search"], maxBudget: 10 },
        { agentId: "a2", role: "writer", goal: "写作", dependencies: [], allowedTools: ["edit"], maxBudget: 5 },
      ],
    });

    expect(pool.query).toHaveBeenCalledTimes(2);
    // 验证第一条 INSERT
    const firstCall = pool.query.mock.calls[0]!;
    expect(firstCall[0]).toContain("INSERT INTO collab_role_permissions");
    expect(firstCall[1]).toEqual(["t1", "cr-1", "a1", "researcher", ["search"], null, 10]);
    // 验证第二条
    const secondCall = pool.query.mock.calls[1]!;
    expect(secondCall[1]![2]).toBe("a2");
  });
});

/* ================================================================== */
/*  checkAgentToolPermission                                           */
/* ================================================================== */

describe("checkAgentToolPermission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("工具允许：工具在白名单中返回 allowed=true", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ allowed_tools: ["search", "edit"], max_budget: 10, used_budget: 2, expires_at: null }],
      })),
    } as any;

    const result = await checkAgentToolPermission({
      pool, tenantId: "t1", collabRunId: "cr-1", agentId: "a1", toolName: "search",
    });
    expect(result.allowed).toBe(true);
  });

  it("工具拒绝：工具不在白名单返回 allowed=false, reason", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ allowed_tools: ["search"], max_budget: 10, used_budget: 2, expires_at: null }],
      })),
    } as any;

    const result = await checkAgentToolPermission({
      pool, tenantId: "t1", collabRunId: "cr-1", agentId: "a1", toolName: "delete",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("delete");
  });

  it("无限制工具：allowed_tools 为 null 时允许所有工具", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ allowed_tools: null, max_budget: null, used_budget: 0, expires_at: null }],
      })),
    } as any;

    const result = await checkAgentToolPermission({
      pool, tenantId: "t1", collabRunId: "cr-1", agentId: "a1", toolName: "any_tool",
    });
    expect(result.allowed).toBe(true);
  });

  it("预算超限：used_budget >= max_budget 时拒绝", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ allowed_tools: null, max_budget: 5, used_budget: 5, expires_at: null }],
      })),
    } as any;

    const result = await checkAgentToolPermission({
      pool, tenantId: "t1", collabRunId: "cr-1", agentId: "a1", toolName: "search",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("预算");
  });

  it("过期权限：expires_at 已过期时返回 allowed=false, reason='permission_delegation_expired'", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ allowed_tools: null, max_budget: null, used_budget: 0, expires_at: "2020-01-01T00:00:00Z" }],
      })),
    } as any;

    const result = await checkAgentToolPermission({
      pool, tenantId: "t1", collabRunId: "cr-1", agentId: "a1", toolName: "search",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("permission_delegation_expired");
  });

  it("space 隔离：传入不同 spaceId 时查询不到权限", async () => {
    const pool = {
      query: vi.fn(async () => ({ rowCount: 0, rows: [] })),
    } as any;

    const result = await checkAgentToolPermission({
      pool, tenantId: "t1", collabRunId: "cr-1", agentId: "a1", toolName: "search",
      spaceId: "other-space",
    });
    // 无权限记录 = 不限制
    expect(result.allowed).toBe(true);
    // 验证 spaceId 被传入查询
    const queryArgs = pool.query.mock.calls[0]![1]!;
    expect(queryArgs[3]).toBe("other-space");
  });
});

/* ================================================================== */
/*  delegatePermissions                                                */
/* ================================================================== */

describe("delegatePermissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertAuditEvent.mockResolvedValue(undefined);
  });

  it("正常委派：子集权限委派成功，返回 ok=true", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({
          rowCount: 1,
          rows: [{ role: "researcher", allowed_tools: ["search", "edit"], allowed_resources: ["docs"], max_budget: 10, used_budget: 2 }],
        })
        .mockResolvedValue({ rowCount: 1, rows: [] }),
    } as any;

    const result = await delegatePermissions({
      pool, tenantId: "t1", collabRunId: "cr-1",
      delegation: {
        parentAgentId: "parent-1",
        childAgentId: "child-1",
        delegatedTools: ["search"],
        delegatedResources: ["docs"],
        delegatedBudget: 5,
      },
    });

    expect(result.ok).toBe(true);
    // 至少 3 次 query: 查父权限 + 写子权限 + 写上下文
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it("工具越权拒绝：子权限包含父权限没有的工具时拒绝", async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ role: "researcher", allowed_tools: ["search"], allowed_resources: null, max_budget: null, used_budget: 0 }],
      }),
    } as any;

    const result = await delegatePermissions({
      pool, tenantId: "t1", collabRunId: "cr-1",
      delegation: {
        parentAgentId: "parent-1",
        childAgentId: "child-1",
        delegatedTools: ["search", "delete"], // delete 不在父权限中
        delegatedResources: [],
        delegatedBudget: 0,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("越权");
    expect(result.reason).toContain("delete");
  });

  it("预算越权拒绝：委派预算超出父 Agent 剩余预算时拒绝", async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ role: "researcher", allowed_tools: null, allowed_resources: null, max_budget: 10, used_budget: 8 }],
      }),
    } as any;

    const result = await delegatePermissions({
      pool, tenantId: "t1", collabRunId: "cr-1",
      delegation: {
        parentAgentId: "parent-1",
        childAgentId: "child-1",
        delegatedTools: [],
        delegatedResources: [],
        delegatedBudget: 5, // 剩余 = 10-8 = 2，请求5 > 2
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("预算越权");
  });

  it("仲裁角色禁止委派：orchestrator_arbiter 角色尝试委派时返回 ok=false", async () => {
    const pool = {
      query: vi.fn().mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ role: "orchestrator_arbiter", allowed_tools: ["*"], allowed_resources: null, max_budget: null, used_budget: 0 }],
      }),
    } as any;

    const result = await delegatePermissions({
      pool, tenantId: "t1", collabRunId: "cr-1",
      delegation: {
        parentAgentId: "arbiter-1",
        childAgentId: "child-1",
        delegatedTools: ["search"],
        delegatedResources: [],
        delegatedBudget: 0,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("arbiter_cannot_delegate");
  });
});

/* ================================================================== */
/*  revokePermissionDelegation                                         */
/* ================================================================== */

describe("revokePermissionDelegation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertAuditEvent.mockResolvedValue(undefined);
  });

  it("正常撤销：撤销后子 Agent 权限记录被删除", async () => {
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    await revokePermissionDelegation({
      pool, tenantId: "t1", collabRunId: "cr-1",
      parentAgentId: "parent-1", childAgentId: "child-1",
    });

    // 2 次 DELETE: collab_role_permissions + collab_permission_contexts
    expect(pool.query).toHaveBeenCalledTimes(2);
    const firstCall = pool.query.mock.calls[0]![0] as string;
    expect(firstCall).toContain("DELETE FROM collab_role_permissions");
    const secondCall = pool.query.mock.calls[1]![0] as string;
    expect(secondCall).toContain("DELETE FROM collab_permission_contexts");
    // 审计事件被调用
    expect(insertAuditEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: "collab.permission.revoke",
        inputDigest: expect.objectContaining({ childAgent: "child-1" }),
      }),
    );
  });
});

/* ================================================================== */
/*  arbitrateCollabConflict                                            */
/* ================================================================== */

describe("arbitrateCollabConflict", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertAuditEvent.mockResolvedValue(undefined);
    upsertCollabSharedState.mockResolvedValue(undefined);
  });

  it("priority 策略：按角色优先级选择赢家", async () => {
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    const result = await arbitrateCollabConflict({
      pool, tenantId: "t1", collabRunId: "cr-1",
      resourceKey: "shared_data",
      competingAgents: [
        { agentId: "a1", role: "junior", priority: 1, value: "v1" },
        { agentId: "a2", role: "senior", priority: 10, value: "v2" },
      ],
      strategy: "priority",
    });

    expect(result.winnerAgent).toBe("a2");
    expect(result.reasoning).toContain("优先级");
  });

  it("审计日志：验证仲裁后调用了 insertAuditEvent", async () => {
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    await arbitrateCollabConflict({
      pool, tenantId: "t1", collabRunId: "cr-1",
      resourceKey: "key-1",
      competingAgents: [
        { agentId: "a1", role: "r1", priority: 5, value: "v1" },
        { agentId: "a2", role: "r2", priority: 3, value: "v2" },
      ],
      strategy: "priority",
    });

    expect(insertAuditEvent).toHaveBeenCalledWith(
      pool,
      expect.objectContaining({
        action: "collab.arbiter.commit",
        inputDigest: expect.objectContaining({ resourceKey: "key-1", strategy: "priority" }),
      }),
    );
    // 共享状态应被写入
    expect(upsertCollabSharedState).toHaveBeenCalledWith(
      expect.objectContaining({ key: "key-1", updatedByAgent: "a1" }),
    );
  });
});

/* ================================================================== */
/*  runConsensusRound                                                  */
/* ================================================================== */

describe("runConsensusRound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryRolePerformanceHistory.mockResolvedValue([]);
  });

  it("majority 共识：>50% 批准时达成共识", async () => {
    isConsensusReachedMock.mockReturnValue(true);
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    const result = await runConsensusRound({
      pool, tenantId: "t1", spaceId: "s1", collabRunId: "cr-1",
      proposedBy: "a1", topic: "replan", content: { reason: "需要重规划" },
      voters: ["a1", "a2", "a3"],
      quorum: "majority",
      collectedVotes: [
        { voterId: "a1", voterRole: "planner", decision: "approve", reason: "同意" },
        { voterId: "a2", voterRole: "executor", decision: "approve", reason: "同意" },
        { voterId: "a3", voterRole: "reviewer", decision: "reject", reason: "反对" },
      ],
    });

    expect(result.reached).toBe(true);
    expect(result.approveCount).toBe(2);
    expect(result.totalVoters).toBe(3);
    expect(result.quorum).toBe("majority");
    expect(isConsensusReachedMock).toHaveBeenCalled();
  });

  it("unanimous 共识：100% 批准时达成", async () => {
    isConsensusReachedMock.mockReturnValue(true);
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    const result = await runConsensusRound({
      pool, tenantId: "t1", spaceId: "s1", collabRunId: "cr-1",
      proposedBy: "a1", topic: "abort", content: {},
      voters: ["a1", "a2"],
      quorum: "unanimous",
      collectedVotes: [
        { voterId: "a1", voterRole: "planner", decision: "approve" },
        { voterId: "a2", voterRole: "executor", decision: "approve" },
      ],
    });

    expect(result.reached).toBe(true);
    expect(result.approveCount).toBe(2);
  });

  it("bft 共识：满足 >= 2f+1 条件时达成", async () => {
    isConsensusReachedMock.mockReturnValue(true);
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    const result = await runConsensusRound({
      pool, tenantId: "t1", spaceId: "s1", collabRunId: "cr-1",
      proposedBy: "a1", topic: "replan", content: {},
      voters: ["a1", "a2", "a3", "a4"],
      quorum: "bft",
      faultTolerance: 1,
      collectedVotes: [
        { voterId: "a1", voterRole: "r1", decision: "approve" },
        { voterId: "a2", voterRole: "r2", decision: "approve" },
        { voterId: "a3", voterRole: "r3", decision: "approve" },
        { voterId: "a4", voterRole: "r4", decision: "reject" },
      ],
    });

    expect(result.reached).toBe(true);
    expect(result.quorum).toBe("bft");
    // 验证 isConsensusReached 被传入包含 faultTolerance 的 proposal
    const proposal = isConsensusReachedMock.mock.calls[0]![0];
    expect(proposal.faultTolerance).toBe(1);
  });

  it("未达共识：投票不足时 reached=false", async () => {
    isConsensusReachedMock.mockReturnValue(false);
    const pool = {
      query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
    } as any;

    const result = await runConsensusRound({
      pool, tenantId: "t1", spaceId: "s1", collabRunId: "cr-1",
      proposedBy: "a1", topic: "abort", content: {},
      voters: ["a1", "a2", "a3"],
      quorum: "unanimous",
      collectedVotes: [
        { voterId: "a1", voterRole: "r1", decision: "approve" },
        { voterId: "a2", voterRole: "r2", decision: "reject" },
        { voterId: "a3", voterRole: "r3", decision: "approve" },
      ],
    });

    expect(result.reached).toBe(false);
    expect(result.approveCount).toBe(2);
    // DB 持久化应被调用
    expect(pool.query).toHaveBeenCalled();
    const insertCall = pool.query.mock.calls.find(([sql]: [string]) => String(sql).includes("INSERT INTO collab_consensus_proposals"));
    expect(insertCall).toBeDefined();
  });
});
