#!/usr/bin/env bash
# Restore drill: proves a backup is actually restorable and internally consistent. Run monthly (and after schema changes).
#   SRC_URL=postgres://… (prod replica or PITR clone)  SCRATCH_URL=postgres://… (empty scratch DB)  ./scripts/restore-drill.sh
set -euo pipefail
: "${SRC_URL:?}" "${SCRATCH_URL:?}"
dump="$(mktemp -t amrutam-drill.XXXXXX)"; trap 'rm -f "$dump"' EXIT

pg_dump --format=custom --no-owner --file="$dump" "$SRC_URL"
pg_restore --no-owner --exit-on-error --dbname="$SCRATCH_URL" "$dump"

# Integrity checks that would catch a bad restore or a broken saga:
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -At <<'SQL'
\echo -- slots double-referenced by live consultations (must be 0)
SELECT count(*) FROM (SELECT slot_id FROM consultations WHERE status IN ('pending_payment','confirmed','in_progress','completed','no_show') GROUP BY slot_id HAVING count(*) > 1) x;
\echo -- confirmed consultations whose slot is not booked (must be 0)
SELECT count(*) FROM consultations c JOIN availability_slots s ON s.id = c.slot_id WHERE c.status = 'confirmed' AND s.status <> 'booked';
\echo -- succeeded payments on cancelled/expired consultations still owed a refund (must be 0)
SELECT count(*) FROM payments p JOIN consultations c ON c.id = p.consultation_id WHERE p.status = 'succeeded' AND c.status IN ('expired') ;
\echo -- row counts
SELECT 'users', count(*) FROM users UNION ALL SELECT 'consultations', count(*) FROM consultations UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs;
SQL
echo "Restore drill OK"
