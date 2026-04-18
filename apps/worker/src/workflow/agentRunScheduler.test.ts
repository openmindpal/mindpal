import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendCollabEventOnce: vi.fn(async () => undefined),
}));

vi.mock("../lib/collabEvents", () => ({
  appendCollabEventOnce: mocks.appendCollabEventOnce,
}));

import { createAgentRunScheduler } from "./agentRunScheduler";

type HarnessOptions = {
  runRow?: Record<string, unknown>;
  candidateRows?: any[];
  plan?: any;
  doneRows?: any[];
  usedRoleRows?: any[];
  tokenUsageTotal?: number;
  lockedStepIds?: string[];
  queueAddImpl?: (name: string, data: any) => Promise<any>;
};

function createHarness(options: HarnessOptions = {}) {
  const runRow = {
    tenant_id: "tenant-1",
    status: "running",
    input_digest: {},
    started_at: null,
    created_at: new Date().toISOString(),
    ...(options.runRow ?? {}),
  };
  const candidateRows = options.candidateRows ?? [];
  const plan = options.plan ?? null;
  const doneRows = options.doneRows ?? [];
  const usedRoleRows = options.usedRoleRows ?? [];
  const tokenUsageTotal = options.tokenUsageTotal ?? 0;
  const lockedStepIds = options.lockedStepIds ?? candidateRows.map((row) => String(row.step_id));
  const postCommitQueries: Array<{ sql: string; params?: unknown[] }> = [];

  const clientQuery = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT (input->>'spaceId') AS space_id")) {
      return { rowCount: 1, rows: [{ space_id: "space-1", tenant_id: "tenant-1" }] };
    }
    if (sql.includes("SELECT step_id FROM steps")) {
      return { rowCount: lockedStepIds.length, rows: lockedStepIds.map((stepId) => ({ step_id: stepId })) };
    }
    return { rowCount: 1, rows: [] };
  });

  const poolQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT tenant_id, status, input_digest, started_at, created_at FROM runs")) {
      return { rowCount: 1, rows: [runRow] };
    }
    if (sql.includes("FROM steps") && sql.includes("ORDER BY seq ASC") && sql.includes("FOR UPDATE SKIP LOCKED")) {
      return { rowCount: candidateRows.length, rows: candidateRows };
    }
    if (sql.includes("SELECT (input->>'planStepId') AS plan_step_id")) {
      return { rowCount: doneRows.length, rows: doneRows };
    }
    if (sql.includes("SELECT plan FROM memory_task_states")) {
      return plan ? { rowCount: 1, rows: [{ plan }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes("SELECT (input->>'actorRole') AS role_name")) {
      return { rowCount: usedRoleRows.length, rows: usedRoleRows };
    }
    if (sql.includes("SELECT COALESCE(SUM(COALESCE(total_tokens, 0)), 0)::bigint AS total")) {
      return { rowCount: 1, rows: [{ total: tokenUsageTotal }] };
    }
    if (sql.includes("SELECT status, tenant_id FROM runs")) {
      return { rowCount: 1, rows: [{ status: runRow.status, tenant_id: runRow.tenant_id }] };
    }
    if (sql.includes("UPDATE steps SET queue_job_id = $1") || sql.includes("UPDATE steps SET queue_job_id = NULL")) {
      postCommitQueries.push({ sql, params });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  });

  const release = vi.fn();
  const pool = {
    query: poolQuery,
    connect: vi.fn(async () => ({
      query: clientQuery,
      release,
    })),
  } as any;

  const queueAdd = vi.fn(options.queueAddImpl ?? (async (_name: string, data: any) => ({ id: `q-${data.stepId}` })));
  const queue = { add: queueAdd } as any;
  const redis = {} as any;
  const syncWorkerCollabStateSafe = vi.fn(async () => undefined);

  const scheduler = createAgentRunScheduler({
    pool,
    queue,
    redis,
    syncWorkerCollabStateSafe,
  });

  return {
    scheduler,
    poolQuery,
    clientQuery,
    queueAdd,
    postCommitQueries,
    syncWorkerCollabStateSafe,
    release,
  };
}

describe("agentRunScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("对需要审批的首个步骤进入 needs_approval 且不直接入队", async () => {
    const { scheduler, clientQuery, queueAdd, syncWorkerCollabStateSafe } = createHarness({
      runRow: {
        input_digest: { kind: "agent.run" },
      },
      candidateRows: [
        {
          step_id: "step-1",
          seq: 1,
          tool_ref: "entity.update@1",
          input: {
            spaceId: "space-1",
            subjectId: "user-1",
            toolContract: { approvalRequired: true },
          },
          policy_snapshot_ref: "ps-1",
          input_digest: { foo: "bar" },
        },
      ],
    });

    await scheduler.scheduleNextAgentRunStep({ jobId: "job-1", runId: "run-1" });

    expect(queueAdd).not.toHaveBeenCalled();
    expect(
      clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO approvals")),
    ).toBe(true);
    expect(
      clientQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE runs SET status = 'needs_approval'")),
    ).toBe(true);
    expect(syncWorkerCollabStateSafe).not.toHaveBeenCalled();
  });

  it("在协作工具不满足角色策略时停止 run 并写入拒绝事件", async () => {
    const { scheduler, queueAdd, syncWorkerCollabStateSafe, clientQuery } = createHarness({
      runRow: {
        input_digest: {
          kind: "collab.run",
          collabRunId: "collab-1",
          taskId: "task-1",
        },
      },
      candidateRows: [
        {
          step_id: "step-1",
          seq: 1,
          tool_ref: "tool.blocked",
          input: {
            spaceId: "space-1",
            actorRole: "planner",
            dependsOn: [],
          },
          policy_snapshot_ref: "ps-1",
          input_digest: { foo: "bar" },
        },
      ],
      plan: {
        roles: [
          {
            roleName: "planner",
            toolPolicy: { allowedTools: ["tool.allowed"] },
          },
        ],
      },
    });

    await scheduler.scheduleNextAgentRunStep({ jobId: "job-1", runId: "run-1" });

    expect(queueAdd).not.toHaveBeenCalled();
    expect(syncWorkerCollabStateSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "stopped",
        collabRunId: "collab-1",
      }),
    );
    expect(mocks.appendCollabEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "collab.policy.denied",
      }),
    );
    expect(
      clientQuery.mock.calls.some(
        (call) => {
          const sql = String(call[0]);
          const params = (call as unknown[])[1] as unknown[] | undefined;
          return (
          String(sql).includes("UPDATE steps SET status = 'canceled'") &&
          !String(sql).includes("tenant_id") &&
          JSON.stringify(params) === JSON.stringify(["run-1"])
          );
        },
      ),
    ).toBe(true);
  });

  it("在协作 ready steps 可执行时会并行入队并同步角色状态", async () => {
    const { scheduler, queueAdd, syncWorkerCollabStateSafe, postCommitQueries } = createHarness({
      runRow: {
        input_digest: {
          kind: "collab.run",
          collabRunId: "collab-1",
          taskId: "task-1",
        },
      },
      candidateRows: [
        {
          step_id: "step-1",
          seq: 1,
          tool_ref: "tool.plan",
          input: {
            spaceId: "space-1",
            actorRole: "planner",
            planStepId: "plan-1",
            dependsOn: [],
          },
          policy_snapshot_ref: "ps-1",
          input_digest: { foo: "bar" },
        },
        {
          step_id: "step-2",
          seq: 2,
          tool_ref: "tool.exec",
          input: {
            spaceId: "space-1",
            actorRole: "executor",
            planStepId: "plan-2",
            dependsOn: [],
          },
          policy_snapshot_ref: "ps-2",
          input_digest: { bar: "baz" },
        },
      ],
      plan: {
        roles: [
          {
            roleName: "planner",
            toolPolicy: { allowedTools: ["tool.plan"] },
          },
          {
            roleName: "executor",
            toolPolicy: { allowedTools: ["tool.exec"] },
          },
        ],
      },
    });

    await scheduler.scheduleNextAgentRunStep({ jobId: "job-1", runId: "run-1" });

    expect(queueAdd).toHaveBeenCalledTimes(2);
    expect(postCommitQueries.filter(({ sql }) => sql.includes("UPDATE steps SET queue_job_id = $1"))).toHaveLength(2);
    expect(syncWorkerCollabStateSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "executing",
        currentRole: "planner",
      }),
    );
    expect(syncWorkerCollabStateSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        roleName: "executor",
        roleStatus: "waiting",
      }),
    );
  });

  it("在事务提交后入队失败时会释放 claim 占位，避免步骤卡死", async () => {
    const { scheduler, postCommitQueries } = createHarness({
      runRow: {
        input_digest: { kind: "agent.run" },
      },
      candidateRows: [
        {
          step_id: "step-1",
          seq: 1,
          tool_ref: "tool.exec",
          input: { spaceId: "space-1", dependsOn: [] },
          policy_snapshot_ref: "ps-1",
          input_digest: { foo: "bar" },
        },
      ],
      queueAddImpl: async () => {
        throw new Error("queue down");
      },
    });

    await expect(scheduler.scheduleNextAgentRunStep({ jobId: "job-1", runId: "run-1" })).rejects.toThrow("queue down");

    expect(
      postCommitQueries.some(
        ({ sql, params }) =>
          sql.includes("UPDATE steps SET queue_job_id = NULL") &&
          Array.isArray(params) &&
          params[0] === "step-1" &&
          String(params[1]).startsWith("sched:"),
      ),
    ).toBe(true);
  });
});
