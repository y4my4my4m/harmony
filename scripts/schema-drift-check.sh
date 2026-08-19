#!/usr/bin/env bash
# Fails when db_schema/init/ and db_schema/migrations/ disagree.
#
# A fresh install runs init.sql and then every migration in order, so applying
# the migrations to a fresh init must leave the schema unchanged. A difference
# means a migration altered the schema without the matching edit to init/, and a
# new instance would come up different from a migrated one.
#
# Two containers rather than two databases in one: the Supabase image restarts
# Postgres after its own init scripts, and CREATE DATABASE ... TEMPLATE needs the
# source database to have no connections. Separate instances sidestep both.
set -euo pipefail

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
MIGRA_IMAGE="${MIGRA_IMAGE:-djrobstep/migra}"
PORT_BASE="${PORT_BASE:-55440}"
PW=postgres
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C_BASE=harmony-drift-baseline
C_FULL=harmony-drift-migrated

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { docker rm -f "$C_BASE" "$C_FULL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start_pg() {
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" -e POSTGRES_PASSWORD="$PW" -p "$2:5432" "$IMAGE" >/dev/null
}

# The image reports ready, runs its init scripts, then restarts. Require several
# consecutive successful queries so the restart is not mistaken for readiness.
wait_pg() {
  local ok=0
  for _ in $(seq 1 120); do
    if docker exec "$1" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      ok=$((ok + 1)); [ "$ok" -ge 5 ] && return 0
    else ok=0; fi
    sleep 2
  done
  err "$1 never stabilised"; docker logs "$1" 2>&1 | tail -20; return 1
}

prepare() {
  local c="$1"
  # docker cp into an existing directory nests the source inside it.
  docker exec "$c" rm -rf /db_schema
  docker cp "$ROOT/db_schema" "$c:/db_schema" >/dev/null
  docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$c:/supabase-compat.sql" >/dev/null
  docker exec "$c" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -v ON_ERROR_STOP=1 -f /supabase-compat.sql
  docker exec -w /db_schema/init "$c" psql -U postgres -d postgres -q -f init.sql >/dev/null
}

log "starting two $IMAGE instances"
start_pg "$C_BASE" "$PORT_BASE"
start_pg "$C_FULL" "$((PORT_BASE + 1))"
wait_pg "$C_BASE"; wait_pg "$C_FULL"

log "baseline  <- init/init.sql"
prepare "$C_BASE"

log "migrated  <- init/init.sql + migrations/*.sql"
prepare "$C_FULL"
# A migration written for an older shape errors here and does nothing, which is
# harmless only while init/ already carries its end state - the diff below is what
# proves that. The reason is captured too: without it a migration that starts
# failing for a NEW cause is indistinguishable from the known set.
FAILED=$(docker exec "$C_FULL" bash -c '
  for f in /db_schema/migrations/*.sql; do
    # RI_ConstraintTrigger names carry an OID that moves whenever init/ changes.
    err=$(psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 >/dev/null \
          | grep -m1 -oP "ERROR:  \K.*" \
          | sed "s/RI_ConstraintTrigger_[a-z]_[0-9]\+/RI_ConstraintTrigger_*/g") || true
    [ -n "$err" ] && printf "%s\t%s\n" "$(basename "$f")" "$err"
  done
  true
')
EXPECTED="$ROOT/db_schema/EXPECTED-MIGRATION-FAILURES.tsv"
if [ -n "$FAILED" ]; then
  log "migrations that errored against a fresh init:"
  printf '%s\n' "$FAILED" | sed 's/^/      /'
fi
if [ -r "$EXPECTED" ]; then
  # Compare names and reasons. A reason that changes means the migration is now
  # failing for a different cause than the one adjudicated.
  if ! diff -u <(grep -v '^#' "$EXPECTED" | grep -v '^[[:space:]]*$' | sort) \
               <(printf '%s\n' "$FAILED" | grep -v '^[[:space:]]*$' | sort) \
       > /tmp/harmony-migfail.diff 2>&1; then
    printf '\033[31mthe set of migrations failing against a fresh init changed.\033[0m\n' >&2
    sed 's/^/    /' /tmp/harmony-migfail.diff >&2
    printf '\033[31mAdjudicate each new line, then update %s.\033[0m\n' "${EXPECTED#$ROOT/}" >&2
    exit 1
  fi
  log "migration failure set matches ${EXPECTED#$ROOT/}"
fi

log "diffing baseline against migrated"
DUMP=/tmp/harmony-drift
mkdir -p "$DUMP"
for pair in "$C_BASE:baseline" "$C_FULL:migrated"; do
  c="${pair%%:*}"; label="${pair##*:}"
  docker exec "$c" sh -c \
    'PGPASSWORD=postgres pg_dump -U postgres -d postgres --schema-only --no-owner --no-comments --schema=public' \
    > "$DUMP/$label.sql"
  python3 "$ROOT/scripts/test-db/normalize-schema.py" "$DUMP/$label.sql" > "$DUMP/$label.txt"
done

if python3 "$ROOT/scripts/test-db/compare-schema.py" "$DUMP/baseline.txt" "$DUMP/migrated.txt"; then
  log "no drift: migrations are a no-op on a fresh init"
  exit 0
fi

err "dumps kept in $DUMP for inspection"
exit 1
