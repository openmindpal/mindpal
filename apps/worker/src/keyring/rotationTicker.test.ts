import { describe, expect, it, vi } from "vitest";

import { tickKeyRotation } from "./rotationTicker";

describe("tickKeyRotation", () => {
  it("没有新轮换时也会为遗留的待重加密 scope 补发 reencrypt 作业", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM partition_keys") && sql.includes("LIMIT 500")) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes("FROM secret_records s")) {
          return {
            rowCount: 1,
            rows: [{
              tenant_id: "tenant-1",
              scope_type: "space",
              scope_id: "space-1",
              active_key_version: 3,
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
    } as any;
    const queue = {
      add: vi.fn(async () => ({ id: "job-1" })),
    } as any;

    const result = await tickKeyRotation({ pool, queue, masterKey: "test-master-key" });

    expect(result.rotated).toBe(0);
    expect(result.reencryptJobsEnqueued).toBe(1);
    expect(result.details.some((detail) => detail.action === "reencrypt_queued")).toBe(true);
    expect(queue.add).toHaveBeenCalledWith(
      "step",
      expect.objectContaining({
        kind: "keyring.reencrypt",
        tenantId: "tenant-1",
        scopeType: "space",
        scopeId: "space-1",
      }),
      expect.objectContaining({
        jobId: "keyring-reencrypt:tenant-1:space:space-1:3",
      }),
    );
    expect(
      queries.some(({ sql }) => sql.includes("FROM secret_records s")),
    ).toBe(true);
  });
});
