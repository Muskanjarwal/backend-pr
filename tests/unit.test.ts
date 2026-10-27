import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { FieldCipher, Keyring } from "../src/lib/crypto.js";
import { PasswordHasher } from "../src/lib/password.js";
import { backoffDelay, retry } from "../src/lib/retry.js";
import { base32Decode, base32Encode, hotp, verifyTotp } from "../src/lib/totp.js";
import { MemoryCache, ReadThrough } from "../src/lib/cache.js";
import { TRANSITIONS } from "../src/modules/consultations/service.js";
import { parseSignatureHeader, signWebhook } from "../src/modules/payments/provider.js";

const k = () => randomBytes(32).toString("base64");

describe("FieldCipher", () => {
  it("round-trips and never repeats ciphertext", () => {
    const c = new FieldCipher(new Keyring(`1:${k()}`));
    const a = c.encrypt("hello", "t:1");
    expect(a).not.toContain("hello");
    expect(c.encrypt("hello", "t:1")).not.toBe(a); // random IV
    expect(c.decrypt(a, "t:1")).toBe("hello");
  });

  it("rejects ciphertext moved to another record (AAD binding) and tampering", () => {
    const c = new FieldCipher(new Keyring(`1:${k()}`));
    const a = c.encrypt("secret", "prescriptions.notes:A");
    expect(() => c.decrypt(a, "prescriptions.notes:B")).toThrow();
    const [v, iv, tag, ct] = a.split(".");
    expect(() => c.decrypt([v, iv, tag, Buffer.from("xx").toString("base64url") + ct].join("."), "prescriptions.notes:A")).toThrow();
  });

  it("supports key rotation: old data still decrypts, new writes use the newest key", () => {
    const k1 = k();
    const old = new FieldCipher(new Keyring(`1:${k1}`)).encrypt("legacy", "x");
    const rotated = new FieldCipher(new Keyring(`1:${k1},2:${k()}`));
    expect(rotated.decrypt(old, "x")).toBe("legacy");
    expect(rotated.isStale(old)).toBe(true);
    expect(rotated.encrypt("fresh", "x").startsWith("v2.")).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(() => new Keyring("1:c2hvcnQ=")).toThrow(/32 bytes/);
  });
});

describe("TOTP (RFC 6238 test vectors)", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the RFC SHA1 vector at T=59 (counter 1)", () => {
    expect(hotp(secret, 1)).toBe("287082");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });
  it("accepts ±1 step skew, rejects further, and blocks replay of a used step", () => {
    const at = new Date(59_000);
    expect(verifyTotp(secret, "287082", at)).toBe(1);
    expect(verifyTotp(secret, "287082", new Date(59_000 + 30_000))).toBe(1); // one step late
    expect(verifyTotp(secret, "287082", new Date(59_000 + 90_000))).toBeNull();
    expect(verifyTotp(secret, "287082", at, 1)).toBeNull(); // step 1 already consumed
    expect(verifyTotp(secret, "abc123", at)).toBeNull();
  });
});

describe("PasswordHasher", () => {
  it("verifies correct and rejects wrong passwords; salts differ", async () => {
    const h = new PasswordHasher({ N: 1024, r: 8, p: 1 });
    const a = await h.hash("hunter2-hunter2");
    expect(a).not.toBe(await h.hash("hunter2-hunter2"));
    expect(await h.verify("hunter2-hunter2", a)).toBe(true);
    expect(await h.verify("hunter3-hunter3", a)).toBe(false);
    expect(await h.verify("x", "garbage")).toBe(false);
  });
});

describe("backoff & retry", () => {
  it("full-jitter stays within [0, min(max, base*2^n)]", () => {
    for (let n = 0; n < 12; n++) {
      const d = backoffDelay(n, { baseMs: 100, maxMs: 5000 });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(5000, 100 * 2 ** n));
    }
    expect(backoffDelay(3, { baseMs: 100, maxMs: 5000 }, () => 0.999)).toBe(799);
  });

  it("retries transient failures and gives up after the limit", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const ok = await retry(async () => { if (++calls < 3) throw new Error("flaky"); return "done"; }, { retries: 5, baseMs: 10, maxMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    expect(ok).toBe("done");
    expect(sleeps).toHaveLength(2);
    await expect(retry(async () => { throw new Error("down"); }, { retries: 2, baseMs: 1, maxMs: 2, sleep: async () => {} })).rejects.toThrow("down");
    let fatalCalls = 0;
    await expect(retry(async () => { fatalCalls++; throw new Error("bad input"); }, { retries: 5, baseMs: 1, maxMs: 2, sleep: async () => {}, shouldRetry: () => false })).rejects.toThrow();
    expect(fatalCalls).toBe(1);
  });
});

describe("ReadThrough cache", () => {
  it("collapses concurrent cold reads into one load and honours version bumps", async () => {
    const rt = new ReadThrough(new MemoryCache());
    let loads = 0;
    const load = async () => { loads++; await new Promise((r) => setTimeout(r, 10)); return loads; };
    await Promise.all(Array.from({ length: 20 }, () => rt.get("t", "k", 30, load)));
    expect(loads).toBe(1);
    expect(await rt.get("t", "k", 30, load)).toBe(1); // warm
    await rt.bump("fam");
    const v1 = await rt.version("fam");
    await rt.bump("fam");
    expect(await rt.version("fam")).not.toBe(v1);
  });
});

describe("consultation state machine", () => {
  it("terminal states have no exits and every target is a known state", () => {
    for (const s of ["completed", "cancelled", "expired", "no_show"] as const) expect(TRANSITIONS[s]).toEqual([]);
    for (const targets of Object.values(TRANSITIONS)) for (const t of targets) expect(t in TRANSITIONS).toBe(true);
  });
});

describe("webhook signature header", () => {
  it("round-trips", () => {
    const h = signWebhook("s".repeat(20), '{"a":1}', new Date(1_700_000_000_000));
    expect(parseSignatureHeader(h)).toMatchObject({ t: 1_700_000_000 });
    expect(parseSignatureHeader("garbage")).toBeNull();
  });
});
