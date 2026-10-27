import { loadConfig } from "../config.js";
import { createPgDb } from "./pg.js";
import { migrate } from "./migrate.js";
import { ensureAuditPartitions } from "../modules/audit/partitions.js";

const cfg = loadConfig();
const db = createPgDb({ connectionString: cfg.DATABASE_URL, max: 2, ssl: cfg.DATABASE_SSL });
try {
  const applied = await migrate(db);
  await ensureAuditPartitions(db, new Date(), 3);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await db.close();
}
