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

val() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }
PG_PW="$(val "$SCRIPT_DIR/supabase/.env" POSTGRES_PASSWORD)"
LISTENER_PW="$(val "$SCRIPT_DIR/federation.env" __LISTENER_PW)"
DOMAIN="$(val "$SCRIPT_DIR/.env" DOMAIN)"
INSTANCE_NAME="$(val "$SCRIPT_DIR/.env" INSTANCE_NAME)"
[[ -n "$PG_PW" ]] || die "Could not read POSTGRES_PASSWORD - run configure.sh first"
[[ -n "$LISTENER_PW" ]] || die "Could not read listener password - run configure.sh first"

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

# --- migrations (idempotent) -------------------------------------------------
info "Applying migrations..."
docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
docker cp "$REPO_DIR/db_schema" "$DB_CONTAINER:/tmp/db_schema"
for f in "$REPO_DIR"/db_schema/migrations/*.sql; do
	fname="$(basename "$f")"
	docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" \
		psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=0 -f "/tmp/db_schema/migrations/$fname" >/dev/null 2>&1 \
		&& printf '.' || printf 'x'
done
echo
docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
ok "Migrations applied"

# --- least-privilege listener role ------------------------------------------
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

# --- instance config + PostgREST reload --------------------------------------
if [[ -n "$DOMAIN" ]]; then
	psql_exec >/dev/null 2>&1 <<SQL || true
UPDATE public.instance_config SET config_value = '"${DOMAIN}"' WHERE config_key = 'domain';
UPDATE public.instance_config SET config_value = '"${INSTANCE_NAME}"' WHERE config_key = 'instance_name';
SQL
fi
psql_exec -c "NOTIFY pgrst, 'reload schema';" >/dev/null 2>&1 || true

echo
ok "Bootstrap complete. Federation worker will use harmony_listener for instant job pickup."
