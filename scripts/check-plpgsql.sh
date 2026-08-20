#!/usr/bin/env bash
# Every plpgsql function in a fresh init/ build must resolve against the schema it ships
# with.
#
# plpgsql does not resolve column or relation references until a statement first executes,
# so a body naming a column its table lacks is accepted by CREATE FUNCTION and raises 42703
# only when something calls it. The drift gate cannot see it - init/ and the migrations
# agree on the same broken text. check-rpc-coverage.sh cannot see it - the function exists.
# The type checker cannot see it - TypeScript does not read the database. That combination
# is how public.verify_bot_token shipped filtering on a bot_tokens.is_active that init/
# never declared, leaving bot authentication answering 401 on every fresh install.
#
# plpgsql_check walks each body against the catalog and reports what would raise. This gate
# runs it over every plpgsql function and fails on level='error'.
#
#   check-plpgsql.sh            build a schema from init/ and check it
#   check-plpgsql.sh --keep     leave the container running for inspection
#
# TRIGGER FUNCTIONS need the table they fire on, because NEW and OLD take its rowtype. One
# attached to several tables is checked against each, and an error counts only when it
# appears for EVERY one of them: a branch guarded by TG_TABLE_NAME legitimately fails to
# resolve against the tables it does not serve, while a genuine defect fails everywhere.
# Without that rule public.handle_unified_notification_processing reports a false
# `record "new" has no field "message_id"` - true of follows and post_interactions, and
# irrelevant, because the reference sits inside its `TG_TABLE_NAME = 'reactions'` arm.
#
# A trigger function with no trigger attached cannot be checked at all and is reported as
# skipped rather than passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-plpgsql}"
EXPECTED="$ROOT/db_schema/EXPECTED-PLPGSQL-ERRORS.tsv"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { [ "$KEEP" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

log "building a schema from init/"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null

# The unix socket accepts connections before TCP does, and the compat file runs over TCP as
# supabase_admin. Wait on the connection actually used.
ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else ok=0; fi
  sleep 2
done
[ "$ok" -ge 3 ] || { err "postgres never stabilised"; docker logs "$CONTAINER" 2>&1 | tail -20 >&2; exit 1; }

docker exec "$CONTAINER" rm -rf /db_schema
docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -v ON_ERROR_STOP=1 -f /compat.sql >/dev/null
"$ROOT/scripts/test-db/load-schema.sh" "$CONTAINER"
docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -q \
  -c 'CREATE EXTENSION IF NOT EXISTS plpgsql_check' >/dev/null

log "checking every plpgsql function in public"
docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAF'	' -c "
WITH fns AS (
  SELECT p.oid, (p.prorettype = 'trigger'::regtype) AS is_trig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
   WHERE n.nspname = 'public' AND l.lanname = 'plpgsql'
),
rel AS (
  SELECT f.oid, t.tgrelid
    FROM fns f
    JOIN pg_trigger t ON t.tgfoid = f.oid AND NOT t.tgisinternal
   WHERE f.is_trig
   GROUP BY f.oid, t.tgrelid
),
nrel AS (SELECT oid, count(*) AS n FROM rel GROUP BY oid),
checks AS (
  SELECT f.oid, 0::oid AS relid, 1::bigint AS n FROM fns f WHERE NOT f.is_trig
  UNION ALL
  SELECT r.oid, r.tgrelid, nr.n FROM rel r JOIN nrel nr ON nr.oid = r.oid
),
res AS (
  SELECT c.oid, c.n, k.sqlstate, k.message,
         count(*) OVER (PARTITION BY c.oid, k.sqlstate, k.message) AS hits
    FROM checks c
    CROSS JOIN LATERAL plpgsql_check_function_tb(c.oid, c.relid) k
   WHERE k.level = 'error'
)
SELECT DISTINCT oid::regprocedure::text, sqlstate, message
  FROM res WHERE hits = n
 ORDER BY 1;" > /tmp/plpgsql_found.tsv

# Trigger functions with no trigger cannot be given a rowtype, so they are never checked.
docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc "
SELECT count(*) FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
 WHERE n.nspname = 'public' AND l.lanname = 'plpgsql'
   AND p.prorettype = 'trigger'::regtype
   AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal);
" > /tmp/plpgsql_unchecked.txt

checked=$(docker exec "$CONTAINER" psql -h 127.0.0.1 -U supabase_admin -d postgres -tAc "
SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
 WHERE n.nspname = 'public' AND l.lanname = 'plpgsql';")
skipped=$(tr -d ' \n' < /tmp/plpgsql_unchecked.txt)

log "$checked plpgsql functions; $skipped trigger function(s) carry no trigger and are NOT checked"

sort -o /tmp/plpgsql_found.tsv /tmp/plpgsql_found.tsv
if [ -r "$EXPECTED" ]; then
  grep -v '^#' "$EXPECTED" | grep -v '^[[:space:]]*$' | sort > /tmp/plpgsql_expected.tsv
else
  : > /tmp/plpgsql_expected.tsv
fi

new="$(comm -23 /tmp/plpgsql_found.tsv /tmp/plpgsql_expected.tsv)"
gone="$(comm -13 /tmp/plpgsql_found.tsv /tmp/plpgsql_expected.tsv)"

if [ -n "$new" ]; then
  err "$(printf '%s\n' "$new" | wc -l) plpgsql function(s) would raise when called:"
  printf '%s\n' "$new" | sed 's/^/    /' >&2
  printf '\033[31mEach installs cleanly and fails at run time. Fix the body, or record it in\033[0m\n' >&2
  printf '\033[31m%s with the reason.\033[0m\n' "${EXPECTED#$ROOT/}" >&2
  exit 1
fi

if [ -n "$gone" ]; then
  err "recorded in ${EXPECTED#$ROOT/} but no longer reported - delete the stale line(s):"
  printf '%s\n' "$gone" | sed 's/^/    /' >&2
  exit 1
fi

log "every plpgsql function resolves against the schema it ships with"
