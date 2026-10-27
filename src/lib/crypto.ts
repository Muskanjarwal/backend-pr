import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Keyring string format: "1:<base64 32 bytes>,2:<base64 32 bytes>". The highest version encrypts; all versions decrypt. */
export class Keyring {
  private readonly keys = new Map<number, Buffer>();
  readonly currentVersion: number;

  constructor(spec: string) {
    for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(":");
      const version = Number(part.slice(0, idx));
      const key = Buffer.from(part.slice(idx + 1), "base64");
      if (!Number.isInteger(version) || version < 1) throw new Error(`Invalid key version in keyring: "${part.slice(0, idx)}"`);
      if (key.length !== 32) throw new Error(`Key v${version} must be 32 bytes (base64-encoded)`);
      this.keys.set(version, key);
    }
    if (this.keys.size === 0) throw new Error("Keyring is empty");
    this.currentVersion = Math.max(...this.keys.keys());
  }

  get(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Unknown key version ${version}`);
    return key;
  }

  current(): Buffer {
    return this.get(this.currentVersion);
  }
}

/**
 * Field-level AES-256-GCM. Output: "v<keyVersion>.<iv>.<tag>.<ciphertext>" (base64url parts).
 * `aad` binds the ciphertext to its row/column so a value copied to another record fails authentication.
 */
export class FieldCipher {
  constructor(private readonly keyring: Keyring) {}

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keyring.current(), iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [`v${this.keyring.currentVersion}`, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
  }

  decrypt(envelope: string, aad: string): string {
    const [v, iv, tag, ct] = envelope.split(".");
    if (!v || !iv || !tag || ct === undefined || !v.startsWith("v")) throw new Error("Malformed ciphertext envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.keyring.get(Number(v.slice(1))), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  /** True when the envelope was written with an older key and should be re-encrypted on next write. */
  isStale(envelope: string): boolean {
    return Number(envelope.split(".")[0]?.slice(1)) !== this.keyring.currentVersion;
  }
}

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
export const hmacHex = (key: string | Buffer, data: string): string => createHmac("sha256", key).update(data).digest("hex");
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
