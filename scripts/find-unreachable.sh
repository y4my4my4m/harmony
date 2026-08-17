#!/usr/bin/env bash
# Regenerates db_schema/UNREACHABLE.tsv: public functions that no entry point
# reaches. Advisory only - nothing is dropped automatically. Removing a
# function is a reviewed change, because a false positive here is an outage.
set -euo pipefail

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-reach}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"

log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 5 ] && break
  else ok=0; fi
  sleep 2
done

log "building schema from init/"
docker exec "$CONTAINER" rm -rf /db_schema
docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
docker cp "$ROOT/scripts/test-db/roots-query.sql" "$CONTAINER:/roots.sql" >/dev/null
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -f /compat.sql >/dev/null 2>&1 || true
docker exec -w /db_schema/init "$CONTAINER" psql -U postgres -d postgres -q -f init.sql >/dev/null

docker exec "$CONTAINER" sh -c \
  'PGPASSWORD=postgres pg_dump -U postgres -d postgres --schema-only --no-owner --schema=public' \
  > "$WORK/public.sql"
docker exec "$CONTAINER" psql -U postgres -d postgres -f /roots.sql > "$WORK/roots.txt" 2>/dev/null

log "resolving reachability"
python3 "$ROOT/scripts/test-db/find-unreachable.py" "$WORK/public.sql" "$ROOT" "$WORK/roots.txt"
