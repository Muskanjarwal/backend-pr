import pg from "pg";
import { backoffDelay } from "../lib/retry.js";
import type { Db, Queryable, QueryResult, Row } from "./types.js";

const RETRYABLE = new Set(["40001", "40P01"]); // serialization_failure, deadlock_detected
const MAX_TX_ATTEMPTS = 4;

// Parse int8 as number: counts/sums stay far below 2^53 and callers shouldn't deal with strings.
pg.types.setTypeParser(20, (v) => Number(v));

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T = Row>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
      const r = await client.query(sql, params as any[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

export interface PgOptions {
  connectionString: string;
  max?: number;
  statementTimeoutMs?: number;
  ssl?: boolean;
}

export function createPgDb(opts: PgOptions): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Bound runaway queries so one bad plan can't exhaust the pool and sink availability.
    statement_timeout: opts.statementTimeoutMs ?? 10_000,
    idle_in_transaction_session_timeout: 15_000,
    ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
  });
  // An idle client erroring (e.g. DB failover) must not crash the process.
  pool.on("error", () => {});
  const base = wrap(pool);

  return {
    ...base,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(wrap(client));
          await client.query("COMMIT");
          return result;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          const code = (err as { code?: string }).code;
          if (code && RETRYABLE.has(code) && attempt + 1 < MAX_TX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, backoffDelay(attempt, { baseMs: 20, maxMs: 400 })));
            continue;
          }
          throw err;
        } finally {
          client.release();
        }
      }
    },
    async ping() {
      await pool.query("SELECT 1");
    },
    async close() {
      await pool.end();
    },
    poolStats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
  };
}
