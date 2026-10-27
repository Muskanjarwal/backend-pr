import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totp } from "../src/lib/totp.js";
import { PASSWORD, createAdmin, createEnv, registerDoctor, registerPatient, type Env } from "./helpers.js";

let env: Env;
beforeAll(async () => { env = await createEnv({ MAX_LOGIN_ATTEMPTS: "3" }); });
afterAll(() => env.close());

const register = (over: object = {}) =>
  env.api("POST", "/v1/auth/register", { body: { email: `u${Math.random().toString(36).slice(2)}@example.com`, password: PASSWORD, fullName: "Test User", role: "patient", ...over } });

describe("registration", () => {
  it("rejects weak passwords, unknown fields (mass assignment), and role=admin", async () => {
    expect((await register({ password: "short" })).status).toBe(400);
    expect((await register({ role: "admin" })).status).toBe(400);
    expect((await register({ isAdmin: true })).status).toBe(400);
    expect((await register({ role: "doctor" })).status).toBe(400); // doctor block required
  });

  it("returns 409 for a duplicate email (case-insensitive)", async () => {
    const email = `dup${Date.now()}@example.com`;
    expect((await register({ email })).status).toBe(201);
    expect((await register({ email: email.toUpperCase() })).status).toBe(409);
  });

  it("never stores plaintext phone or password", async () => {
    const p = await registerPatient(env);
    const { rows } = await env.deps.db.query(`SELECT u.password_hash, p.phone_enc FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [p.id]);
    expect(rows[0]!.password_hash).toMatch(/^scrypt\$/);
    expect(rows[0]!.phone_enc).toMatch(/^v1\./);
    expect(JSON.stringify(rows[0])).not.toContain("9876543210");
    expect((await env.api("GET", "/v1/me", { token: p.token })).body.phone).toBe("+919876543210");
  });
});

describe("login, lockout, and tokens", () => {
  it("gives the same error for unknown email and wrong password", async () => {
    const p = await registerPatient(env);
    const a = await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: "wrong-password-123" } });
    const b = await env.api("POST", "/v1/auth/login", { body: { email: "nobody@example.com", password: "wrong-password-123" } });
    expect(a.status).toBe(401);
    expect(a.body.error.code).toBe(b.body.error.code);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it("locks the account after repeated failures, and unlocks after the lockout window", async () => {
    const p = await registerPatient(env);
    for (let i = 0; i < 3; i++) await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: "wrong-password-123" } });
    const locked = await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: PASSWORD } });
    expect(locked.status).toBe(423); // even the right password is refused while locked
    env.clock.advance(16 * 60_000);
    expect((await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: PASSWORD } })).status).toBe(200);
  });

  it("rotates refresh tokens and revokes the whole family on reuse", async () => {
    const p = await registerPatient(env);
    const r1 = await env.api("POST", "/v1/auth/refresh", { body: { refreshToken: p.refreshToken } });
    expect(r1.status).toBe(200);
    const replay = await env.api("POST", "/v1/auth/refresh", { body: { refreshToken: p.refreshToken } }); // stolen/old token
    expect(replay.status).toBe(401);
    const afterReuse = await env.api("POST", "/v1/auth/refresh", { body: { refreshToken: r1.body.refreshToken } });
    expect(afterReuse.status).toBe(401); // legit holder is kicked too — forces re-auth
  });

  it("logout revokes the refresh token", async () => {
    const p = await registerPatient(env);
    expect((await env.api("POST", "/v1/auth/logout", { body: { refreshToken: p.refreshToken } })).status).toBe(204);
    expect((await env.api("POST", "/v1/auth/refresh", { body: { refreshToken: p.refreshToken } })).status).toBe(401);
  });

  it("rejects tampered, expired, and missing tokens", async () => {
    const p = await registerPatient(env);
    expect((await env.api("GET", "/v1/me")).status).toBe(401);
    expect((await env.api("GET", "/v1/me", { token: p.token.slice(0, -3) + "abc" })).status).toBe(401);
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + p.token.split(".")[1] + ".";
    expect((await env.api("GET", "/v1/me", { token: none })).status).toBe(401); // alg=none attack
    env.clock.advance(16 * 60_000);
    const expired = await env.api("GET", "/v1/me", { token: p.token });
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("blocks suspended users from logging in and refreshing", async () => {
    const admin = await createAdmin(env);
    const p = await registerPatient(env);
    expect((await env.api("POST", `/v1/admin/users/${p.id}/suspend`, { token: admin.token })).status).toBe(204);
    expect((await env.api("POST", "/v1/auth/refresh", { body: { refreshToken: p.refreshToken } })).status).toBe(401);
    expect((await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: PASSWORD } })).status).toBe(403);
    await env.api("POST", `/v1/admin/users/${p.id}/reinstate`, { token: admin.token });
    expect((await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: PASSWORD } })).status).toBe(200);
  });
});

describe("MFA", () => {
  it("forces doctors through enrollment and then requires a TOTP on every login", async () => {
    const doc = await registerDoctor(env);
    const login = await env.api("POST", "/v1/auth/login", { body: { email: doc.email, password: PASSWORD } });
    expect(login.body.status).toBe("mfa_required");
    expect(login.body.tokens).toBeUndefined();

    env.clock.advance(30_000); // next TOTP step (enrollment consumed the current one)
    const code = totp(doc.secret, env.clock.now());
    const ok = await env.api("POST", "/v1/auth/mfa/verify", { body: { mfaToken: login.body.mfaToken, code } });
    expect(ok.status).toBe(200);
    expect(ok.body.tokens.accessToken).toBeTruthy();

    const replay = await env.api("POST", "/v1/auth/mfa/verify", { body: { mfaToken: login.body.mfaToken, code } });
    expect(replay.status).toBe(401); // same step can't be used twice
  });

  it("rejects a wrong code, and a challenge token can't be used as a session", async () => {
    const doc = await registerDoctor(env);
    const login = await env.api("POST", "/v1/auth/login", { body: { email: doc.email, password: PASSWORD } });
    expect((await env.api("POST", "/v1/auth/mfa/verify", { body: { mfaToken: login.body.mfaToken, code: "000000" } })).body.error.code).toBe("INVALID_MFA_CODE");
    expect((await env.api("GET", "/v1/doctors", { token: login.body.mfaToken })).status).toBe(401);
  });

  it("stores the MFA secret encrypted", async () => {
    const doc = await registerDoctor(env);
    const { rows } = await env.deps.db.query(`SELECT mfa_secret_enc FROM users WHERE id = $1`, [doc.id]);
    expect(rows[0]!.mfa_secret_enc).toMatch(/^v1\./);
    expect(rows[0]!.mfa_secret_enc).not.toContain(doc.secret);
  });

  it("lets patients opt in with a normal session", async () => {
    const p = await registerPatient(env);
    const setup = await env.api("POST", "/v1/auth/mfa/setup", { token: p.token });
    const act = await env.api("POST", "/v1/auth/mfa/activate", { token: p.token, body: { code: totp(setup.body.secret, env.clock.now()) } });
    expect(act.status).toBe(200);
    expect((await env.api("POST", "/v1/auth/login", { body: { email: p.email, password: PASSWORD } })).body.status).toBe("mfa_required");
  });
});

describe("RBAC", () => {
  it("enforces role permissions", async () => {
    const patient = await registerPatient(env);
    const doctor = await registerDoctor(env);
    expect((await env.api("GET", "/v1/admin/doctors", { token: patient.token })).status).toBe(403);
    expect((await env.api("GET", "/v1/admin/audit-logs", { token: doctor.token })).status).toBe(403);
    expect((await env.api("POST", "/v1/doctors/me/slots", { token: patient.token, body: {} })).status).toBe(403);
    expect((await env.api("POST", "/v1/consultations", { token: doctor.token, body: {} })).status).toBe(403);
  });

  it("a doctor-setup token cannot call business endpoints", async () => {
    const email = `d${Date.now()}@example.com`;
    await env.api("POST", "/v1/auth/register", { body: { email, password: PASSWORD, fullName: "Dr X", role: "doctor", doctor: { specialty: "yoga", registrationNumber: `R${Date.now()}`, yearsExperience: 1, feeMinor: 100 } } });
    const login = await env.api("POST", "/v1/auth/login", { body: { email, password: PASSWORD } });
    expect((await env.api("GET", "/v1/doctors", { token: login.body.setupToken })).status).toBe(401);
  });
});

describe("hardening", () => {
  it("returns a consistent error envelope and request id, no stack traces", async () => {
    const res = await env.api("GET", "/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(res.headers["x-request-id"]).toBeTruthy();
    const bad = await env.api("POST", "/v1/auth/login", { headers: { "content-type": "application/json" }, body: undefined });
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts/);
  });

  it("sets security headers", async () => {
    const res = await env.api("GET", "/healthz");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeTruthy();
  });
});

describe("secret rotation", () => {
  it("accepts tokens signed with the previous JWT secret during a rotation window, and rejects unknown secrets", async () => {
    const old = await createEnv({ JWT_SECRET: "old-jwt-secret-that-is-long-enough-123456" });
    const p = await registerPatient(old);
    const rotated = await createEnv({ JWT_SECRET: "new-jwt-secret-that-is-long-enough-123456", JWT_SECRET_PREVIOUS: "old-jwt-secret-that-is-long-enough-123456" });
    const unrelated = await createEnv({ JWT_SECRET: "other-jwt-secret-that-is-long-enough-12345" });
    expect((await rotated.api("GET", "/v1/doctors", { token: p.token })).status).toBe(200); // token signed with the old secret is still honoured
    expect((await unrelated.api("GET", "/v1/doctors", { token: p.token })).status).toBe(401);
    await Promise.all([old.close(), rotated.close(), unrelated.close()]);
  });
});
