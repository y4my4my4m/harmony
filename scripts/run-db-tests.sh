#!/usr/bin/env bash
# Runs the pgTAP suite against a schema built from init/.
#
# Each file under db_schema/tests/ beyond the bootstrap and fixtures runs in its
# own transaction and rolls back, so files cannot affect one another.
set -euo pipefail

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-dbtest}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP="${KEEP_CONTAINER:-0}"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { [ "$KEEP" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "starting $IMAGE"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 5 ] && break
  else ok=0; fi
  sleep 2
done
[ "$ok" -ge 5 ] || { err "postgres never stabilised"; docker logs "$CONTAINER" | tail -20; exit 1; }

log "building schema from init/"
docker exec "$CONTAINER" rm -rf /db_schema
docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
# supabase_admin owns the realtime schema and postgres is not superuser in this
# image, so the realtime stubs are silently skipped when compat runs as
# postgres. pg_hba trusts supabase_admin over 127.0.0.1.
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -f /compat.sql 2>&1 |
  grep -v 'already exists, skipping' || true

# The stub is created inside an exception-guarded DO block, so a privilege
# failure leaves it absent instead of raising. Every broadcast trigger calls
# realtime.send; without it any INSERT on a table carrying one aborts and the
# test reads as a schema bug rather than a missing shim.
docker exec "$CONTAINER" psql -U postgres -d postgres -tAc \
  "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='realtime' AND p.proname='send'" | grep -q 1 || {
  err "realtime.send stub missing after compat; broadcast triggers will fail"
  exit 1
}
"$ROOT/scripts/test-db/load-schema.sh" "$CONTAINER"
log "installing pgtap and fixtures"
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f /db_schema/tests/00_bootstrap.sql
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f /db_schema/tests/01_fixtures.sql

FAILED=0
for f in "$ROOT"/db_schema/tests/*.sql; do
  name="$(basename "$f")"
  case "$name" in 00_*|01_*) continue ;; esac
  log "$name"
  # Output is read through here-strings, never `echo | grep -q` or `| head`: under pipefail a
  # reader that exits early leaves the writer with SIGPIPE (141), which turns a match into a
  # miss inside `if` and ends the script outside it.
  status=0
  out="$(docker exec "$CONTAINER" psql -U postgres -d postgres -tA -f "/db_schema/tests/$name" 2>&1)" || status=$?
  grep -E '^(ok|not ok|# )' <<<"$out" || true
  if [ "$status" -ne 0 ]; then
    FAILED=$((FAILED + 1))
    err "$name: psql exited $status"
    awk 'NR <= 10' <<<"$out" >&2
    continue
  fi
  if grep -q '^not ok' <<<"$out"; then
    FAILED=$((FAILED + 1))
    err "$name has failing assertions"
  fi
  # psql prefixes diagnostics: "psql:/db_schema/tests/NN_x.sql:LINE: ERROR:  ...".
  # ERROR never appears at column 0. A raise aborts the transaction, so every
  # assertion after it is skipped rather than failed: fewer ok lines, no not ok.
  if grep -qE '(^|:[[:space:]])ERROR:' <<<"$out"; then
    FAILED=$((FAILED + 1))
    err "$name raised an error"
    grep -E -A2 '(^|:[[:space:]])ERROR:' <<<"$out" | awk 'NR <= 10' >&2
  fi
  # finish() reports a short run only when reached. Separate from the error
  # check: a plan can be miscounted with nothing raised.
  if grep -q '^# Looks like you planned' <<<"$out"; then
    FAILED=$((FAILED + 1))
    err "$name ran a different number of assertions than it planned"
  fi
done

[ "$FAILED" -eq 0 ] || { err "$FAILED test file(s) failed"; exit 1; }
log "all database tests passed"
