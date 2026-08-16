#!/usr/bin/env bash
# Fails when db_schema/init/ and db_schema/migrations/ disagree.
#
# A fresh install runs init.sql and then every migration in order, so applying
# the migrations to a fresh init must be a no-op. Any difference means a
# migration changed the schema without the matching edit to init/, and a new
# instance would come up different from a migrated one.
#
# Two containers rather than two databases in one: the Supabase image restarts
# Postgres after its own init scripts, and CREATE DATABASE ... TEMPLATE needs
# the source database to have no connections. Separate instances sidestep both.
set -euo pipefail

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
PORT_INIT="${PORT_INIT:-55440}"
PORT_FULL="${PORT_FULL:-55441}"
PW="postgres"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C_INIT=harmony-drift-init
C_FULL=harmony-drift-full

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
err()  { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { docker rm -f "$C_INIT" "$C_FULL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

start_pg() {
  local name="$1" port="$2"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -e POSTGRES_PASSWORD="$PW" -p "$port:5432" "$IMAGE" >/dev/null
}

# The image reports ready, runs its init scripts, then restarts. Require several
# consecutive successful queries so the restart is not mistaken for readiness.
wait_pg() {
  local name="$1" ok=0
  for _ in $(seq 1 120); do
    if docker exec "$name" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
      ok=$((ok + 1))
      [ "$ok" -ge 5 ] && return 0
    else
      ok=0
    fi
    sleep 2
  done
  err "$name never stabilised"
  docker logs "$name" 2>&1 | tail -20
  return 1
}

apply_init() {
  docker exec -w /db_schema/init "$1" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f init.sql
}

log "starting two $IMAGE instances"
start_pg "$C_INIT" "$PORT_INIT"
start_pg "$C_FULL" "$PORT_FULL"
wait_pg "$C_INIT"
wait_pg "$C_FULL"

docker cp "$ROOT/db_schema" "$C_INIT:/db_schema" >/dev/null
docker cp "$ROOT/db_schema" "$C_FULL:/db_schema" >/dev/null

log "baseline   <- init/init.sql"
apply_init "$C_INIT" >/dev/null

log "migrated   <- init/init.sql + migrations/*.sql"
apply_init "$C_FULL" >/dev/null

FAILED=$(docker exec "$C_FULL" bash -c '
  for f in /db_schema/migrations/*.sql; do
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1 || basename "$f"
  done
')
if [ -n "$FAILED" ]; then
  log "migrations that errored on top of a fresh init (often benign - a"
  log "migration for an older shape - but worth reading):"
  echo "$FAILED" | sed 's/^/      /'
fi

log "diffing baseline against migrated"
DIFF=$(docker run --rm --network host djrobstep/migra \
  migra --unsafe \
  "postgresql://postgres:$PW@127.0.0.1:$PORT_INIT/postgres" \
  "postgresql://postgres:$PW@127.0.0.1:$PORT_FULL/postgres" 2>&1) && RC=0 || RC=$?

# migra exits 2 when a difference exists, 0 when identical, 1 on error.
if [ "$RC" = "0" ]; then
  log "no drift: migrations are a no-op on a fresh init"
  exit 0
fi
if [ "$RC" != "2" ]; then
  err "migra failed to run"
  echo "$DIFF"
  exit 1
fi

err "init/ and migrations/ disagree. The statements below reconcile a fresh"
err "init/ to the migrated schema - port them into init/ and re-run."
echo
echo "$DIFF"
exit 1
