import { describe, expect, it, vi } from "vitest";
import { rotatePartitionKey } from "./keyringRepo";

describe("rotatePartitionKey", () => {
  it("使用单一 client 事务轮换分区密钥", async () => {
    const clientQueries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        clientQueries.push(sql);
        if (sql.includes("SELECT key_version")) {
          return { rowCount: 1, rows: [{ key_version: 3 }] };
        }
        if (sql.includes("INSERT INTO partition_keys")) {
          return {
            rowCount: 1,
            rows: [{
              tenant_id: "tenant-1",
              scope_type: "space",
              scope_id: "space-1",
              key_version: 4,
              status: "active",
              encrypted_key: { iv: "iv", ciphertext: "ct", tag: "tag" },
              created_at: "2026-01-01T00:00:00.000Z",
              updated_at: "2026-01-01T00:00:00.000Z",
              disabled_at: null,
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(),
    } as any;

    const row = await rotatePartitionKey({
      pool,
      tenantId: "tenant-1",
      scopeType: "space",
      scopeId: "space-1",
      masterKey: "test-master-key",
    });

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(clientQueries.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(row.keyVersion).toBe(4);
  });
});
