#!/usr/bin/env bash
# =============================================================================
# Harmony self-host database bootstrap
# =============================================================================
# Loads the Harmony schema into the running Supabase Postgres and provisions
# the least-privilege `harmony_listener` role used by the federation worker.
#
# Run once after the first `docker compose up -d`. Safe to re-run: the schema
# load is skipped if Harmony tables already exist, migrations are idempotent,
# and the listener role is create-or-update.
#
# Usage:  bash bootstrap.sh [--migrations-only]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_CONTAINER="${SUPABASE_DB_CONTAINER:-supabase-db}"
DB_USER="postgres"
DB_NAME="postgres"

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_reset=$'\033[0m'
info() { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()   { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }
die()  { printf "Error: %s\n" "$*" >&2; exit 1; }

# A missing file makes sed exit non-zero, which `set -o pipefail` propagates and
# `set -e` turns into a silent exit at the assignment below - before any message
# is printed. Deployments whose compose lives outside the repo have no env files
# here at all, so absence has to read as "empty", not as failure.
val() {
	[ -f "$1" ] || return 0
	sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1 || true
}
PG_PW="$(val "$SCRIPT_DIR/supabase/.env" POSTGRES_PASSWORD)"
LISTENER_PW="$(val "$SCRIPT_DIR/federation.env" __LISTENER_PW)"
DOMAIN="$(val "$SCRIPT_DIR/.env" DOMAIN)"
INSTANCE_NAME="$(val "$SCRIPT_DIR/.env" INSTANCE_NAME)"
# The env files are written by configure.sh and sit beside this script, which
# assumes the bundled self-host layout. A deployment whose compose lives
# elsewhere has neither, and neither is needed to apply migrations: psql runs
# through `docker exec`, so it reaches Postgres over the container's local
# socket and PGPASSWORD goes unused. Only the steps that consume these values
# are skipped when they are missing.
[[ -n "$PG_PW" ]] || info "No POSTGRES_PASSWORD found; using the container's local socket"


docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || die "$DB_CONTAINER is not running. Start the stack first: docker compose up -d"

psql_exec() { docker exec -e PGPASSWORD="$PG_PW" -i "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

# Wait for Postgres to accept connections.
info "Waiting for Postgres..."
for _ in $(seq 1 60); do
	if docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" pg_isready -U "$DB_USER" -h localhost >/dev/null 2>&1; then break; fi
	sleep 2
done

MIGRATIONS_ONLY=false
[[ "${1:-}" == "--migrations-only" ]] && MIGRATIONS_ONLY=true

# --- full schema (init.sql) --------------------------------------------------
already="$(psql_exec -tAc "SELECT to_regclass('public.profiles') IS NOT NULL" 2>/dev/null | tr -d '[:space:]')"
if [[ "$already" == "t" ]]; then
	info "Harmony tables already present - skipping init.sql"
elif ! $MIGRATIONS_ONLY; then
	info "Loading full schema (db_schema/init/init.sql)..."
	docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
	docker cp "$REPO_DIR/db_schema" "$DB_CONTAINER:/tmp/db_schema"
	docker exec -e PGPASSWORD="$PG_PW" -w /tmp/db_schema/init "$DB_CONTAINER" \
		psql -U "$DB_USER" -d "$DB_NAME" -f init.sql 2>&1 | tail -10
	ok "Schema loaded"
fi

# --- migrations --------------------------------------------------------------
# Each migration runs once, in version order, and is recorded in
# supabase_migrations.schema_migrations - the same ledger the Supabase CLI uses,
# so `supabase migration list --db-url ...` reports on an instance installed
# this way and `supabase db push` continues from where this stopped.
#
# This loop used to run every file on every invocation with ON_ERROR_STOP=0 and
# output discarded, printing '.' or 'x' and then "Migrations applied" either
# way. Replaying is not merely wasteful: the 20260528 revert/restore pair was
# applied in filename order, so every run finished by dropping the home-feed
# trigger.
info "Applying migrations..."
docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
docker cp "$REPO_DIR/db_schema" "$DB_CONTAINER:/tmp/db_schema"

psql_exec -q >/dev/null <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
	version text PRIMARY KEY,
	name text,
	statements text[]
);
SQL

applied="$(psql_exec -tAc 'SELECT version FROM supabase_migrations.schema_migrations')"
pending=0
failed=0
for f in "$REPO_DIR"/db_schema/migrations/*.sql; do
	fname="$(basename "$f")"
	version="${fname:0:14}"
	name="${fname:15}"; name="${name%.sql}"
	grep -qxF "$version" <<<"$applied" && continue
	pending=$((pending + 1))
	if docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" \
		psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "/tmp/db_schema/migrations/$fname" >/tmp/harmony_mig_out 2>&1
	then
		psql_exec -q >/dev/null <<SQL
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('${version}', '${name}') ON CONFLICT (version) DO NOTHING;
SQL
		printf '  applied %s\n' "$fname"
	else
		failed=1
		printf 'Error: %s failed. It was not recorded; later migrations were skipped.\n' "$fname" >&2
		grep -E 'ERROR|FATAL' /tmp/harmony_mig_out | head -5 >&2 || true
		break
	fi
done
docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
[[ $failed -eq 0 ]] || die "migration failed - database is at the last migration that succeeded"
if [[ $pending -eq 0 ]]; then ok "Migrations up to date"; else ok "Applied $pending migration(s)"; fi

# --- least-privilege listener role ------------------------------------------
# Needs a password to set, so it is skipped where configure.sh has not run. The
# role is only used by the federation worker for instant job pickup; migrations
# do not depend on it.
if [[ -z "$LISTENER_PW" ]]; then
	info "No listener password found; leaving harmony_listener untouched"
else
info "Provisioning harmony_listener role..."
psql_exec >/dev/null <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harmony_listener') THEN
    CREATE ROLE harmony_listener WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
\$\$;
ALTER ROLE harmony_listener WITH PASSWORD '${LISTENER_PW}';
GRANT CONNECT ON DATABASE ${DB_NAME} TO harmony_listener;
SQL
ok "Listener role ready"
fi

# --- instance config + PostgREST reload --------------------------------------
if [[ -n "$DOMAIN" ]]; then
	psql_exec >/dev/null 2>&1 <<SQL || true
UPDATE public.instance_config SET config_value = '"${DOMAIN}"' WHERE config_key = 'domain';
UPDATE public.instance_config SET config_value = '"${INSTANCE_NAME}"' WHERE config_key = 'instance_name';
SQL
fi
psql_exec -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true

echo
ok "Bootstrap complete."
