#!/usr/bin/env bash
# =============================================================================
# Harmony self-host configurator
# =============================================================================
# Writes .env, federation.env, bot-gateway.env, discord-bridge.env,
# livekit.yaml and supabase/.env, and provisions the upstream Supabase Docker
# stack into supabase/. install.sh runs it; it neither starts nor touches the
# running stack.
#
# Re-running merges: a key already present keeps its value and a missing key is
# added. Secrets of an existing install are never regenerated. Answers are
# written as given; values derived from the domain are rewritten only when the
# domain changes. A new supabase/.env has sign-up disabled (DISABLE_SIGNUP):
# `harmony registration` applies REGISTRATION once an admin exists.
#
# Usage:
#   bash configure.sh                      interactive
#   bash configure.sh --non-interactive    answers from the variables below
#   bash configure.sh --refresh-supabase   re-fetch supabase/ at SUPABASE_REF;
#                                          keeps answers, never touches data
#
# Answers, as environment variables; each defaults to the configured value:
#   HARMONY_DOMAIN          public domain, e.g. chat.example.com
#   HARMONY_INSTANCE_NAME   display name
#   HARMONY_ADMIN_EMAIL     Let's Encrypt contact and Web Push (VAPID) contact
#   HARMONY_TLS             acme | internal
#   HARMONY_VOICE           y | n   (LiveKit voice/video)
#   HARMONY_BOTS            y | n   (bot gateway)
#   HARMONY_DISCORD         y | n   (Discord bridge hosting; implies bots)
#   HARMONY_REGISTRATION    open | invite | closed
#   HARMONY_SMTP_HOST       SMTP server; set to configure email, unset keeps
#   HARMONY_SMTP_PORT       default 587
#   HARMONY_SMTP_USER, HARMONY_SMTP_PASS
#   HARMONY_SMTP_SENDER     From address, default noreply@DOMAIN
# Not asked:
#   HARMONY_VERSION         image tag; default from the checkout: X.Y.Z at
#                           tag vX.Y.Z, otherwise edge
#   HARMONY_BUILD           1 builds Harmony's images from this checkout
#                           (docker-compose.build.yml), 0 returns to images
#   HARMONY_HTTP_PORT       [address:]port Caddy publishes for 80 (default 80)
#   HARMONY_HTTPS_PORT      [address:]port Caddy publishes for 443 (default 443)
#   SUPABASE_REF            supabase/supabase commit, tag or branch
#
# Host requirements: Docker with Compose 2.24.4+, git, openssl.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUPABASE_DIR="$SCRIPT_DIR/supabase"
SUPABASE_REPO="${SUPABASE_REPO:-https://github.com/supabase/supabase}"
# Last upstream commit whose docker/ stack runs supabase/postgres:15.8.1.060, the
# image CI installs the schema on (scripts/check-fresh-install.sh). Its
# successors move to 15.8.1.085 and then to Postgres 17.
SUPABASE_REF_DEFAULT=31b6368049a1d9f5ef409383567b3f9bdaf018e9
SUPABASE_REF="${SUPABASE_REF:-$SUPABASE_REF_DEFAULT}"
COMPOSE_MIN=2.24.4

ENV_FILE="$SCRIPT_DIR/.env"
SB_ENV="$SUPABASE_DIR/.env"
FED_ENV="$SCRIPT_DIR/federation.env"
BOT_ENV="$SCRIPT_DIR/bot-gateway.env"
BRIDGE_ENV="$SCRIPT_DIR/discord-bridge.env"
LIVEKIT_YAML="$SCRIPT_DIR/livekit.yaml"
LIVEKIT_EXAMPLE="$REPO_DIR/webrtc/livekit.yaml.example"
DB_DATA_DIR="$SUPABASE_DIR/volumes/db/data"

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_reset=$'\033[0m'
info() { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()   { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }
warn() { printf "%s ! %s%s\n" "$c_yellow" "$*" "$c_reset" >&2; }
die()  { printf "Error: %s\n" "$*" >&2; exit 1; }

INTERACTIVE=true
REFRESH=false
for arg in "$@"; do
	case "$arg" in
		--non-interactive) INTERACTIVE=false ;;
		--refresh-supabase) REFRESH=true; INTERACTIVE=false ;;
		-h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) die "unknown argument: $arg (see --help)" ;;
	esac
done
[[ -t 0 ]] || INTERACTIVE=false

# --- host requirements -------------------------------------------------------
command -v docker  >/dev/null || die "docker is required: https://docs.docker.com/engine/install/"
command -v git     >/dev/null || die "git is required (fetches the Supabase stack): install it with your package manager"
command -v openssl >/dev/null || die "openssl is required (generates secrets): install it with your package manager"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is required ('docker compose'); the old docker-compose v1 does not read this stack"

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
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*//')"
version_ge "${compose_version:-0}" "$COMPOSE_MIN" ||
	die "Docker Compose $COMPOSE_MIN or later is required (found ${compose_version:-unknown}): include with a file list and !reset"

# --- helpers -----------------------------------------------------------------
rand_hex() { openssl rand -hex "$1"; }
rand_b64() { openssl rand -base64 "$1" | tr -d '\n'; }
b64url()   { openssl base64 -e -A | tr '+/' '-_' | tr -d '='; }
b64url_decode() {
	local s
	s="$(tr '_-' '/+')"
	case $(( ${#s} % 4 )) in 2) s="$s==" ;; 3) s="$s=" ;; esac
	printf '%s' "$s" | openssl base64 -d -A
}
lower() { tr '[:upper:]' '[:lower:]'; }

# HS256 JWT for a Supabase role, valid for 10 years.
sign_jwt() {
	local role="$1" secret="$2" now header payload body sig
	now=$(date +%s)
	header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
	payload=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$role" "$now" $((now + 315360000)) | b64url)
	body="$header.$payload"
	sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
	printf '%s.%s' "$body" "$sig"
}

# jwt_valid TOKEN SECRET ROLE: signed with SECRET, carries ROLE, and valid for
# at least another year.
jwt_valid() {
	local token="$1" secret="$2" role="$3" body payload exp
	[[ "$token" == *.*.* ]] || return 1
	body="${token%.*}"
	[[ "$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)" == "${token##*.}" ]] || return 1
	payload="$(printf '%s' "${body#*.}" | b64url_decode 2>/dev/null)" || return 1
	[[ "$payload" == *"\"role\":\"$role\""* ]] || return 1
	exp="$(printf '%s' "$payload" | sed -n 's/.*"exp":\([0-9]*\).*/\1/p')"
	[[ -n "$exp" ]] && (( exp > $(date +%s) + 31536000 ))
}

# Web Push VAPID keypair: P-256, base64url, as web-push expects. The SEC1 DER
# private key is 30 77 02 01 01 04 20 <32-byte scalar> ...; the SPKI public key
# ends with the 65-byte uncompressed point.
gen_vapid() {
	local pem
	pem="$(openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null)" || die "openssl could not generate a P-256 key"
	[[ "$(printf '%s\n' "$pem" | openssl ec -outform DER 2>/dev/null | od -An -tx1 -N7 | tr -d ' \n')" == 30770201010420 ]] ||
		die "unexpected EC key encoding from $(openssl version); generate VAPID keys with 'npx web-push generate-vapid-keys' and set them in federation.env"
	VAPID_PRIVATE_KEY="$(printf '%s\n' "$pem" | openssl ec -outform DER 2>/dev/null | tail -c +8 | head -c 32 | b64url)"
	VAPID_PUBLIC_KEY="$(printf '%s\n' "$pem" | openssl ec -pubout -outform DER 2>/dev/null | tail -c 65 | b64url)"
	[[ ${#VAPID_PRIVATE_KEY} -eq 43 && ${#VAPID_PUBLIC_KEY} -eq 87 ]] || die "VAPID key generation produced unexpected lengths"
}

# --- env files ---------------------------------------------------------------
# Keys are [A-Z0-9_]; values are written unquoted, one per line.

# Value of KEY in FILE: the first KEY= line, one layer of matching quotes removed.
env_get() {
	[[ -f "$1" ]] || return 0
	awk -v k="$2" '
		index($0, k "=") == 1 {
			v = substr($0, length(k) + 2)
			if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) v = substr(v, 2, length(v) - 2)
			print v; exit
		}' "$1"
}
env_has() { [[ -f "$1" ]] && grep -q "^$2=" "$1"; }

# Creates FILE mode 600 when absent.
env_touch() { [[ -f "$1" ]] || ( umask 077; : > "$1" ); }

# env_set FILE KEY VALUE: replaces the first KEY= line, or appends one.
env_set() {
	local file="$1" key="$2" val="$3" tmp
	env_touch "$file"
	if env_has "$file" "$key"; then
		[[ "$(env_get "$file" "$key")" == "$val" ]] && return 0
		tmp="$(mktemp "$file.XXXXXX")"
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

# Adds KEY only when absent.
env_default() { env_has "$1" "$2" || env_set "$1" "$2" "$3"; }

# Domain-derived: rewritten when the domain changed, otherwise added if absent.
env_domain() { if $DOMAIN_CHANGED; then env_set "$@"; else env_default "$@"; fi; }

env_del() {
	local file="$1" key="$2" tmp
	env_has "$file" "$key" || return 0
	tmp="$(mktemp "$file.XXXXXX")"
	awk -v k="$key" 'index($0, k "=") != 1' "$file" > "$tmp"
	mv "$tmp" "$file"
}

prompt() { # prompt VAR "question" "default"
	local __var="$1" __q="$2" __def="${3:-}" __ans=""
	if $INTERACTIVE; then
		if [[ -n "$__def" ]]; then read -rp "$__q [$__def]: " __ans; else read -rp "$__q: " __ans; fi
	fi
	printf -v "$__var" '%s' "${__ans:-$__def}"
}
yes_no() { case "$(printf '%s' "$1" | lower)" in y|yes|true|1) echo true ;; *) echo false ;; esac; }

# =============================================================================
# Answers
# =============================================================================
OLD_DOMAIN="$(env_get "$ENV_FILE" DOMAIN)"
OLD_TLS="$(env_get "$ENV_FILE" CADDY_TLS)"

ADMIN_EMAIL_DEFAULT="$(env_get "$ENV_FILE" ADMIN_EMAIL)"
[[ -n "$ADMIN_EMAIL_DEFAULT" || "$OLD_TLS" != *@* ]] || ADMIN_EMAIL_DEFAULT="$OLD_TLS"
[[ -n "$ADMIN_EMAIL_DEFAULT" ]] || ADMIN_EMAIL_DEFAULT="$(env_get "$FED_ENV" VAPID_SUBJECT)"

VOICE_DEFAULT="$(env_get "$ENV_FILE" ENABLE_VOICE)"
[[ -n "$VOICE_DEFAULT" ]] || VOICE_DEFAULT="$(env_get "$ENV_FILE" VITE_ENABLE_VOICE)"
BOTS_DEFAULT="$(env_get "$ENV_FILE" ENABLE_BOTS)"
[[ -n "$BOTS_DEFAULT" || ! -f "$BOT_ENV" ]] || BOTS_DEFAULT=true
DISCORD_DEFAULT="$(env_get "$ENV_FILE" ENABLE_DISCORD_BRIDGE)"
REGISTRATION_DEFAULT="$(env_get "$ENV_FILE" REGISTRATION)"
OLD_SMTP_HOST="$(env_get "$SB_ENV" SMTP_HOST)"

if [[ "$OLD_TLS" == internal ]]; then TLS_DEFAULT=n; else TLS_DEFAULT=y; fi
case "${HARMONY_TLS:-}" in
	acme) TLS_DEFAULT=y ;; internal) TLS_DEFAULT=n ;; "") ;;
	*) die "HARMONY_TLS must be acme or internal" ;;
esac

if $REFRESH; then
	[[ -n "$OLD_DOMAIN" ]] || die "--refresh-supabase needs an existing configuration; run configure.sh first"
fi

$INTERACTIVE && { echo; info "Harmony self-host configuration"; echo; }

prompt DOMAIN "Public domain for your instance (e.g. chat.example.com)" "${HARMONY_DOMAIN:-$OLD_DOMAIN}"
DOMAIN="$(printf '%s' "$DOMAIN" | lower)"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
[[ -n "$DOMAIN" ]] || die "a domain is required (HARMONY_DOMAIN)"
[[ "$DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
	die "'$DOMAIN' is not a domain name (letters, digits, hyphens, at least one dot)"

prompt INSTANCE_NAME "Instance display name" "${HARMONY_INSTANCE_NAME:-$(env_get "$ENV_FILE" INSTANCE_NAME)}"
INSTANCE_NAME="${INSTANCE_NAME:-Harmony}"
# Env files hold the name unquoted: compose expands $, cuts at " #", and reads
# a leading quote as quoting.
[[ "$INSTANCE_NAME" != *[\$\#\"\\\`]* && "$INSTANCE_NAME" != \'* && "$INSTANCE_NAME" != *$'\n'* ]] ||
	die "the instance name cannot contain \$ # \" \\ or a backtick, or start with a quote (the admin panel accepts any name later)"

$INTERACTIVE && { echo; info "The admin email is the Let's Encrypt contact and the contact push services see."; }
prompt ADMIN_EMAIL "Admin email" "${HARMONY_ADMIN_EMAIL:-$ADMIN_EMAIL_DEFAULT}"
ADMIN_EMAIL="${ADMIN_EMAIL#mailto:}"
[[ "$ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "an admin email is required (HARMONY_ADMIN_EMAIL)"

if $INTERACTIVE; then
	echo
	info "TLS: Caddy fetches public certificates (Let's Encrypt) for $DOMAIN and db.$DOMAIN,"
	info "or uses its own local CA for LAN/NAS setups without public DNS."
fi
prompt TLS_CHOICE "Public HTTPS via Let's Encrypt? (y = public DNS + ports 80/443 reachable, n = local CA)" "$TLS_DEFAULT"
if [[ "$(yes_no "$TLS_CHOICE")" == true ]]; then CADDY_TLS="$ADMIN_EMAIL"; else CADDY_TLS=internal; fi

prompt VOICE_CHOICE "Enable voice/video (LiveKit; needs live.$DOMAIN in DNS, UDP 7882 and TCP 7881 open)?" "${HARMONY_VOICE:-$( [[ "$(yes_no "${VOICE_DEFAULT:-n}")" == true ]] && echo y || echo n)}"
ENABLE_VOICE="$(yes_no "$VOICE_CHOICE")"
prompt BOTS_CHOICE "Enable the bot gateway (bots, Discord bridge)?" "${HARMONY_BOTS:-$( [[ "$(yes_no "${BOTS_DEFAULT:-n}")" == true ]] && echo y || echo n)}"
ENABLE_BOTS="$(yes_no "$BOTS_CHOICE")"

ENABLE_DISCORD_BRIDGE=false
if $ENABLE_BOTS || [[ "$(yes_no "${HARMONY_DISCORD:-n}")" == true ]]; then
	prompt DISCORD_CHOICE "Host Discord bridges for your communities (they paste their Discord bot token in Harmony)?" "${HARMONY_DISCORD:-$( [[ "$(yes_no "${DISCORD_DEFAULT:-n}")" == true ]] && echo y || echo n)}"
	ENABLE_DISCORD_BRIDGE="$(yes_no "$DISCORD_CHOICE")"
fi
if $ENABLE_DISCORD_BRIDGE && ! $ENABLE_BOTS; then
	warn "Discord bridge hosting runs on the bot gateway; enabling bots"
	ENABLE_BOTS=true
fi

if $INTERACTIVE; then
	echo
	info "Registration: open = anyone can sign up; invite = you create invite links"
	info "(harmony admin invite EMAIL); closed = no new accounts."
fi
prompt REGISTRATION "Registration (open / invite / closed)" "${HARMONY_REGISTRATION:-${REGISTRATION_DEFAULT:-open}}"
REGISTRATION="$(printf '%s' "$REGISTRATION" | lower)"
case "$REGISTRATION" in
	open|closed) ;;
	invite|invite-only|invite_only|invites) REGISTRATION=invite ;;
	*) die "registration must be open, invite or closed (HARMONY_REGISTRATION)" ;;
esac

# SMTP: answered only when asked for; otherwise supabase/.env keeps its values.
smtp_configured() { [[ -n "$1" && "$1" != supabase-mail ]]; }
SMTP_SET=false
if $INTERACTIVE; then
	echo
	info "Email (SMTP) sends password resets and address confirmations. Without it,"
	info "accounts are usable at sign-up and nobody can reset a forgotten password."
	if smtp_configured "$OLD_SMTP_HOST"; then smtp_default=y; else smtp_default=n; fi
	prompt SMTP_CHOICE "Configure outgoing email (SMTP) now?" "$smtp_default"
	if [[ "$(yes_no "$SMTP_CHOICE")" == true ]]; then
		SMTP_SET=true
		cur_host="$OLD_SMTP_HOST"; smtp_configured "$cur_host" || cur_host=""
		prompt SMTP_HOST "SMTP host (e.g. smtp.mailgun.org)" "${HARMONY_SMTP_HOST:-$cur_host}"
		prompt SMTP_PORT "SMTP port" "${HARMONY_SMTP_PORT:-$(smtp_configured "$OLD_SMTP_HOST" && env_get "$SB_ENV" SMTP_PORT || echo 587)}"
		prompt SMTP_USER "SMTP username" "${HARMONY_SMTP_USER:-$(smtp_configured "$OLD_SMTP_HOST" && env_get "$SB_ENV" SMTP_USER)}"
		read -rsp "SMTP password (empty keeps the current one): " SMTP_PASS; echo
		[[ -n "$SMTP_PASS" ]] || SMTP_PASS="${HARMONY_SMTP_PASS:-$(smtp_configured "$OLD_SMTP_HOST" && env_get "$SB_ENV" SMTP_PASS)}"
		prompt SMTP_SENDER "Sender address (From)" "${HARMONY_SMTP_SENDER:-$(smtp_configured "$OLD_SMTP_HOST" && env_get "$SB_ENV" SMTP_ADMIN_EMAIL || echo "noreply@$DOMAIN")}"
	fi
elif [[ -n "${HARMONY_SMTP_HOST:-}" ]]; then
	SMTP_SET=true
	SMTP_HOST="$HARMONY_SMTP_HOST"
	SMTP_PORT="${HARMONY_SMTP_PORT:-587}"
	SMTP_USER="${HARMONY_SMTP_USER:-}"
	SMTP_PASS="${HARMONY_SMTP_PASS:-}"
	SMTP_SENDER="${HARMONY_SMTP_SENDER:-noreply@$DOMAIN}"
fi
if $SMTP_SET; then
	[[ "$SMTP_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "SMTP host '$SMTP_HOST' is not a host name"
	[[ "$SMTP_PORT" =~ ^[0-9]+$ ]] || die "SMTP port '$SMTP_PORT' is not a number"
	[[ "$SMTP_SENDER" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || die "sender '$SMTP_SENDER' is not an email address"
	[[ "$SMTP_USER" != *[[:space:]\'\"\$\#]* ]] || die "the SMTP username cannot contain spaces, quotes, \$ or #"
	[[ "$SMTP_PASS" != *"'"* && "$SMTP_PASS" != *$'\n'* ]] || die "the SMTP password cannot contain a single quote or a newline"
fi

# Image tag: X.Y.Z when the checkout sits on tag vX.Y.Z, otherwise edge.
derive_version() {
	local tag
	if tag="$(git -C "$REPO_DIR" describe --tags --exact-match --match 'v[0-9]*' HEAD 2>/dev/null)"; then
		printf '%s' "${tag#v}"
	elif ! git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 && [[ -s "$REPO_DIR/VERSION" ]]; then
		tr -d '[:space:]' < "$REPO_DIR/VERSION"
	else
		printf edge
	fi
}
HARMONY_VERSION="${HARMONY_VERSION:-$(derive_version)}"
HARMONY_VERSION="${HARMONY_VERSION#v}"
[[ "$HARMONY_VERSION" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ ]] || die "HARMONY_VERSION '$HARMONY_VERSION' is not an image tag"

HTTP_PORT="${HARMONY_HTTP_PORT:-$(env_get "$ENV_FILE" HARMONY_HTTP_PORT)}"; HTTP_PORT="${HTTP_PORT:-80}"
HTTPS_PORT="${HARMONY_HTTPS_PORT:-$(env_get "$ENV_FILE" HARMONY_HTTPS_PORT)}"; HTTPS_PORT="${HTTPS_PORT:-443}"
for p in "$HTTP_PORT" "$HTTPS_PORT"; do
	[[ "$p" =~ ^(([0-9.]+|\[[0-9a-fA-F:]+\]):)?[0-9]+$ ]] || die "port '$p' is not [address:]port (HARMONY_HTTP_PORT / HARMONY_HTTPS_PORT)"
done

DOMAIN_CHANGED=false
[[ -n "$OLD_DOMAIN" && "$OLD_DOMAIN" != "$DOMAIN" ]] && DOMAIN_CHANGED=true
$DOMAIN_CHANGED && warn "domain changes from $OLD_DOMAIN to $DOMAIN: URLs derived from it are rewritten. Federated accounts keep the old domain in their ids; a domain is meant to stay."

DB_DOMAIN="db.$DOMAIN"
LIVEKIT_DOMAIN="live.$DOMAIN"
PROFILES=""
$ENABLE_VOICE && PROFILES="voice"
$ENABLE_BOTS && PROFILES="${PROFILES:+$PROFILES,}bots"
$ENABLE_DISCORD_BRIDGE && PROFILES="${PROFILES:+$PROFILES,}discord"

# =============================================================================
# Supabase stack
# =============================================================================
pg_major() { sed -n 's#.*supabase/postgres:\([0-9][0-9]*\)\..*#\1#p' "$1" | head -1; }

# Fetches docker/ of supabase/supabase at SUPABASE_REF into a staging clone and
# copies its files over supabase/. Nothing is deleted: the database
# (volumes/db/data) and uploads (volumes/storage) live in the same tree.
# docker-compose.yml is copied last, so an interrupted first provisioning
# leaves no compose file and the next run provisions again.
provision_supabase() {
	local stage="$SCRIPT_DIR/.supabase-src" src rev old_major new_major
	rm -rf "$stage"
	mkdir -p "$stage"
	info "Fetching the Supabase Docker stack ($SUPABASE_REF)..."
	git -C "$stage" init -q
	git -C "$stage" remote add origin "$SUPABASE_REPO"
	git -C "$stage" sparse-checkout set docker
	git -C "$stage" fetch -q --depth 1 --filter=blob:none origin "$SUPABASE_REF" ||
		die "could not fetch $SUPABASE_REF from $SUPABASE_REPO (network, or no such commit/tag/branch)"
	git -C "$stage" checkout -q FETCH_HEAD || die "could not check out $SUPABASE_REF"
	rev="$(git -C "$stage" rev-parse HEAD)"
	src="$stage/docker"
	[[ -f "$src/docker-compose.yml" && -f "$src/.env.example" ]] ||
		die "$SUPABASE_REF has no docker/docker-compose.yml and docker/.env.example"

	new_major="$(pg_major "$src/docker-compose.yml")"
	[[ -n "$new_major" ]] || die "no supabase/postgres image in $SUPABASE_REF's docker-compose.yml"
	if [[ -f "$SUPABASE_DIR/docker-compose.yml" && -d "$DB_DATA_DIR" ]]; then
		old_major="$(pg_major "$SUPABASE_DIR/docker-compose.yml")"
		if [[ -n "$old_major" && "$old_major" != "$new_major" ]]; then
			rm -rf "$stage"
			die "$SUPABASE_REF runs Postgres $new_major; the database in supabase/volumes/db/data is Postgres $old_major and would not start. A major upgrade is a dump and restore; supabase/ is unchanged."
		fi
	fi

	mkdir -p "$SUPABASE_DIR"
	# reset.sh deletes volumes/db/data and volumes/storage.
	( cd "$src" && tar -cf - --exclude=./docker-compose.yml --exclude=./reset.sh \
		--exclude=./volumes/db/data --exclude=./volumes/storage . ) |
		( cd "$SUPABASE_DIR" && tar -xf - ) || die "could not copy the Supabase files into supabase/"
	rm -f "$SUPABASE_DIR/reset.sh"
	cp "$src/docker-compose.yml" "$SUPABASE_DIR/docker-compose.yml.tmp"
	mv "$SUPABASE_DIR/docker-compose.yml.tmp" "$SUPABASE_DIR/docker-compose.yml"
	printf '%s\n' "$rev" > "$SUPABASE_DIR/.harmony-supabase-ref"
	rm -rf "$stage"
	ok "Supabase stack at ${rev:0:12} in self-host/supabase (Postgres $new_major)"
}

if [[ ! -f "$SUPABASE_DIR/docker-compose.yml" ]] || $REFRESH; then
	provision_supabase
else
	cur_ref="$(cat "$SUPABASE_DIR/.harmony-supabase-ref" 2>/dev/null || echo unknown)"
	info "Reusing self-host/supabase (${cur_ref:0:12}); --refresh-supabase re-fetches it"
	[[ "$cur_ref" == "$SUPABASE_REF" || "$cur_ref" == unknown ]] ||
		warn "self-host/supabase is at ${cur_ref:0:12}, this release pins ${SUPABASE_REF:0:12}; run configure.sh --refresh-supabase after a backup"
fi

# =============================================================================
# Secrets
# =============================================================================
SB_ENV_NEW=false
[[ -f "$SB_ENV" ]] || SB_ENV_NEW=true

sb_secret() { $SB_ENV_NEW || env_get "$SB_ENV" "$1"; }
JWT_SECRET="$(sb_secret JWT_SECRET)"
POSTGRES_PASSWORD="$(sb_secret POSTGRES_PASSWORD)"
if [[ -d "$DB_DATA_DIR" && ( -z "$JWT_SECRET" || -z "$POSTGRES_PASSWORD" ) ]]; then
	die "supabase/volumes/db/data holds a database, but supabase/.env has no JWT_SECRET/POSTGRES_PASSWORD. Restore supabase/.env from your backup: new secrets would lock this database out."
fi
JWT_SECRET="${JWT_SECRET:-$(rand_b64 48)}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(rand_hex 24)}"

ANON_KEY="$(sb_secret ANON_KEY)"
SERVICE_ROLE_KEY="$(sb_secret SERVICE_ROLE_KEY)"
KEYS_RESIGNED=false
if ! jwt_valid "$ANON_KEY" "$JWT_SECRET" anon; then ANON_KEY="$(sign_jwt anon "$JWT_SECRET")"; KEYS_RESIGNED=true; fi
if ! jwt_valid "$SERVICE_ROLE_KEY" "$JWT_SECRET" service_role; then SERVICE_ROLE_KEY="$(sign_jwt service_role "$JWT_SECRET")"; KEYS_RESIGNED=true; fi
$KEYS_RESIGNED && ! $SB_ENV_NEW && warn "ANON_KEY/SERVICE_ROLE_KEY re-signed (expiring or not signed with JWT_SECRET); 'docker compose up -d' applies them"

REDIS_PASSWORD="$(env_get "$ENV_FILE" REDIS_PASSWORD)"; REDIS_PASSWORD="${REDIS_PASSWORD:-$(rand_hex 24)}"
LISTENER_PASSWORD="$(env_get "$FED_ENV" __LISTENER_PW)"
LISTENER_NEW=false
[[ -n "$LISTENER_PASSWORD" ]] || { LISTENER_PASSWORD="$(rand_hex 24)"; LISTENER_NEW=true; }
INTERNAL_API_SECRET="$(env_get "$FED_ENV" INTERNAL_API_SECRET)"; INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-$(rand_hex 32)}"

# A push subscription is bound to the VAPID public key: the pair never rotates.
VAPID_PUBLIC_KEY="$(env_get "$FED_ENV" VAPID_PUBLIC_KEY)"
VAPID_PRIVATE_KEY="$(env_get "$FED_ENV" VAPID_PRIVATE_KEY)"
VAPID_NEW=false
if [[ -z "$VAPID_PUBLIC_KEY" || -z "$VAPID_PRIVATE_KEY" ]]; then gen_vapid; VAPID_NEW=true; fi

LIVEKIT_API_KEY="$(env_get "$FED_ENV" LIVEKIT_API_KEY)"
LIVEKIT_API_SECRET="$(env_get "$FED_ENV" LIVEKIT_API_SECRET)"
if [[ -z "$LIVEKIT_API_KEY" || -z "$LIVEKIT_API_SECRET" ]]; then
	# LiveKit requires secrets of at least 32 characters.
	LIVEKIT_API_KEY="API$(rand_hex 6)"
	LIVEKIT_API_SECRET="$(rand_hex 32)"
fi

# The gateway refuses a host secret under 32 characters.
BRIDGE_HOST_SECRET="$(env_get "$BRIDGE_ENV" BRIDGE_HOST_SECRET)"
[[ ${#BRIDGE_HOST_SECRET} -ge 32 ]] || BRIDGE_HOST_SECRET="$(rand_hex 32)"

# =============================================================================
# supabase/.env
# =============================================================================
if $SB_ENV_NEW; then
	( umask 077; cp "$SUPABASE_DIR/.env.example" "$SB_ENV" )
	# Upstream ships demo values for these; replace them all.
	env_set "$SB_ENV" JWT_SECRET "$JWT_SECRET"
	env_set "$SB_ENV" ANON_KEY "$ANON_KEY"
	env_set "$SB_ENV" SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
	env_set "$SB_ENV" POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
	env_set "$SB_ENV" DASHBOARD_PASSWORD "$(rand_hex 16)"
	env_set "$SB_ENV" SECRET_KEY_BASE "$(rand_b64 48)"
	env_set "$SB_ENV" VAULT_ENC_KEY "$(rand_hex 16)"
	env_set "$SB_ENV" PG_META_CRYPTO_KEY "$(rand_hex 16)"
	env_set "$SB_ENV" LOGFLARE_PUBLIC_ACCESS_TOKEN "$(rand_hex 32)"
	env_set "$SB_ENV" LOGFLARE_PRIVATE_ACCESS_TOKEN "$(rand_hex 32)"
	# Without SMTP, accounts are usable at signup.
	if $SMTP_SET; then env_set "$SB_ENV" ENABLE_EMAIL_AUTOCONFIRM false; else env_set "$SB_ENV" ENABLE_EMAIL_AUTOCONFIRM true; fi
	# Closed until an admin exists; `harmony registration` opens it.
	env_set "$SB_ENV" DISABLE_SIGNUP true
	env_set "$SB_ENV" STUDIO_DEFAULT_PROJECT "$INSTANCE_NAME"
	env_set "$SB_ENV" SITE_URL "https://$DOMAIN"
	env_set "$SB_ENV" API_EXTERNAL_URL "https://$DB_DOMAIN"
	env_set "$SB_ENV" SUPABASE_PUBLIC_URL "https://$DB_DOMAIN"
	env_set "$SB_ENV" ADDITIONAL_REDIRECT_URLS "https://$DOMAIN"
else
	env_set "$SB_ENV" ANON_KEY "$ANON_KEY"
	env_set "$SB_ENV" SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
	env_domain "$SB_ENV" SITE_URL "https://$DOMAIN"
	env_domain "$SB_ENV" API_EXTERNAL_URL "https://$DB_DOMAIN"
	env_domain "$SB_ENV" SUPABASE_PUBLIC_URL "https://$DB_DOMAIN"
	env_domain "$SB_ENV" ADDITIONAL_REDIRECT_URLS "https://$DOMAIN"
	# Keys a newer upstream .env.example introduced, with upstream's defaults.
	added=()
	while IFS= read -r line; do
		key="${line%%=*}"
		env_has "$SB_ENV" "$key" && continue
		[[ ${#added[@]} -eq 0 ]] && printf '\n# Added from upstream .env.example by configure.sh\n' >> "$SB_ENV"
		printf '%s\n' "$line" >> "$SB_ENV"
		added+=("$key")
	done < <(grep -E '^[A-Z0-9_]+=' "$SUPABASE_DIR/.env.example")
	[[ ${#added[@]} -eq 0 ]] || info "supabase/.env: added ${added[*]}"
fi
if $SMTP_SET; then
	env_set "$SB_ENV" SMTP_HOST "$SMTP_HOST"
	env_set "$SB_ENV" SMTP_PORT "$SMTP_PORT"
	env_set "$SB_ENV" SMTP_USER "$SMTP_USER"
	# Single quotes: compose reads the value literally ($, # and spaces).
	if [[ "$SMTP_PASS" =~ ^[A-Za-z0-9._@:+/=-]*$ ]]; then
		env_set "$SB_ENV" SMTP_PASS "$SMTP_PASS"
	else
		env_set "$SB_ENV" SMTP_PASS "'$SMTP_PASS'"
	fi
	env_set "$SB_ENV" SMTP_ADMIN_EMAIL "$SMTP_SENDER"
	env_set "$SB_ENV" SMTP_SENDER_NAME "$INSTANCE_NAME"
	# Addresses are confirmed by email once mail can be sent; only a change of
	# SMTP host flips it, so a hand edit stays.
	smtp_configured "$OLD_SMTP_HOST" || env_set "$SB_ENV" ENABLE_EMAIL_AUTOCONFIRM false
fi
chmod 600 "$SB_ENV"
ok "self-host/supabase/.env"

# =============================================================================
# .env (compose interpolation)
# =============================================================================
[[ -f "$ENV_FILE" ]] || { env_touch "$ENV_FILE"; printf '# Written by configure.sh; re-running it keeps existing values.\n' >> "$ENV_FILE"; }
env_set     "$ENV_FILE" DOMAIN "$DOMAIN"
env_domain  "$ENV_FILE" DB_DOMAIN "$DB_DOMAIN"
env_domain  "$ENV_FILE" LIVEKIT_DOMAIN "$LIVEKIT_DOMAIN"
env_set     "$ENV_FILE" INSTANCE_NAME "$INSTANCE_NAME"
env_set     "$ENV_FILE" ADMIN_EMAIL "$ADMIN_EMAIL"
env_set     "$ENV_FILE" CADDY_TLS "$CADDY_TLS"
env_set     "$ENV_FILE" ENABLE_VOICE "$ENABLE_VOICE"
env_set     "$ENV_FILE" ENABLE_BOTS "$ENABLE_BOTS"
env_set     "$ENV_FILE" ENABLE_DISCORD_BRIDGE "$ENABLE_DISCORD_BRIDGE"
env_set     "$ENV_FILE" REGISTRATION "$REGISTRATION"
# Read by docker compose itself: `docker compose up -d` starts these profiles.
env_set     "$ENV_FILE" COMPOSE_PROFILES "$PROFILES"
env_set     "$ENV_FILE" HARMONY_VERSION "$HARMONY_VERSION"
case "$(printf '%s' "${HARMONY_BUILD:-}" | lower)" in
	1|y|yes|true)
		env_set "$ENV_FILE" COMPOSE_FILE docker-compose.yml:docker-compose.build.yml ;;
	0|n|no|false)
		[[ "$(env_get "$ENV_FILE" COMPOSE_FILE)" != docker-compose.yml:docker-compose.build.yml ]] ||
			env_del "$ENV_FILE" COMPOSE_FILE ;;
esac
env_set     "$ENV_FILE" HARMONY_HTTP_PORT "$HTTP_PORT"
env_set     "$ENV_FILE" HARMONY_HTTPS_PORT "$HTTPS_PORT"
# Runtime frontend config: the web container writes /config.json from it.
env_set     "$ENV_FILE" SUPABASE_ANON_KEY "$ANON_KEY"
env_default "$ENV_FILE" REDIS_PASSWORD "$REDIS_PASSWORD"
# Dead keys from earlier configure.sh versions; nothing reads them.
for dead in VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY VITE_LIVEKIT_URL VITE_ENABLE_FEDERATION VITE_ENABLE_VOICE VITE_ENABLE_E2E_ENCRYPTION VITE_FEDERATION_API_URL; do
	env_del "$ENV_FILE" "$dead"
done
chmod 600 "$ENV_FILE"
ok "self-host/.env"

# =============================================================================
# federation.env
# =============================================================================
[[ -f "$FED_ENV" ]] || { env_touch "$FED_ENV"; printf '# Written by configure.sh; re-running it keeps existing values.\n' >> "$FED_ENV"; }
env_default "$FED_ENV" NODE_ENV production
env_domain  "$FED_ENV" INSTANCE_DOMAIN "$DOMAIN"
env_set     "$FED_ENV" INSTANCE_NAME "$INSTANCE_NAME"
env_domain  "$FED_ENV" API_BASE_URL "https://$DOMAIN"
env_domain  "$FED_ENV" CORS_ORIGIN "https://$DOMAIN"
env_default "$FED_ENV" SUPABASE_URL http://supabase-kong:8000
env_domain  "$FED_ENV" PUBLIC_SUPABASE_URL "https://$DB_DOMAIN"
env_set     "$FED_ENV" SUPABASE_ANON_KEY "$ANON_KEY"
env_set     "$FED_ENV" SUPABASE_SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
env_default "$FED_ENV" REDIS_URL "redis://:$REDIS_PASSWORD@redis:6379"
env_default "$FED_ENV" USE_BULLMQ_QUEUE true
# harmony_listener: least-privilege LISTEN role; __LISTENER_PW repeats its
# password outside the URL.
env_default "$FED_ENV" FEDERATION_LISTENER_URL "postgresql://harmony_listener:$LISTENER_PASSWORD@supabase-db:5432/postgres"
env_default "$FED_ENV" __LISTENER_PW "$LISTENER_PASSWORD"
# Bearer secret for /link-preview/enrich-message; narrower than the
# service-role key, which the endpoint accepts in its absence.
env_default "$FED_ENV" INTERNAL_API_SECRET "$INTERNAL_API_SECRET"
if $VAPID_NEW; then
	env_set "$FED_ENV" VAPID_PUBLIC_KEY "$VAPID_PUBLIC_KEY"
	env_set "$FED_ENV" VAPID_PRIVATE_KEY "$VAPID_PRIVATE_KEY"
fi
env_set "$FED_ENV" VAPID_SUBJECT "$ADMIN_EMAIL"
env_default "$FED_ENV" LIVEKIT_API_KEY "$LIVEKIT_API_KEY"
env_default "$FED_ENV" LIVEKIT_API_SECRET "$LIVEKIT_API_SECRET"
if $ENABLE_VOICE; then
	env_default "$FED_ENV" LIVEKIT_URL ws://livekit:7880
	env_domain  "$FED_ENV" LIVEKIT_PUBLIC_URL "wss://$LIVEKIT_DOMAIN"
else
	# The backend treats LiveKit as configured when key, secret and URL are set.
	env_del "$FED_ENV" LIVEKIT_URL
	env_del "$FED_ENV" LIVEKIT_PUBLIC_URL
fi
chmod 600 "$FED_ENV"
ok "self-host/federation.env"

# =============================================================================
# bot-gateway.env
# =============================================================================
if $ENABLE_BOTS; then
	[[ -f "$BOT_ENV" ]] || { env_touch "$BOT_ENV"; printf '# Written by configure.sh; re-running it keeps existing values.\n' >> "$BOT_ENV"; }
	env_default "$BOT_ENV" NODE_ENV production
	env_default "$BOT_ENV" SUPABASE_URL http://supabase-kong:8000
	env_set     "$BOT_ENV" SUPABASE_SERVICE_ROLE_KEY "$SERVICE_ROLE_KEY"
	# Storage URLs handed to bots and bridges: SUPABASE_URL replaced by this.
	env_domain  "$BOT_ENV" PUBLIC_URL "https://$DB_DOMAIN"
	# Base of the bridge pairing URLs (wss://DOMAIN/bot-gateway/gateway).
	env_domain  "$BOT_ENV" INSTANCE_DOMAIN "$DOMAIN"
	# Link previews of bot messages. The gateway sends its secret only over
	# https or to localhost; DOMAIN resolves to Caddy on the selfcall network.
	env_domain  "$BOT_ENV" FEDERATION_BACKEND_URL "https://$DOMAIN"
	env_set     "$BOT_ENV" INTERNAL_API_SECRET "$(env_get "$FED_ENV" INTERNAL_API_SECRET)"
	# GET /bridge/v2/hosted answers only with this secret; absent, hosting is off.
	if $ENABLE_DISCORD_BRIDGE; then
		env_set "$BOT_ENV" BRIDGE_HOST_SECRET "$BRIDGE_HOST_SECRET"
	else
		env_del "$BOT_ENV" BRIDGE_HOST_SECRET
	fi
	chmod 600 "$BOT_ENV"
	ok "self-host/bot-gateway.env"
fi

# =============================================================================
# discord-bridge.env
# =============================================================================
if $ENABLE_DISCORD_BRIDGE; then
	[[ -f "$BRIDGE_ENV" ]] || { env_touch "$BRIDGE_ENV"; printf '# Written by configure.sh; re-running it keeps existing values.\n' >> "$BRIDGE_ENV"; }
	env_set "$BRIDGE_ENV" BRIDGE_HOST_SECRET "$BRIDGE_HOST_SECRET"
	chmod 600 "$BRIDGE_ENV"
	ok "self-host/discord-bridge.env"
fi

# =============================================================================
# livekit.yaml
# =============================================================================
if $ENABLE_VOICE; then
	lk_key="$(env_get "$FED_ENV" LIVEKIT_API_KEY)"
	lk_secret="$(env_get "$FED_ENV" LIVEKIT_API_SECRET)"
	redis_pw="$(env_get "$ENV_FILE" REDIS_PASSWORD)"
	if [[ -f "$LIVEKIT_YAML" ]]; then
		if $DOMAIN_CHANGED; then
			tmp="$(mktemp "$LIVEKIT_YAML.XXXXXX")"
			O="  domain: live.$OLD_DOMAIN" N="  domain: $LIVEKIT_DOMAIN" awk '
				$0 == ENVIRON["O"] { print ENVIRON["N"]; next } { print }' "$LIVEKIT_YAML" > "$tmp"
			mv "$tmp" "$LIVEKIT_YAML"
		fi
		grep -q "^  $lk_key: $lk_secret\$" "$LIVEKIT_YAML" ||
			warn "self-host/livekit.yaml exists and lacks LIVEKIT_API_KEY/SECRET from federation.env; delete it to regenerate"
		ok "self-host/livekit.yaml kept"
	else
		[[ -f "$LIVEKIT_EXAMPLE" ]] || die "missing $LIVEKIT_EXAMPLE"
		tmp="$(mktemp "$LIVEKIT_YAML.XXXXXX")"
		{
			printf '# Written by self-host/configure.sh from webrtc/livekit.yaml.example; kept on re-run.\n'
			printf '# Keys, Redis password and webhook match federation.env and .env.\n'
			printf '# TURN is off: it relays through UDP 30000-40000 (turn.relay_range_*), which\n'
			printf '# docker-compose.yml does not publish. Clients without UDP use ICE/TCP on 7881.\n\n'
			K="$lk_key" S="$lk_secret" R="$redis_pw" D="$LIVEKIT_DOMAIN" awk '
				BEGIN { k = ENVIRON["K"]; s = ENVIRON["S"]; r = ENVIRON["R"]; d = ENVIRON["D"] }
				/^[^ #]/                                   { section = $0 }
				section == "turn:" && $0 == "  enabled: true" { print "  enabled: false"; next }
				$0 == "  YOUR_API_KEY: YOUR_API_SECRET"    { print "  " k ": " s; next }
				$0 == "  domain: live.yourdomain.com"      { print "  domain: " d; next }
				$0 == "  address: harmony-redis:6379"     { print "  address: redis:6379"; next }
				$0 == "  password: YOUR_REDIS_PASSWORD_HERE" { print "  password: " r; next }
				$0 == "# webhook:"                         { print "webhook:"; next }
				$0 == "#   api_key: YOUR_API_KEY"          { print "  api_key: " k; next }
				$0 == "#   urls:"                          { print "  urls:"; next }
				$0 == "#     - https://yourdomain.com/api/livekit/webhook" { print "    - http://federation-server:3001/api/livekit/webhook"; next }
				{ print }' "$LIVEKIT_EXAMPLE"
		} > "$tmp"
		if grep -vE '^[[:space:]]*#' "$tmp" | grep -qE 'YOUR_|yourdomain|enabled: true' ||
			! grep -q '^webhook:' "$tmp" || ! grep -q '^  address: redis:6379$' "$tmp" ||
			! grep -q "^  $lk_key: $lk_secret\$" "$tmp"; then
			rm -f "$tmp"
			die "webrtc/livekit.yaml.example no longer has the lines configure.sh fills in; update configure.sh"
		fi
		mv "$tmp" "$LIVEKIT_YAML"
		ok "self-host/livekit.yaml"
	fi
fi

# =============================================================================
# Validate
# =============================================================================
( cd "$SCRIPT_DIR" && docker compose config -q ) ||
	die "docker compose rejects the configuration above (Compose $compose_version)"

echo
ok "Configuration complete."
echo
if [[ -d "$DB_DATA_DIR" ]]; then
	info "Existing install: 'docker compose up -d' applies configuration changes; 'harmony update' also updates the code."
	$LISTENER_NEW && warn "a new harmony_listener password was generated; run 'bash bootstrap.sh' once to set it"
	$VAPID_NEW && info "Push notifications use a new VAPID key; restart the federation services (update.sh does)."
else
	info "Next steps (in self-host/):"
	echo "  1) docker compose pull && docker compose up -d${PROFILES:+   # profiles: $PROFILES}"
	echo "  2) bash bootstrap.sh          # load the database schema"
	echo "  3) harmony admin create     # the admin account; sign-up stays closed until then"
	echo "  4) harmony registration     # apply REGISTRATION=$REGISTRATION"
	echo "  (harmony install does all of this.)"
	echo
	if $ENABLE_VOICE; then
		info "DNS: $DOMAIN, $DB_DOMAIN and $LIVEKIT_DOMAIN must point at this host."
	else
		info "DNS: $DOMAIN and $DB_DOMAIN must point at this host."
	fi
fi
info "Supabase Studio: https://$DB_DOMAIN (user supabase, DASHBOARD_PASSWORD in supabase/.env)"
info "Back up self-host/*.env, livekit.yaml and supabase/.env (harmony backup does): they hold the only copy of the secrets."
