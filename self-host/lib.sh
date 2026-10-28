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
upper() { tr '[:lower:]' '[:upper:]'; }

# reserved_username NAME DOMAIN: guard_local_username's reserved names
# (20261031900001_reserved_usernames.sql, src/utils/usernameRules.ts), and the labels of DOMAIN
# before its last, port dropped.
reserved_username() {
	local name="$1" host labels label
	case "$name" in
		everyone|here|system|harmony|admin|admins|administrator|mod|mods|moderator|moderators|staff|root) return 0 ;;
	esac
	host="$(printf '%s' "${2%%:*}" | lower)"
	[[ -n "$host" ]] || return 1
	IFS=. read -ra labels <<<"$host"
	(( ${#labels[@]} > 1 )) && unset 'labels[-1]'
	for label in "${labels[@]}"; do [[ "$name" == "$label" ]] && return 0; done
	return 1
}
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

# Auth image of the Supabase stack in supabase/ (supabase/gotrue:vX.Y.Z); empty when absent.
stack_gotrue_image() {
	{ grep -oE 'supabase/gotrue:v[0-9]+\.[0-9]+\.[0-9]+' "$SELF_HOST_DIR/supabase/docker-compose.yml" 2>/dev/null || true; } | head -1
}

# shellcheck source=linking.sh
source "$SELF_HOST_DIR/linking.sh"

# --- upload ceiling -----------------------------------------------------------
# FILE_SIZE_LIMIT in supabase/.env: the largest object storage-api accepts, bytes,
# TUS included (supabase-overrides.yml). instance_config.upload_ceiling_bytes
# holds the same number; no upload limit of the admin panel goes above it
# (db_schema/migrations/20261031100001_upload_limits.sql). MB is 1048576 bytes,
# as the admin panel counts.
UPLOAD_CEILING_DEFAULT=52428800
# S3's largest object, 5 TiB.
UPLOAD_CEILING_MAX=5497558138880

# parse_size SIZE: bytes of N, N MB or N GB (also M, G, MiB, GiB; any case);
# status 1 when SIZE does not parse or lies outside 1 MB .. 5 TiB.
parse_size() {
	local v n unit bytes
	v="$(printf '%s' "$1" | tr -d ' ' | lower)"
	[[ "$v" =~ ^([0-9]+)(b|m|mb|mib|g|gb|gib)?$ ]] || return 1
	n="${BASH_REMATCH[1]}"; unit="${BASH_REMATCH[2]}"
	[[ ${#n} -le 13 ]] || return 1
	case "$unit" in
		""|b) bytes=$((10#$n)) ;;
		m|mb|mib) bytes=$((10#$n * 1048576)) ;;
		g|gb|gib) bytes=$((10#$n * 1073741824)) ;;
	esac
	((bytes >= 1048576 && bytes <= UPLOAD_CEILING_MAX)) || return 1
	printf '%s' "$bytes"
}

# human_size BYTES: N GB or N MB when whole, else N bytes.
human_size() {
	if (($1 % 1073741824 == 0)); then printf '%s GB' $(($1 / 1073741824))
	elif (($1 % 1048576 == 0)); then printf '%s MB' $(($1 / 1048576))
	else printf '%s bytes' "$1"; fi
}

upload_ceiling() {
	local v; v="$(env_get "$SB_ENV" FILE_SIZE_LIMIT)"
	printf '%s' "${v:-$UPLOAD_CEILING_DEFAULT}"
}

# docker compose in self-host/, so .env, COMPOSE_FILE and COMPOSE_PROFILES apply.
compose() { ( cd "$SELF_HOST_DIR" && docker compose "$@" ); }

# Container id of a running compose service; empty when it is not running.
svc_id() { compose ps -q --status running "$1" 2>/dev/null | head -1; }

# Environment of the running auth service, one VAR=value per line; empty when it is not running.
auth_env() {
	local id; id="$(svc_id auth)"
	[[ -z "$id" ]] || docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null || true
}

# oauth_enabled [ENV]: the GoTrue OAuth providers that are on, space-separated. ENV (auth_env)
# names them by GOTRUE_EXTERNAL_<ID>_ENABLED; empty ENV falls back to supabase/.env's
# <ID>_ENABLED of the built-in providers.
oauth_enabled() {
	local env="${1-$(auth_env)}" p v out=""
	if [[ -n "$env" ]]; then
		for p in $GOTRUE_OAUTH_PROVIDERS; do
			v="$(printf '%s\n' "$env" | sed -n "s/^GOTRUE_EXTERNAL_$(printf '%s' "$p" | upper)_ENABLED=//p" | head -1)"
			if truthy "$v"; then out+="${out:+ }$p"; fi
		done
	else
		for p in $BUILTIN_OAUTH_PROVIDERS; do
			if truthy "$(env_get "$SB_ENV" "$(printf '%s' "$p" | upper)_ENABLED")"; then out+="${out:+ }$p"; fi
		done
	fi
	printf '%s' "$out"
}

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

# A generated secret stays out of the scripts' output (pipes, logs) and off the terminal's normal
# screen and scrollback. With a terminal (interactive, /dev/tty writable) reveal_secret draws it
# on /dev/tty's alternate screen (DEC 1049) until Enter. Without one it goes to SECRET_FILE, a file
# only this user can read, and only the path is printed: self-host/.secret-<date>-<time>-<pid>,
# else $HOME/harmony-secret-XXXXXX when self-host/ is not writable.
SECRET_FILE=""
reveal_on_tty() { interactive && [[ -w /dev/tty ]]; }

# secret_ready: status 0 when reveal_secret has a place for a secret, 1 when it has none. Without
# a terminal it creates SECRET_FILE, empty, now. Run it before the secret takes effect.
secret_ready() {
	reveal_on_tty && return 0
	[[ -n "$SECRET_FILE" && -f "$SECRET_FILE" ]] && return 0
	SECRET_FILE="$SELF_HOST_DIR/.secret-$(date +%Y%m%d-%H%M%S)-$$"
	( umask 077 && set -C && : > "$SECRET_FILE" ) 2>/dev/null && return 0
	SECRET_FILE="$(mktemp "${HOME:-/nonexistent}/harmony-secret-XXXXXX" 2>/dev/null)" && return 0
	SECRET_FILE=""
	return 1
}

# secret_discard: removes SECRET_FILE while it is still empty (the secret never took effect).
secret_discard() {
	if [[ -n "$SECRET_FILE" && -f "$SECRET_FILE" && ! -s "$SECRET_FILE" ]]; then rm -f "$SECRET_FILE"; fi
	SECRET_FILE=""
}

# The Linux console and GNU screen without altscreen ignore 1049 and draw on the normal screen,
# so the screen is cleared before the switch back.
reveal_leave_screen() { printf '\033[H\033[2J\033[?1049l' > /dev/tty; }

# INT or TERM while the secret is on screen: clear it, restore the caller's traps, re-raise.
reveal_interrupted() {
	reveal_leave_screen
	eval "${REVEAL_TRAP_INT:-trap - INT}"
	eval "${REVEAL_TRAP_TERM:-trap - TERM}"
	kill -s "$1" "$$"
	exit $((128 + $(kill -l "$1")))
}

# reveal_secret LABEL VALUE: shows a generated secret once (see SECRET_FILE above).
reveal_secret() {
	local label="$1" value="$2"
	if reveal_on_tty; then
		# Lines typed earlier (an Enter during a long pull) would end the wait at once.
		while read -r -t 0 _ < /dev/tty; do read -r _ < /dev/tty || break; done
		REVEAL_TRAP_INT="$(trap -p INT)"; REVEAL_TRAP_TERM="$(trap -p TERM)"
		trap 'reveal_interrupted INT' INT
		trap 'reveal_interrupted TERM' TERM
		{
			printf '\033[?1049h\033[H\033[2J'
			printf '\n   %s\n\n      %s%s%s\n\n   Store it now. Enter clears it from the screen.' \
				"$label" "$c_bold" "$value" "$c_reset"
		} > /dev/tty
		read -r _ < /dev/tty || true
		reveal_leave_screen
		eval "${REVEAL_TRAP_INT:-trap - INT}"
		eval "${REVEAL_TRAP_TERM:-trap - TERM}"
		ok "$label shown once and cleared from the screen"
	else
		secret_ready || die "nowhere to store the generated secret: no terminal, and neither $SELF_HOST_DIR nor ${HOME:-\$HOME} is writable"
		printf '%s\n' "$value" > "$SECRET_FILE"
		ok "$label written to $SECRET_FILE (readable by $(id -un) only; delete it once stored)"
		SECRET_FILE=""
	fi
}

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

# is_private_addr ADDR: an address the internet cannot reach. IPv4: RFC 1918, loopback,
# link-local, CGNAT (100.64/10). IPv6: loopback, unique-local fc00::/7, link-local fe80::/10.
is_private_addr() {
	case "$1" in
		10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
		100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0 ;;
		::1|[fF][cCdD]*:*|[fF][eE][89aAbB]*:*) return 0 ;;
	esac
	return 1
}
is_loopback_addr() { case "$1" in 127.*|::1) return 0 ;; esac; return 1; }

# doh_records NAME TYPE: NAME's records of TYPE (A, AAAA or CNAME) from Cloudflare's
# DNS-over-HTTPS resolver (JSON API), one per line, trailing dot removed; empty without curl or
# an answer. Answers of other types (a CNAME before the A records, the SOA of an empty answer)
# are skipped by their numeric type.
doh_records() {
	local num
	case "$2" in A) num=1 ;; AAAA) num=28 ;; CNAME) num=5 ;; *) return 0 ;; esac
	command -v curl >/dev/null || return 0
	{ curl -fsS --max-time 6 -H 'accept: application/dns-json' \
		"https://cloudflare-dns.com/dns-query?name=$1&type=$2" 2>/dev/null || true; } |
		{ grep -o "\"type\": *$num,[^}]*\"data\": *\"[^\"]*\"" || true; } |
		sed 's/.*"\([^"]*\)"$/\1/; s/\.$//'
}

# dns_addrs NAME [doh]: sets DNS4 and DNS6, NAME's IPv4 and IPv6 addresses (space-separated),
# and DNS_LOCAL. Loopback answers come from this host's /etc/hosts (cloud-init writes
# 127.0.1.1 <fqdn>) and hide the public records: they are left out and listed in DNS_LOCAL, and
# when nothing else answers and the second argument is doh, DNS4 and DNS6 come from doh_records.
dns_addrs() {
	local name="$1" addr
	DNS4=""; DNS6=""; DNS_LOCAL=""
	for addr in $(resolve4 "$name") $(resolve6 "$name"); do
		if is_loopback_addr "$addr"; then DNS_LOCAL+="${DNS_LOCAL:+ }$addr"
		elif [[ "$addr" == *:* ]]; then DNS6+="${DNS6:+ }$addr"
		else DNS4+="${DNS4:+ }$addr"
		fi
	done
	if [[ -z "$DNS4$DNS6" && -n "$DNS_LOCAL" && "${2:-}" == doh ]]; then
		DNS4="$(doh_records "$name" A | tr '\n' ' ' | sed 's/ $//')"
		DNS6="$(doh_records "$name" AAAA | tr '\n' ' ' | sed 's/ $//')"
	fi
}

# canonical_name NAME [doh]: where NAME's CNAME chain ends, as the first line of `getent ahosts`
# names it (AI_CANONNAME); NAME itself without a CNAME. When nothing resolves (glibc skips AAAA
# lookups on a host without IPv6: AI_ADDRCONFIG) and the second argument is doh, the first CNAME
# from doh_records. Empty when neither knows NAME.
canonical_name() {
	local cn
	cn="$({ getent ahosts "$1" 2>/dev/null || true; } | awk 'NR == 1 {print $3}')"
	[[ -n "$cn" || "${2:-}" != doh ]] || cn="$(doh_records "$1" CNAME | head -1)"
	printf '%s' "${cn%.}" | lower
}

# tunnel_dns_only NAME [doh]: NAME is a Cloudflare Tunnel record set to DNS only. Such a record
# shows its CNAME, <tunnel id>.cfargotunnel.com, whose only address is AAAA fd10:aec2:5dae::. A
# proxied record answers with Cloudflare's own addresses and hides the target.
tunnel_dns_only() {
	[[ "$(canonical_name "$1" "${2:-}")" == *.cfargotunnel.com ]] && return 0
	[[ " $(resolve6 "$1" | tr '\n' ' ') " == *" fd10:aec2:5dae:: "* ]]
}

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
