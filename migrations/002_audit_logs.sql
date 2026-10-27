-- Append-only audit trail, range-partitioned by month so old partitions can be archived/detached cheaply.
-- No foreign keys point at this table, which is what makes partitioning it painless.
-- Each row carries an HMAC (key-versioned) so offline tampering is detectable even by someone with DB write access
-- but without the audit key.

CREATE TABLE audit_logs (
  id           uuid NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  actor_id     uuid,
  actor_role   text,
  action       text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text,
  ip           text,
  request_id   text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  sig_version  integer NOT NULL,
  signature    text NOT NULL,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;

CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
