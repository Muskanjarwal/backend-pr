# Security checklist & threat model

Status legend: ✅ implemented and covered by a test · 🟡 implemented, operational step needed · 📋 planned / out of scope for this assignment.

## 1. Data classification

| Class | Examples | Where | Controls |
|---|---|---|---|
| **Restricted (PHI)** | consultation `reason` (symptoms), prescription `items`/`notes` | `consultations.reason_enc`, `prescriptions` | AES-256-GCM field encryption (notes/reason), AAD-bound to row, role-limited reads, every read audited, never logged, never cached, never in audit metadata, admins cannot read clinical content |
| **Confidential (PII / secrets)** | phone, email, DOB, password hash, MFA secret, refresh tokens | `profiles`, `users`, `refresh_tokens` | phone & MFA secret encrypted; passwords scrypt-hashed; refresh tokens stored only as SHA-256; email only in `users` (never in logs/audit) |
| **Internal** | slots, fees, job payloads, audit rows | various | RBAC; audit rows HMAC-signed |
| **Public** | doctor name, specialty, fee, languages | `/v1/doctors` (authenticated) | verified doctors only |

Logs redact `Authorization`, cookies, signature headers and `password`/`token` fields; request bodies are never logged.

## 2. Attack surface

| Surface | Exposure | Primary defences |
|---|---|---|
| `POST /v1/auth/*` | Internet | per-IP rate limit (10/min), account lockout (5 failures → 15 min), constant-time dummy hash for unknown emails, generic error messages, strict schemas |
| Authenticated REST API | Internet, bearer JWT | HS256 pinned (no `alg=none`), `iss`/`aud`/`exp`/`kind` checked, permission matrix + ownership checks, zod `.strict()` bodies, body size cap 256 KB |
| `POST /v1/payments/webhook` | Internet (PSP) | HMAC-SHA256 over `timestamp.rawBody`, constant-time compare, 5-min tolerance, event-id de-duplication |
| `GET /readyz`, `/healthz` | Cluster/LB | no data returned |
| `/metrics` | Cluster only (separate port + NetworkPolicy) | not routed by the ingress |
| Postgres / Redis | VPC only | NetworkPolicy egress, TLS (`DATABASE_SSL`), least-privilege DB role |
| Worker → PSP / notifier | Egress 443 | provider idempotency keys, timeouts |
| CI/CD, container image | Supply chain | `npm audit`, Trivy, gitleaks, CodeQL, SHA-pinned image, non-root read-only container |

## 3. Threat model (STRIDE)

| # | Threat | Scenario | Mitigation | Status |
|---|---|---|---|---|
| S1 | **Spoofing** – credential stuffing / brute force | bots try leaked passwords | rate limit + lockout + generic errors; `LoginFailureSpike` alert; MFA mandatory for doctors/admins | ✅ `auth.test.ts` |
| S2 | Spoofing – stolen access token | token leaked from a device | 15-min TTL; `kind` claim stops challenge/setup tokens being used as sessions | ✅ |
| S3 | Spoofing – stolen refresh token | token exfiltrated | rotation on every use; **reuse of a rotated token revokes the whole family**; stored hashed; `RefreshTokenReuse` alert | ✅ |
| S4 | Spoofing – TOTP replay / shoulder-surf | attacker replays an observed code | time-step is single-use (conditional `UPDATE … mfa_last_step < step`); counts toward lockout | ✅ |
| S5 | Spoofing – forged PSP webhook | attacker marks a payment paid | HMAC signature, timestamp window, dedupe; unknown payment ids rejected | ✅ `booking.test.ts` |
| T1 | **Tampering** – parameter tampering / mass assignment | `{"role":"admin"}` at signup; extra fields | role not accepted for admin; `.strict()` schemas reject unknown fields | ✅ |
| T2 | Tampering – IDOR | patient reads another's consultation / prescription | ownership check in service layer; **404 not 403** so existence isn't leaked | ✅ |
| T3 | Tampering – replay of a write | network retry double-books or double-prescribes | `Idempotency-Key` (same-transaction), request-hash binding | ✅ |
| T4 | Tampering – ciphertext swapping | DB admin copies an encrypted value to another row | AES-GCM with row-bound AAD → decryption fails | ✅ `unit.test.ts` |
| R1 | **Repudiation** – "I never cancelled that" / privileged abuse | insider edits records | append-only `audit_logs` (trigger), same-transaction writes, per-row HMAC (`signatureValid`), actor/IP/request-id; admin reads of PHI and of the audit log are themselves audited | ✅ `admin.test.ts` |
| I1 | **Information disclosure** – PHI leakage via logs/metrics/errors | stack traces, query strings | redaction; opaque 500s; no PHI in metrics labels (route templates, not URLs) or audit metadata | ✅ |
| I2 | Info disclosure – DB dump / backup theft | stolen snapshot | field-level encryption (keys live outside the DB), encrypted volumes/backups | ✅ / 🟡 (infra) |
| I3 | Info disclosure – user enumeration | probing login/registration | identical login errors and timing; registration returns 409 (accepted trade-off, rate limited) | 🟡 |
| I4 | Info disclosure – cache poisoning/leak | PHI served from cache to wrong user | PHI never cached; cache keys contain only public query parameters | ✅ |
| D1 | **DoS** – request flood | L7 flood | ingress limit + per-IP app limit (Redis-backed across pods) + body/time limits + HPA | ✅ / 🟡 |
| D2 | DoS – slot hoarding | script holds every slot | ≤ 3 pending holds per patient; 10-min hold expiry | ✅ |
| D3 | DoS – expensive queries | huge ranges / unbounded pages | `limit ≤ 100`, 31-day slot window, keyset pagination, `statement_timeout` 10 s, analytics from rollup table | ✅ |
| D4 | DoS – PSP outage cascades | slow dependency blocks requests | PSP only called from the worker; timeouts; backoff | ✅ |
| E1 | **Elevation of privilege** – role confusion | patient calls doctor/admin endpoints | permission matrix (`modules/auth/rbac.ts`) per route + ownership in services | ✅ `auth.test.ts` |
| E2 | EoP – half-authenticated session | password-only token used as full session | separate `mfa_challenge`/`mfa_setup` token kinds, short TTL, accepted only at their endpoints | ✅ |
| E3 | EoP – self-registered admin | `role: admin` in signup | not in schema; admins only via `npm run seed` (operator with DB access) | ✅ |
| E4 | EoP – injection | SQLi / ILIKE wildcard abuse | 100 % parameterized queries; dynamic SQL limited to generated identifiers; `LIKE` metacharacters escaped | ✅ |
| E5 | EoP – deserialization/prototype pollution | crafted JSON | `JSON.parse` + zod strict schemas; no dynamic property assignment from input | ✅ |

## 4. OWASP Top 10 (2021) mapping

| Risk | How it is addressed |
|---|---|
| **A01 Broken Access Control** | RBAC matrix + ownership checks in services; 404 for foreign resources; doctors can only prescribe for their own consultations; tests for IDOR per resource |
| **A02 Cryptographic Failures** | scrypt (N=2¹⁵) passwords; AES-256-GCM field encryption with versioned keys + AAD; TLS everywhere; HSTS in prod; secrets only via env/secret manager; no custom crypto primitives |
| **A03 Injection** | parameterized SQL only; zod validation on every input; escaped `LIKE`; JSON-only API (no HTML sinks) |
| **A04 Insecure Design** | threat model above; saga/compensation design; idempotency; hold caps; state machine for lifecycle; invariants in DB constraints |
| **A05 Security Misconfiguration** | `@fastify/helmet`; non-root, read-only, cap-dropped containers; restricted PodSecurity; default-deny NetworkPolicy; config validated at boot (fails fast, never echoes values); no debug routes |
| **A06 Vulnerable Components** | `npm audit` (fail on high), Trivy image scan, CodeQL, lockfile-pinned installs (`npm ci`), minimal runtime dependency set; Dependabot/Renovate recommended |
| **A07 Identification & Authentication Failures** | MFA (TOTP) required for doctors/admins, optional for patients; lockout; rotating refresh tokens with reuse detection; password length 12–128, rejects passwords containing the email name; TOTP replay protection |
| **A08 Software & Data Integrity Failures** | signed webhooks; HMAC-signed audit rows; immutable SHA-tagged images; CI secret scanning; migrations applied by a Job from the same image |
| **A09 Security Logging & Monitoring Failures** | structured logs with request/trace ids; audit trail; alerts for login-failure spikes, refresh reuse, webhook signature failures, dead jobs |
| **A10 SSRF** | the server makes no requests to user-supplied URLs; PSP/notifier endpoints are fixed configuration; egress NetworkPolicy limits destinations |

## 5. Encryption

* **In transit:** TLS at the ingress (cert-manager); DB connections with `DATABASE_SSL=true` (certificate verification on); mesh/mTLS optional.
* **At rest:** volume/snapshot encryption (KMS) at the platform layer **plus** application-level AES-256-GCM on PHI/PII fields, so a leaked backup or an over-privileged DBA still sees ciphertext.
* **Format:** `v<keyVersion>.<iv>.<tag>.<ciphertext>`; random 96-bit IV per value; AAD = `<table.column>:<row id>`.
* **Passwords:** scrypt (N=32768, r=8, p=1, 16-byte salt) with timing-safe comparison. Cost is configurable (`PASSWORD_SCRYPT_N`); raise to 2¹⁷ when pod CPU allows.

## 6. Key management & rotation

| Secret | Rotation procedure | Frequency |
|---|---|---|
| **Data keys** `DATA_ENCRYPTION_KEYS` | 1) generate a new 32-byte key, set `DATA_ENCRYPTION_KEYS=1:<old>,2:<new>` and roll out (highest version encrypts, all decrypt — zero downtime) 2) run `npm run reencrypt -- --apply` (batched, compare-and-set, safe while serving traffic) 3) after it reports `0/N on an old key`, drop the old version | annually or on suspicion |
| **Audit HMAC keys** `AUDIT_HMAC_KEYS` | add a new version; old rows keep verifying via the `sig_version` stored on each row | annually |
| **JWT secret** | set `JWT_SECRET=<new>` and `JWT_SECRET_PREVIOUS=<old>`; remove the previous one after one access-token lifetime (15 min) — nobody is logged out | quarterly |
| **Webhook secret** | rotate at the PSP (dual-secret window), then update `PAYMENT_WEBHOOK_SECRET` | on staff change / annually |
| **DB credentials** | secret-manager rotation; pods pick up on restart | 90 days |

Verified on real data: re-encrypting rows from key v1 to v2 and reading them back (`tests/unit.test.ts` covers the cipher; the rotation script was exercised against a live database). In production the keys live in KMS/Secrets Manager and are injected as env vars via the ExternalSecret in `deploy/k8s/config.yaml`; a compromised pod can read its own env, so also keep the DB role least-privileged and monitor audit logs.

## 7. Audit logging

* Written **in the same transaction** as the action (register, login, MFA events, refresh reuse, booking, cancel, lifecycle, prescriptions, doctor verification, user suspension, slot publish/withdraw, payment webhooks and refunds, hold expiry) and for **reads of sensitive data** (prescriptions; admin reads of consultations; reads of the audit log itself).
* Fields: actor id/role, action, entity, IP, request id, small metadata (ids/state only — no PII/PHI).
* **Append-only:** `BEFORE UPDATE OR DELETE` trigger raises. Production should additionally run the app with a DB role that has `INSERT, SELECT` only on `audit_logs`.
* **Tamper-evident:** each row carries `HMAC-SHA256(auditKey[version], canonical(row))`; `GET /v1/admin/audit-logs?verify=true` recomputes it. The test disables the trigger as a superuser, edits a row and shows `signatureValid:false`.
* Monthly partitions → export closed partitions to WORM storage for the retention period required by regulation.

## 8. Dependency & supply-chain scanning

CI (`.github/workflows/ci.yml`): `npm audit --omit=dev --audit-level=high`, gitleaks (secrets), CodeQL (SAST), Trivy on the built image (fails on fixed HIGH/CRITICAL). Local result at the time of writing: `found 0 vulnerabilities`. Recommended: enable Dependabot/Renovate and sign images (cosign) with admission-time verification.

## 9. Security checklist

**Identity & access**
- [x] Passwords hashed with scrypt, 12-char minimum, no plaintext anywhere
- [x] MFA (TOTP) mandatory for doctors & admins, replay-protected
- [x] Lockout + rate limits on credential endpoints
- [x] Short-lived access tokens; rotating, reuse-detecting refresh tokens
- [x] RBAC permission matrix + per-resource ownership checks (IDOR tests)
- [x] No self-service admin creation
- [ ] 📋 MFA recovery codes; per-user (not just per-IP) rate limits; step-up auth for admin actions

**Data protection**
- [x] PHI/PII fields encrypted at the application layer (AES-256-GCM, versioned keys, AAD)
- [x] Key rotation procedure + re-encryption tool; JWT secret rotation without logout
- [x] PHI never logged, cached or placed in audit metadata
- [x] Money in integer minor units
- [ ] 🟡 Volume, snapshot and backup encryption (platform setting), TLS to the DB (`DATABASE_SSL=true` in prod)

**Application**
- [x] Input validation on every route, strict schemas, size limits
- [x] Parameterized SQL only; LIKE wildcards escaped
- [x] Idempotency on money-adjacent/clinical writes; webhook de-duplication
- [x] Security headers (helmet); uniform error envelope without internals
- [x] DB-level invariants for double booking and audit immutability

**Operations**
- [x] Secrets via environment/secret manager; config validated at startup
- [x] Non-root, read-only, capability-dropped container; restricted pod security; default-deny network policy
- [x] Dependency, image, SAST and secret scanning in CI; SHA-pinned immutable images
- [x] Metrics endpoint not publicly routed; alerts for auth abuse and stuck sagas
- [x] Backups + monthly restore drill (`scripts/restore-drill.sh`)
- [ ] 🟡 Least-privilege DB roles (`app` without DDL; `audit_logs` INSERT/SELECT only) — provisioning step
- [ ] 📋 Penetration test, WAF, bug-bounty, image signing

## 10. Residual risks (accepted)

1. **Registration reveals whether an email exists** (409). Mitigated by rate limiting; fixing it requires an email-verification flow, which needs a mail provider.
2. **Access token outlives suspension by ≤ 15 min** (stateless JWT). Reduce TTL or add a denylist if the risk appetite is lower.
3. **Env-var secrets are readable by anything executing in the pod.** Use CSI-mounted secrets / workload identity to shrink this further.
4. **Account lockout can be abused to lock a victim out** (targeted DoS). Lockouts are short (15 min), the per-IP limiter slows mass abuse, and admins can see the `login_locked` signal; adaptive/CAPTCHA step-up would be the next control.
5. **Mock PSP** — the webhook scheme (HMAC + timestamp) mirrors common PSPs but a real integration must follow that vendor's exact scheme.
