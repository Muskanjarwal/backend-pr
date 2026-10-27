import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable, QueryResult, Row } from "./types.js";

type Runner = Pick<PGlite, "query" | "exec">;

function wrap(r: Runner): Queryable {
  return {
    async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const res = await r.query<T>(sql, params as any[]);
      // PGlite reports affectedRows=0 for SELECT; node-postgres reports the row count. Normalize to the pg behaviour.
      return { rows: res.rows, rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0) };
    },
    async exec(sql: string) {
      await r.exec(sql);
    },
  };
}

/**
 * In-process Postgres (WASM) so the test-suite runs real SQL — partial unique indexes, FOR UPDATE SKIP LOCKED,
 * partitioned tables, triggers — with no Docker. CI additionally runs the same suite against a real server.
 */
export async function createPgliteDb(): Promise<Db> {
  const db = new PGlite();
  await db.waitReady;
  const base = wrap(db);
  return {
    ...base,
    tx: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as Runner))),
    ping: async () => {
      await db.query("SELECT 1");
    },
    close: () => db.close(),
  };
}
