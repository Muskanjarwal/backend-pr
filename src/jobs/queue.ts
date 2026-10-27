import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/types.js";
import { backoffDelay } from "../lib/retry.js";

export interface EnqueueOptions {
  runAt?: Date;
  /** At most one queued/running job per dedupe key. */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface Job {
  id: string;
  type: string;
  payload: any;
  attempts: number;
  max_attempts: number;
}

/** Retry schedule for failed jobs: full-jitter exponential, 5s base, capped at 30 min. attempts=1 after the first run. */
export const JOB_BACKOFF = { baseMs: 5_000, maxMs: 30 * 60_000 };

/**
 * Pass the caller's transaction to make this an outbox write: the job exists if and only if the business change
 * committed. That is what lets saga steps survive a crash between "state changed" and "side effect requested".
 */
export async function enqueue(q: Queryable, now: Date, type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
  await q.query(
    `INSERT INTO jobs (id, type, payload, run_at, dedupe_key, max_attempts, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING`,
    [randomUUID(), type, JSON.stringify(payload ?? {}), opts.runAt ?? now, opts.dedupeKey ?? null, opts.maxAttempts ?? 8, now],
  );
}

export class JobStore {
  constructor(private readonly db: Db) {}

  /** Claim up to `limit` due jobs. SKIP LOCKED lets any number of workers pull concurrently without blocking each other. */
  async claim(now: Date, limit: number, leaseMs: number): Promise<Job[]> {
    const { rows } = await this.db.query<Job>(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = $1, locked_until = $2
       WHERE id IN (
         SELECT id FROM jobs
         WHERE (status = 'queued' AND run_at <= $1) OR (status = 'running' AND locked_until < $1)
         ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $3)
       RETURNING id, type, payload, attempts, max_attempts`,
      [now, new Date(now.getTime() + leaseMs), limit],
    );
    return rows;
  }

  async succeed(id: string, now: Date): Promise<void> {
    await this.db.query(`UPDATE jobs SET status='succeeded', locked_until=NULL, last_error=NULL, updated_at=$2 WHERE id=$1`, [id, now]);
  }

  /** Returns "dead" once attempts are exhausted (job parks for manual inspection/replay), else "retry". */
  async fail(job: Job, err: unknown, now: Date, rand = Math.random): Promise<"retry" | "dead"> {
    const message = String((err as Error)?.message ?? err).slice(0, 1000);
    if (job.attempts >= job.max_attempts) {
      await this.db.query(`UPDATE jobs SET status='dead', locked_until=NULL, last_error=$2, updated_at=$3 WHERE id=$1`, [job.id, message, now]);
      return "dead";
    }
    const runAt = new Date(now.getTime() + backoffDelay(job.attempts - 1, JOB_BACKOFF, rand));
    await this.db.query(`UPDATE jobs SET status='queued', locked_until=NULL, last_error=$2, run_at=$3, updated_at=$4 WHERE id=$1`, [job.id, message, runAt, now]);
    return "retry";
  }

  /** Insert a recurring job unless one ran/was queued within the last `everyMs`. Safe to call from every worker. */
  async ensureRecurring(now: Date, type: string, everyMs: number): Promise<void> {
    await this.db.query(
      `INSERT INTO jobs (id, type, payload, run_at, dedupe_key, created_at, updated_at)
       SELECT $1, $2, '{}', $3, $4, $3, $3
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE type = $2 AND created_at > $5)
       ON CONFLICT DO NOTHING`,
      [randomUUID(), type, now, `cron:${type}`, new Date(now.getTime() - everyMs)],
    );
  }

  async depth(now: Date): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE status = 'queued' AND run_at <= $1`,
      [now],
    );
    return rows[0]?.n ?? 0;
  }
}
