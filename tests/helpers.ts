import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { createPgDb } from "../src/db/pg.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/migrate.js";
import { buildDeps } from "../src/bootstrap.js";
import type { Deps } from "../src/deps.js";
import { MemoryCache } from "../src/lib/cache.js";
import { FakeClock } from "../src/lib/clock.js";
import { FieldCipher, Keyring } from "../src/lib/crypto.js";
import { PasswordHasher } from "../src/lib/password.js";
import { totp } from "../src/lib/totp.js";
import { ReadThrough } from "../src/lib/cache.js";
import { AuditService } from "../src/modules/audit/service.js";
import { MockPaymentProvider, signWebhook } from "../src/modules/payments/provider.js";
import { LogNotifier } from "../src/jobs/notifier.js";
import { Worker } from "../src/jobs/worker.js";
import { ensureAuditPartitions } from "../src/modules/audit/partitions.js";

const key = () => randomBytes(32).toString("base64");

export const WEBHOOK_SECRET = "test-webhook-secret-1234567890";

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    JWT_SECRET: "test-jwt-secret-that-is-long-enough-123456",
    DATA_ENCRYPTION_KEYS: `1:${key()}`,
    AUDIT_HMAC_KEYS: `1:${key()}`,
    PAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PASSWORD_SCRYPT_N: "1024", // fast hashing for tests only
    RATE_LIMIT_GLOBAL_PER_MIN: "100000",
    RATE_LIMIT_AUTH_PER_MIN: "100000",
    ...over,
  } as NodeJS.ProcessEnv);
}

/** TEST_DATABASE_URL → real Postgres (isolated schema per env); otherwise in-process Postgres (PGlite). */
async function makeDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return { db: await createPgliteDb(), cleanup: async () => {} };
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const u = new URL(url);
  u.searchParams.set("options", `-c search_path=${schema}`);
  const db = createPgDb({ connectionString: u.toString(), max: 10 });
  return {
    db,
    cleanup: async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

export interface Env {
  app: FastifyInstance;
  deps: Deps;
  clock: FakeClock;
  provider: MockPaymentProvider;
  notifier: LogNotifier;
  worker: Worker;
  close(): Promise<void>;
  api(method: string, url: string, opts?: { token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Record<string, any> }>;
}

export async function createEnv(configOverrides: Record<string, string> = {}): Promise<Env> {
  const config = testConfig(configOverrides);
  const { db, cleanup } = await makeDb();
  await migrate(db);
  const clock = new FakeClock(new Date("2030-01-01T00:00:00Z"));
  await ensureAuditPartitions(db, clock.now(), 3);

  const base = buildDeps(config, db, new MemoryCache());
  const provider = new MockPaymentProvider();
  const notifier = new LogNotifier();
  const deps: Deps = {
    ...base,
    clock,
    hasher: new PasswordHasher({ N: config.PASSWORD_SCRYPT_N, r: 8, p: 1 }),
    cipher: new FieldCipher(new Keyring(config.DATA_ENCRYPTION_KEYS)),
    audit: new AuditService(new Keyring(config.AUDIT_HMAC_KEYS), clock),
    readThrough: new ReadThrough(base.cache),
    paymentProvider: provider,
    notifier,
  };
  const app = await buildApp(deps);
  await app.ready();
  const worker = new Worker(deps, { info() {}, warn() {}, error() {} });

  return {
    app, deps, clock, provider, notifier, worker,
    async close() {
      await app.close();
      await db.close();
      await cleanup();
    },
    async api(method, url, opts = {}) {
      const res = await app.inject({
        method: method as any,
        url,
        headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
        payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      let body: any = null;
      try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
      return { status: res.statusCode, body, headers: res.headers };
    },
  };
}

export const PASSWORD = "correct-horse-battery-staple";
let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

export async function registerPatient(env: Env, name = "Pat Patient") {
  const email = `patient-${uniq()}@example.com`;
  const reg = await env.api("POST", "/v1/auth/register", { body: { email, password: PASSWORD, fullName: name, role: "patient", phone: "+919876543210" } });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const login = await env.api("POST", "/v1/auth/login", { body: { email, password: PASSWORD } });
  return { id: reg.body.id as string, email, token: login.body.tokens.accessToken as string, refreshToken: login.body.tokens.refreshToken as string };
}

/** Doctors/admins must enroll in MFA before getting a session; this walks the real flow. */
async function loginWithMfaEnrollment(env: Env, email: string) {
  const login = await env.api("POST", "/v1/auth/login", { body: { email, password: PASSWORD } });
  if (login.body.status !== "mfa_setup_required") throw new Error(`expected mfa_setup_required, got ${JSON.stringify(login.body)}`);
  const setupToken = login.body.setupToken as string;
  const setup = await env.api("POST", "/v1/auth/mfa/setup", { token: setupToken });
  const activate = await env.api("POST", "/v1/auth/mfa/activate", { token: setupToken, body: { code: totp(setup.body.secret, env.clock.now()) } });
  if (activate.status !== 200) throw new Error(`activate failed ${JSON.stringify(activate.body)}`);
  return { secret: setup.body.secret as string, token: activate.body.tokens.accessToken as string };
}

export async function registerDoctor(env: Env, o: { name?: string; specialty?: string; feeMinor?: number; verify?: boolean; adminToken?: string } = {}) {
  const email = `doctor-${uniq()}@example.com`;
  const reg = await env.api("POST", "/v1/auth/register", {
    body: {
      email, password: PASSWORD, fullName: o.name ?? "Dr Asha Rao", role: "doctor",
      doctor: { specialty: o.specialty ?? "ayurveda", registrationNumber: `REG-${uniq()}`, yearsExperience: 8, languages: ["en", "hi"], feeMinor: o.feeMinor ?? 50_000 },
    },
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const session = await loginWithMfaEnrollment(env, email);
  if (o.verify !== false) {
    const admin = o.adminToken ?? (await createAdmin(env)).token;
    const v = await env.api("POST", `/v1/admin/doctors/${reg.body.id}/verification`, { token: admin, body: { status: "verified" } });
    if (v.status !== 204) throw new Error(`verify failed ${JSON.stringify(v.body)}`);
  }
  return { id: reg.body.id as string, email, ...session };
}

export async function createAdmin(env: Env) {
  const email = `admin-${uniq()}@example.com`;
  const id = randomUUID();
  const now = env.clock.now();
  await env.deps.db.query(`INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ($1,$2,$3,'admin',$4,$4)`, [id, email, await env.deps.hasher.hash(PASSWORD), now]);
  await env.deps.db.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1,'Ada Admin')`, [id]);
  return { id, email, ...(await loginWithMfaEnrollment(env, email)) };
}

/** Publish `count` consecutive 30-minute slots starting `startInHours` from the fake clock's now. */
export async function publishSlots(env: Env, doctor: { token: string }, o: { startInHours?: number; count?: number; slotMinutes?: number } = {}) {
  const slotMinutes = o.slotMinutes ?? 30;
  const start = new Date(env.clock.now().getTime() + (o.startInHours ?? 48) * 3_600_000);
  const end = new Date(start.getTime() + (o.count ?? 4) * slotMinutes * 60_000);
  const res = await env.api("POST", "/v1/doctors/me/slots", { token: doctor.token, body: { windows: [{ start: start.toISOString(), end: end.toISOString() }], slotMinutes } });
  if (res.status !== 201) throw new Error(`slot publish failed ${JSON.stringify(res.body)}`);
  return res;
}

export async function listOpenSlots(env: Env, doctor: { id: string }, token: string) {
  const to = new Date(env.clock.now().getTime() + 30 * 86_400_000).toISOString();
  const res = await env.api("GET", `/v1/doctors/${doctor.id}/slots?to=${encodeURIComponent(to)}`, { token });
  return res.body.items as Array<{ id: string; startsAt: string; endsAt: string }>;
}

export const book = (env: Env, patient: { token: string }, slotId: string, key = randomUUID(), reason?: string) =>
  env.api("POST", "/v1/consultations", { token: patient.token, headers: { "idempotency-key": key }, body: { slotId, ...(reason ? { reason } : {}) } });

/** Simulates the PSP calling our webhook with a valid signature. */
export async function pspWebhook(env: Env, type: "payment.succeeded" | "payment.failed" | "refund.succeeded", providerPaymentId: string, eventId = randomUUID()) {
  const raw = JSON.stringify({ id: eventId, type, data: { paymentId: providerPaymentId } });
  return env.api("POST", "/v1/payments/webhook", { headers: { "content-type": "application/json", "x-signature": signWebhook(WEBHOOK_SECRET, raw, env.clock.now()) }, body: JSON.parse(raw) });
}

/** Drain the job queue (create_intent, notify, …) until idle. */
export async function drainJobs(env: Env, rounds = 10) {
  for (let i = 0; i < rounds; i++) if ((await env.worker.runOnce(50)) === 0) return;
}

/** Book a slot and complete payment: returns the confirmed consultation. */
export async function bookAndPay(env: Env, patient: { token: string }, slotId: string) {
  const b = await book(env, patient, slotId);
  if (b.status !== 201) throw new Error(`book failed ${JSON.stringify(b.body)}`);
  await drainJobs(env);
  const pay = await env.api("GET", `/v1/payments/${b.body.payment.id}`, { token: patient.token });
  await pspWebhook(env, "payment.succeeded", `mock_pay_${pay.body.id}`);
  return b.body.id as string;
}
