import fs from "node:fs/promises";
import path from "node:path";
import { StructuredLogger } from "@openslin/shared";

const _logger = new StructuredLogger({ module: "cli:migrate" });
import { loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";

async function findMigrationsDir(): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "../../migrations"),
    path.resolve(process.cwd(), "apps/api/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isDirectory()) return c;
    } catch {
      continue;
    }
  }
  return candidates[2];
}

async function main() {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);
  await migrate(pool, await findMigrationsDir());
  await pool.end();
}

main().catch((err) => {
  _logger.error("migration failed", { error: (err as Error)?.message ?? err });
  process.exit(1);
});
