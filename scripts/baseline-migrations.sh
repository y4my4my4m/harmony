#!/usr/bin/env bash
# Records migrations as applied without running them.
#
# For a database whose schema is already at or ahead of the migration files: a
# fresh init/ build (init/ contains everything the migrations produce), or an
# instance whose migrations were applied by hand and so has no history table.
# Without this the first `db push` or bootstrap.sh run would replay everything.
#
# Two transports, because a self-hosted stack does not publish Postgres on the
# host - self-host/trim-supabase.py drops supavisor, and with it the published
# port - so --url cannot reach it and --docker is the way in:
#
#   scripts/baseline-migrations.sh --url "$DATABASE_URL"
#   scripts/baseline-migrations.sh --docker supabase-db --password "$PGPASSWORD"
#
# --through records up to and including one version and leaves the rest
# pending, which is how an existing instance takes only the new migrations:
#
#   scripts/baseline-migrations.sh --docker supabase-db --through 20260809000001
#
# --dry-run prints what would be recorded and writes nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGDIR="$ROOT/db_schema/migrations"
URL=""
CONTAINER=""
PGPW="${PGPASSWORD:-}"
DB_USER="${PGUSER:-postgres}"
DB_NAME="${PGDATABASE:-postgres}"
THROUGH=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)      URL="$2"; shift 2 ;;
    --docker)   CONTAINER="$2"; shift 2 ;;
    --password) PGPW="$2"; shift 2 ;;
    --user)     DB_USER="$2"; shift 2 ;;
    --db)       DB_NAME="$2"; shift 2 ;;
    --through)  THROUGH="$2"; shift 2 ;;
    --dry-run)  DRY=1; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] || [ -n "$CONTAINER" ] || {
  printf -- 'one of --url <conninfo> or --docker <container> is required\n' >&2; exit 2; }

psql_run() {
  if [ -n "$CONTAINER" ]; then
    docker exec -i -e PGPASSWORD="$PGPW" "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" "$@"
  else
    psql "$URL" "$@"
  fi
}

psql_run -tAc 'select 1' >/dev/null 2>&1 || { printf 'cannot reach the database\n' >&2; exit 1; }

mapfile -t VERSIONS < <(find "$MIGDIR" -name '*.sql' -type f -printf '%f\n' | sort | cut -c1-14)
[ "${#VERSIONS[@]}" -gt 0 ] || { printf 'no migrations in %s\n' "$MIGDIR" >&2; exit 1; }

SELECTED=()
for v in "${VERSIONS[@]}"; do
  [ -n "$THROUGH" ] && [ "$v" \> "$THROUGH" ] && continue
  SELECTED+=("$v")
done

# Report what is already recorded. Without this the counts describe the files on
# disk and say nothing about the database, which reads as "246 of 246" on an
# instance that has no ledger at all and on one that is fully up to date alike.
existing=""
if [ "$(psql_run -tAc "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL" | tr -d '[:space:]')" = "t" ]; then
	existing="$(psql_run -tAc 'SELECT version FROM supabase_migrations.schema_migrations')"
	printf '==> ledger exists, %s migration(s) already recorded\n' "$(grep -c . <<<"$existing" || true)"
else
	printf '==> no ledger yet; it will be created\n'
fi

new_rows=0
for v in "${SELECTED[@]}"; do grep -qxF "$v" <<<"$existing" || new_rows=$((new_rows + 1)); done
pending_after=0
for v in "${VERSIONS[@]}"; do
	grep -qxF "$v" <<<"$existing" && continue
	[ -n "$THROUGH" ] && [ "$v" \> "$THROUGH" ] && { pending_after=$((pending_after + 1)); continue; }
done

printf '==> %s of %s file(s) selected; %s not yet recorded\n' "${#SELECTED[@]}" "${#VERSIONS[@]}" "$new_rows"
[ -n "$THROUGH" ] && printf '    cutoff: %s -> %s migration(s) stay pending for the runner\n' "$THROUGH" "$pending_after"
printf '    first: %s\n    last:  %s\n' "${SELECTED[0]}" "${SELECTED[-1]}"
[ "$DRY" = 1 ] && { printf '==> dry run, nothing written\n'; exit 0; }

# Same table and columns the Supabase CLI writes, so `supabase migration list`
# and `supabase db push` read this correctly, as does self-host/bootstrap.sh.
{
  printf 'CREATE SCHEMA IF NOT EXISTS supabase_migrations;\n'
  printf 'CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[]);\n'
  for f in $(find "$MIGDIR" -name '*.sql' -type f -printf '%f\n' | sort); do
    v="${f:0:14}"
    for s in "${SELECTED[@]}"; do
      if [ "$s" = "$v" ]; then
        n="${f:15}"; n="${n%.sql}"
        printf "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('%s', '%s') ON CONFLICT (version) DO NOTHING;\n" "$v" "$n"
        break
      fi
    done
  done
} | psql_run -v ON_ERROR_STOP=1 -q >/dev/null

recorded="$(psql_run -tAc 'SELECT count(*) FROM supabase_migrations.schema_migrations' | tr -d '[:space:]')"
printf '==> history now holds %s migration(s)\n' "$recorded"
