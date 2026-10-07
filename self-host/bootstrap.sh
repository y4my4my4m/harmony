#!/usr/bin/env bash
# Loads the Harmony schema into the running Supabase Postgres, provisions the
# least-privilege `harmony_listener` role, on a new database names the
# instance, and removes the JWT secret from the database settings (both modes).
#
# Usage:  bash bootstrap.sh [--migrations-only]
#
#   --migrations-only   apply pending migrations and reload PostgREST; leave
#                       the listener role and instance_config alone (update.sh)
#
# SUPABASE_DB_CONTAINER names the Postgres container; default the compose
# service `db` of this directory's stack, else supabase-db.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_CONTAINER="${SUPABASE_DB_CONTAINER:-}"
if [[ -z "$DB_CONTAINER" ]]; then
	DB_CONTAINER="$(cd "$SCRIPT_DIR" && docker compose ps -q db 2>/dev/null | head -1 || true)"
	DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
fi
DB_USER="postgres"
DB_NAME="postgres"

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_reset=$'\033[0m'
info() { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()   { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }
warn() { printf "%s ! %s%s\n" "$c_yellow" "$*" "$c_reset" >&2; }
die()  { printf "Error: %s\n" "$*" >&2; exit 1; }

MIGRATIONS_ONLY=false
for arg in "$@"; do
	case "$arg" in
		--migrations-only) MIGRATIONS_ONLY=true ;;
		-h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) die "unknown argument: $arg (see --help)" ;;
	esac
done

# Value of KEY in an env file, one layer of matching quotes removed; a missing
# file reads as empty.
val() {
	[[ -f "$1" ]] || return 0
	awk -v k="$2" '
		index($0, k "=") == 1 {
			v = substr($0, length(k) + 2)
			if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
			print v; exit
		}' "$1"
}
PG_PW="$(val "$SCRIPT_DIR/supabase/.env" POSTGRES_PASSWORD)"
LISTENER_PW="$(val "$SCRIPT_DIR/federation.env" __LISTENER_PW)"
DOMAIN="$(val "$SCRIPT_DIR/.env" DOMAIN)"
INSTANCE_NAME="$(val "$SCRIPT_DIR/.env" INSTANCE_NAME)"
# psql runs through `docker exec` over the container's local socket, so
# PGPASSWORD is unused there; steps that consume a missing value are skipped.
[[ -n "$PG_PW" ]] || info "No POSTGRES_PASSWORD found; using the container's local socket"

[[ "$(docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null)" == true ]] ||
	die "$DB_CONTAINER is not running. Start the stack first: docker compose up -d"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# The image's entrypoint runs a temporary server on the socket only while it
# initialises a new data directory, then restarts; TCP on localhost answering
# three times in a row is the final server.
info "Waiting for Postgres..."
streak=0
for _ in $(seq 1 90); do
	if docker exec "$DB_CONTAINER" pg_isready -U postgres -h localhost >/dev/null 2>&1; then
		streak=$((streak + 1))
		[[ $streak -ge 3 ]] && break
	else
		streak=0
	fi
	sleep 2
done
[[ $streak -ge 3 ]] || die "Postgres in $DB_CONTAINER did not become ready within 180 s. Check: docker logs $DB_CONTAINER"

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

# ${arr[@]+...}: an empty array under `set -u` is unbound before bash 4.4.
# NOTICEs (IF NOT EXISTS skips) are noise here; migrations keep theirs.
psql_exec() {
	docker exec -e PGPASSWORD="$PG_PW" -e PGOPTIONS='-c client_min_messages=warning' -i "$DB_CONTAINER" \
		psql -U "$DB_USER" ${DB_HOST_ARGS[@]+"${DB_HOST_ARGS[@]}"} -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

pick_db_role || die "no role can modify the schema: tried postgres and supabase_admin"
info "Applying as $DB_USER"

# --- migrations --------------------------------------------------------------
# The migration chain builds an empty database: 20260101000000_baseline.sql
# creates every table and the files after it are deltas. An empty instance and
# an existing one take the same path, the ledger deciding what runs.
#
# Each migration runs once, in version order, recorded in
# supabase_migrations.schema_migrations - the ledger the Supabase CLI reads, so
# `supabase migration list --db-url ...` and `supabase db push` continue from an
# instance installed this way.
info "Applying migrations..."
docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
docker cp "$REPO_DIR/db_schema" "$DB_CONTAINER:/tmp/db_schema" >/dev/null

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
		psql -U "$DB_USER" ${DB_HOST_ARGS[@]+"${DB_HOST_ARGS[@]}"} -d "$DB_NAME" -v ON_ERROR_STOP=1 -q \
		-f "/tmp/db_schema/migrations/$fname" >"$TMP_DIR/mig_out" 2>&1
	then
		psql_exec -q -v version="$version" -v name="$name" >/dev/null <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES (:'version', :'name') ON CONFLICT (version) DO NOTHING;
SQL
		printf '  applied %s\n' "$fname"
	else
		failed=1
		printf 'Error: %s failed. It was not recorded; later migrations were skipped.\n' "$fname" >&2
		grep -E 'ERROR|FATAL' "$TMP_DIR/mig_out" | head -5 >&2 || true
		break
	fi
done
docker exec "$DB_CONTAINER" rm -rf /tmp/db_schema 2>/dev/null || true
[[ $failed -eq 0 ]] || die "migration failed - database is at the last migration that succeeded"
if [[ $pending -eq 0 ]]; then ok "Migrations up to date"; else ok "Applied $pending migration(s)"; fi

if ! $MIGRATIONS_ONLY; then
	# --- least-privilege listener role -----------------------------------------
	if [[ -z "$LISTENER_PW" ]]; then
		info "No listener password in federation.env; leaving harmony_listener untouched"
	else
		info "Provisioning harmony_listener role..."
		psql_exec -q -v pw="$LISTENER_PW" -v db="$DB_NAME" >/dev/null <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harmony_listener') THEN
    CREATE ROLE harmony_listener WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
ALTER ROLE harmony_listener WITH PASSWORD :'pw';
GRANT CONNECT ON DATABASE :"db" TO harmony_listener;
SQL
		ok "Listener role ready"
	fi

	# --- instance name and domain ----------------------------------------------
	# Written only while the domain is still the seed 'localhost', i.e. on a new
	# database; afterwards the admin panel owns both. Name first: its condition
	# reads the domain row the second statement changes.
	if [[ -n "$DOMAIN" ]]; then
		result="$(psql_exec -qtA -v domain="$DOMAIN" -v name="${INSTANCE_NAME:-Harmony}" <<'SQL'
BEGIN;
UPDATE public.instance_config
   SET config_value = to_jsonb(:'name'::text), updated_at = now()
 WHERE config_key = 'instance_name'
   AND EXISTS (SELECT 1 FROM public.instance_config
                WHERE config_key = 'domain' AND config_value = '"localhost"'::jsonb);
UPDATE public.instance_config
   SET config_value = to_jsonb(:'domain'::text), updated_at = now()
 WHERE config_key = 'domain' AND config_value = '"localhost"'::jsonb;
COMMIT;
SELECT config_value #>> '{}' FROM public.instance_config WHERE config_key = 'domain';
SQL
)" || die "could not set the instance name and domain in public.instance_config"
		current="$(printf '%s\n' "$result" | tail -1)"
		if [[ "$current" == "$DOMAIN" ]]; then
			ok "Instance domain: $current"
		elif [[ "$current" == localhost ]]; then
			die "instance_config domain is still 'localhost' after the update; $DB_USER cannot write public.instance_config"
		else
			info "instance_config domain is '$current' (set in the admin panel); .env has '$DOMAIN', left as is"
		fi
	fi
fi

# --- app.settings.jwt_* ------------------------------------------------------
# Upstream's db init (supabase/volumes/db/jwt.sql) stores the JWT secret and
# expiry as database defaults, which every session, anon included, reads with
# current_setting(). GoTrue, PostgREST, Realtime and Storage take the secret
# from their environment; no function reads these settings. Kept when one does.
# Sessions already open keep their value until they reconnect.
jwt_readers="$(psql_exec -tA -c "SELECT string_agg(DISTINCT n.nspname || '.' || p.proname, ', ')
	FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
	WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
	  AND p.prosrc LIKE '%app.settings.jwt_%'")" || jwt_readers="?"
jwt_set="$(psql_exec -tA -c "SELECT count(*) FROM pg_db_role_setting s
	JOIN pg_database d ON d.oid = s.setdatabase
	WHERE d.datname = current_database() AND s.setrole = 0
	  AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'app.settings.jwt\_%')")" || jwt_set=0
if [[ "$jwt_set" != 0 ]]; then
	if [[ -n "$jwt_readers" ]]; then
		warn "app.settings.jwt_secret kept: read by $jwt_readers"
	else
		# A superuser set them; only a superuser resets them (postgres is none
		# in this image). pg_hba trusts supabase_admin over 127.0.0.1.
		if docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$DB_CONTAINER" \
			psql -U supabase_admin -h 127.0.0.1 -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -v db="$DB_NAME" >/dev/null 2>"$TMP_DIR/jwt_err" <<'SQL'
ALTER DATABASE :"db" RESET "app.settings.jwt_secret";
ALTER DATABASE :"db" RESET "app.settings.jwt_exp";
SQL
		then
			ok "Removed the JWT secret from the database defaults (app.settings.jwt_secret)"
		else
			warn "app.settings.jwt_secret not reset ($(head -1 "$TMP_DIR/jwt_err")); as a superuser: ALTER DATABASE $DB_NAME RESET \"app.settings.jwt_secret\""
		fi
	fi
fi

psql_exec -q -c "NOTIFY pgrst, 'reload schema';" >/dev/null ||
	info "PostgREST schema reload not sent; restart supabase-rest if the API serves an old schema"

echo
ok "Bootstrap complete."
