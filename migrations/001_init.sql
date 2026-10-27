-- Amrutam telemedicine core schema.
-- Conventions: UUID primary keys, timestamptz everywhere, money as integer minor units (paise).

CREATE TABLE users (
  id               uuid PRIMARY KEY,
  email            text NOT NULL,
  password_hash    text NOT NULL,
  role             text NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  mfa_enabled      boolean NOT NULL DEFAULT false,
  mfa_secret_enc   text,                       -- AES-256-GCM envelope (see lib/crypto.ts)
  mfa_last_step    integer,                    -- last accepted TOTP time-step; blocks code replay
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,                   -- rotation family; reuse of a rotated token revokes the family
  token_hash  text NOT NULL UNIQUE,            -- sha256 of the opaque token; the raw token is never stored
  expires_at  timestamptz NOT NULL,
  rotated_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

-- PII lives here, apart from credentials, so it can be encrypted/retained/erased independently.
CREATE TABLE profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name      text NOT NULL,
  phone_enc      text,                          -- encrypted
  date_of_birth  date,
  gender         text CHECK (gender IN ('female', 'male', 'other')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX profiles_name_prefix_idx ON profiles (lower(full_name) text_pattern_ops, user_id);

CREATE TABLE doctors (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  specialty            text NOT NULL,
  registration_number  text NOT NULL,
  years_experience     integer NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  languages            text[] NOT NULL DEFAULT '{}',
  bio                  text,
  fee_minor            integer NOT NULL CHECK (fee_minor >= 0),
  currency             text NOT NULL DEFAULT 'INR',
  verification_status  text NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending', 'verified', 'rejected')),
  verified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX doctors_registration_uq ON doctors (registration_number);
CREATE INDEX doctors_search_idx ON doctors (specialty, fee_minor) WHERE verification_status = 'verified';

-- A slot is the unit of inventory. Fixed length, so overlap checks are plain equality on (doctor_id, starts_at).
CREATE TABLE availability_slots (
  id          uuid PRIMARY KEY,
  doctor_id   uuid NOT NULL REFERENCES doctors(user_id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'held', 'booked', 'cancelled')),
  held_until  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK ((status = 'held') = (held_until IS NOT NULL))
);
CREATE UNIQUE INDEX slots_doctor_start_uq ON availability_slots (doctor_id, starts_at) WHERE status <> 'cancelled';
CREATE INDEX slots_doctor_open_idx ON availability_slots (doctor_id, starts_at) WHERE status = 'open';
CREATE INDEX slots_held_expiry_idx ON availability_slots (held_until) WHERE status = 'held';

CREATE TABLE consultations (
  id                uuid PRIMARY KEY,
  slot_id           uuid NOT NULL REFERENCES availability_slots(id),
  patient_id        uuid NOT NULL REFERENCES users(id),
  doctor_id         uuid NOT NULL REFERENCES doctors(user_id),
  status            text NOT NULL CHECK (status IN
                      ('pending_payment', 'confirmed', 'in_progress', 'completed', 'cancelled', 'expired', 'no_show')),
  scheduled_start   timestamptz NOT NULL,
  scheduled_end     timestamptz NOT NULL,
  reason_enc        text,                       -- patient-supplied symptoms; encrypted
  hold_expires_at   timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  cancelled_by      uuid REFERENCES users(id),
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Only one *live* consultation per slot; cancelled/expired ones release it.
CREATE UNIQUE INDEX consultations_live_slot_uq ON consultations (slot_id)
  WHERE status IN ('pending_payment', 'confirmed', 'in_progress', 'completed', 'no_show');
CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_start DESC);
CREATE INDEX consultations_doctor_idx ON consultations (doctor_id, scheduled_start DESC);
CREATE INDEX consultations_status_idx ON consultations (status, scheduled_start);
CREATE INDEX consultations_recent_idx ON consultations (scheduled_start DESC, id DESC); -- admin listing without filters
CREATE INDEX consultations_hold_expiry_idx ON consultations (hold_expires_at) WHERE status = 'pending_payment';

CREATE TABLE prescriptions (
  id               uuid PRIMARY KEY,
  consultation_id  uuid NOT NULL REFERENCES consultations(id),
  doctor_id        uuid NOT NULL REFERENCES doctors(user_id),
  patient_id       uuid NOT NULL REFERENCES users(id),
  items            jsonb NOT NULL,              -- [{medicine, dosage, frequency, duration_days, instructions?}]
  notes_enc        text,                        -- encrypted free text
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_consultation_idx ON prescriptions (consultation_id);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY,
  consultation_id      uuid NOT NULL REFERENCES consultations(id),
  patient_id           uuid NOT NULL REFERENCES users(id),
  amount_minor         integer NOT NULL CHECK (amount_minor >= 0),
  currency             text NOT NULL,
  status               text NOT NULL CHECK (status IN
                         ('pending', 'succeeded', 'failed', 'refund_pending', 'refunded')),
  provider             text NOT NULL,
  provider_payment_id  text,
  provider_refund_id   text,
  checkout_url         text,
  failure_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_consultation_idx ON payments (consultation_id);
CREATE UNIQUE INDEX payments_provider_uq ON payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;

-- Webhook de-duplication: provider event ids are processed at most once.
CREATE TABLE processed_webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX processed_webhook_received_idx ON processed_webhook_events (received_at);

-- Idempotency for unsafe writes. (user_id, key) is the identity; request_hash guards against key reuse with a different body.
-- The row is inserted in the SAME transaction as the business write, so it only becomes visible once the work is
-- committed: a crash leaves nothing behind, and a concurrent request with the same key simply blocks on the unique
-- index until the first one commits, then replays its stored response.
CREATE TABLE idempotency_keys (
  user_id        uuid NOT NULL,
  key            text NOT NULL,
  method         text NOT NULL,
  path           text NOT NULL,
  request_hash   text NOT NULL,
  response_status integer NOT NULL,
  response_body  jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_expires_idx ON idempotency_keys (expires_at);

-- Transactional outbox / job queue. Workers claim with FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id            uuid PRIMARY KEY,
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'dead')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 8,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  last_error    text,
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (run_at) WHERE status IN ('queued', 'running');
-- Supports ensureRecurring's "ran recently?" probe and the retention sweep without scanning the whole table.
CREATE INDEX jobs_type_created_idx ON jobs (type, created_at DESC);
CREATE INDEX jobs_cleanup_idx ON jobs (updated_at) WHERE status = 'succeeded';
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running');

-- Admin analytics rollup, refreshed by a scheduled job so dashboards never scan consultations.
CREATE TABLE daily_stats (
  day                date NOT NULL,
  specialty          text NOT NULL,
  booked             integer NOT NULL DEFAULT 0,
  completed          integer NOT NULL DEFAULT 0,
  cancelled          integer NOT NULL DEFAULT 0,
  revenue_minor      bigint NOT NULL DEFAULT 0,
  refreshed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, specialty)
);
