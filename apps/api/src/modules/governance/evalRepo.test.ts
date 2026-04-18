import { describe, expect, it, vi } from "vitest";
import { replaceChangeSetEvalBindings } from "./evalRepo";

describe("replaceChangeSetEvalBindings", () => {
  it("使用单一 client 事务替换变更集绑定", async () => {
    const clientQueries: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        clientQueries.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as any;

    await replaceChangeSetEvalBindings({
      pool,
      tenantId: "tenant-1",
      changesetId: "cs-1",
      suiteIds: ["suite-1", "suite-2"],
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(clientQueries[1]?.sql).toContain("DELETE FROM changeset_eval_bindings");
    expect(clientQueries.filter(({ sql }) => sql.includes("INSERT INTO changeset_eval_bindings"))).toHaveLength(2);
  });
});
