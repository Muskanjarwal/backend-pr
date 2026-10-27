// Creates the first admin (admins cannot self-register). MFA is pre-enrolled so the account is usable immediately.
//   ADMIN_EMAIL=ops@amrutam.example ADMIN_PASSWORD='<12+ chars>' npm run seed      (in the image: node dist/cli/seed.js)
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createPgDb } from "../db/pg.js";
import { FieldCipher, Keyring } from "../lib/crypto.js";
import { PasswordHasher } from "../lib/password.js";
import { generateSecret, otpauthUri } from "../lib/totp.js";

const cfg = loadConfig();
const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars).");
  process.exit(1);
}

const db = createPgDb({ connectionString: cfg.DATABASE_URL, max: 2, ssl: cfg.DATABASE_SSL });
try {
  const id = randomUUID();
  const secret = generateSecret();
  const cipher = new FieldCipher(new Keyring(cfg.DATA_ENCRYPTION_KEYS));
  const hash = await new PasswordHasher({ N: cfg.PASSWORD_SCRYPT_N, r: 8, p: 1 }).hash(password);
  await db.tx(async (q) => {
    const r = await q.query(
      `INSERT INTO users (id, email, password_hash, role, mfa_enabled, mfa_secret_enc) VALUES ($1,$2,$3,'admin',true,$4) ON CONFLICT DO NOTHING`,
      [id, email, hash, cipher.encrypt(secret, `users.mfa_secret:${id}`)],
    );
    if (r.rowCount === 0) throw new Error(`An account for ${email} already exists`);
    await q.query(`INSERT INTO profiles (user_id, full_name) VALUES ($1, 'Administrator')`, [id]);
  });
  console.log(`Admin created: ${email}\nAuthenticator secret (shown once): ${secret}\n${otpauthUri(secret, email, "Amrutam")}`);
} finally {
  await db.close();
}
