import type { FastifyRequest } from "fastify";
import type { Db, Queryable } from "../db/types.js";
import type { Clock } from "../lib/clock.js";
import { sha256Hex } from "../lib/crypto.js";
import { badRequest, unprocessable, unauthorized } from "../lib/errors.js";

export interface IdempotentResult {
  status: number;
  body: unknown;
}

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Exactly-once effects for retried writes (client retries, mobile network flaps, gateway timeouts).
 *
 * The key row is inserted inside the SAME transaction as the business change:
 *   - crash before commit  → nothing persisted, the retry just runs normally;
 *   - concurrent duplicate → its INSERT blocks on the unique index until the first commits, then sees the row and
 *                            replays the stored response (no "in progress" state to get stuck in);
 *   - same key, new body   → 422, never a silent wrong replay.
 * Business errors (thrown) roll everything back, so a retry re-evaluates them — the correct behaviour for 409s.
 */
export class Idempotency {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async run(
    req: FastifyRequest,
    opts: { required: boolean },
    work: (q: Queryable) => Promise<IdempotentResult>,
  ): Promise<IdempotentResult & { replayed: boolean }> {
    const key = req.headers["idempotency-key"];
    if (key === undefined) {
      if (opts.required) throw badRequest("Idempotency-Key header is required for this operation");
      return { ...(await this.db.tx(work)), replayed: false };
    }
    if (typeof key !== "string" || !KEY_RE.test(key)) throw badRequest("Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-:.]");
    if (!req.actor) throw unauthorized();

    const userId = req.actor.id;
    const hash = sha256Hex(`${req.method}\n${req.routeOptions.url}\n${req.url}\n${req.rawBody ?? ""}`);
    const now = this.clock.now();

    return this.db.tx(async (q) => {
      const claimed = await q.query(
        `INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, response_status, response_body, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,0,'null',$6,$7) ON CONFLICT (user_id, key) DO NOTHING`,
        [userId, key, req.method, req.routeOptions.url ?? req.url, hash, now, new Date(now.getTime() + TTL_MS)],
      );
      if (claimed.rowCount === 0) {
        const { rows } = await q.query<{ request_hash: string; response_status: number; response_body: unknown }>(
          `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
          [userId, key],
        );
        const prior = rows[0];
        if (!prior || prior.request_hash !== hash) throw unprocessable("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
        return { status: prior.response_status, body: prior.response_body, replayed: true };
      }
      const result = await work(q);
      await q.query(`UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2`, [
        userId, key, result.status, JSON.stringify(result.body ?? null),
      ]);
      return { ...result, replayed: false };
    });
  }
}
