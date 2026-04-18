import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrate } from "./migrate";

class FakePool {
  public applied = new Set<string>();
  public executedBodies: string[] = [];
  public insertedIds: string[] = [];
  public released = 0;

  async query(sql: string, params?: any[]) {
    if (sql.includes("CREATE TABLE IF NOT EXISTS migrations")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("SELECT pg_advisory_lock") || sql.includes("SELECT pg_advisory_unlock")) {
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SELECT id FROM migrations WHERE id = ANY")) {
      const ids = (params?.[0] ?? []) as string[];
      const matched = ids.find((id) => this.applied.has(id));
      return matched ? { rowCount: 1, rows: [{ id: matched }] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes("INSERT INTO migrations (id) VALUES")) {
      const id = String(params?.[0] ?? "");
      this.applied.add(id);
      this.insertedIds.push(id);
      return { rowCount: 1, rows: [] };
    }
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rowCount: 0, rows: [] };
    }

    this.executedBodies.push(sql.trim());
    return { rowCount: 0, rows: [] };
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release: () => {
        this.released += 1;
      },
    };
  }
}

const tempDirs: string[] = [];

async function createMigrationDir(files: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openslin-migrate-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("db/migrate", () => {
  it("当旧 migration id 已存在时，使用 alias 同步新文件名且不重复执行 SQL", async () => {
    const dir = await createMigrationDir({
      "048a_governance_routing_quota.sql": "-- migration-aliases: 048_governance_routing_quota.sql\nSELECT 1;",
    });
    const pool = new FakePool();
    pool.applied.add("048_governance_routing_quota.sql");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await migrate(pool as any, dir);

    expect(pool.executedBodies).toEqual([]);
    expect(pool.insertedIds).toContain("048a_governance_routing_quota.sql");
    expect(logSpy).toHaveBeenCalledWith("[migrate] alias-sync summary: 1 file(s) [048a_governance_routing_quota.sql <= 048_governance_routing_quota.sql]");
  });

  it("当别名和当前 id 都不存在时，正常执行 migration SQL", async () => {
    const dir = await createMigrationDir({
      "150a_memory_entry_attachments.sql": "-- migration-aliases: 150_memory_entry_attachments.sql\nSELECT 42;",
    });
    const pool = new FakePool();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await migrate(pool as any, dir);

    expect(pool.executedBodies).toHaveLength(1);
    expect(pool.executedBodies[0]).toContain("SELECT 42;");
    expect(pool.insertedIds).toContain("150a_memory_entry_attachments.sql");
    expect(logSpy).toHaveBeenCalledWith("[migrate] applying: 150a_memory_entry_attachments.sql");
    expect(logSpy).toHaveBeenCalledWith("[migrate] done: 150a_memory_entry_attachments.sql");
    expect(pool.released).toBe(1);
  });
});
