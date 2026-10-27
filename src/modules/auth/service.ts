import { randomUUID } from "node:crypto";
import type { Deps } from "../../deps.js";
import { AppError, conflict, unauthorized } from "../../lib/errors.js";
import { randomToken, sha256Hex } from "../../lib/crypto.js";
import { generateSecret, otpauthUri, verifyTotp } from "../../lib/totp.js";
import type { Queryable } from "../../db/types.js";
import type { Role } from "./rbac.js";
import { TokenService } from "./tokens.js";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export type LoginResult =
  | { status: "authenticated"; tokens: TokenPair }
  | { status: "mfa_required"; mfaToken: string }
  | { status: "mfa_setup_required"; setupToken: string };

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  role: "patient" | "doctor";
  doctor?: {
    specialty: string;
    registrationNumber: string;
    yearsExperience: number;
    languages: string[];
    bio?: string;
    feeMinor: number;
  };
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  status: "active" | "suspended";
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  mfa_last_step: number | null;
  failed_attempts: number;
  locked_until: Date | null;
}

const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set(["doctor", "admin"]);
const secretAad = (userId: string) => `users.mfa_secret:${userId}`;
const invalidCreds = () => unauthorized("Invalid email or password", "INVALID_CREDENTIALS");

export class AuthService {
  readonly tokens: TokenService;
  constructor(private readonly d: Deps) {
    this.tokens = new TokenService(d.config.JWT_SECRET, d.config.JWT_ISSUER, d.config.ACCESS_TOKEN_TTL_SEC, d.clock, d.config.JWT_SECRET_PREVIOUS);
  }

  async register(input: RegisterInput, meta: { ip?: string; requestId?: string }) {
    const hash = await this.d.hasher.hash(input.password);
    const id = randomUUID();
    const now = this.d.clock.now();
    try {
      await this.d.db.tx(async (q) => {
        await q.query(`INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)`, [
          id, input.email, hash, input.role, now,
        ]);
        await q.query(`INSERT INTO profiles (user_id, full_name, phone_enc, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)`, [
          id, input.fullName, input.phone ? this.d.cipher.encrypt(input.phone, `profiles.phone:${id}`) : null, now,
        ]);
        if (input.role === "doctor" && input.doctor) {
          const dr = input.doctor;
          await q.query(
            `INSERT INTO doctors (user_id, specialty, registration_number, years_experience, languages, bio, fee_minor, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
            [id, dr.specialty.toLowerCase(), dr.registrationNumber, dr.yearsExperience, dr.languages, dr.bio ?? null, dr.feeMinor, now],
          );
        }
        await this.d.audit.record(q, { actorId: id, actorRole: input.role, action: "user.register", entityType: "user", entityId: id, ...meta });
      });
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      // 23505 = unique_violation (pg). PGlite reports the same SQLSTATE.
      if (e.code === "23505") {
        if (/registration/.test(`${e.constraint ?? ""}${e.message ?? ""}`)) throw conflict("REGISTRATION_NUMBER_TAKEN", "Registration number already in use");
        throw conflict("EMAIL_TAKEN", "An account with this email already exists");
      }
      throw err;
    }
    this.d.metrics.authEvents.inc({ event: "register" });
    return { id, email: input.email, role: input.role };
  }

  async login(email: string, password: string, meta: { ip?: string; requestId?: string }): Promise<LoginResult> {
    const { rows } = await this.d.db.query<UserRow>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
    const user = rows[0];
    if (!user) {
      await this.d.hasher.verifyDummy(password);
      this.d.metrics.authEvents.inc({ event: "login_failed" });
      throw invalidCreds();
    }
    const now = this.d.clock.now();
    if (user.locked_until && user.locked_until > now) {
      this.d.metrics.authEvents.inc({ event: "login_locked" });
      throw new AppError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
    }
    if (!(await this.d.hasher.verify(password, user.password_hash))) {
      await this.recordFailure(user.id, meta);
      throw invalidCreds();
    }
    if (user.status !== "active") throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");

    if (user.mfa_enabled) {
      return { status: "mfa_required", mfaToken: await this.tokens.sign(user.id, user.role, "mfa_challenge") };
    }
    if (MFA_REQUIRED_ROLES.has(user.role)) {
      return { status: "mfa_setup_required", setupToken: await this.tokens.sign(user.id, user.role, "mfa_setup") };
    }
    await this.d.db.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await this.d.audit.record(this.d.db, { actorId: user.id, actorRole: user.role, action: "auth.login", entityType: "user", entityId: user.id, ...meta });
    this.d.metrics.authEvents.inc({ event: "login" });
    return { status: "authenticated", tokens: await this.issueTokens(this.d.db, user.id, user.role, randomUUID()) };
  }

  async verifyMfa(mfaToken: string, code: string, meta: { ip?: string; requestId?: string }): Promise<TokenPair> {
    const claims = await this.tokens.verify(mfaToken, ["mfa_challenge"]);
    const user = await this.getUser(claims.sub);
    const now = this.d.clock.now();
    if (user.locked_until && user.locked_until > now) throw new AppError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
    if (user.status !== "active") throw new AppError(403, "ACCOUNT_SUSPENDED", "This account is suspended");
    if (!user.mfa_enabled || !user.mfa_secret_enc) throw unauthorized("MFA is not enabled", "MFA_NOT_ENABLED");

    const secret = this.d.cipher.decrypt(user.mfa_secret_enc, secretAad(user.id));
    const step = verifyTotp(secret, code, now, user.mfa_last_step);
    if (step === null) {
      await this.recordFailure(user.id, meta);
      throw unauthorized("Invalid verification code", "INVALID_MFA_CODE");
    }
    // Conditional update makes the step single-use even under concurrent submissions of the same code.
    const claimed = await this.d.db.query(
      `UPDATE users SET mfa_last_step = $2, failed_attempts = 0, locked_until = NULL
       WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)`,
      [user.id, step],
    );
    if (claimed.rowCount === 0) throw unauthorized("Invalid verification code", "INVALID_MFA_CODE");

    await this.d.audit.record(this.d.db, { actorId: user.id, actorRole: user.role, action: "auth.login_mfa", entityType: "user", entityId: user.id, ...meta });
    this.d.metrics.authEvents.inc({ event: "login_mfa" });
    return this.issueTokens(this.d.db, user.id, user.role, randomUUID());
  }

  /** Step 1 of enrollment. Stores the secret encrypted but leaves MFA disabled until a valid code proves the app is set up. */
  async mfaSetup(userId: string) {
    const user = await this.getUser(userId);
    if (user.mfa_enabled) throw conflict("MFA_ALREADY_ENABLED", "MFA is already enabled");
    const secret = generateSecret();
    await this.d.db.query(`UPDATE users SET mfa_secret_enc = $2, updated_at = $3 WHERE id = $1`, [
      userId, this.d.cipher.encrypt(secret, secretAad(userId)), this.d.clock.now(),
    ]);
    return { secret, otpauthUri: otpauthUri(secret, user.email, "Amrutam") };
  }

  /** Step 2: confirm a code. Returns a full session when `issueTokens` (enrollment via setup token). */
  async mfaActivate(userId: string, code: string, issueSession: boolean, meta: { ip?: string; requestId?: string }): Promise<{ enabled: true; tokens?: TokenPair }> {
    const user = await this.getUser(userId);
    if (user.mfa_enabled) throw conflict("MFA_ALREADY_ENABLED", "MFA is already enabled");
    if (!user.mfa_secret_enc) throw conflict("MFA_NOT_STARTED", "Call /auth/mfa/setup first");
    const step = verifyTotp(this.d.cipher.decrypt(user.mfa_secret_enc, secretAad(userId)), code, this.d.clock.now());
    if (step === null) throw unauthorized("Invalid verification code", "INVALID_MFA_CODE");

    await this.d.db.tx(async (q) => {
      await q.query(`UPDATE users SET mfa_enabled = true, mfa_last_step = $2, updated_at = $3 WHERE id = $1`, [userId, step, this.d.clock.now()]);
      await this.d.audit.record(q, { actorId: userId, actorRole: user.role, action: "auth.mfa_enabled", entityType: "user", entityId: userId, ...meta });
    });
    return { enabled: true, ...(issueSession ? { tokens: await this.issueTokens(this.d.db, userId, user.role, randomUUID()) } : {}) };
  }

  /**
   * Rotating refresh tokens: each use retires the old token and issues a new one in the same family. Presenting an
   * already-rotated token means it leaked (or a client raced itself), so the entire family is revoked.
   */
  async refresh(raw: string): Promise<TokenPair> {
    const now = this.d.clock.now();
    const outcome = await this.d.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string; user_id: string; family_id: string; expires_at: Date; rotated_at: Date | null; revoked_at: Date | null }>(
        `SELECT id, user_id, family_id, expires_at, rotated_at, revoked_at FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
        [sha256Hex(raw)],
      );
      const t = rows[0];
      if (!t || t.revoked_at || t.expires_at <= now) return { kind: "invalid" as const };
      if (t.rotated_at) {
        await q.query(`UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL`, [t.family_id, now]);
        await this.d.audit.record(q, { actorId: t.user_id, action: "auth.refresh_reuse_detected", entityType: "user", entityId: t.user_id });
        return { kind: "reuse" as const };
      }
      const user = (await q.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [t.user_id])).rows[0];
      if (!user || user.status !== "active") return { kind: "invalid" as const };
      await q.query(`UPDATE refresh_tokens SET rotated_at = $2 WHERE id = $1`, [t.id, now]);
      return { kind: "ok" as const, tokens: await this.issueTokens(q, user.id, user.role, t.family_id) };
    });
    if (outcome.kind === "ok") return outcome.tokens;
    this.d.metrics.authEvents.inc({ event: outcome.kind === "reuse" ? "refresh_reuse" : "refresh_invalid" });
    throw unauthorized("Invalid refresh token", "INVALID_REFRESH_TOKEN");
  }

  async logout(raw: string): Promise<void> {
    await this.d.db.query(
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE revoked_at IS NULL AND family_id =
         (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [sha256Hex(raw), this.d.clock.now()],
    );
  }

  private async issueTokens(q: Queryable, userId: string, role: Role, familyId: string): Promise<TokenPair> {
    const now = this.d.clock.now();
    const refreshToken = randomToken(48);
    await q.query(`INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      randomUUID(), userId, familyId, sha256Hex(refreshToken), new Date(now.getTime() + this.d.config.REFRESH_TOKEN_TTL_SEC * 1000), now,
    ]);
    return { accessToken: await this.tokens.sign(userId, role, "access"), refreshToken, tokenType: "Bearer", expiresIn: this.tokens.accessTtl };
  }

  private async recordFailure(userId: string, meta: { ip?: string; requestId?: string }): Promise<void> {
    const now = this.d.clock.now();
    const lockUntil = new Date(now.getTime() + this.d.config.LOGIN_LOCKOUT_MINUTES * 60_000);
    // Atomic increment: parallel guesses can't race past the threshold.
    const { rows } = await this.d.db.query<{ failed_attempts: number }>(
      `UPDATE users SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN $3::timestamptz ELSE locked_until END
       WHERE id = $1 RETURNING failed_attempts`,
      [userId, this.d.config.MAX_LOGIN_ATTEMPTS, lockUntil],
    );
    this.d.metrics.authEvents.inc({ event: "login_failed" });
    await this.d.audit.record(this.d.db, {
      actorId: userId, action: "auth.login_failed", entityType: "user", entityId: userId, ...meta,
      metadata: { attempts: rows[0]?.failed_attempts },
    });
  }

  private async getUser(id: string): Promise<UserRow> {
    const { rows } = await this.d.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!rows[0]) throw unauthorized();
    return rows[0];
  }
}
