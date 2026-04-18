import { describe, expect, it, vi } from "vitest";

import { processEventReasoningJob } from "./ai-event-reasoning";

describe("processEventReasoningJob", () => {
  it("动作入队失败时不会先写 reasoning log，并将 run/job/step 回落为 failed", async () => {
    const txQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const poolQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params });
        if (sql.includes("INSERT INTO runs")) {
          return { rowCount: 1, rows: [{ run_id: "run-1" }] };
        }
        if (sql.includes("SELECT j.job_id")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("INSERT INTO jobs")) {
          return { rowCount: 1, rows: [{ job_id: "job-1" }] };
        }
        if (sql.includes("INSERT INTO steps")) {
          return { rowCount: 1, rows: [{ step_id: "step-1" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        poolQueries.push({ sql, params });
        if (sql.includes("SELECT 1 FROM event_reasoning_logs")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("SELECT * FROM event_reasoning_rules")) {
          return {
            rowCount: 1,
            rows: [{
              rule_id: "rule-1",
              name: "rule-1",
              decision: "execute",
              action_kind: "workflow",
              action_ref: "entity.create@1",
              action_input_template: { title: "hello" },
              event_type_pattern: "issue.opened",
              provider_pattern: "github",
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;
    const queue = {
      add: vi.fn(async () => {
        throw new Error("queue down");
      }),
    } as any;

    await expect(
      processEventReasoningJob({
        pool,
        queue,
        data: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          eventSourceId: "event-1",
          eventType: "issue.opened",
          provider: "github",
          workspaceId: "ws-1",
          payload: { type: "issue.opened" },
        },
      }),
    ).rejects.toThrow("queue down");

    expect(
      poolQueries.some(({ sql }) => sql.includes("INSERT INTO event_reasoning_logs")),
    ).toBe(false);
    expect(
      poolQueries.some(({ sql }) => sql.includes("UPDATE runs SET status = 'failed'")),
    ).toBe(true);
    expect(
      poolQueries.some(({ sql }) => sql.includes("UPDATE jobs SET status = 'failed'")),
    ).toBe(true);
    expect(
      poolQueries.some(({ sql }) => sql.includes("UPDATE steps") && sql.includes("error_category = 'queue_error'")),
    ).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("log 写入失败重试时复用已有 action，不会重复入队", async () => {
    const poolQueries: Array<{ sql: string; params?: unknown[] }> = [];
    let actionCreated = false;
    let queueJobId: string | null = null;
    let logAttempts = 0;

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO runs")) {
          actionCreated = true;
          return { rowCount: 1, rows: [{ run_id: "run-1" }] };
        }
        if (sql.includes("SELECT j.job_id")) {
          if (!actionCreated) {
            return { rowCount: 0, rows: [] };
          }
          return {
            rowCount: 1,
            rows: [{
              job_id: "job-1",
              step_id: "step-1",
              step_status: "pending",
              queue_job_id: queueJobId,
            }],
          };
        }
        if (sql.includes("INSERT INTO jobs")) {
          return { rowCount: 1, rows: [{ job_id: "job-1" }] };
        }
        if (sql.includes("INSERT INTO steps")) {
          return { rowCount: 1, rows: [{ step_id: "step-1" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        poolQueries.push({ sql, params });
        if (sql.includes("SELECT 1 FROM event_reasoning_logs")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("SELECT * FROM event_reasoning_rules")) {
          return {
            rowCount: 1,
            rows: [{
              rule_id: "rule-1",
              name: "rule-1",
              decision: "execute",
              action_kind: "workflow",
              action_ref: "entity.create@1",
              action_input_template: { title: "hello" },
              event_type_pattern: "issue.opened",
              provider_pattern: "github",
            }],
          };
        }
        if (sql.includes("UPDATE steps SET queue_job_id = $2")) {
          queueJobId = String((params ?? [])[1]);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("INSERT INTO event_reasoning_logs")) {
          logAttempts += 1;
          if (logAttempts === 1) {
            throw new Error("log down");
          }
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;
    const queue = {
      add: vi.fn(async () => ({ id: "queue-1" })),
    } as any;

    await expect(
      processEventReasoningJob({
        pool,
        queue,
        data: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          eventSourceId: "event-1",
          eventType: "issue.opened",
          provider: "github",
          workspaceId: "ws-1",
          payload: { type: "issue.opened" },
        },
      }),
    ).rejects.toThrow("log down");

    await expect(
      processEventReasoningJob({
        pool,
        queue,
        data: {
          tenantId: "tenant-1",
          spaceId: "space-1",
          eventSourceId: "event-1",
          eventType: "issue.opened",
          provider: "github",
          workspaceId: "ws-1",
          payload: { type: "issue.opened" },
        },
      }),
    ).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(
      poolQueries.filter(({ sql }) => sql.includes("INSERT INTO event_reasoning_logs")),
    ).toHaveLength(2);
  });
});
