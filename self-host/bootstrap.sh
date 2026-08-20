#!/usr/bin/env bash
# Loads the Harmony schema into the running Supabase Postgres and provisions the
# least-privilege `harmony_listener` role.
#
# Usage:  bash bootstrap.sh [--migrations-only]
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

# sed on a missing file exits non-zero; pipefail and `set -e` turn that into a
# silent exit at the assignment. A missing env file reads as empty.
val() {
	[ -f "$1" ] || return 0
	sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1 || true
}
PG_PW="$(val "$SCRIPT_DIR/supabase/.env" POSTGRES_PASSWORD)"
LISTENER_PW="$(val "$SCRIPT_DIR/federation.env" __LISTENER_PW)"
DOMAIN="$(val "$SCRIPT_DIR/.env" DOMAIN)"
INSTANCE_NAME="$(val "$SCRIPT_DIR/.env" INSTANCE_NAME)"
# The env files sit beside this script under the bundled self-host layout.
# psql runs through `docker exec` and reaches Postgres over the container's
# local socket, so PGPASSWORD is unused; only the steps consuming these values
# are skipped when they are missing.
[[ -n "$PG_PW" ]] || info "No POSTGRES_PASSWORD found; using the container's local socket"


docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || die "$DB_CONTAINER is not running. Start the stack first: docker compose up -d"

# Replacing functions requires ownership or superuser. Objects created through
# the Studio SQL editor are owned by supabase_admin, and `postgres` - not a
# superuser in this image - fails with "must be owner of function ...". pg_hba
# trusts supabase_admin over 127.0.0.1 inside the container.
DB_HOST_ARGS=()
pick_db_role() {
	local not_owned super
	if docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" \
		psql -U postgres -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
		super="$(docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -tAc \
			"SELECT rolsuper FROM pg_roles WHERE rolname = current_user" 2>/dev/null | tr -d '[:space:]')"
		not_owned="$(docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" psql -U postgres -d "$DB_NAME" -tAc \
			"SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
			  WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) <> current_user" 2>/dev/null | tr -d '[:space:]')"
		if [[ "$super" == "t" || "$not_owned" == "0" ]]; then
			DB_USER=postgres; DB_HOST_ARGS=(); return 0
		fi
		info "postgres owns none of ${not_owned:-?} public function(s); trying supabase_admin"
	fi
	if docker exec "$DB_CONTAINER" psql -U supabase_admin -h 127.0.0.1 -d "$DB_NAME" -tAc 'SELECT 1' >/dev/null 2>&1; then
		DB_USER=supabase_admin; DB_HOST_ARGS=(-h 127.0.0.1); return 0
	fi
	return 1
}

psql_exec() { docker exec -e PGPASSWORD="$PG_PW" -i "$DB_CONTAINER" psql -U "$DB_USER" "${DB_HOST_ARGS[@]}" -d "$DB_NAME" "$@"; }

info "Waiting for Postgres..."
for _ in $(seq 1 60); do
	if docker exec -e PGPASSWORD="$PG_PW" "$DB_CONTAINER" pg_isready -U "$DB_USER" -h localhost >/dev/null 2>&1; then break; fi
	sleep 2
done

pick_db_role || die "no role can modify the schema: tried postgres and supabase_admin"
info "Applying as $DB_USER"

MIGRATIONS_ONLY=false
FRESH_LOAD=false
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
		psql -U "$DB_USER" "${DB_HOST_ARGS[@]}" -d "$DB_NAME" -f init.sql 2>&1 | tail -10
	ok "Schema loaded"
	FRESH_LOAD=true
fi

# --- migrations --------------------------------------------------------------
# Each migration runs once, in version order, recorded in
# supabase_migrations.schema_migrations - the ledger the Supabase CLI reads, so
# `supabase migration list --db-url ...` and `supabase db push` continue from an
# instance installed this way.
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

# init/ is the end state every migration carries an existing database towards, so
# a database built from init.sql is already at the head and its migrations are
# recorded rather than run. Migrations written for an older shape fail against
# the current one - CREATE OR REPLACE cannot rename a parameter or change a
# return type, and a policy cannot be created twice - and the loop below stops
# at the first failure.
if $FRESH_LOAD; then
	info "Fresh schema: recording migration history without replaying it"
	for f in "$REPO_DIR"/db_schema/migrations/*.sql; do
		fname="$(basename "$f")"
		version="${fname:0:14}"
		name="${fname:15}"; name="${name%.sql}"
		psql_exec -q >/dev/null <<SQL
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('${version}', '${name}') ON CONFLICT (version) DO NOTHING;
SQL
	done
	ok "Recorded $(ls "$REPO_DIR"/db_schema/migrations/*.sql | wc -l | tr -d ' ') migration(s) as applied"
fi

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
		psql -U "$DB_USER" "${DB_HOST_ARGS[@]}" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "/tmp/db_schema/migrations/$fname" >/tmp/harmony_mig_out 2>&1
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
