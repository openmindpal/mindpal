import { describe, expect, it, vi } from "vitest";
import { tickDeviceExecutionResume } from "./resumeTicker";

describe("tickDeviceExecutionResume", () => {
  it("入队失败时回退 needs_device 恢复状态，避免伪 queued", async () => {
    const txQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params });
        if (sql.includes("SELECT status, queue_job_id")) {
          return {
            rowCount: 1,
            rows: [{
              status: "needs_device",
              queue_job_id: null,
              collab_run_id: "11111111-1111-1111-1111-111111111111",
              space_id: "space-1",
            }],
          };
        }
        if (sql.includes("UPDATE runs SET status = 'queued'")) return { rowCount: 1, rows: [] };
        if (sql.includes("UPDATE steps SET status = 'pending', queue_job_id = $2")) return { rowCount: 1, rows: [{ "?column?": 1 }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM device_executions")) {
          return {
            rowCount: 1,
            rows: [{
              device_execution_id: "de-1",
              tenant_id: "tenant-1",
              run_id: "22222222-2222-2222-2222-222222222222",
              step_id: "33333333-3333-3333-3333-333333333333",
              de_status: "succeeded",
              run_status: "needs_device",
              job_id: "44444444-4444-4444-4444-444444444444",
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      connect: vi.fn(async () => client),
    } as any;
    const queue = {
      add: vi.fn(async () => {
        throw new Error("queue down");
      }),
    } as any;

    await tickDeviceExecutionResume({ pool, queue });

    expect(
      txQueries.some(({ sql }) => sql.includes("UPDATE runs SET status = 'needs_device'")),
    ).toBe(true);
    expect(
      txQueries.some(({ sql }) => sql.includes("UPDATE jobs SET status = 'needs_device'")),
    ).toBe(true);
    expect(
      txQueries.some(({ sql }) => sql.includes("UPDATE steps SET queue_job_id = NULL")),
    ).toBe(true);
    expect(
      txQueries.some(({ sql }) => sql.includes("UPDATE memory_task_states SET phase = 'needs_device'")),
    ).toBe(true);
  });
});
