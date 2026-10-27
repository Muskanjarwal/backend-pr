import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./types.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const LOCK_ID = 727_274_001; // arbitrary constant; serializes concurrent migrators (e.g. several pods booting)

export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    await db.tx(async (q) => {
      await q.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
      const done = await q.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (done.rowCount > 0) return;
      await q.exec(sql);
      await q.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    });
  }
  return applied;
}
