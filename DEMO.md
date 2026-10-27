# 5-minute demo script

The brief asks for a 5-minute demo video. This is the shot list; every command is copy-pasteable. Record the terminal plus browser tabs for Grafana (:3001) and Jaeger (:16686).

**Before recording:** `docker compose up --build -d`, run the seed command from the README, export `ADMIN_TOTP_SECRET` (printed by seed) and `PAYMENT_WEBHOOK_SECRET=dev-only-webhook-secret`.

| Time | Show | Say |
|---|---|---|
| 0:00 | `docs/architecture.md` §1 diagram | "Modular monolith: stateless API + worker, Postgres as source of truth and queue, Redis only for cache and limits." |
| 0:30 | `npm run demo` (leave running while narrating the next rows) | "This drives the real API end to end." |
| 0:45 | demo step 2 | "Doctors can't get a session until they enroll in TOTP MFA; admin verifies them before they can publish slots." |
| 1:15 | demo step 4 — retry with same key, second patient gets 409 | "Booking requires an Idempotency-Key. The key commits in the same transaction as the booking, so a retry replays the original response and a duplicate can never double-book." |
| 1:45 | `BASE_URL=… npm run loadtest` — contention line | "40 patients, one slot, one winner, zero errors." |
| 2:15 | demo step 5 — unsigned → 401, signed → confirmed, replay → duplicate | "Webhooks are HMAC-signed with a timestamp window and de-duplicated by event id." |
| 2:45 | `docs/architecture.md` §2 sequence diagram | "Saga: hold + outbox in one tx; payment intent created by the worker; late payment on an expired hold triggers an automatic refund." |
| 3:15 | demo step 6–7 — prescription, audit entries with ✓sig | "PHI is AES-GCM encrypted per field; every read is audited; audit rows are append-only and HMAC-signed." Optionally: `psql -c "select reason_enc from consultations limit 1"` to show ciphertext. |
| 3:45 | Grafana dashboard after the load test | "RED metrics with SLO threshold lines, booking contention, queue depth, DB pool." |
| 4:15 | Jaeger: open a `POST /v1/consultations` trace | "Traces go down to each SQL statement; log lines carry the same trace id." |
| 4:30 | `npm test` (and CI file) | "76 tests — races, idempotency, saga edge cases, RBAC/IDOR, MFA, audit tamper detection, plus a contract test that fails if code and OpenAPI drift. Same suite runs on PGlite locally and real Postgres in CI." |
| 4:50 | `docs/security.md` threat-model table | "Threat model, OWASP mapping and key-rotation procedure are documented; known limits are listed honestly." |

Rotation moment worth showing if time allows: add `2:<new key>` to `DATA_ENCRYPTION_KEYS`, restart, `npm run reencrypt` (dry run shows `N/N on an old key`), `--apply`, run again → `0/N`.
