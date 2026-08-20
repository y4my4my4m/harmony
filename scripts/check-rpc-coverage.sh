#!/usr/bin/env bash
# Every RPC the application calls must exist in a schema built from init/.
#
# The drift gate compares init/ against init/ plus migrations, so it cannot see
# a function that is in neither. This gate reads the other side: the names the
# code actually calls. It exists because prod carried eight functions the app
# calls -- get_server_members_by_instance, verify_bot_token, the push-delivery
# set -- that were in no init file and no migration, so a fresh install answered
# "function does not exist" and nothing in CI noticed.
#
# Names are collected from `.rpc('name')` literals. A name assembled at runtime
# is invisible here; postReactions.ts picks between add_ and
# remove_post_emoji_reaction with a ternary, so both are listed explicitly in
# ALLOW_DYNAMIC below rather than silently missed.
#
#   check-rpc-coverage.sh              against a fresh init/ build (the CI gate)
#   check-rpc-coverage.sh --dump FILE  against a pg_dump of a live instance
#
# --dump answers the other half of the question. A fresh build having every called
# RPC says nothing about the instance users are on: production lacked six that
# init/ and staging both had, so those calls returned PGRST202 in the running app
# while every gate here was green. It reads function names out of the dump text
# and starts no container. CI cannot run it - there is no dump in CI - so it is an
# operator check, run before and after converging an instance.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${SUPABASE_PG_IMAGE:-supabase/postgres:15.8.1.060}"
CONTAINER="${CONTAINER_NAME:-harmony-rpccheck}"
KEEP="${KEEP_CONTAINER:-0}"
DUMP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dump) DUMP="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

if [ -n "$DUMP" ]; then
  [ -r "$DUMP" ] || { err "cannot read dump: $DUMP"; exit 2; }
  TARGET="$DUMP"
else
  TARGET="a fresh init/ build"
  cleanup() { [ "$KEEP" = "1" ] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
fi

if [ -z "$DUMP" ]; then
log "building a schema from init/"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
ok=0
for _ in $(seq 1 120); do
  if docker exec "$CONTAINER" psql -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 5 ] && break
  else ok=0; fi
  sleep 2
done
[ "$ok" -ge 5 ] || { err "postgres never stabilised"; exit 1; }

docker cp "$ROOT/db_schema" "$CONTAINER:/db_schema" >/dev/null
docker cp "$ROOT/scripts/test-db/supabase-compat.sql" "$CONTAINER:/compat.sql" >/dev/null
docker exec "$CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d postgres -q -f /compat.sql >/dev/null 2>&1 || true
docker exec -w /db_schema/init "$CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f init.sql >/dev/null
fi

log "collecting rpc() names from the application"
python3 - "$ROOT" <<'PY' > /tmp/rpc_wanted.txt
import re, os, sys
root = sys.argv[1]
names = set()
for sub in ('src', 'federation-backend/src', 'bot-gateway/src'):
    base = os.path.join(root, sub)
    for dp, _, fs in os.walk(base):
        if 'node_modules' in dp:
            continue
        for fn in fs:
            if not fn.endswith(('.ts', '.vue', '.js', '.mjs')):
                continue
            with open(os.path.join(dp, fn), encoding='utf8', errors='ignore') as fh:
                names |= set(re.findall(r"\.rpc\(\s*['\"]([a-z0-9_]+)['\"]", fh.read()))
print("\n".join(sorted(names)))
PY

# Names built at runtime, so no string literal exists to find.
ALLOW_DYNAMIC="add_post_emoji_reaction remove_post_emoji_reaction"
for n in $ALLOW_DYNAMIC; do echo "$n" >> /tmp/rpc_wanted.txt; done
sort -u /tmp/rpc_wanted.txt -o /tmp/rpc_wanted.txt

if [ -n "$DUMP" ]; then
  # pg_dump writes CREATE FUNCTION; hand-written files reach dumps as CREATE OR
  # REPLACE FUNCTION. Both forms, schema-qualified or not.
  grep -oP '^CREATE (OR REPLACE )?FUNCTION (public\.)?\K[a-z0-9_]+' "$DUMP" \
    | sort -u > /tmp/rpc_have.txt
  [ -s /tmp/rpc_have.txt ] || { err "no functions found in $DUMP - is it a schema dump?"; exit 2; }
else
  docker exec "$CONTAINER" psql -U postgres -d postgres -tAc \
    "SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'" | sort -u > /tmp/rpc_have.txt
fi

missing="$(comm -23 /tmp/rpc_wanted.txt /tmp/rpc_have.txt)"
wanted=$(wc -l < /tmp/rpc_wanted.txt)

if [ -n "$missing" ]; then
  err "$(printf '%s\n' "$missing" | wc -l) of $wanted called RPCs are missing from $TARGET:"
  printf '%s\n' "$missing" | sed 's/^/    /' >&2
  exit 1
fi
log "all $wanted called RPCs exist in $TARGET"
