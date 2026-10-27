// Closed-loop load/concurrency check against a running API. Registers a pool of patients, then drives a read-heavy
// mix (search, slot listing, consultation list) plus a booking contention test. Prints latency percentiles vs the SLO.
//   BASE_URL=… ADMIN_EMAIL=… ADMIN_PASSWORD=… ADMIN_TOTP_SECRET=… npm run loadtest
import { randomUUID } from "node:crypto";
import { totp } from "../src/lib/totp.js";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PATIENTS = Number(process.env.PATIENTS ?? 40);
const DURATION_S = Number(process.env.DURATION_S ?? 15);
const need = (k: string) => process.env[k] ?? (console.error(`Missing env ${k}`), process.exit(1));
const PASSWORD = "loadtest-password-123456";
const run = Date.now().toString(36);

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, ms: performance.now() - t0 };
}
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? 0;

// --- setup -------------------------------------------------------------------------------------------------------
const l = await call("POST", "/v1/auth/login", { body: { email: need("ADMIN_EMAIL"), password: need("ADMIN_PASSWORD") } });
const admin = (await call("POST", "/v1/auth/mfa/verify", { body: { mfaToken: l.body.mfaToken, code: totp(need("ADMIN_TOTP_SECRET"), new Date()) } })).body.tokens.accessToken as string;

const docEmail = `lt.dr.${run}@example.com`;
const reg = await call("POST", "/v1/auth/register", { body: { email: docEmail, password: PASSWORD, fullName: `Dr Load ${run}`, role: "doctor", doctor: { specialty: "loadtest", registrationNumber: `LT-${run}`, yearsExperience: 5, feeMinor: 10000 } } });
const dl = await call("POST", "/v1/auth/login", { body: { email: docEmail, password: PASSWORD } });
const setup = await call("POST", "/v1/auth/mfa/setup", { token: dl.body.setupToken });
const doctor = (await call("POST", "/v1/auth/mfa/activate", { token: dl.body.setupToken, body: { code: totp(setup.body.secret, new Date()) } })).body.tokens.accessToken as string;
await call("POST", `/v1/admin/doctors/${reg.body.id}/verification`, { token: admin, body: { status: "verified" } });
const start = new Date(Date.now() + 3 * 86_400_000);
await call("POST", "/v1/doctors/me/slots", { token: doctor, body: { windows: [{ start: start.toISOString(), end: new Date(+start + 20 * 3_600_000).toISOString() }], slotMinutes: 15 } });

const tokens: string[] = [];
for (let i = 0; i < PATIENTS; i += 10) {
  await Promise.all(Array.from({ length: Math.min(10, PATIENTS - i) }, async (_, j) => {
    const email = `lt.p${i + j}.${run}@example.com`;
    await call("POST", "/v1/auth/register", { body: { email, password: PASSWORD, fullName: `LT Patient ${i + j}`, role: "patient" } });
    tokens.push((await call("POST", "/v1/auth/login", { body: { email, password: PASSWORD } })).body.tokens.accessToken);
  }));
}
const slots = (await call("GET", `/v1/doctors/${reg.body.id}/slots?from=${start.toISOString()}&to=${new Date(+start + 21 * 3_600_000).toISOString()}`, { token: tokens[0] })).body.items as Array<{ id: string }>;
console.log(`Setup: ${tokens.length} patients, ${slots.length} slots`);

// --- 1. contention: every patient fights for the SAME slot --------------------------------------------------------
const target = slots[0]!.id;
const fight = await Promise.all(tokens.map((t) => call("POST", "/v1/consultations", { token: t, headers: { "idempotency-key": randomUUID() }, body: { slotId: target } })));
const won = fight.filter((r) => r.status === 201).length;
console.log(`\nContention: ${tokens.length} simultaneous bookings for one slot -> ${won} succeeded, ${fight.filter((r) => r.status === 409).length} conflicts, ${fight.filter((r) => r.status >= 500).length} errors  ${won === 1 ? "✓ no double booking" : "✗ DOUBLE BOOKING"}`);

// --- 2. sustained mix -------------------------------------------------------------------------------------------
const reads: number[] = [];
const writes: number[] = [];
const errors: Record<string, number> = {};
const deadline = Date.now() + DURATION_S * 1000;
let nextSlot = 1;
await Promise.all(tokens.map(async (token, idx) => {
  while (Date.now() < deadline) {
    const roll = Math.random();
    let r;
    if (roll < 0.45) { r = await call("GET", `/v1/doctors?specialty=loadtest&limit=20`, { token }); reads.push(r.ms); }
    else if (roll < 0.8) { r = await call("GET", `/v1/doctors/${reg.body.id}/slots?from=${start.toISOString()}&to=${new Date(+start + 21 * 3_600_000).toISOString()}`, { token }); reads.push(r.ms); }
    else if (roll < 0.9) { r = await call("GET", `/v1/consultations?limit=20`, { token }); reads.push(r.ms); }
    else if (nextSlot < slots.length) {
      r = await call("POST", "/v1/consultations", { token, headers: { "idempotency-key": randomUUID() }, body: { slotId: slots[nextSlot++]!.id } });
      writes.push(r.ms);
    } else continue;
    if (r.status >= 400 && r.status !== 409) errors[r.status] = (errors[r.status] ?? 0) + 1;
  }
  void idx;
}));
const row = (name: string, xs: number[], slo: number) =>
  console.log(`${name.padEnd(7)} n=${String(xs.length).padStart(6)}  p50=${pct(xs, 50).toFixed(1)}ms  p95=${pct(xs, 95).toFixed(1)}ms  p99=${pct(xs, 99).toFixed(1)}ms   SLO p95<${slo}ms ${pct(xs, 95) < slo ? "✓" : "✗"}`);
console.log(`\nSustained load: ${tokens.length} concurrent clients for ${DURATION_S}s  (${((reads.length + writes.length) / DURATION_S).toFixed(0)} req/s)`);
row("reads", reads, 200);
row("writes", writes, 500);
console.log("unexpected errors:", Object.keys(errors).length ? errors : "none");
