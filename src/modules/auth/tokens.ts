import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import type { Clock } from "../../lib/clock.js";
import { AppError, unauthorized } from "../../lib/errors.js";
import type { Role } from "./rbac.js";

/**
 * access       – normal API calls
 * mfa_challenge– password OK, TOTP still required (5 min); only usable at /auth/mfa/verify
 * mfa_setup    – doctor/admin with no MFA yet; only usable to enroll (15 min)
 * Separate `kind` claims stop a half-authenticated token from being replayed as a full session.
 */
export type TokenKind = "access" | "mfa_challenge" | "mfa_setup";

export interface TokenClaims {
  sub: string;
  role: Role;
  kind: TokenKind;
}

const TTL: Record<Exclude<TokenKind, "access">, number> = { mfa_challenge: 300, mfa_setup: 900 };

export class TokenService {
  private readonly key: Uint8Array;
  private readonly previousKey?: Uint8Array;
  /** `previousSecret` lets a rotation roll out without logging everyone out: tokens signed by it still verify until they expire. */
  constructor(
    secret: string,
    private readonly issuer: string,
    private readonly accessTtlSec: number,
    private readonly clock: Clock,
    previousSecret?: string,
  ) {
    this.key = new TextEncoder().encode(secret);
    if (previousSecret) this.previousKey = new TextEncoder().encode(previousSecret);
  }

  async sign(userId: string, role: Role, kind: TokenKind): Promise<string> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const ttl = kind === "access" ? this.accessTtlSec : TTL[kind];
    return new SignJWT({ role, kind })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience("amrutam-api")
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .setJti(crypto.randomUUID())
      .sign(this.key);
  }

  async verify(token: string, allowed: readonly TokenKind[]): Promise<TokenClaims> {
    try {
      const opts = {
        algorithms: ["HS256"], // pinned: rejects alg=none and algorithm-confusion attempts
        issuer: this.issuer,
        audience: "amrutam-api",
        currentDate: this.clock.now(),
      };
      const { payload } = await jwtVerify(token, this.key, opts).catch((err) => {
        if (!this.previousKey || !(err instanceof joseErrors.JWSSignatureVerificationFailed)) throw err;
        return jwtVerify(token, this.previousKey, opts);
      });
      const kind = payload.kind as TokenKind;
      if (!allowed.includes(kind) || typeof payload.sub !== "string") throw unauthorized("Token not valid for this operation", "INVALID_TOKEN");
      return { sub: payload.sub, role: payload.role as Role, kind };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) throw unauthorized("Token expired", "TOKEN_EXPIRED");
      if (err instanceof AppError) throw err;
      throw unauthorized("Invalid token", "INVALID_TOKEN");
    }
  }

  get accessTtl(): number {
    return this.accessTtlSec;
  }
}
