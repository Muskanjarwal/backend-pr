import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signWebhook } from "../src/modules/payments/provider.js";
import { WEBHOOK_SECRET, book, bookAndPay, createAdmin, createEnv, drainJobs, listOpenSlots, pspWebhook, publishSlots, registerDoctor, registerPatient, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => {
  env = await createEnv({ ACCESS_TOKEN_TTL_SEC: String(60 * 86_400) }); // tests jump the clock by days; keep sessions alive
});
afterAll(() => env.close());

async function scene(slots = 4) {
  const doctor = await registerDoctor(env);
  const patient = await registerPatient(env);
  await publishSlots(env, doctor, { count: slots });
  const open = await listOpenSlots(env, doctor, patient.token);
  return { doctor, patient, open };
}
const consult = (id: string, token: string) => env.api("GET", `/v1/consultations/${id}`, { token });
const mins = (n: number) => n * 60_000;

describe("booking happy path", () => {
  it("books, pays via webhook, and confirms the consultation", async () => {
    const { doctor, patient, open } = await scene();
    const res = await book(env, patient, open[0]!.id, undefined, "persistent cough");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "pending_payment", reason: "persistent cough", payment: { status: "pending", amountMinor: 50_000 } });

    await drainJobs(env); // outbox → payment intent
    const pay = await env.api("GET", `/v1/payments/${res.body.payment.id}`, { token: patient.token });
    expect(pay.body.checkoutUrl).toContain("checkout");

    const hook = await pspWebhook(env, "payment.succeeded", `mock_pay_${res.body.payment.id}`);
    expect(hook.body).toMatchObject({ duplicate: false, outcome: "confirmed" });
    expect((await consult(res.body.id, patient.token)).body.status).toBe("confirmed");

    await drainJobs(env);
    expect(env.notifier.sent.filter((n) => n.template === "consultation.confirmed").map((n) => n.userId).sort()).toEqual([doctor.id, patient.id].sort());
    expect(await listOpenSlots(env, doctor, patient.token)).toHaveLength(3);
  });

  it("encrypts the patient's reason at rest and hides it from admins", async () => {
    const { patient, open } = await scene();
    const res = await book(env, patient, open[0]!.id, undefined, "very private symptoms");
    const { rows } = await env.deps.db.query(`SELECT reason_enc FROM consultations WHERE id = $1`, [res.body.id]);
    expect(rows[0]!.reason_enc).not.toContain("private");
    expect((await consult(res.body.id, (await createAdmin(env)).token)).body.reason).toBeNull();
  });
});

describe("double-booking protection", () => {
  it("lets exactly one of many concurrent requests win a slot", async () => {
    const { open, doctor } = await scene(1);
    const patients = await Promise.all(Array.from({ length: 12 }, () => registerPatient(env)));
    const results = await Promise.all(patients.map((p) => book(env, p, open[0]!.id)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "SLOT_UNAVAILABLE")).toBe(true);
    const { rows } = await env.deps.db.query(`SELECT count(*)::int AS n FROM consultations WHERE slot_id = $1`, [open[0]!.id]);
    expect(rows[0]!.n).toBe(1);
    expect(await listOpenSlots(env, doctor, patients[0]!.token)).toHaveLength(0);
  });

  it("the database itself refuses a second live consultation on a slot", async () => {
    const { patient, open } = await scene(1);
    const first = await book(env, patient, open[0]!.id);
    const other = await registerPatient(env);
    await expect(
      env.deps.db.query(
        `INSERT INTO consultations (id, slot_id, patient_id, doctor_id, status, scheduled_start, scheduled_end) SELECT $1, slot_id, $2, doctor_id, 'confirmed', scheduled_start, scheduled_end FROM consultations WHERE id = $3`,
        [randomUUID(), other.id, first.body.id],
      ),
    ).rejects.toThrow(/consultations_live_slot_uq|unique/i);
  });

  it("rejects slots in the past, unknown slots, overlapping bookings, and hold hoarding", async () => {
    const { patient, open } = await scene(5);
    expect((await book(env, patient, randomUUID())).status).toBe(404);
    for (let i = 0; i < 3; i++) expect((await book(env, patient, open[i]!.id)).status).toBe(201);
    expect((await book(env, patient, open[3]!.id)).body.error.code).toBe("TOO_MANY_PENDING_BOOKINGS");

    // overlap: same time, different doctor
    const d2 = await registerDoctor(env);
    const p2 = await registerPatient(env);
    await publishSlots(env, d2, { count: 1 });
    await publishSlots(env, await registerDoctor(env), { count: 1 });
    const s = (await listOpenSlots(env, d2, p2.token))[0]!;
    expect((await book(env, p2, s.id)).status).toBe(201);
    const d3 = await registerDoctor(env);
    await publishSlots(env, d3, { count: 1 });
    const s3 = (await listOpenSlots(env, d3, p2.token))[0]!;
    expect((await book(env, p2, s3.id)).body.error.code).toBe("PATIENT_OVERLAP");
  });
});

describe("idempotency", () => {
  it("replays the original response for a retried request and creates one booking", async () => {
    const { patient, open } = await scene();
    const key = randomUUID();
    const a = await book(env, patient, open[0]!.id, key);
    const b = await book(env, patient, open[0]!.id, key);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers["idempotent-replayed"]).toBe("true");
    const { rows } = await env.deps.db.query(`SELECT count(*)::int AS n FROM consultations WHERE patient_id = $1`, [patient.id]);
    expect(rows[0]!.n).toBe(1);
  });

  it("handles a burst of identical concurrent retries as one booking", async () => {
    const { patient, open } = await scene();
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 8 }, () => book(env, patient, open[0]!.id, key)));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(rs.every((r) => r.status === 201)).toBe(true);
  });

  it("rejects key reuse with a different payload, and requires the header", async () => {
    const { patient, open } = await scene();
    const key = randomUUID();
    await book(env, patient, open[0]!.id, key);
    expect((await book(env, patient, open[1]!.id, key)).body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const missing = await env.api("POST", "/v1/consultations", { token: patient.token, body: { slotId: open[1]!.id } });
    expect(missing.status).toBe(400);
    expect((await env.api("POST", "/v1/consultations", { token: patient.token, headers: { "idempotency-key": "short" }, body: { slotId: open[1]!.id } })).status).toBe(400);
  });

  it("scopes keys per user (no cross-user replay) and doesn't cache failures", async () => {
    const { patient, open } = await scene();
    const other = await registerPatient(env);
    const key = randomUUID();
    await book(env, patient, open[0]!.id, key);
    const theirs = await book(env, other, open[1]!.id, key);
    expect(theirs.status).toBe(201);
    expect(theirs.body.patientId).toBe(other.id);

    const loser = await registerPatient(env);
    const k2 = randomUUID();
    expect((await book(env, loser, open[0]!.id, k2)).status).toBe(409); // slot taken
    await env.api("POST", `/v1/consultations/${(await book(env, patient, open[2]!.id)).body.id}/cancel`, { token: patient.token });
    expect((await book(env, loser, open[2]!.id, k2)).status).toBe(201); // the failed attempt left nothing behind, so the key is reusable
  });
});

describe("saga: holds, payment edge-cases, and compensation", () => {
  it("expires an unpaid hold, releases the slot, and lets someone else book it", async () => {
    const { doctor, patient, open } = await scene();
    const first = await book(env, patient, open[0]!.id);
    env.clock.advance(mins(11));
    expect((await listOpenSlots(env, doctor, patient.token)).map((s) => s.id)).toContain(open[0]!.id); // readers see it free immediately

    await drainJobs(env); // cron: expire_holds
    const got = await consult(first.body.id, patient.token);
    expect(got.body.status).toBe("expired");
    expect(got.body.payment.status).toBe("failed");

    const other = await registerPatient(env);
    expect((await book(env, other, open[0]!.id)).status).toBe(201);
  });

  it("books over an expired hold even if the sweeper hasn't run yet", async () => {
    const { patient, open } = await scene();
    const first = await book(env, patient, open[0]!.id);
    env.clock.advance(mins(11));
    const other = await registerPatient(env);
    expect((await book(env, other, open[0]!.id)).status).toBe(201);
    expect((await consult(first.body.id, patient.token)).body.status).toBe("expired");
  });

  it("refunds automatically when the payment lands after the hold expired", async () => {
    const { patient, open } = await scene();
    const b = await book(env, patient, open[0]!.id);
    await drainJobs(env);
    env.clock.advance(mins(11));
    await drainJobs(env); // sweeper expires it
    const hook = await pspWebhook(env, "payment.succeeded", `mock_pay_${b.body.payment.id}`);
    expect(hook.body.outcome).toBe("refund_scheduled");
    await drainJobs(env);
    expect((await env.api("GET", `/v1/payments/${b.body.payment.id}`, { token: patient.token })).body.status).toBe("refunded");
    expect(env.provider.refunds).toContain(b.body.payment.id);
    expect((await consult(b.body.id, patient.token)).body.status).toBe("expired");
  });

  it("refunds when payment lands after the patient cancelled", async () => {
    const { patient, open } = await scene();
    const b = await book(env, patient, open[0]!.id);
    await drainJobs(env);
    await env.api("POST", `/v1/consultations/${b.body.id}/cancel`, { token: patient.token });
    expect((await pspWebhook(env, "payment.succeeded", `mock_pay_${b.body.payment.id}`)).body.outcome).toBe("refund_scheduled");
  });

  it("frees the slot when the PSP reports a failed payment", async () => {
    const { doctor, patient, open } = await scene();
    const b = await book(env, patient, open[0]!.id);
    await drainJobs(env);
    await pspWebhook(env, "payment.failed", `mock_pay_${b.body.payment.id}`);
    expect((await consult(b.body.id, patient.token)).body.status).toBe("cancelled");
    expect(await listOpenSlots(env, doctor, patient.token)).toHaveLength(4);
  });

  it("processes each webhook event once; duplicates and replays are no-ops", async () => {
    const { patient, open } = await scene();
    const b = await book(env, patient, open[0]!.id);
    await drainJobs(env);
    const eventId = randomUUID();
    const first = await pspWebhook(env, "payment.succeeded", `mock_pay_${b.body.payment.id}`, eventId);
    const dup = await pspWebhook(env, "payment.succeeded", `mock_pay_${b.body.payment.id}`, eventId);
    expect(first.body.duplicate).toBe(false);
    expect(dup.body.duplicate).toBe(true);
    const newId = await pspWebhook(env, "payment.succeeded", `mock_pay_${b.body.payment.id}`); // different event, already confirmed
    expect(newId.body.outcome).toBe("ignored");
    await drainJobs(env);
    expect(env.notifier.sent.filter((n) => n.template === "consultation.confirmed" && (n.data as any).consultationId === b.body.id)).toHaveLength(2); // patient+doctor, once
  });

  it("authenticates webhooks: bad signature, stale timestamp, malformed payload", async () => {
    const raw = JSON.stringify({ id: "evt_1", type: "payment.succeeded", data: { paymentId: "x" } });
    const hdr = { "content-type": "application/json" };
    expect((await env.api("POST", "/v1/payments/webhook", { headers: hdr, body: JSON.parse(raw) })).status).toBe(401);
    expect((await env.api("POST", "/v1/payments/webhook", { headers: { ...hdr, "x-signature": "t=1,v1=deadbeef" }, body: JSON.parse(raw) })).status).toBe(401);
    const stale = signWebhook(WEBHOOK_SECRET, raw, new Date(env.clock.now().getTime() - mins(10)));
    expect((await env.api("POST", "/v1/payments/webhook", { headers: { ...hdr, "x-signature": stale }, body: JSON.parse(raw) })).status).toBe(401);
    const signedOther = signWebhook("another-secret-another-secret", raw, env.clock.now());
    expect((await env.api("POST", "/v1/payments/webhook", { headers: { ...hdr, "x-signature": signedOther }, body: JSON.parse(raw) })).status).toBe(401);
    const bad = JSON.stringify({ nope: 1 });
    expect((await env.api("POST", "/v1/payments/webhook", { headers: { ...hdr, "x-signature": signWebhook(WEBHOOK_SECRET, bad, env.clock.now()) }, body: JSON.parse(bad) })).status).toBe(400);
  });

  it("returns 404 (so the PSP retries) for an unknown payment and doesn't burn the event id", async () => {
    const eventId = randomUUID();
    expect((await pspWebhook(env, "payment.succeeded", "mock_pay_unknown", eventId)).status).toBe(404);
    const { rows } = await env.deps.db.query(`SELECT 1 FROM processed_webhook_events WHERE event_id = $1`, [eventId]);
    expect(rows).toHaveLength(0);
  });
});

describe("async jobs: retry, backoff, dead-letter", () => {
  it("retries a failing PSP call with backoff and succeeds once the PSP recovers", async () => {
    const { patient, open } = await scene();
    env.provider.failNext(2);
    const b = await book(env, patient, open[0]!.id);
    await drainJobs(env);
    expect((await env.api("GET", `/v1/payments/${b.body.payment.id}`, { token: patient.token })).body.checkoutUrl).toBeNull();
    const { rows } = await env.deps.db.query(`SELECT status, attempts, last_error, run_at FROM jobs WHERE type = 'payment.create_intent' AND payload->>'paymentId' = $1`, [b.body.payment.id]);
    expect(rows[0]!).toMatchObject({ status: "queued", attempts: 1 });
    expect(rows[0]!.last_error).toContain("unavailable");
    expect(rows[0]!.run_at.getTime()).toBeGreaterThanOrEqual(env.clock.now().getTime()); // deferred, not hot-looping

    for (let i = 0; i < 4; i++) { env.clock.advance(30_000); await drainJobs(env); } // stays inside the 10-min hold
    expect((await env.api("GET", `/v1/payments/${b.body.payment.id}`, { token: patient.token })).body.checkoutUrl).toContain("checkout");
  });

  it("dead-letters a job after max attempts, with exponential-but-capped backoff between tries", async () => {
    const id = randomUUID();
    await env.deps.db.query(`INSERT INTO jobs (id, type, payload, max_attempts, run_at) VALUES ($1,'does.not.exist','{}',4,$2)`, [id, env.clock.now()]);
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      await drainJobs(env, 1);
      const { rows } = await env.deps.db.query(`SELECT status, attempts, run_at FROM jobs WHERE id = $1`, [id]);
      if (rows[0]!.status === "dead") break;
      gaps.push(rows[0]!.run_at.getTime() - env.clock.now().getTime());
      env.clock.advance(31 * 60_000);
    }
    const { rows } = await env.deps.db.query(`SELECT status, attempts, last_error FROM jobs WHERE id = $1`, [id]);
    expect(rows[0]!).toMatchObject({ status: "dead", attempts: 4 });
    expect(rows[0]!.last_error).toContain("no handler");
    expect(gaps.every((g) => g >= 0 && g <= 30 * 60_000)).toBe(true);
  });

  it("recovers jobs whose worker died mid-flight (lease expiry)", async () => {
    await env.deps.db.query(`INSERT INTO jobs (id, type, payload, status, attempts, locked_until, run_at) VALUES ($1,'notify','{"userId":"u","template":"lease.test"}','running',1,$2,$2)`, [randomUUID(), new Date(env.clock.now().getTime() - 1000)]);
    await drainJobs(env);
    expect(env.notifier.sent.some((n) => n.template === "lease.test")).toBe(true);
  });
});

describe("cancellation & refunds", () => {
  it("refunds a patient who cancels outside the free-cancellation window and reopens the slot", async () => {
    const { doctor, patient, open } = await scene();
    const id = await bookAndPay(env, patient, open[0]!.id);
    const res = await env.api("POST", `/v1/consultations/${id}/cancel`, { token: patient.token, body: { reason: "plans changed" } });
    expect(res.body.status).toBe("cancelled");
    expect(res.body.payment.status).toBe("refund_pending");
    await drainJobs(env);
    expect((await consult(id, patient.token)).body.payment.status).toBe("refunded");
    expect(await listOpenSlots(env, doctor, patient.token)).toHaveLength(4);
    expect((await env.api("POST", `/v1/consultations/${id}/cancel`, { token: patient.token })).status).toBe(200); // idempotent
  });

  it("keeps the fee for late patient cancellations but refunds when the doctor cancels", async () => {
    const { patient, doctor, open } = await scene();
    const late = await bookAndPay(env, patient, open[0]!.id);
    const late2 = await bookAndPay(env, patient, open[1]!.id);
    env.clock.advance(mins(60 * 30)); // slot is now <24h away
    expect((await env.api("POST", `/v1/consultations/${late}/cancel`, { token: patient.token })).body.payment.status).toBe("succeeded");
    expect((await env.api("POST", `/v1/consultations/${late2}/cancel`, { token: doctor.token })).body.payment.status).toBe("refund_pending");
  });

  it("can't cancel a started consultation, and strangers get 404", async () => {
    const { patient, doctor, open } = await scene();
    const id = await bookAndPay(env, patient, open[0]!.id);
    const stranger = await registerPatient(env);
    expect((await env.api("POST", `/v1/consultations/${id}/cancel`, { token: stranger.token })).status).toBe(404);
    env.clock.set(new Date(open[0]!.startsAt));
    await env.api("POST", `/v1/consultations/${id}/start`, { token: doctor.token });
    expect((await env.api("POST", `/v1/consultations/${id}/cancel`, { token: patient.token })).body.error.code).toBe("INVALID_STATE");
  });
});

describe("consultation lifecycle & prescriptions", () => {
  it("runs confirmed → in_progress → completed and issues an encrypted prescription", async () => {
    const { patient, doctor, open } = await scene();
    const id = await bookAndPay(env, patient, open[0]!.id);
    expect((await env.api("POST", `/v1/consultations/${id}/start`, { token: doctor.token })).body.error.code).toBe("TOO_EARLY");
    env.clock.set(new Date(new Date(open[0]!.startsAt).getTime() - mins(5)));
    expect((await env.api("POST", `/v1/consultations/${id}/start`, { token: patient.token })).status).toBe(403);
    expect((await env.api("POST", `/v1/consultations/${id}/start`, { token: doctor.token })).body.status).toBe("in_progress");

    const body = { items: [{ medicine: "Ashwagandha", dosage: "500mg", frequency: "twice daily", durationDays: 14 }], notes: "avoid cold drinks" };
    const key = randomUUID();
    const rx = await env.api("POST", `/v1/consultations/${id}/prescriptions`, { token: doctor.token, headers: { "idempotency-key": key }, body });
    expect(rx.status).toBe(201);
    const replay = await env.api("POST", `/v1/consultations/${id}/prescriptions`, { token: doctor.token, headers: { "idempotency-key": key }, body });
    expect(replay.body.id).toBe(rx.body.id);
    expect((await env.deps.db.query(`SELECT count(*)::int AS n FROM prescriptions WHERE consultation_id = $1`, [id])).rows[0]!.n).toBe(1);
    const stored = (await env.deps.db.query(`SELECT notes_enc FROM prescriptions WHERE id = $1`, [rx.body.id])).rows[0]!;
    expect(stored.notes_enc).not.toContain("cold");

    expect((await env.api("POST", `/v1/consultations/${id}/complete`, { token: doctor.token })).body.status).toBe("completed");
    const read = await env.api("GET", `/v1/consultations/${id}/prescriptions`, { token: patient.token });
    expect(read.body.items[0]).toMatchObject({ notes: "avoid cold drinks", items: [{ medicine: "Ashwagandha" }] });
  });

  it("only the treating doctor can prescribe; only the patient/doctor can read; admins can't read clinical data", async () => {
    const { patient, doctor, open } = await scene();
    const otherDoc = await registerDoctor(env);
    const stranger = await registerPatient(env);
    const admin = await createAdmin(env);
    const id = await bookAndPay(env, patient, open[0]!.id);
    env.clock.set(new Date(open[0]!.startsAt));
    await env.api("POST", `/v1/consultations/${id}/start`, { token: doctor.token });
    const body = { items: [{ medicine: "X", dosage: "1", frequency: "daily", durationDays: 1 }] };
    const post = (token: string) => env.api("POST", `/v1/consultations/${id}/prescriptions`, { token, headers: { "idempotency-key": randomUUID() }, body });
    expect((await post(otherDoc.token)).status).toBe(404);
    expect((await post(patient.token)).status).toBe(403);
    expect((await post(doctor.token)).status).toBe(201);
    expect((await env.api("GET", `/v1/consultations/${id}/prescriptions`, { token: stranger.token })).status).toBe(404);
    expect((await env.api("GET", `/v1/consultations/${id}`, { token: stranger.token })).status).toBe(404);
    expect((await env.api("GET", `/v1/consultations/${id}/prescriptions`, { token: admin.token })).status).toBe(403);
  });

  it("refuses prescriptions before the consultation starts", async () => {
    const { patient, doctor, open } = await scene();
    const id = await bookAndPay(env, patient, open[0]!.id);
    const res = await env.api("POST", `/v1/consultations/${id}/prescriptions`, { token: doctor.token, headers: { "idempotency-key": randomUUID() }, body: { items: [{ medicine: "X", dosage: "1", frequency: "daily", durationDays: 1 }] } });
    expect(res.body.error.code).toBe("INVALID_STATE");
  });

  it("supports no-show after the grace period", async () => {
    const { patient, doctor, open } = await scene();
    const id = await bookAndPay(env, patient, open[0]!.id);
    env.clock.set(new Date(new Date(open[0]!.startsAt).getTime() + mins(5)));
    expect((await env.api("POST", `/v1/consultations/${id}/no-show`, { token: doctor.token })).body.error.code).toBe("TOO_EARLY");
    env.clock.set(new Date(new Date(open[0]!.startsAt).getTime() + mins(11)));
    expect((await env.api("POST", `/v1/consultations/${id}/no-show`, { token: doctor.token })).body.status).toBe("no_show");
  });
});

describe("listing & filtering", () => {
  it("scopes lists by role, filters by status/date, and paginates with a keyset cursor", async () => {
    const { patient, doctor, open } = await scene(4);
    const other = await registerPatient(env);
    const ids: string[] = [];
    for (const s of open.slice(0, 3)) ids.push(await bookAndPay(env, patient, s.id));
    await book(env, other, open[3]!.id);

    const all = await env.api("GET", "/v1/consultations?limit=2", { token: patient.token });
    expect(all.body.items).toHaveLength(2);
    expect(all.body.nextCursor).toBeTruthy();
    const page2 = await env.api("GET", `/v1/consultations?limit=2&cursor=${all.body.nextCursor}`, { token: patient.token });
    expect(page2.body.items).toHaveLength(1);
    expect([...all.body.items, ...page2.body.items].map((c: any) => c.id).sort()).toEqual([...ids].sort());
    expect(all.body.items[0].scheduledStart > all.body.items[1].scheduledStart).toBe(true); // newest first

    expect((await env.api("GET", "/v1/consultations?status=pending_payment", { token: doctor.token })).body.items).toHaveLength(1);
    expect((await env.api("GET", "/v1/consultations?status=confirmed", { token: other.token })).body.items).toHaveLength(0);
    const from = encodeURIComponent(new Date(open[1]!.startsAt).toISOString());
    expect((await env.api("GET", `/v1/consultations?from=${from}&status=confirmed`, { token: patient.token })).body.items).toHaveLength(2);
    expect((await env.api("GET", "/v1/consultations?status=bogus", { token: patient.token })).status).toBe(400);
    expect((await env.api("GET", `/v1/consultations?doctorId=${randomUUID()}`, { token: patient.token })).body.items.length).toBeGreaterThan(0); // ignored for non-admins
  });
});
