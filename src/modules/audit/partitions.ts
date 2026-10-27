import type { Db } from "../../db/types.js";

const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Creates monthly partitions of audit_logs for the current month and `monthsAhead` more. Idempotent.
 * Rows that land before a partition exists go to audit_logs_default, so a missed run never loses data.
 * Returns the partitions created.
 */
export async function ensureAuditPartitions(db: Db, now: Date, monthsAhead: number): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i <= monthsAhead; i++) {
    const from = monthStart(now.getUTCFullYear(), now.getUTCMonth() + i);
    const to = monthStart(now.getUTCFullYear(), now.getUTCMonth() + i + 1);
    const name = `audit_logs_${from.getUTCFullYear()}_${String(from.getUTCMonth() + 1).padStart(2, "0")}`;
    const exists = await db.query("SELECT 1 FROM pg_class WHERE relname = $1 AND relnamespace = current_schema()::regnamespace", [name]);
    if (exists.rowCount > 0) continue;
    try {
      // Identifiers/dates are generated here, never user-supplied.
      await db.exec(`CREATE TABLE ${name} PARTITION OF audit_logs FOR VALUES FROM ('${ymd(from)}') TO ('${ymd(to)}')`);
      created.push(name);
    } catch (err) {
      // Fails if audit_logs_default already holds rows in this range; operator must move them. Not fatal.
      if (!/default partition/i.test(String((err as Error).message))) throw err;
    }
  }
  return created;
}
