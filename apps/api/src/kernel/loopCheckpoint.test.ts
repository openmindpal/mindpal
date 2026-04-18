/**
 * P0-1 验证：loopCheckpoint 纯函数 + Supervisor 心跳/恢复流程测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/* ─── Mock DB pool ─── */
function mockPool(queryResults: Record<string, any> = {}) {
  return {
    query: vi.fn(async (sql: string, _params?: any[]) => {
      for (const [key, val] of Object.entries(queryResults)) {
        if (sql.includes(key)) return val;
      }
      return { rows: [], rowCount: 0 };
    }),
  } as any;
}

/* ================================================================== */
/*  heartbeatIntervalMs / heartbeatTimeoutMs — 配置函数                   */
/* ================================================================== */

import { heartbeatIntervalMs, heartbeatTimeoutMs } from "./loopCheckpoint";

describe("heartbeatIntervalMs", () => {
  const origEnv = process.env.AGENT_LOOP_HEARTBEAT_INTERVAL_MS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENT_LOOP_HEARTBEAT_INTERVAL_MS;
    else process.env.AGENT_LOOP_HEARTBEAT_INTERVAL_MS = origEnv;
  });

  it("默认返回 10000ms", () => {
    delete process.env.AGENT_LOOP_HEARTBEAT_INTERVAL_MS;
    expect(heartbeatIntervalMs()).toBe(10_000);
  });

  it("通过环境变量自定义", () => {
    process.env.AGENT_LOOP_HEARTBEAT_INTERVAL_MS = "5000";
    expect(heartbeatIntervalMs()).toBe(5000);
  });

  it("最小值不低于 3000ms", () => {
    process.env.AGENT_LOOP_HEARTBEAT_INTERVAL_MS = "100";
    expect(heartbeatIntervalMs()).toBe(3000);
  });
});

describe("heartbeatTimeoutMs", () => {
  const origEnv = process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS;
    else process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS = origEnv;
  });

  it("默认返回 60000ms", () => {
    delete process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS;
    expect(heartbeatTimeoutMs()).toBe(60_000);
  });

  it("通过环境变量自定义", () => {
    process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS = "30000";
    expect(heartbeatTimeoutMs()).toBe(30_000);
  });

  it("最小值不低于 15000ms", () => {
    process.env.AGENT_LOOP_HEARTBEAT_TIMEOUT_MS = "500";
    expect(heartbeatTimeoutMs()).toBe(15_000);
  });
});

/* ================================================================== */
/*  writeCheckpoint — 幂等 UPSERT                                      */
/* ================================================================== */

import { writeCheckpoint } from "./loopCheckpoint";

describe("writeCheckpoint", () => {
  it("执行 UPSERT 写入 checkpoint", async () => {
    const pool = mockPool({ "INSERT INTO agent_loop_checkpoints": { rows: [], rowCount: 1 } });
    await writeCheckpoint({
      pool,
      loopId: "loop-1",
      tenantId: "t1",
      spaceId: "s1",
      runId: "r1",
      jobId: "j1",
      taskId: null,
      iteration: 3,
      currentSeq: 5,
      succeededSteps: 2,
      failedSteps: 1,
      observations: [],
      lastDecision: null,
      goal: "测试任务",
      maxIterations: 20,
      maxWallTimeMs: 300_000,
      subjectPayload: { tenantId: "t1" },
      locale: "zh-CN",
      authorization: null,
      traceId: null,
      defaultModelRef: null,
      toolDiscoveryCache: null,
      memoryContext: null,
      taskHistory: null,
      knowledgeContext: null,
      status: "running",
    });
    expect(pool.query).toHaveBeenCalledTimes(1);
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain("INSERT INTO agent_loop_checkpoints");
    expect(sql).toContain("ON CONFLICT");
  });
});

/* ================================================================== */
/*  startHeartbeat — 心跳定时器                                         */
/* ================================================================== */

import { startHeartbeat } from "./loopCheckpoint";

describe("startHeartbeat", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("启动后周期性更新 heartbeat_at", async () => {
    const pool = mockPool({ "UPDATE agent_loop_checkpoints": { rows: [], rowCount: 1 } });
    const hb = startHeartbeat(pool, "loop-1");
    // 推进时间，触发至少一次心跳
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs() + 100);
    expect(pool.query).toHaveBeenCalled();
    hb.stop();
  });

  it("stop() 后不再更新", async () => {
    const pool = mockPool({ "UPDATE agent_loop_checkpoints": { rows: [], rowCount: 1 } });
    const hb = startHeartbeat(pool, "loop-1");
    hb.stop();
    const callsBefore = pool.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(heartbeatIntervalMs() * 3);
    // stop 后调用次数不再增长（或最多多一次已排队的）
    expect(pool.query.mock.calls.length).toBeLessThanOrEqual(callsBefore + 1);
  });
});

/* ================================================================== */
/*  loadCheckpoint — 从 DB 加载                                        */
/* ================================================================== */

import { loadCheckpoint } from "./loopCheckpoint";

describe("loadCheckpoint", () => {
  it("checkpoint 存在时返回 CheckpointRow", async () => {
    const row = {
      loop_id: "loop-1", tenant_id: "t1", space_id: "s1", run_id: "r1",
      job_id: "j1", task_id: null, iteration: 5, current_seq: 8,
      succeeded_steps: 3, failed_steps: 1,
      observations_digest: JSON.stringify([]),
      last_decision: null, decision_context: JSON.stringify({}),
      goal: "test", max_iterations: 20, max_wall_time_ms: 300000,
      subject_payload: JSON.stringify({ tenantId: "t1" }),
      locale: "zh-CN", authorization: null, trace_id: null,
      default_model_ref: null, tool_discovery_cache: null,
      memory_context: null, task_history: null, knowledge_context: null,
      node_id: "node-1", status: "running",
      heartbeat_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      finished_at: null, resumed_from: null, resume_count: 0,
    };
    const pool = mockPool({ "SELECT": { rows: [row], rowCount: 1 } });
    const result = await loadCheckpoint(pool, "loop-1");
    expect(result).not.toBeNull();
    expect(result!.loopId).toBe("loop-1");
    expect(result!.iteration).toBe(5);
  });

  it("checkpoint 不存在时返回 null", async () => {
    const pool = mockPool({});
    const result = await loadCheckpoint(pool, "non-existent");
    expect(result).toBeNull();
  });
});

/* ================================================================== */
/*  acquireResumeLock — CAS 恢复锁                                     */
/* ================================================================== */

import { acquireResumeLock } from "./loopCheckpoint";

describe("acquireResumeLock", () => {
  it("成功获取锁返回 true", async () => {
    const pool = mockPool({
      "UPDATE agent_loop_checkpoints": { rows: [{ loop_id: "loop-1" }], rowCount: 1 },
    });
    const locked = await acquireResumeLock(pool, "loop-1");
    expect(locked).toBe(true);
  });

  it("竞争失败返回 false", async () => {
    const pool = mockPool({
      "UPDATE agent_loop_checkpoints": { rows: [], rowCount: 0 },
    });
    const locked = await acquireResumeLock(pool, "loop-1");
    expect(locked).toBe(false);
  });
});

/* ================================================================== */
/*  findExpiredCheckpoints                                              */
/* ================================================================== */

import { findExpiredCheckpoints } from "./loopCheckpoint";

describe("findExpiredCheckpoints", () => {
  it("返回心跳超时的 checkpoint 列表", async () => {
    const pool = mockPool({
      "SELECT": {
        rows: [
          { loop_id: "l1", run_id: "r1", tenant_id: "t1", resume_count: 0 },
          { loop_id: "l2", run_id: "r2", tenant_id: "t1", resume_count: 1 },
        ],
        rowCount: 2,
      },
    });
    const result = await findExpiredCheckpoints(pool);
    expect(result).toHaveLength(2);
    expect(result[0].loopId).toBe("l1");
    expect(result[1].resumeCount).toBe(1);
  });

  it("无超时时返回空数组", async () => {
    const pool = mockPool({});
    const result = await findExpiredCheckpoints(pool);
    expect(result).toHaveLength(0);
  });
});

/* ================================================================== */
/*  registerProcess / updateProcessStatus / findActiveProcess          */
/* ================================================================== */

import { registerProcess, updateProcessStatus, findActiveProcess } from "./loopCheckpoint";

describe("registerProcess", () => {
  it("注册进程并返回 processId", async () => {
    const pool = mockPool({
      "INSERT INTO agent_processes": { rows: [{ process_id: "p-123" }], rowCount: 1 },
    });
    const pid = await registerProcess({
      pool,
      tenantId: "t1",
      spaceId: "s1",
      runId: "r1",
      loopId: "loop-1",
      priority: 5,
      resourceQuota: {},
      parentProcessId: null,
    });
    expect(pid).toBe("p-123");
  });
});

describe("updateProcessStatus", () => {
  it("更新进程状态", async () => {
    const pool = mockPool({ "UPDATE agent_processes": { rows: [], rowCount: 1 } });
    await updateProcessStatus(pool, "p-1", "completed");
    expect(pool.query).toHaveBeenCalledTimes(1);
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE agent_processes");
  });
});

describe("findActiveProcess", () => {
  it("找到活跃进程", async () => {
    const pool = mockPool({
      "SELECT": {
        rows: [{
          process_id: "p-1", tenant_id: "t1", space_id: "s1",
          run_id: "r1", loop_id: "l1", priority: 5,
          resource_quota: {}, parent_process_id: null,
          node_id: "n1", status: "running",
          heartbeat_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          finished_at: null, metadata: {},
        }],
        rowCount: 1,
      },
    });
    const proc = await findActiveProcess(pool, "r1");
    expect(proc).not.toBeNull();
    expect(proc!.processId).toBe("p-1");
  });

  it("无活跃进程返回 null", async () => {
    const pool = mockPool({});
    const proc = await findActiveProcess(pool, "r1");
    expect(proc).toBeNull();
  });
});

/* ================================================================== */
/*  finalizeCheckpoint                                                  */
/* ================================================================== */

import { finalizeCheckpoint } from "./loopCheckpoint";

describe("finalizeCheckpoint", () => {
  it("标记 checkpoint 终态", async () => {
    const pool = mockPool({ "UPDATE agent_loop_checkpoints": { rows: [], rowCount: 1 } });
    await finalizeCheckpoint(pool, "loop-1", "succeeded");
    expect(pool.query).toHaveBeenCalledTimes(1);
    const sql = String(pool.query.mock.calls[0][0]);
    expect(sql).toContain("UPDATE agent_loop_checkpoints");
    // status 参数应该是 "succeeded"
    expect(pool.query.mock.calls[0][1]).toContain("succeeded");
  });
});
