#!/usr/bin/env bash
# Records migrations as applied without running them.
#
# For a database whose schema is already at or ahead of the migration files:
# a fresh init/ build (init/ contains everything the migrations produce), or an
# instance whose migrations were applied by hand and so has no history table.
#
# Wraps `supabase migration repair --status applied`, which takes every version
# in one call. The only thing added here is reading the version list from the
# migrations directory and the --through cutoff.
#
#   scripts/baseline-migrations.sh --url "$DATABASE_URL"
#   scripts/baseline-migrations.sh --url "$DATABASE_URL" --through 20260809000001
#   scripts/baseline-migrations.sh --url "$DATABASE_URL" --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGDIR="$ROOT/db_schema/migrations"
URL=""
THROUGH=""
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --url)     URL="$2"; shift 2 ;;
    --through) THROUGH="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] || { printf -- '--url is required\n' >&2; exit 2; }

mapfile -t VERSIONS < <(find "$MIGDIR" -name '*.sql' -type f -printf '%f\n' | sort | cut -c1-14)
[ "${#VERSIONS[@]}" -gt 0 ] || { printf 'no migrations in %s\n' "$MIGDIR" >&2; exit 1; }

if [ -n "$THROUGH" ]; then
  SELECTED=()
  for v in "${VERSIONS[@]}"; do
    [ "$v" \> "$THROUGH" ] && continue
    SELECTED+=("$v")
  done
else
  SELECTED=("${VERSIONS[@]}")
fi

printf '==> %s of %s migration(s) to record as applied\n' "${#SELECTED[@]}" "${#VERSIONS[@]}"
[ -n "$THROUGH" ] && printf '    cutoff: %s (later versions stay pending)\n' "$THROUGH"
printf '    first: %s\n    last:  %s\n' "${SELECTED[0]}" "${SELECTED[-1]}"

if [ "$DRY" = 1 ]; then
  printf '==> dry run, nothing written\n'
  exit 0
fi

supabase migration repair --status applied "${SELECTED[@]}" --db-url "$URL"
printf '==> done. Pending work:\n'
supabase db push --dry-run --db-url "$URL" || true
