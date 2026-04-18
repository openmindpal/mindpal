import { describe, expect, it, vi } from "vitest";

const auditMocks = vi.hoisted(() => ({
  writeAudit: vi.fn(async () => undefined),
}));

vi.mock("../workflow/processor/audit", () => ({
  writeAudit: auditMocks.writeAudit,
}));

import { fireCronTrigger, type TriggerDefinitionRow } from "./runner";

describe("fireCronTrigger", () => {
  it("入队失败时将新建的 run/job/step 显式回落为 failed", async () => {
    const txQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const poolQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        txQueries.push({ sql, params });
        if (sql.includes("INSERT INTO runs")) {
          return { rowCount: 1, rows: [{ run_id: "run-1" }] };
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
        if (sql.includes("INSERT INTO trigger_runs")) {
          return { rowCount: 1, rows: [{ trigger_run_id: "trigger-run-1" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;
    const queue = {
      add: vi.fn(async () => {
        throw new Error("queue down");
      }),
    } as any;

    const trigger: TriggerDefinitionRow = {
      triggerId: "trigger-1",
      tenantId: "tenant-1",
      spaceId: "space-1",
      type: "cron",
      status: "enabled",
      cronExpr: "* * * * *",
      cronTz: null,
      cronMisfirePolicy: "skip",
      nextFireAt: null,
      eventSource: null,
      eventFilter: null,
      eventWatermark: null,
      targetKind: "workflow",
      targetRef: "entity.create@1",
      inputMapping: { kind: "static", input: { title: "from-trigger" } },
      idempotencyKeyTemplate: null,
      idempotencyWindowSec: 3600,
      rateLimitPerMin: 60,
      lastRunAt: null,
      createdBySubjectId: "admin",
    };

    await expect(
      fireCronTrigger({
        pool,
        queue,
        trigger,
        scheduledAt: "2026-01-01T00:00:00.000Z",
        traceId: "trace-1",
      }),
    ).rejects.toThrow("queue down");

    expect(
      poolQueries.some(({ sql }) => sql.includes("UPDATE trigger_runs SET status = 'failed'")),
    ).toBe(true);
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
});
