import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

export async function migrate(pool: Pool, migrationsDir: string) {
  await pool.query("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");

  const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();

  for (const file of files) {
    const id = file;
    const already = await pool.query("SELECT 1 FROM migrations WHERE id = $1", [id]);
    if (already.rowCount && already.rowCount > 0) continue;

    const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO migrations (id) VALUES ($1)", [id]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }
  }
}

