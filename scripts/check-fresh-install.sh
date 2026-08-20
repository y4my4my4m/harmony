#!/usr/bin/env bash
# Runs self-host/bootstrap.sh against a throwaway container. bootstrap.sh loads
# db_schema/migrations/ and consults supabase_migrations.schema_migrations; no other gate
# exercises that decision. A fresh install must complete and record every migration file.
#
#   check-fresh-install.sh          build, install, assert
#   check-fresh-install.sh --keep   leave the container up
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-freshinstall}"
KEEP="${KEEP_CONTAINER:-0}"

[ "${1:-}" = "--keep" ] && KEEP=1

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { [ "$KEEP" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "starting $IMAGE as $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else ok=0; fi
  sleep 2
done
[ "$ok" -ge 3 ] || { err "postgres never stabilised"; exit 1; }

# compat.sql supplies realtime.messages; without it 98_enable_rls.sql skips the realtime
# policies and this gate passes on a schema no instance has.
docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -f /compat.sql >/dev/null

log "running self-host/bootstrap.sh against an empty database"
if ! SUPABASE_DB_CONTAINER="$CONTAINER" bash "$ROOT/self-host/bootstrap.sh" > /tmp/fresh-install.log 2>&1; then
  err "bootstrap.sh exited non-zero on a fresh database"
  tail -25 /tmp/fresh-install.log >&2
  exit 1
fi

if grep -qE '^Error:|failed\.' /tmp/fresh-install.log; then
  err "bootstrap.sh reported a failure:"
  grep -E '^Error:|failed\.' /tmp/fresh-install.log | head -5 >&2
  exit 1
fi

q() { docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc "$1" | tr -d '[:space:]'; }

files=$(ls "$ROOT"/db_schema/migrations/*.sql | wc -l | tr -d '[:space:]')
recorded=$(q "SELECT count(*) FROM supabase_migrations.schema_migrations")
tables=$(q "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'")
funcs=$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'")

log "$tables tables, $funcs functions, $recorded of $files migrations recorded"

fail=0
[ "$recorded" = "$files" ] || { err "ledger holds $recorded of $files migrations; a new install must be at the head"; fail=1; }
[ "$tables" -ge 90 ]       || { err "only $tables tables in public; the baseline did not finish"; fail=1; }
[ "$funcs"  -ge 300 ]      || { err "only $funcs functions in public; the baseline did not finish"; fail=1; }

log "running bootstrap.sh a second time"
if ! SUPABASE_DB_CONTAINER="$CONTAINER" bash "$ROOT/self-host/bootstrap.sh" --migrations-only > /tmp/fresh-install-2.log 2>&1; then
  err "the second bootstrap.sh run exited non-zero"
  tail -25 /tmp/fresh-install-2.log >&2
  exit 1
fi
if grep -qE '^  applied ' /tmp/fresh-install-2.log; then
  err "the second run applied migrations; a completed install must be idempotent:"
  grep -E '^  applied ' /tmp/fresh-install-2.log | head -5 >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1
log "a fresh install completes and lands at the head"
