import { describe, expect, it, vi } from "vitest";
import { tickLoopSupervisor } from "./loopSupervisor";

function createCheckpointRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    loop_id: "loop-1",
    run_id: "run-1",
    job_id: "job-1",
    task_id: "task-1",
    tenant_id: "tenant-1",
    space_id: "space-1",
    goal: "resume loop",
    max_iterations: 10,
    max_wall_time_ms: 90_000,
    subject_payload: { subjectId: "subject-1" },
    locale: "zh-CN",
    authorization: "Bearer test",
    trace_id: "trace-1",
    default_model_ref: "mock:echo-1",
    decision_context: { allowedTools: ["tool.a@1"] },
    iteration: 4,
    current_seq: 7,
    succeeded_steps: 3,
    failed_steps: 1,
    observations_digest: [{ type: "observation" }],
    last_decision: { action: "tool_call" },
    tool_discovery_cache: { tools: [] },
    memory_context: "memory",
    task_history: "history",
    knowledge_context: "knowledge",
    resume_count: 1,
    ...overrides,
  };
}

describe("tickLoopSupervisor", () => {
  it("为可恢复 checkpoint 投递 loop_resume 任务", async () => {
    const queue = { add: vi.fn().mockResolvedValue({ id: "job-loop-resume" }) };
    const checkpoint = createCheckpointRow({ resume_count: 1 });
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SET status = 'expired'")) return { rowCount: 0, rows: [] };
        if (sql.includes("SELECT loop_id, run_id, tenant_id, resume_count")) {
          return { rowCount: 1, rows: [{ loop_id: "loop-1", run_id: "run-1", tenant_id: "tenant-1", resume_count: 1 }] };
        }
        if (sql.includes("SET status = 'resuming'")) return { rowCount: 1, rows: [] };
        if (sql.includes("SELECT * FROM agent_loop_checkpoints WHERE loop_id = $1")) {
          return { rowCount: 1, rows: [checkpoint] };
        }
        return { rowCount: 0, rows: [] };
      }),
    } as any;

    await tickLoopSupervisor({ pool, queue });
    expect(queue.add).toHaveBeenCalledWith(
      "loop_resume",
      expect.objectContaining({
        loopId: "loop-1",
        runId: "run-1",
        jobId: "job-1",
        taskId: "task-1",
        resumeState: expect.objectContaining({
          iteration: 4,
          currentSeq: 7,
          succeededSteps: 3,
          failedSteps: 1,
        }),
      }),
      expect.objectContaining({
        jobId: "loop_resume:loop-1:1",
      }),
    );
  });

  it("在恢复任务投递失败时回滚 checkpoint 状态", async () => {
    const queue = { add: vi.fn().mockRejectedValue(new Error("queue_down")) };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SET status = 'expired'")) return { rowCount: 0, rows: [] };
        if (sql.includes("SELECT loop_id, run_id, tenant_id, resume_count")) {
          return { rowCount: 1, rows: [{ loop_id: "loop-1", run_id: "run-1", tenant_id: "tenant-1", resume_count: 0 }] };
        }
        if (sql.includes("SET status = 'resuming'")) return { rowCount: 1, rows: [] };
        if (sql.includes("SELECT * FROM agent_loop_checkpoints WHERE loop_id = $1")) {
          return { rowCount: 1, rows: [createCheckpointRow({ resume_count: 0 })] };
        }
        if (sql.includes("SET status = 'running'")) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      }),
    } as any;

    await tickLoopSupervisor({ pool, queue });
    expect(pool.query).toHaveBeenCalledWith(
      "UPDATE agent_loop_checkpoints SET status = 'running', updated_at = now() WHERE loop_id = $1",
      ["loop-1"],
    );
  });

  it("在 checkpoint 超过恢复次数后标记为 expired 并传播 run 失败", async () => {
    const queue = { add: vi.fn() };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SET status = 'expired'")) return { rowCount: 2, rows: [{ loop_id: "loop-1" }, { loop_id: "loop-2" }] };
        if (sql.includes("UPDATE runs SET status = 'failed'")) return { rowCount: 2, rows: [] };
        if (sql.includes("SELECT loop_id, run_id, tenant_id, resume_count")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      }),
    } as any;

    await tickLoopSupervisor({ pool, queue });
    expect(queue.add).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE runs SET status = 'failed'"),
    );
  });
});
