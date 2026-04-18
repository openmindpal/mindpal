import { describe, expect, it, vi } from "vitest";
import { prepareRunForExecution } from "./loopStateHelpers";

describe("prepareRunForExecution", () => {
  function createPool(initialStatus: string) {
    let currentStatus = initialStatus;
    const query = vi.fn(async (sql: string, params?: any[]) => {
      if (sql.startsWith("SELECT status FROM runs")) {
        return { rowCount: 1, rows: [{ status: currentStatus }] };
      }
      if (sql.startsWith("UPDATE runs SET status =")) {
        currentStatus = String(params?.[1] ?? currentStatus);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });
    return {
      pool: { query } as any,
      query,
      getCurrentStatus: () => currentStatus,
    };
  }

  it("moves a created run through queued into running", async () => {
    const { pool, query, getCurrentStatus } = createPool("created");

    const ok = await prepareRunForExecution(pool, "run-1");

    expect(ok).toBe(true);
    expect(getCurrentStatus()).toBe("running");
    const updates = query.mock.calls.filter((call) => String(call[0]).startsWith("UPDATE runs SET status ="));
    expect(updates).toHaveLength(2);
  });

  it("keeps a running run unchanged", async () => {
    const { pool, query, getCurrentStatus } = createPool("running");

    const ok = await prepareRunForExecution(pool, "run-2");

    expect(ok).toBe(true);
    expect(getCurrentStatus()).toBe("running");
    const updates = query.mock.calls.filter((call) => String(call[0]).startsWith("UPDATE runs SET status ="));
    expect(updates).toHaveLength(0);
  });

  it.each(["paused", "needs_approval", "needs_device", "needs_arbiter", "failed"])(
    "moves a %s run back through queued into running",
    async (initialStatus) => {
      const { pool, query, getCurrentStatus } = createPool(initialStatus);

      const ok = await prepareRunForExecution(pool, `run-${initialStatus}`);

      expect(ok).toBe(true);
      expect(getCurrentStatus()).toBe("running");
      const updates = query.mock.calls
        .filter((call) => String(call[0]).startsWith("UPDATE runs SET status ="))
        .map((call) => call[1]?.[1]);
      expect(updates).toEqual(["queued", "running"]);
    },
  );

  it("rejects non-runnable terminal statuses", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT status FROM runs")) {
        return { rowCount: 1, rows: [{ status: "canceled" }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const ok = await prepareRunForExecution({ query } as any, "run-3", { log: { warn: vi.fn() } as any });

    expect(ok).toBe(false);
  });
});
