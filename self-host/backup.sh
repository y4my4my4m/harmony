#!/usr/bin/env bash
# =============================================================================
# Harmony backup and restore
# =============================================================================
#   bash backup.sh create [--no-storage] [--label TEXT]
#   bash backup.sh restore <backup> [--yes]
#
# A backup is a directory backups/<YYYYmmdd-HHMMSS>[-label]/ holding:
#   manifest          key=value: created, commit, version, domain, contents
#   database.dump     pg_dump -Fc of the whole database (auth, storage, Harmony)
#   roles.sql         pg_dumpall --globals-only: the roles, with their password
#                     hashes, grants and settings
#   config.tar        .env, federation.env, bot-gateway.env, discord-bridge.env,
#                     livekit.yaml, supabase/.env, and supabase/pgsodium_root.key
#                     (the key Supabase Vault secrets are encrypted with)
#   storage.tar       uploaded files (supabase/volumes/storage) with their
#                     extended attributes, where Supabase Storage keeps each
#                     file's content type; absent with --no-storage
#
# restore takes such a directory, a tar archive of one, or a bare .dump
# (database only). It first backs up the current database and configuration
# (label pre-restore), moves the current database directory and uploads aside
# (*.before-restore-<time>; nothing is deleted), loads the backup into a fresh
# database, then brings the schema to this checkout's migrations.
# =============================================================================
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DB_DATA_DIR="$SELF_HOST_DIR/supabase/volumes/db/data"
STORAGE_DIR="$SELF_HOST_DIR/supabase/volumes/storage"
CONFIG_FILES=(.env federation.env bot-gateway.env discord-bridge.env livekit.yaml supabase/.env)
PGSODIUM_KEY=/etc/postgresql-custom/pgsodium_root.key

# storage_tar ARGS...: GNU tar with user.* xattrs, as root, in the database
# image (busybox tar in the storage image drops xattrs), on supabase/volumes/storage.
storage_tar() {
	local img mode="$1"; shift
	img="$(docker inspect -f '{{.Config.Image}}' "$(db_container)" 2>/dev/null)" ||
		die "the database container is not running"
	docker run --rm -i -v "$STORAGE_DIR:/s:$mode,z" --entrypoint tar "$img" \
		--xattrs --xattrs-include='user.*' -C /s "$@"
}

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}"; }

# Waits for the final Postgres server: the image's entrypoint runs a temporary
# one on the socket while it initialises a new data directory, then restarts.
wait_db() {
	local streak=0 _
	for _ in $(seq 1 120); do
		if db_ready; then
			streak=$((streak + 1))
			[[ $streak -ge 3 ]] && return 0
		else
			streak=0
		fi
		sleep 2
	done
	die "Postgres did not become ready within 240 s; check: docker compose logs db"
}

ensure_db() {
	if [[ -z "$(svc_id db)" ]]; then
		info "Starting the database..."
		compose up -d db >/dev/null
	fi
	wait_db
}

# --- create ------------------------------------------------------------------
create() {
	local storage=true label="" stamp dir n=1 c
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--no-storage) storage=false ;;
			--label) label="${2:?--label needs a value}"; shift ;;
			*) die "unknown argument: $1 (see --help)" ;;
		esac
		shift
	done
	[[ -f "$ENV_FILE" ]] || die "self-host/.env is missing; this is not a configured install"
	label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9._-' '-')"

	ensure_db
	stamp="$(date +%Y%m%d-%H%M%S)${label:+-$label}"
	( umask 077; mkdir -p "$BACKUP_DIR" )
	dir="$BACKUP_DIR/$stamp"
	while [[ -e "$dir" ]]; do n=$((n + 1)); dir="$BACKUP_DIR/$stamp-$n"; done
	( umask 077; mkdir "$dir" )
	BACKUP_OUT="$dir"

	info "Dumping the database..."
	# supabase_admin is a superuser: the dump covers auth, storage and Harmony.
	if ! ( umask 077; docker exec "$(db_container)" pg_dump -U supabase_admin -h 127.0.0.1 -d postgres -Fc > "$dir/database.dump.partial" ); then
		rm -rf "$dir"
		die "pg_dump failed; no backup written"
	fi
	[[ -s "$dir/database.dump.partial" ]] || { rm -rf "$dir"; die "pg_dump wrote nothing; no backup written"; }
	mv "$dir/database.dump.partial" "$dir/database.dump"
	( umask 077; docker exec "$(db_container)" pg_dumpall -U supabase_admin -h 127.0.0.1 --globals-only > "$dir/roles.sql" ) ||
		die "pg_dumpall --globals-only failed"

	local -a files=()
	for c in "${CONFIG_FILES[@]}"; do [[ -f "$SELF_HOST_DIR/$c" ]] && files+=("$c"); done
	( cd "$SELF_HOST_DIR" && umask 077 && tar -cf "$dir/config.tar" "${files[@]}" ) ||
		die "could not archive the configuration files"
	if docker exec "$(db_container)" test -s "$PGSODIUM_KEY" 2>/dev/null; then
		( umask 077; mkdir -p "$dir/.key/supabase"
		  docker exec "$(db_container)" cat "$PGSODIUM_KEY" > "$dir/.key/supabase/pgsodium_root.key"
		  tar -rf "$dir/config.tar" -C "$dir/.key" supabase/pgsodium_root.key ) ||
			die "could not archive the Vault key"
		rm -rf "$dir/.key"
	fi

	local contents="database,config"
	if $storage; then
		info "Archiving uploads..."
		mkdir -p "$STORAGE_DIR"
		( umask 077; storage_tar ro -cf - . > "$dir/storage.tar" ) ||
			die "could not archive $STORAGE_DIR"
		contents="$contents,storage"
	fi

	{
		printf 'created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		printf 'commit=%s\n' "$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
		printf 'version=%s\n' "$(env_get "$ENV_FILE" HARMONY_VERSION)"
		printf 'domain=%s\n' "$(env_get "$ENV_FILE" DOMAIN)"
		printf 'supabase_ref=%s\n' "$(cat "$SELF_HOST_DIR/supabase/.harmony-supabase-ref" 2>/dev/null || echo unknown)"
		printf 'migration=%s\n' "$(db_sql -c 'SELECT max(version) FROM supabase_migrations.schema_migrations' 2>/dev/null || echo unknown)"
		printf 'contents=%s\n' "$contents"
	} > "$dir/manifest"
	chmod 600 "$dir/manifest"

	ok "Backup: $dir ($(du -sh "$dir" | cut -f1))"
	$storage || info "Uploads are not in this backup (--no-storage)."
	info "Copy it off this machine; it holds the instance's secrets."
}

# --- restore -----------------------------------------------------------------
# Sets SRC (directory holding database.dump) from the argument.
resolve_source() {
	local arg="$1"
	[[ -e "$arg" ]] || die "$arg does not exist"
	if [[ -d "$arg" ]]; then
		[[ -f "$arg/database.dump" ]] || die "$arg holds no database.dump"
		SRC="$(cd "$arg" && pwd)"
	elif [[ "$arg" == *.dump ]]; then
		TMP_SRC="$(mktemp -d "$BACKUP_DIR/.restore-XXXXXX")"
		ln -s "$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")" "$TMP_SRC/database.dump"
		SRC="$TMP_SRC"
	elif tar -tf "$arg" >/dev/null 2>&1; then
		TMP_SRC="$(mktemp -d "$BACKUP_DIR/.restore-XXXXXX")"
		tar -xf "$arg" -C "$TMP_SRC"
		local found
		found="$(find "$TMP_SRC" -name database.dump -print -quit)"
		[[ -n "$found" ]] || die "$arg holds no database.dump"
		SRC="$(dirname "$found")"
	else
		die "$arg is not a backup directory, a tar archive of one, or a .dump file"
	fi
}

restore() {
	local arg="" yes=false stamp moved=()
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--yes|-y) yes=true ;;
			-*) die "unknown argument: $1 (see --help)" ;;
			*) [[ -z "$arg" ]] || die "one backup at a time"; arg="$1" ;;
		esac
		shift
	done
	[[ -n "$arg" ]] || die "usage: backup.sh restore <backup directory | archive.tar | database.dump> [--yes]"
	( umask 077; mkdir -p "$BACKUP_DIR" )
	TMP_SRC=""
	trap '[[ -z "$TMP_SRC" ]] || rm -rf "$TMP_SRC"' EXIT
	resolve_source "$arg"

	local has_config=false has_storage=false
	[[ -f "$SRC/config.tar" ]] && has_config=true
	[[ -f "$SRC/storage.tar" ]] && has_storage=true
	if ! $has_config && [[ ! -f "$ENV_FILE" ]]; then
		die "a database-only backup needs a configured install; run harmony install first"
	fi

	echo
	info "Restore from $arg"
	[[ -f "$SRC/manifest" ]] && sed 's/^/    /' "$SRC/manifest"
	echo "    database: replaces the current database"
	if $has_config; then echo "    config:   replaces .env, federation.env, supabase/.env, ..."; else echo "    config:   kept (not in this backup)"; fi
	if $has_storage; then echo "    uploads:  replace the current uploads"; else echo "    uploads:  kept (not in this backup)"; fi
	echo "  The current database and uploads move aside, nothing is deleted."
	if ! $yes; then
		interactive || die "restore replaces the running instance's data; pass --yes to confirm"
		ask_yn "Continue?" n || die "cancelled"
	fi

	stamp="$(date +%Y%m%d-%H%M%S)"
	if [[ -f "$ENV_FILE" && -d "$DB_DATA_DIR" ]]; then
		info "Backing up the current database and configuration first..."
		( create --no-storage --label pre-restore ) ||
			warn "no pre-restore backup; the current database directory still moves aside"
	fi

	if $has_config; then
		info "Restoring configuration..."
		tar -xf "$SRC/config.tar" -C "$SELF_HOST_DIR" --exclude=supabase/pgsodium_root.key
		[[ ! -f "$SB_ENV" ]] || chmod 600 "$SB_ENV"
	fi
	# Provisions supabase/ on a new machine; keeps every value just restored.
	bash "$SELF_HOST_DIR/configure.sh" --non-interactive </dev/null

	info "Stopping the stack..."
	compose down >/dev/null 2>&1 || true

	if [[ -d "$DB_DATA_DIR" ]]; then
		mv "$DB_DATA_DIR" "$DB_DATA_DIR.before-restore-$stamp"
		moved+=("supabase/volumes/db/data.before-restore-$stamp")
	fi
	if $has_storage && [[ -d "$STORAGE_DIR" ]]; then
		mv "$STORAGE_DIR" "$STORAGE_DIR.before-restore-$stamp"
		moved+=("supabase/volumes/storage.before-restore-$stamp")
	fi
	mkdir -p "$STORAGE_DIR"

	# Vault secrets decrypt only with the key they were encrypted with. The
	# volume's own key stays beside it.
	if $has_config && tar -tf "$SRC/config.tar" supabase/pgsodium_root.key >/dev/null 2>&1; then
		info "Restoring the Vault encryption key..."
		# The image creates the key owned by postgres, mode 600.
		tar -xOf "$SRC/config.tar" supabase/pgsodium_root.key |
			compose run --rm --no-deps -T --entrypoint sh db -c '
				set -e; k='"$PGSODIUM_KEY"'
				[ ! -s "$k" ] || cp -p "$k" "$k.before-restore-'"$stamp"'"
				cat > "$k.new"; chown postgres:postgres "$k.new"; chmod 600 "$k.new"; mv "$k.new" "$k"' >/dev/null ||
			die "could not write the Vault key into the db-config volume"
	fi

	info "Starting a fresh database..."
	compose up -d db >/dev/null
	wait_db

	local log="$BACKUP_DIR/restore-$stamp.log" rc=0 unexpected
	if [[ -f "$SRC/roles.sql" ]]; then
		# Roles first: the fresh database lacks those other services create on
		# their first start (supabase_realtime_admin) and harmony_listener.
		# Existing roles fail CREATE ROLE and take the ALTER ROLE that follows.
		info "Restoring database roles..."
		docker exec -i "$(db_container)" psql -U supabase_admin -h 127.0.0.1 -d postgres -q \
			< "$SRC/roles.sql" > "$log" 2>&1 || true
		unexpected="$(grep 'ERROR:' "$log" | grep -vc 'already exists' || true)"
		[[ "$unexpected" == 0 ]] || warn "$unexpected role statement(s) failed; details in $log"
	fi
	info "Loading the dump (pg_restore)..."
	docker exec -i "$(db_container)" pg_restore -U supabase_admin -h 127.0.0.1 -d postgres \
		--clean --if-exists < "$SRC/database.dump" >> "$log" 2>&1 || rc=$?
	if [[ $rc -ne 0 ]]; then
		# A fresh Supabase database fails these on every restore: auth.users and
		# the storage schema are depended on by objects the image creates, and
		# the GraphQL placeholder and the pg_net event trigger belong to
		# Supabase. Harmony relies on none of them being recreated.
		unexpected="$(grep -A1 '^pg_restore: error' "$log" | grep 'ERROR:' |
			grep -vE 'cannot drop (constraint users_pkey|schema storage)|schema "storage" already exists|graphql_public\.graphql|event trigger "issue_pg_net_access"' || true)"
		if [[ -n "$unexpected" ]]; then
			warn "pg_restore errors beyond the expected ones (details in $log):"
			printf '%s\n' "$unexpected" | head -5 >&2
		else
			info "pg_restore: only the expected errors on Supabase-owned objects (details in $log)"
		fi
	fi
	local ledger
	ledger="$(db_sql -c 'SELECT count(*) FROM supabase_migrations.schema_migrations' 2>/dev/null || true)"
	[[ "$ledger" =~ ^[1-9][0-9]*$ ]] || die "the restored database has no migration ledger; see $log. The previous data is in: ${moved[*]:-nothing moved}"
	ok "Database restored ($ledger migrations recorded)"

	if $has_storage; then
		info "Restoring uploads..."
		storage_tar rw -xf - < "$SRC/storage.tar" ||
			die "could not extract uploads; the database is restored"
	fi

	info "Bringing the schema to this version and starting everything..."
	compose up -d >/dev/null
	bash "$SELF_HOST_DIR/bootstrap.sh"
	compose restart federation-worker >/dev/null 2>&1 || true

	echo
	ok "Restore complete."
	if [[ ${#moved[@]} -gt 0 ]]; then
		info "The previous data is kept in self-host/: ${moved[*]}"
		info "Once the restored instance works, remove it: sudo rm -rf ${moved[*]/#/$SELF_HOST_DIR/}"
	fi
}

case "${1:-}" in
	create) shift; create "$@" ;;
	restore) shift; restore "$@" ;;
	-h|--help|"") usage ;;
	*) die "unknown command: $1 (create | restore)" ;;
esac
