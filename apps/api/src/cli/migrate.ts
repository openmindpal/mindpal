import path from "node:path";
import { loadConfig } from "../config";
import { migrate } from "../db/migrate";
import { createPool } from "../db/pool";

async function main() {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg);
  const migrationsDir = path.resolve(process.cwd(), "migrations");
  await migrate(pool, migrationsDir);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

