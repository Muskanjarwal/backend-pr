// End-to-end walkthrough against a running stack (API + worker + Postgres). Used for the demo video.
//   BASE_URL=http://localhost:3000 ADMIN_EMAIL=… ADMIN_PASSWORD=… ADMIN_TOTP_SECRET=… PAYMENT_WEBHOOK_SECRET=… npm run demo
import { randomUUID } from "node:crypto";
import { totp } from "../src/lib/totp.js";
import { signWebhook } from "../src/modules/payments/provider.js";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const need = (k: string) => process.env[k] ?? (console.error(`Missing env ${k}`), process.exit(1));
const PASSWORD = "demo-password-123456";
const run = Date.now().toString(36);

async function call(method: string, path: string, o: { token?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(o.body !== undefined || o.raw ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}), ...o.headers },
    body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
const step = (n: number, title: string) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const show = (label: string, v: unknown) => console.log(`   ${label}:`, typeof v === "string" ? v : JSON.stringify(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function adminLogin() {
  const l = await call("POST", "/v1/auth/login", { body: { email: need("ADMIN_EMAIL"), password: need("ADMIN_PASSWORD") } });
  const v = await call("POST", "/v1/auth/mfa/verify", { body: { mfaToken: l.body.mfaToken, code: totp(need("ADMIN_TOTP_SECRET"), new Date()) } });
  return v.body.tokens.accessToken as string;
}

step(1, "Admin signs in with password + TOTP");
const admin = await adminLogin();
show("admin session", "ok");

step(2, "A doctor registers; MFA enrollment is forced before first session");
const docEmail = `dr.${run}@example.com`;
const reg = await call("POST", "/v1/auth/register", { body: { email: docEmail, password: PASSWORD, fullName: `Dr Demo ${run}`, role: "doctor", doctor: { specialty: "ayurveda", registrationNumber: `REG-${run}`, yearsExperience: 12, languages: ["en", "hi"], feeMinor: 60000 } } });
const doctorId = reg.body.id as string;
const dl = await call("POST", "/v1/auth/login", { body: { email: docEmail, password: PASSWORD } });
show("login result", dl.body.status);
const setup = await call("POST", "/v1/auth/mfa/setup", { token: dl.body.setupToken });
const act = await call("POST", "/v1/auth/mfa/activate", { token: dl.body.setupToken, body: { code: totp(setup.body.secret, new Date()) } });
const doctor = act.body.tokens.accessToken as string;
show("doctor session after MFA enrollment", "ok");

step(3, "Admin verifies the doctor (audit-logged); doctor publishes availability");
await call("POST", `/v1/admin/doctors/${doctorId}/verification`, { token: admin, body: { status: "verified" } });
const start = new Date(Date.now() + 2 * 60_000);
const pub = await call("POST", "/v1/doctors/me/slots", { token: doctor, body: { windows: [{ start: start.toISOString(), end: new Date(start.getTime() + 90 * 60_000).toISOString() }], slotMinutes: 30 } });
show("slots", pub.body);

step(4, "A patient registers, searches, and books — with an Idempotency-Key");
const patEmail = `pat.${run}@example.com`;
await call("POST", "/v1/auth/register", { body: { email: patEmail, password: PASSWORD, fullName: "Pat Demo", role: "patient", phone: "+919876543210" } });
const patient = (await call("POST", "/v1/auth/login", { body: { email: patEmail, password: PASSWORD } })).body.tokens.accessToken as string;
const found = await call("GET", `/v1/doctors?specialty=ayurveda&q=Dr%20Demo%20${run}`, { token: patient });
show("search hit", found.body.items.map((d: any) => `${d.fullName} (₹${d.feeMinor / 100})`));
const slots = (await call("GET", `/v1/doctors/${doctorId}/slots`, { token: patient })).body.items;
const key = randomUUID();
const booking = await call("POST", "/v1/consultations", { token: patient, headers: { "idempotency-key": key }, body: { slotId: slots[0].id, reason: "Recurring migraine for two weeks" } });
show("booking", { status: booking.status, state: booking.body.status, holdExpiresAt: booking.body.holdExpiresAt });
const retry = await call("POST", "/v1/consultations", { token: patient, headers: { "idempotency-key": key }, body: { slotId: slots[0].id, reason: "Recurring migraine for two weeks" } });
show("network retry with the same key", { sameId: retry.body.id === booking.body.id, replayed: retry.headers.get("idempotent-replayed") });
const rival = await call("POST", "/v1/auth/register", { body: { email: `rival.${run}@example.com`, password: PASSWORD, fullName: "Rival", role: "patient" } });
const rivalTok = (await call("POST", "/v1/auth/login", { body: { email: `rival.${run}@example.com`, password: PASSWORD } })).body.tokens.accessToken;
const lost = await call("POST", "/v1/consultations", { token: rivalTok, headers: { "idempotency-key": randomUUID() }, body: { slotId: slots[0].id } });
show("a second patient tries the same slot", { status: lost.status, code: lost.body.error.code });

step(5, "Worker creates the payment intent (outbox); PSP webhook confirms the booking");
let pay = (await call("GET", `/v1/payments/${booking.body.payment.id}`, { token: patient })).body;
for (let i = 0; i < 15 && !pay.checkoutUrl; i++) { await sleep(500); pay = (await call("GET", `/v1/payments/${booking.body.payment.id}`, { token: patient })).body; }
show("checkout url", pay.checkoutUrl);
const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: "payment.succeeded", data: { paymentId: `mock_pay_${pay.id}` } });
const hdr = { "x-signature": signWebhook(need("PAYMENT_WEBHOOK_SECRET"), raw, new Date()) };
show("unsigned webhook", (await call("POST", "/v1/payments/webhook", { raw })).status);
show("signed webhook", (await call("POST", "/v1/payments/webhook", { raw, headers: hdr })).body);
show("replayed webhook", (await call("POST", "/v1/payments/webhook", { raw, headers: hdr })).body);
show("consultation", (await call("GET", `/v1/consultations/${booking.body.id}`, { token: patient })).body.status);

step(6, "Consultation runs; doctor issues an encrypted prescription (idempotent)");
await call("POST", `/v1/consultations/${booking.body.id}/start`, { token: doctor });
const rx = await call("POST", `/v1/consultations/${booking.body.id}/prescriptions`, { token: doctor, headers: { "idempotency-key": randomUUID() }, body: { items: [{ medicine: "Brahmi", dosage: "500mg", frequency: "twice daily", durationDays: 21 }], notes: "Reduce screen time" } });
show("prescription", { id: rx.body.id, items: rx.body.items.length });
await call("POST", `/v1/consultations/${booking.body.id}/complete`, { token: doctor });
show("patient reads prescription", (await call("GET", `/v1/consultations/${booking.body.id}/prescriptions`, { token: patient })).body.items[0].notes);

step(7, "Compliance: tamper-evident audit trail, and admin analytics");
const audit = await call("GET", `/v1/admin/audit-logs?entityType=consultation&entityId=${booking.body.id}&verify=true`, { token: admin });
show("audit entries for this consultation", audit.body.items.map((a: any) => `${a.action}${a.signatureValid ? " ✓sig" : " ✗sig"}`).reverse());
await call("POST", "/v1/admin/analytics/refresh", { token: admin });
await sleep(2500);
const day = new Date(slots[0].startsAt);
const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
show("analytics", (await call("GET", `/v1/admin/analytics/summary?from=${from.toISOString()}&to=${new Date(+from + 86_400_000).toISOString()}`, { token: admin })).body.totals);
console.log("\n\x1b[32mDemo complete.\x1b[0m");
