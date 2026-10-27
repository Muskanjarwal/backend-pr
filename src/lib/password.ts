import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

// OWASP-recommended minimum for scrypt: N=2^17, r=8, p=1. We default to 2^15 to keep login p95 inside the latency budget
// on small pods; raise via config when hardware allows.
export const DEFAULT_COST: ScryptCost = { N: 32768, r: 8, p: 1 };

const KEYLEN = 64;

function derive(password: string, salt: Buffer, c: ScryptCost): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: c.N, r: c.r, p: c.p, maxmem: 256 * c.N * c.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export class PasswordHasher {
  private dummyHash?: Promise<string>;
  constructor(private readonly cost: ScryptCost = DEFAULT_COST) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, this.cost);
    const { N, r, p } = this.cost;
    return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, N, r, p, salt, key] = stored.split("$");
    if (scheme !== "scrypt" || !N || !r || !p || !salt || !key) return false;
    const expected = Buffer.from(key, "base64url");
    const actual = await derive(password, Buffer.from(salt, "base64url"), { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  /** Burn the same CPU as a real verification so unknown-email logins are not distinguishable by timing. */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash("dummy-password-for-timing");
    await this.verify(password, await this.dummyHash);
    return false;
  }
}
