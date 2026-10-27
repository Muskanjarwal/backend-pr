import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { book, bookAndPay, createAdmin, createEnv, drainJobs, listOpenSlots, publishSlots, registerDoctor, registerPatient, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => { env = await createEnv({ ACCESS_TOKEN_TTL_SEC: String(60 * 86_400) }); });
afterAll(() => env.close());

describe("audit trail", () => {
  it("records security- and PHI-relevant actions with actor, entity and request id", async () => {
    const admin = await createAdmin(env);
    const doc = await registerDoctor(env, { adminToken: admin.token });
    const patient = await registerPatient(env);
    await publishSlots(env, doc, { count: 1 });
    const [slot] = await listOpenSlots(env, doc, patient.token);
    const b = await book(env, patient, slot!.id);

    const res = await env.api("GET", `/v1/admin/audit-logs?entityType=consultation&entityId=${b.body.id}&verify=true`, { token: admin.token });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ action: "consultation.book", actorId: patient.id, actorRole: "patient", signatureValid: true });
    expect(res.body.items[0].requestId).toBeTruthy();

    const byActor = await env.api("GET", `/v1/admin/audit-logs?actorId=${patient.id}`, { token: admin.token });
    expect(byActor.body.items.map((i: any) => i.action)).toEqual(expect.arrayContaining(["user.register", "auth.login", "consultation.book"]));
    expect(JSON.stringify(byActor.body)).not.toMatch(/persistent|password|@example\.com/); // no PII/secrets in metadata
  });

  it("audits PHI reads by admins and the act of reading the audit log itself", async () => {
    const admin = await createAdmin(env);
    const doc = await registerDoctor(env, { adminToken: admin.token });
    const patient = await registerPatient(env);
    await publishSlots(env, doc, { count: 1 });
    const [slot] = await listOpenSlots(env, doc, patient.token);
    const b = await book(env, patient, slot!.id);
    await env.api("GET", `/v1/consultations/${b.body.id}`, { token: admin.token });
    const logs = await env.api("GET", `/v1/admin/audit-logs?actorId=${admin.id}&action=consultation.read`, { token: admin.token });
    expect(logs.body.items).toHaveLength(1);
    const reads = await env.api("GET", `/v1/admin/audit-logs?action=audit.read`, { token: admin.token });
    expect(reads.body.items.length).toBeGreaterThan(0);
  });

  it("is append-only at the database level and tamper-evident", async () => {
    const admin = await createAdmin(env);
    await expect(env.deps.db.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.deps.db.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);

    // Simulate an insider with superuser rights who disables the trigger and edits a row: the signature exposes it.
    await env.deps.db.query(`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`);
    await env.deps.db.query(`UPDATE audit_logs SET actor_role = 'superadmin' WHERE actor_id = $1 AND action = 'auth.mfa_enabled'`, [admin.id]);
    await env.deps.db.query(`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_update`);
    const res = await env.api("GET", `/v1/admin/audit-logs?actorId=${admin.id}&action=auth.mfa_enabled&verify=true`, { token: admin.token });
    expect(res.body.items[0].signatureValid).toBe(false);
  });

  it("paginates and is admin-only", async () => {
    const admin = await createAdmin(env);
    const patient = await registerPatient(env);
    expect((await env.api("GET", "/v1/admin/audit-logs", { token: patient.token })).status).toBe(403);
    const p1 = await env.api("GET", "/v1/admin/audit-logs?limit=3", { token: admin.token });
    expect(p1.body.items).toHaveLength(3);
    const p2 = await env.api("GET", `/v1/admin/audit-logs?limit=3&cursor=${p1.body.nextCursor}`, { token: admin.token });
    const ids = [...p1.body.items, ...p2.body.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("writes into monthly partitions", async () => {
    const { rows } = await env.deps.db.query(`SELECT tableoid::regclass::text AS part FROM audit_logs LIMIT 1`);
    expect(rows[0]!.part).toMatch(/audit_logs_2030_01/);
  });
});

describe("admin analytics", () => {
  it("rolls up completed consultations and revenue via the async refresh job", async () => {
    const admin = await createAdmin(env);
    const doc = await registerDoctor(env, { adminToken: admin.token, specialty: "ayurveda", feeMinor: 70_000 });
    const patient = await registerPatient(env);
    await publishSlots(env, doc, { count: 3, startInHours: 24 });
    const slots = await listOpenSlots(env, doc, patient.token);
    const first = await bookAndPay(env, patient, slots[0]!.id);
    const second = await bookAndPay(env, patient, slots[1]!.id);
    await env.api("POST", `/v1/consultations/${second}/cancel`, { token: patient.token });

    env.clock.set(new Date(slots[0]!.startsAt));
    await env.api("POST", `/v1/consultations/${first}/start`, { token: doc.token });
    await env.api("POST", `/v1/consultations/${first}/complete`, { token: doc.token });

    expect((await env.api("POST", "/v1/admin/analytics/refresh", { token: admin.token })).status).toBe(202);
    await drainJobs(env);

    const day = new Date(slots[0]!.startsAt);
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())).toISOString();
    const to = new Date(Date.parse(from) + 86_400_000).toISOString();
    const sum = await env.api("GET", `/v1/admin/analytics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { token: admin.token });
    const row = sum.body.byDay.find((r: any) => r.specialty === "ayurveda");
    expect(row).toMatchObject({ completed: 1, cancelled: 1, revenueMinor: 70_000 });
    expect(sum.body.totals.revenueMinor).toBeGreaterThanOrEqual(70_000);

    const util = await env.api("GET", `/v1/admin/analytics/doctor-utilization?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(Date.parse(from) + 3 * 86_400_000).toISOString())}`, { token: admin.token });
    expect(util.body.items.find((i: any) => i.doctorId === doc.id)).toMatchObject({ bookedSlots: 1, totalSlots: 3 });
  });

  it("is admin-only and validates ranges", async () => {
    const admin = await createAdmin(env);
    const patient = await registerPatient(env);
    const q = "from=2030-01-01T00:00:00Z&to=2030-01-02T00:00:00Z";
    expect((await env.api("GET", `/v1/admin/analytics/summary?${q}`, { token: patient.token })).status).toBe(403);
    expect((await env.api("GET", `/v1/admin/analytics/summary?from=2030-02-01T00:00:00Z&to=2030-01-01T00:00:00Z`, { token: admin.token })).status).toBe(400);
    expect((await env.api("GET", `/v1/admin/analytics/summary?from=nope&to=nope`, { token: admin.token })).status).toBe(400);
  });
});

describe("maintenance", () => {
  it("purges expired idempotency keys and rolls audit partitions forward", async () => {
    const patient = await registerPatient(env);
    const doc = await registerDoctor(env);
    await publishSlots(env, doc, { count: 1 });
    const [slot] = await listOpenSlots(env, doc, patient.token);
    await book(env, patient, slot!.id);
    expect((await env.deps.db.query(`SELECT count(*)::int AS n FROM idempotency_keys`)).rows[0]!.n).toBeGreaterThan(0);
    env.clock.advance(3 * 86_400_000);
    await drainJobs(env);
    expect((await env.deps.db.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE expires_at < $1`, [env.clock.now()])).rows[0]!.n).toBe(0);
  });
});
