import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmin, createEnv, book, listOpenSlots, publishSlots, registerDoctor, registerPatient, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => { env = await createEnv({ ACCESS_TOKEN_TTL_SEC: String(60 * 86_400) }); });
afterAll(() => env.close());

describe("doctor availability", () => {
  it("only verified doctors can publish slots, and unverified ones are hidden from search", async () => {
    const pending = await registerDoctor(env, { verify: false, name: "Dr Pending" });
    const start = new Date(env.clock.now().getTime() + 48 * 3_600_000);
    const body = { windows: [{ start: start.toISOString(), end: new Date(start.getTime() + 3_600_000).toISOString() }], slotMinutes: 30 };
    const denied = await env.api("POST", "/v1/doctors/me/slots", { token: pending.token, body });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("DOCTOR_NOT_VERIFIED");

    const patient = await registerPatient(env);
    expect((await env.api("GET", "/v1/doctors?q=Dr%20Pending", { token: patient.token })).body.items).toHaveLength(0);
    expect((await env.api("GET", `/v1/doctors/${pending.id}`, { token: patient.token })).status).toBe(404);
    expect((await env.api("GET", `/v1/doctors/${pending.id}`, { token: pending.token })).body.verificationStatus).toBe("pending");
  });

  it("generates slots from windows, skips overlaps, and validates input", async () => {
    const doc = await registerDoctor(env);
    const t0 = env.clock.now().getTime() + 72 * 3_600_000;
    const win = (startMin: number, endMin: number) => ({ start: new Date(t0 + startMin * 60_000).toISOString(), end: new Date(t0 + endMin * 60_000).toISOString() });

    const a = await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(0, 120)], slotMinutes: 30 } });
    expect(a.body).toEqual({ requested: 4, created: 4, skippedOverlapping: 0 });
    const again = await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(0, 120)], slotMinutes: 30 } });
    expect(again.body.created).toBe(0); // idempotent re-publish
    const mixed = await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(15, 135)], slotMinutes: 60 } }); // misaligned, overlaps existing
    expect(mixed.body.created).toBe(0);
    expect(mixed.body.skippedOverlapping).toBe(2);

    expect((await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(-5000, -4900)], slotMinutes: 30 } })).status).toBe(400);
    expect((await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(10, 5)], slotMinutes: 30 } })).status).toBe(400);
    expect((await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(0, 60)], slotMinutes: 7 } })).status).toBe(400);
    expect((await env.api("POST", "/v1/doctors/me/slots", { token: doc.token, body: { windows: [win(0, 60 * 24 * 200)], slotMinutes: 30 } })).status).toBe(400);
  });

  it("lets a doctor withdraw an open slot but not a booked one", async () => {
    const doc = await registerDoctor(env);
    const patient = await registerPatient(env);
    await publishSlots(env, doc, { count: 2 });
    const [s1, s2] = await listOpenSlots(env, doc, patient.token);
    await book(env, patient, s1!.id);
    expect((await env.api("DELETE", `/v1/doctors/me/slots/${s1!.id}`, { token: doc.token })).status).toBe(409);
    expect((await env.api("DELETE", `/v1/doctors/me/slots/${s2!.id}`, { token: doc.token })).status).toBe(204);
    expect(await listOpenSlots(env, doc, patient.token)).toHaveLength(0);
    expect((await book(env, patient, s2!.id)).status).toBe(409); // withdrawn slots can't be booked
  });

  it("invalidates the slot cache when inventory changes", async () => {
    const doc = await registerDoctor(env);
    const patient = await registerPatient(env);
    await publishSlots(env, doc, { count: 3 });
    expect(await listOpenSlots(env, doc, patient.token)).toHaveLength(3); // warms cache
    const [s] = await listOpenSlots(env, doc, patient.token);
    await book(env, patient, s!.id);
    expect(await listOpenSlots(env, doc, patient.token)).toHaveLength(2); // not served stale
  });
});

describe("doctor search", () => {
  it("filters by specialty, name prefix, language, fee, and availability; paginates stably", async () => {
    const admin = await createAdmin(env);
    const patient = await registerPatient(env);
    const mk = (name: string, specialty: string, feeMinor: number) => registerDoctor(env, { name, specialty, feeMinor, adminToken: admin.token });
    const [a, b, c] = [await mk("Dr Alpha Search", "dermatology", 30_000), await mk("Dr Beta Search", "dermatology", 80_000), await mk("Dr Gamma Search", "cardiology", 50_000)];
    await publishSlots(env, a, { count: 2 });

    const search = (qs: string) => env.api("GET", `/v1/doctors?${qs}`, { token: patient.token }).then((r) => r.body);
    expect((await search("specialty=dermatology&q=Dr%20")).items.map((d: any) => d.fullName).sort()).toEqual(["Dr Alpha Search", "Dr Beta Search"]);
    expect((await search("q=dr%20gam")).items.map((d: any) => d.id)).toEqual([c.id]);
    expect((await search("specialty=dermatology&maxFeeMinor=40000")).items.map((d: any) => d.id)).toEqual([a.id]);
    expect((await search("language=hi&specialty=cardiology")).items).toHaveLength(1);
    expect((await search("language=fr")).items).toHaveLength(0);
    expect((await search(`availableFrom=${encodeURIComponent(env.clock.now().toISOString())}&q=Dr%20`)).items.map((d: any) => d.id)).toContain(a.id);
    expect((await search(`availableFrom=${encodeURIComponent(env.clock.now().toISOString())}&q=Dr%20Beta`)).items).toHaveLength(0); // no open slots

    const p1 = await search("q=Dr%20&limit=2");
    expect(p1.items).toHaveLength(2);
    const p2 = await search(`q=Dr%20&limit=2&cursor=${p1.nextCursor}`);
    const seen = [...p1.items, ...p2.items].map((d: any) => d.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(p1.items[0]).not.toHaveProperty("verificationStatus");
    expect((await search("q=%25")).items).toHaveLength(0); // LIKE wildcards are escaped, not interpreted
    expect((await env.api("GET", "/v1/doctors?limit=1000", { token: patient.token })).status).toBe(400);
    expect((await env.api("GET", "/v1/doctors")).status).toBe(401);
  });

  it("lets admins list and reject pending doctors; rejected doctors stay hidden", async () => {
    const admin = await createAdmin(env);
    const doc = await registerDoctor(env, { verify: false, name: "Dr Review Me" });
    const pending = await env.api("GET", "/v1/admin/doctors?status=pending", { token: admin.token });
    expect(pending.body.items.map((d: any) => d.id)).toContain(doc.id);
    expect((await env.api("POST", `/v1/admin/doctors/${doc.id}/verification`, { token: admin.token, body: { status: "rejected" } })).status).toBe(204);
    const patient = await registerPatient(env);
    expect((await env.api("GET", "/v1/doctors?q=Dr%20Review", { token: patient.token })).body.items).toHaveLength(0);
  });
});
