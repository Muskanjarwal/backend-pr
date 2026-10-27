import { Redis } from "ioredis";
import type { Config } from "./config.js";
import type { Deps } from "./deps.js";
import { createPgDb } from "./db/pg.js";
import { MemoryCache, ReadThrough, RedisCache, ResilientCache, type Cache } from "./lib/cache.js";
import { systemClock } from "./lib/clock.js";
import { FieldCipher, Keyring } from "./lib/crypto.js";
import { PasswordHasher } from "./lib/password.js";
import { LogNotifier } from "./jobs/notifier.js";
import { AuditService } from "./modules/audit/service.js";
import { MockPaymentProvider } from "./modules/payments/provider.js";
import { createMetrics } from "./observability/metrics.js";

export function buildDeps(config: Config, db: Deps["db"], cache: Cache, log?: { info: (...a: any[]) => void }): Deps {
  const metrics = createMetrics(db);
  return {
    config,
    db,
    cache,
    readThrough: new ReadThrough(cache, (name, hit) => metrics.cacheLookups.inc({ cache: name, result: hit ? "hit" : "miss" })),
    clock: systemClock,
    cipher: new FieldCipher(new Keyring(config.DATA_ENCRYPTION_KEYS)),
    hasher: new PasswordHasher({ N: config.PASSWORD_SCRYPT_N, r: 8, p: 1 }),
    audit: new AuditService(new Keyring(config.AUDIT_HMAC_KEYS), systemClock),
    metrics,
    paymentProvider: new MockPaymentProvider(),
    notifier: new LogNotifier(log),
  };
}

/** Shared by the API and worker entrypoints. */
export function connect(config: Config, log?: { warn: (...a: any[]) => void; info: (...a: any[]) => void }) {
  const db = createPgDb({ connectionString: config.DATABASE_URL, max: config.DB_POOL_MAX, ssl: config.DATABASE_SSL });
  let redis: Redis | undefined;
  let cache: Cache = new MemoryCache();
  if (config.REDIS_URL) {
    redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false });
    redis.on("error", () => {}); // surfaced via ResilientCache/readiness, not as unhandled events
    cache = new ResilientCache(new RedisCache(redis), (op, err) => log?.warn({ op, err: String(err) }, "cache error; serving uncached"));
  }
  return { db, redis, cache, deps: buildDeps(config, db, cache, log) };
}
