// Re-encrypts every encrypted column with the newest data key. Run (built: node dist/cli/reencrypt.js) after adding a new key version to DATA_ENCRYPTION_KEYS
// (and after the new version has been rolled out to all pods), then the old version can be retired.
//   npm run reencrypt            # dry-run summary
//   npm run reencrypt -- --apply
import { loadConfig } from "../config.js";
import { createPgDb } from "../db/pg.js";
import { FieldCipher, Keyring } from "../lib/crypto.js";

const cfg = loadConfig();
const apply = process.argv.includes("--apply");
const cipher = new FieldCipher(new Keyring(cfg.DATA_ENCRYPTION_KEYS));
const db = createPgDb({ connectionString: cfg.DATABASE_URL, max: 2, ssl: cfg.DATABASE_SSL });

// table, primary-key column, encrypted column, AAD prefix (must match what the services use when writing)
const TARGETS = [
  ["users", "id", "mfa_secret_enc", "users.mfa_secret"],
  ["profiles", "user_id", "phone_enc", "profiles.phone"],
  ["consultations", "id", "reason_enc", "consultations.reason"],
  ["prescriptions", "id", "notes_enc", "prescriptions.notes"],
] as const;

try {
  for (const [table, pk, col, aadPrefix] of TARGETS) {
    let last = "00000000-0000-0000-0000-000000000000";
    let stale = 0;
    let total = 0;
    for (;;) {
      const { rows } = await db.query<{ id: string; v: string }>(`SELECT ${pk}::text AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${pk} > $1::uuid ORDER BY ${pk} LIMIT 500`, [last]);
      if (rows.length === 0) break;
      for (const r of rows) {
        total++;
        last = r.id;
        if (!cipher.isStale(r.v)) continue;
        stale++;
        if (apply) {
          const aad = `${aadPrefix}:${r.id}`;
          await db.query(`UPDATE ${table} SET ${col} = $2 WHERE ${pk} = $1::uuid AND ${col} = $3`, [r.id, cipher.encrypt(cipher.decrypt(r.v, aad), aad), r.v]); // compare-and-set: safe against concurrent writers
        }
      }
    }
    console.log(`${table}.${col}: ${stale}/${total} on an old key${apply ? " → re-encrypted" : ""}`);
  }
  if (!apply) console.log("Dry run. Re-run with --apply to rewrite.");
} finally {
  await db.close();
}
