import { describe, expect, it, vi } from "vitest";

import { scanAndEnqueueRegressionEvals } from "./regressionScheduler";

describe("scanAndEnqueueRegressionEvals", () => {
  it("入队失败时将新建 eval_run 回落为 failed", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM changeset_eval_bindings")) {
          return {
            rowCount: 1,
            rows: [{ tenant_id: "tenant-1", changeset_id: "changeset-1", suite_id: "suite-1" }],
          };
        }
        if (sql.includes("FROM eval_suites")) {
          return {
            rowCount: 1,
            rows: [{ cases_json: [{ caseId: "case-1", source: { type: "replay" } }], thresholds: {} }],
          };
        }
        if (sql.includes("status IN ('queued','running')")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("status = 'succeeded'")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("INSERT INTO eval_runs")) {
          return { rowCount: 1, rows: [{ id: "eval-run-1" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;
    const queue = {
      add: vi.fn(async () => {
        throw new Error("queue down");
      }),
    } as any;

    const result = await scanAndEnqueueRegressionEvals({ pool, queue });

    expect(result.enqueued).toBe(0);
    expect(result.details[0]?.action).toBe("error");
    expect(result.details[0]?.error).toContain("queue down");
    expect(
      queries.some(({ sql }) => sql.includes("UPDATE eval_runs") && sql.includes("status = 'failed'")),
    ).toBe(true);
  });
});
