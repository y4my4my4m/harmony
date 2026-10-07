# Shared helpers for the self-host scripts (harmony, install.sh, doctor.sh,
# backup.sh, admin.sh). Sourced, never run. Expects bash 4 and `set -euo pipefail`
# in the caller.

SELF_HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SELF_HOST_DIR/.." && pwd)"
ENV_FILE="$SELF_HOST_DIR/.env"
SB_ENV="$SELF_HOST_DIR/supabase/.env"
FED_ENV="$SELF_HOST_DIR/federation.env"
BOT_ENV="$SELF_HOST_DIR/bot-gateway.env"
BRIDGE_ENV="$SELF_HOST_DIR/discord-bridge.env"
BACKUP_DIR="$SELF_HOST_DIR/backups"
COMPOSE_MIN=2.24.4
RELEASES_API="https://api.github.com/repos/y4my4my4m/harmony/releases/latest"

if [[ -t 1 ]]; then
	c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_reset=$'\033[0m'
else
	c_blue=""; c_green=""; c_yellow=""; c_red=""; c_bold=""; c_reset=""
fi
info() { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()   { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }
warn() { printf "%s ! %s%s\n" "$c_yellow" "$*" "$c_reset" >&2; }
die()  { printf "%sError:%s %s\n" "$c_red" "$c_reset" "$*" >&2; exit 1; }

# Value of KEY in an env file: the first KEY= line, one layer of matching
# quotes removed. A missing file reads as empty.
env_get() {
	[[ -f "$1" ]] || return 0
	awk -v k="$2" '
		index($0, k "=") == 1 {
			v = substr($0, length(k) + 2)
			if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
			print v; exit
		}' "$1"
}

# env_set FILE KEY VALUE: replaces the first KEY= line, or appends one. The
# file keeps its mode; a new one is created 600.
env_set() {
	local file="$1" key="$2" val="$3" tmp
	[[ -f "$file" ]] || ( umask 077; : > "$file" )
	if grep -q "^$key=" "$file"; then
		[[ "$(env_get "$file" "$key")" == "$val" ]] && return 0
		tmp="$(mktemp "$file.XXXXXX")"
		chmod --reference="$file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
		K="$key" V="$val" awk '
			BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
			!done && index($0, k "=") == 1 { print k "=" v; done = 1; next }
			{ print }' "$file" > "$tmp"
		mv "$tmp" "$file"
	else
		[[ ! -s "$file" || -z "$(tail -c 1 "$file")" ]] || echo >> "$file"
		printf '%s=%s\n' "$key" "$val" >> "$file"
	fi
}

lower() { tr '[:upper:]' '[:lower:]'; }
truthy() { case "$(printf '%s' "${1:-}" | lower)" in y|yes|true|1|on) return 0 ;; *) return 1 ;; esac; }

# version_ge A B: A >= B for dotted numeric versions.
version_ge() {
	local IFS=. i
	local -a a b
	read -r -a a <<<"$1"
	read -r -a b <<<"$2"
	for i in 0 1 2; do
		(( 10#${a[i]:-0} > 10#${b[i]:-0} )) && return 0
		(( 10#${a[i]:-0} < 10#${b[i]:-0} )) && return 1
	done
	return 0
}

compose_version() { docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*//'; }

# docker compose in self-host/, so .env, COMPOSE_FILE and COMPOSE_PROFILES apply.
compose() { ( cd "$SELF_HOST_DIR" && docker compose "$@" ); }

# Container id of a running compose service; empty when it is not running.
svc_id() { compose ps -q --status running "$1" 2>/dev/null | head -1; }

# Postgres container: SUPABASE_DB_CONTAINER, else the compose `db` service.
db_container() {
	if [[ -n "${SUPABASE_DB_CONTAINER:-}" ]]; then printf '%s' "$SUPABASE_DB_CONTAINER"; return; fi
	local id; id="$(svc_id db)"
	printf '%s' "${id:-supabase-db}"
}

# psql as supabase_admin (superuser); pg_hba trusts it over 127.0.0.1 in the
# supabase/postgres image. Unaligned, tuples only.
db_sql() {
	docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$(db_container)" \
		psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 -qtAX "$@"
}

db_ready() { docker exec "$(db_container)" pg_isready -U postgres -h localhost >/dev/null 2>&1; }

# Runs JavaScript (stdin) with node in the federation-server container, which
# carries SUPABASE_URL (Kong on the compose network) and the Supabase keys.
fed_node() {
	local id; id="$(svc_id federation-server)"
	[[ -n "$id" ]] || die "federation-server is not running; start the stack: docker compose up -d"
	docker exec -i "$id" node --input-type=module -
}

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# Interaction: prompts read /dev/tty, so they work under `curl | bash`.
# HARMONY_NONINTERACTIVE=1, or no terminal, answers every prompt with its default.
interactive() {
	[[ "${HARMONY_NONINTERACTIVE:-0}" != 1 ]] && { : < /dev/tty; } 2>/dev/null
}

# ask VAR "question" "default"
ask() {
	local __var="$1" __q="$2" __def="${3:-}" __ans=""
	if interactive; then
		if [[ -n "$__def" ]]; then
			read -rp "$__q [$__def]: " __ans < /dev/tty
		else
			read -rp "$__q: " __ans < /dev/tty
		fi
	fi
	printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ask_yn "question" default(y|n): status 0 for yes.
ask_yn() {
	local __a
	ask __a "$1 (y/n)" "$2"
	truthy "$__a"
}

# ask_secret VAR "question": hidden input; empty when not interactive.
ask_secret() {
	local __var="$1" __ans=""
	if interactive; then
		read -rsp "$2: " __ans < /dev/tty
		echo > /dev/tty
	fi
	printf -v "$__var" '%s' "$__ans"
}

gen_password() { openssl rand -base64 18 | tr -d '\n/+=' | cut -c1-20; }

# Release tag (vX.Y.Z) of the newest published release; empty when unknown.
latest_release() {
	command -v curl >/dev/null || return 0
	{ curl -fsS --max-time 10 -H 'Accept: application/vnd.github+json' "$RELEASES_API" 2>/dev/null || true; } |
		sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -1
}

# Public IPv4/IPv6 of this host as the internet sees it; empty when unknown.
# HARMONY_PUBLIC_IP overrides the IPv4 lookup.
public_ip4() {
	if [[ -n "${HARMONY_PUBLIC_IP:-}" ]]; then printf '%s' "$HARMONY_PUBLIC_IP"; return; fi
	local u ip
	for u in https://api.ipify.org https://ipv4.icanhazip.com https://ifconfig.me/ip; do
		ip="$(curl -4 -fsS --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]')" || continue
		[[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { printf '%s' "$ip"; return 0; }
	done
	return 0
}
public_ip6() {
	local u ip
	for u in https://api6.ipify.org https://ipv6.icanhazip.com; do
		ip="$(curl -6 -fsS --max-time 6 "$u" 2>/dev/null | tr -d '[:space:]')" || continue
		[[ "$ip" == *:* ]] && { printf '%s' "$ip"; return 0; }
	done
	return 0
}

# Addresses NAME resolves to, one per line: resolve4 the A records, resolve6
# the AAAA records.
resolve4() { { getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1}' | sort -u; }
resolve6() { { getent ahostsv6 "$1" 2>/dev/null || true; } | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ {print $1}' | sort -u; }

# DNS names the instance serves: DOMAIN, DB_DOMAIN and, with voice, LIVEKIT_DOMAIN.
instance_names() {
	local d db lk
	d="$(env_get "$ENV_FILE" DOMAIN)"; db="$(env_get "$ENV_FILE" DB_DOMAIN)"; lk="$(env_get "$ENV_FILE" LIVEKIT_DOMAIN)"
	printf '%s\n' "$d" "${db:-db.$d}"
	if truthy "$(env_get "$ENV_FILE" ENABLE_VOICE)"; then printf '%s\n' "${lk:-live.$d}"; fi
}

# Newest backup directory under backups/; empty when none. Names sort by time.
latest_backup() {
	local m last=""
	for m in "$BACKUP_DIR"/*/manifest; do
		[[ -f "$m" ]] && last="${m%/manifest}"
	done
	printf '%s' "$last"
}

# wait_healthy SERVICE [TRIES]: 0 once the service runs and its health check,
# if any, passes; 2 s per try.
wait_healthy() {
	local svc="$1" tries="${2:-90}" id state _
	for _ in $(seq 1 "$tries"); do
		id="$(svc_id "$svc")"
		if [[ -n "$id" ]]; then
			state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$id" 2>/dev/null || true)"
			[[ "$state" == healthy || "$state" == running ]] && return 0
		fi
		sleep 2
	done
	return 1
}

# Builds Harmony's images when COMPOSE_FILE names the build overlay, else
# pulls every image. An image no registry serves is accepted when it exists
# locally (loaded or built by hand under the same tag).
pull_images() {
	local img missing=()
	if [[ "${COMPOSE_FILE:-$(env_get "$ENV_FILE" COMPOSE_FILE)}" == *docker-compose.build.yml* ]]; then
		info "Pulling upstream images..."
		compose pull --ignore-buildable
		info "Building Harmony images from this checkout..."
		compose build --pull
		return
	fi
	info "Pulling images (Harmony $(env_get "$ENV_FILE" HARMONY_VERSION))..."
	compose pull && return 0
	# One failure interrupts the other pulls; take what the registries have.
	compose pull --ignore-pull-failures >/dev/null 2>&1 || true
	while read -r img; do
		docker image inspect "$img" >/dev/null 2>&1 || missing+=("$img")
	done < <(compose config --images 2>/dev/null | sort -u)
	if [[ ${#missing[@]} -gt 0 ]]; then
		die "cannot pull ${missing[*]}. A release's images appear some minutes after its tag; HARMONY_VERSION selects another tag, HARMONY_BUILD=1 builds Harmony's from this checkout."
	fi
	warn "some pulls failed (above); the local copies of those images are used"
}
