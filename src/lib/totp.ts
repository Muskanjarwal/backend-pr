import { createHmac, randomBytes } from "node:crypto";

// RFC 6238 TOTP (HMAC-SHA1, 30s step, 6 digits) — what every authenticator app speaks.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = (): string => base32Encode(randomBytes(20));

export const timeStep = (at: Date): number => Math.floor(at.getTime() / 1000 / STEP_SECONDS);

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = (h[h.length - 1] as number) & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

export const totp = (secret: string, at: Date): string => hotp(secret, timeStep(at));

/**
 * Accepts the current step and ±1 (clock skew). Returns the matched step so the caller can persist it and refuse
 * to accept the same step twice (replay protection), or null if the code is wrong.
 */
export function verifyTotp(secret: string, code: string, at: Date, lastUsedStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = timeStep(at);
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep != null && step <= lastUsedStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

export const otpauthUri = (secret: string, account: string, issuer: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
