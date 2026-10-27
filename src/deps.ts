import type { Config } from "./config.js";
import type { Db } from "./db/types.js";
import type { Cache } from "./lib/cache.js";
import { ReadThrough } from "./lib/cache.js";
import type { Clock } from "./lib/clock.js";
import { FieldCipher } from "./lib/crypto.js";
import type { PasswordHasher } from "./lib/password.js";
import type { Metrics } from "./observability/metrics.js";
import type { AuditService } from "./modules/audit/service.js";
import type { PaymentProvider } from "./modules/payments/provider.js";
import type { Notifier } from "./jobs/notifier.js";

/** Everything a service may depend on. Built once in server.ts / worker.ts / tests; passed by constructor, never imported globally. */
export interface Deps {
  config: Config;
  db: Db;
  cache: Cache;
  readThrough: ReadThrough;
  clock: Clock;
  cipher: FieldCipher;
  hasher: PasswordHasher;
  audit: AuditService;
  metrics: Metrics;
  paymentProvider: PaymentProvider;
  notifier: Notifier;
}
