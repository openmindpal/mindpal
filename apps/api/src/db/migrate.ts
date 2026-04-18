import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

function extractMigrationAliases(sql: string): string[] {
  const aliases = new Set<string>();
  for (const line of sql.split(/\r?\n/).slice(0, 10)) {
    const match = line.match(/^\s*--\s*migration-aliases\s*:\s*(.+)\s*$/i);
    if (!match) continue;
    for (const alias of match[1].split(",").map((x) => x.trim()).filter(Boolean)) {
      aliases.add(alias);
    }
  }
  return Array.from(aliases);
}

function formatAliasSyncSummary(pairs: Array<{ file: string; matchedId: string }>): string | null {
  if (!pairs.length) return null;
  if (pairs.length <= 2) {
    const details = pairs.map((p) => `${p.file} <= ${p.matchedId}`).join(", ");
    return `[migrate] alias-sync summary: ${pairs.length} file(s) [${details}]`;
  }
  return `[migrate] alias-sync summary: ${pairs.length} file(s)`;
}

export async function migrate(pool: Pool, migrationsDir: string) {
  await pool.query("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");

  // Advisory lock prevents concurrent migration runs across multiple instances.
  // Lock key 0x4F53_4D49 = "OSMI" (OpenSLIn MIgrate).
  const ADVISORY_LOCK_KEY = 0x4F534D49;
  await pool.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    const aliasSyncedPairs: Array<{ file: string; matchedId: string }> = [];
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith(".sql"))
      .map((e) => e.name)
      .sort();

    // Detect numbering prefix collisions (e.g. two files starting with "048_")
    const prefixMap = new Map<string, string[]>();
    for (const f of files) {
      const m = f.match(/^(\d+)[_.]/);
      if (m) {
        const p = m[1];
        if (!prefixMap.has(p)) prefixMap.set(p, []);
        prefixMap.get(p)!.push(f);
      }
    }
    for (const [prefix, group] of prefixMap) {
      if (group.length > 1) {
        console.warn(`[migrate] WARNING: numbering prefix collision on "${prefix}": ${group.join(", ")}`);
      }
    }

    for (const file of files) {
      const id = file;
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      const aliases = extractMigrationAliases(sql);
      const knownIds = [id, ...aliases];
      const already = await pool.query<{ id: string }>(
        "SELECT id FROM migrations WHERE id = ANY($1::text[]) LIMIT 1",
        [knownIds],
      );
      if (already.rowCount && already.rowCount > 0) {
        const matchedId = String(already.rows[0]?.id ?? "");
        if (matchedId && matchedId !== id) {
          await pool.query("INSERT INTO migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [id]);
          aliasSyncedPairs.push({ file, matchedId });
        }
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        console.log(`[migrate] applying: ${file}`);
        await client.query(sql);
        await client.query("INSERT INTO migrations (id) VALUES ($1)", [id]);
        await client.query("COMMIT");
        console.log(`[migrate] done: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[migrate] FAILED on: ${file}`, err);
        throw err;
      } finally {
        client.release();
      }
    }
    const aliasSummary = formatAliasSyncSummary(aliasSyncedPairs);
    if (aliasSummary) console.log(aliasSummary);
  } finally {
    await pool.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
  }
}

