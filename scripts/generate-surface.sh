#!/usr/bin/env bash
# Regenerates db_schema/SURFACE.tsv, the manifest of the public RPC surface.
#
# Builds the schema from init/ in a throwaway container and queries the catalog,
# so the manifest reflects what a fresh install exposes rather than whatever a
# particular database has accumulated.
#
# CI runs this and fails when the result differs from the committed file, which
# makes adding or removing a client-reachable endpoint a reviewed change.
set -euo pipefail

IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-surface}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/db_schema/SURFACE.tsv"

log() { printf '\033[36m==>\033[0m %s\n' "$*" >&2; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
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
[ "$ok" -ge 5 ] || { echo "postgres never stabilised" >&2; exit 1; }

log "applying init/"
docker exec "$CONTAINER" rm -rf /db_schema
docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
docker cp "$ROOT/scripts/test-db/storage-compat.sql" "$CONTAINER:/storage-compat.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f /storage-compat.sql
docker exec -w /db_schema/init "$CONTAINER" psql -U postgres -d postgres -q -f init.sql >/dev/null

log "querying the catalog"
docker cp "$ROOT/scripts/test-db/surface-query.sql" "$CONTAINER:/surface-query.sql" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -f /surface-query.sql \
  | python3 "$ROOT/scripts/test-db/build-surface.py" "$ROOT" > "$OUT"

log "wrote $OUT"
