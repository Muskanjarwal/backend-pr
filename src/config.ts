import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  METRICS_PORT: z.coerce.number().int().default(9464),
  WORKER_METRICS_PORT: z.coerce.number().int().default(9465),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  TRUST_PROXY: bool.default(false),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(20),
  REDIS_URL: z.string().optional(),

  // Secrets: always from the environment (or a secret manager that injects env), never from code.
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(), // set only during a JWT secret rotation
  JWT_ISSUER: z.string().default("amrutam"),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().default(60 * 60 * 24 * 30),
  DATA_ENCRYPTION_KEYS: z.string().min(1),
  AUDIT_HMAC_KEYS: z.string().min(1),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  PAYMENT_PROVIDER: z.enum(["mock"]).default("mock"),
  PASSWORD_SCRYPT_N: z.coerce.number().int().default(32768),

  SLOT_HOLD_MINUTES: z.coerce.number().int().min(1).default(10),
  FREE_CANCELLATION_HOURS: z.coerce.number().int().min(0).default(24),
  MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().default(600),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().default(10),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  WORKER_POLL_MS: z.coerce.number().int().min(50).default(1000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names only — never echo values, they may be secrets.
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${problems}`);
  }
  return parsed.data;
}
