#!/usr/bin/env bash
# Replays db_schema/migrations/ in version order into a container, which is how a new install
# and `supabase db reset` build the schema.
#
# /db_schema must already be in the container, with supabase-compat.sql applied.
#
#   load-schema.sh <container> [role]
set -euo pipefail

CONTAINER="${1:?usage: load-schema.sh <container> [role]}"
ROLE="${2:-postgres}"

# supabase_admin has no local socket.
host_args=()
[ "$ROLE" = "postgres" ] || host_args=(-h 127.0.0.1)

docker exec "$CONTAINER" sh -c '
  set -e
  for f in $(ls /db_schema/migrations/*.sql | LC_ALL=C sort); do
    psql -U '"$ROLE"' '"${host_args[*]-}"' -d postgres -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  done
'
