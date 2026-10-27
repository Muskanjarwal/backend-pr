export type Row = Record<string, any>;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Multi-statement, parameterless SQL (migrations only). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /**
   * Runs `fn` in a transaction. On serialization failures / deadlocks (SQLSTATE 40001 / 40P01) the whole callback is
   * retried with jittered backoff, so `fn` must be safe to re-run: do all writes through the supplied `q`, and keep
   * external side effects (HTTP calls, cache invalidation) outside it.
   */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  ping(): Promise<void>;
  close(): Promise<void>;
  poolStats?(): { total: number; idle: number; waiting: number };
}
