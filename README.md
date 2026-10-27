# Amrutam Telemedicine — Backend

Production-grade backend for Amrutam's telemedicine platform: user lifecycle (auth, roles, MFA), doctor availability & booking, consultation lifecycle with prescriptions, payments (saga + webhooks), search & filtering, compliance audit trails and admin analytics.

**Stack:** Node.js 22 · TypeScript · Fastify · PostgreSQL (Redis optional) · zod · OpenTelemetry/Prometheus · Docker/Kubernetes · GitHub Actions.

| Requirement | Where |
|---|---|
| Git repo with code + infra | this repo — `src/`, `migrations/`, `Dockerfile`, `docker-compose.yml`, `deploy/k8s/` |
| README with setup | this file |
| OpenAPI schema | [`openapi/openapi.yaml`](openapi/openapi.yaml) (CI fails on drift from the code) |
| Architecture doc | [`docs/architecture.md`](docs/architecture.md) — HLD, booking sequence, ER, retries, partitioning, caching, sagas, backup/DR |
| Tests + CI pipeline | [`tests/`](tests) (76 tests), [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| Observability | [`docs/observability.md`](docs/observability.md), [`deploy/observability/`](deploy/observability) |
| Security checklist & threat model | [`docs/security.md`](docs/security.md) |
| 5-minute demo | [`DEMO.md`](DEMO.md) (script) + `npm run demo` |

## Quick start

### Option A — everything in Docker (API, worker, Postgres, Redis, Prometheus, Grafana, Jaeger)

```bash
docker compose up --build
# create the first admin (admins can't self-register); prints a TOTP secret once — add it to an authenticator app
docker compose run --rm -e ADMIN_EMAIL=admin@amrutam.example -e ADMIN_PASSWORD='change-me-please-123' api node dist/cli/seed.js
```

| Service | URL |
|---|---|
| API | http://localhost:3000 (`/healthz`, `/readyz`) |
| Grafana (dashboard "Amrutam — Service Overview") | http://localhost:3001 |
| Prometheus / alert rules | http://localhost:9090 |
| Jaeger (traces) | http://localhost:16686 |

### Option B — local Node + your own Postgres

```bash
nvm use 22 && npm ci
cp .env.example .env                       # then fill in the secrets (commands are in the file)
export $(grep -v '^#' .env | xargs)        # or use direnv / your shell's equivalent
npm run migrate                            # applies migrations/*.sql, creates audit-log partitions
ADMIN_EMAIL=admin@amrutam.example ADMIN_PASSWORD='change-me-please-123' npm run seed
npm run dev                                # API on :3000          (terminal 1)
npm run dev:worker                         # jobs/sagas/cron       (terminal 2)  ← required: payment intents, hold expiry, notifications, analytics
```

Generate secrets: `openssl rand -base64 48` (JWT) and `openssl rand -base64 32` (each key in `DATA_ENCRYPTION_KEYS` / `AUDIT_HMAC_KEYS`, format `1:<base64>`). Config is validated at boot; the process refuses to start with missing/weak values and never prints them.

### Try it

```bash
BASE_URL=http://localhost:3000 \
ADMIN_EMAIL=admin@amrutam.example ADMIN_PASSWORD='change-me-please-123' ADMIN_TOTP_SECRET=<secret printed by seed> \
PAYMENT_WEBHOOK_SECRET=<same as server> npm run demo
```

The demo walks the whole product: MFA enrollment → doctor verification → availability → search → idempotent booking → contention → payment webhook (signed, replayed, forged) → consultation → encrypted prescription → audit verification → analytics.

## Scripts

| Command | What |
|---|---|
| `npm test` | full suite. Uses an **in-process Postgres (PGlite)** by default — no Docker needed. Set `TEST_DATABASE_URL=postgres://…` to run the same suite against a **real server** (each test file gets an isolated schema). CI runs both. |
| `npm run typecheck` / `npm run build` | `tsc` |
| `npm run migrate` | apply SQL migrations (advisory-locked, safe to run from many pods) |
| `npm run seed` | create the first admin (`dist/cli/seed.js` in the image) |
| `npm run reencrypt [-- --apply]` | re-encrypt data with the newest key after a key rotation |
| `npm run demo` | end-to-end walkthrough against a running stack |
| `npm run loadtest` | contention test (N patients → 1 slot) + sustained mixed load with SLO check |
| `npm run audit` | dependency vulnerability scan |
| `scripts/restore-drill.sh` | backup → restore → invariant checks |

## API tour (curl)

```bash
API=http://localhost:3000
# patient
curl -s $API/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"asha@example.com","password":"a-long-passphrase-1","fullName":"Asha Rao","role":"patient"}'
TOKEN=$(curl -s $API/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"asha@example.com","password":"a-long-passphrase-1"}' | jq -r .tokens.accessToken)

curl -s "$API/v1/doctors?specialty=ayurveda&language=hi&maxFeeMinor=80000" -H "authorization: Bearer $TOKEN"
curl -s "$API/v1/doctors/<doctorId>/slots" -H "authorization: Bearer $TOKEN"

# book — Idempotency-Key is mandatory; retrying with the same key is always safe
curl -s $API/v1/consultations -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"slotId":"<slotId>","reason":"Recurring migraine"}'
```

Booking returns `pending_payment` with a 10-minute hold. The worker creates the PSP intent (`payment.checkoutUrl` appears on `GET /v1/payments/:id`); when the PSP calls `POST /v1/payments/webhook` (HMAC-signed) the consultation becomes `confirmed`. No payment → the hold expires and the slot is released. With the built-in **mock PSP**, `npm run demo` shows how to sign a webhook; the helper is `signWebhook()` in `src/modules/payments/provider.ts`.

Full reference: [`openapi/openapi.yaml`](openapi/openapi.yaml) (paste into https://editor.swagger.io or any OpenAPI viewer).

## Roles & core workflows

| Role | Can |
|---|---|
| **patient** | register, search doctors, view slots, book/cancel, view own consultations/payments/prescriptions |
| **doctor** (MFA required, admin-verified) | manage profile & availability, run consultations (`start` → `complete`/`no-show`), issue prescriptions |
| **admin** (MFA required, seeded) | verify/reject doctors, suspend/reinstate users, query & verify audit logs, analytics |

Consultation state machine: `pending_payment → confirmed → in_progress → completed`, with `cancelled`, `expired`, `no_show` exits. Refund policy: doctor/admin cancellations always refund; patients get a refund when cancelling ≥ 24 h ahead (`FREE_CANCELLATION_HOURS`).

## Project layout

```
src/
  app.ts, server.ts, worker.ts, bootstrap.ts, container.ts, deps.ts   composition root (constructor DI)
  config.ts                      zod-validated env config
  db/                            pg pool + tx retry, PGlite adapter (tests), migration runner
  lib/                           crypto (AES-GCM, keyring), password (scrypt), totp, cache, retry/backoff, clock
  plugins/                       error envelope, auth guards, idempotency
  modules/
    auth/ doctors/ consultations/ payments/ admin/ audit/    routes.ts · service.ts per module
  jobs/                          outbox queue (SKIP LOCKED), handlers, worker, notifier port
  observability/                 logger, Prometheus metrics, OpenTelemetry bootstrap
  cli/                           seed, reencrypt
migrations/                      001_init.sql, 002_audit_logs.sql
openapi/ docs/ deploy/ scripts/ tests/
```

## Design highlights (what to look at first)

* **No double booking, by construction** — an atomic `UPDATE … WHERE status='open'` claim, backed by a partial unique index; verified with 12–40 concurrent bookers (`tests/booking.test.ts`, `npm run loadtest`).
* **Idempotency that can't get stuck** — the key row commits *in the same transaction* as the work, so crashes leave nothing and concurrent duplicates just wait and replay (`src/plugins/idempotency.ts`).
* **Saga with real compensations** — hold expiry, payment-after-expiry auto-refund, refund-on-cancel, all through a transactional outbox (`src/modules/payments/service.ts`, `src/modules/consultations/service.ts`).
* **Security** — MFA, lockout, rotating refresh tokens with reuse detection, field-level AES-GCM with key rotation, HMAC-signed append-only audit log, RBAC + ownership checks, signed webhooks. See [`docs/security.md`](docs/security.md).
* **Operability** — RED + business metrics, SLO alerts, traces down to the SQL statement, readiness vs liveness, graceful shutdown, zero-downtime rollout, restore drill.

## Verified results

Measured locally against **PostgreSQL 18** (not a mock), API + worker as built Docker-equivalent processes, load generator on the same laptop — so treat absolute numbers as indicative, not a capacity claim:

* 76 automated tests pass on both in-process Postgres and a real server.
* 40 simultaneous bookings for one slot → **1 success, 39 × 409, 0 errors**.
* 40 concurrent clients, 15 s mixed workload: reads p95 **3.7 ms**, writes p95 **28.8 ms** (SLO 200 / 500 ms). Reads are mostly cache hits; writes were limited by available slots (79 samples).
* `npm audit`: 0 vulnerabilities.

Not verified here: container image build and Kubernetes manifests (no Docker/cluster available in the authoring environment — the YAML was syntax-checked and mirrors the tested process configuration), and the Mermaid diagrams were not rendered.

## Limitations

See the end of [`docs/architecture.md`](docs/architecture.md) and §10 of [`docs/security.md`](docs/security.md): mock PSP behind a port, no video/chat plane, stateless access tokens outlive suspension by ≤ 15 min, no MFA recovery codes, `consultations` partitioning designed but not yet needed.
