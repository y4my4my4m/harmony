#!/usr/bin/env bash
# =============================================================================
# Harmony installer
# =============================================================================
#   curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
#   bash self-host/install.sh            (from a checkout; installs that checkout)
#
# Checks the host (Linux, x86_64/arm64, Docker with Compose 2.24.4+, memory,
# ports), fetches Harmony into /opt/harmony unless run from a checkout, asks
# a few questions, checks DNS, writes the configuration (configure.sh), pulls
# and starts the stack, loads the database (bootstrap.sh), creates the admin
# account and applies the registration policy. Sign-up stays closed until the
# admin exists.
#
# Re-running is safe: answers default to the current configuration, secrets
# and data are kept, an existing admin is left alone.
#
# Options: --dir DIR, --ref REF, --non-interactive, -h
#
# Without a terminal (or with --non-interactive / HARMONY_NONINTERACTIVE=1)
# every question takes its answer from the environment:
#   HARMONY_DOMAIN            required: chat.example.com
#   HARMONY_ADMIN_EMAIL       required: admin login, Let's Encrypt and push contact
#   HARMONY_ADMIN_USERNAME    default: the email's local part
#   HARMONY_ADMIN_PASSWORD    default: generated and printed once
#   HARMONY_INSTANCE_NAME     default: Harmony
#   HARMONY_VOICE             y|n, default y (LiveKit; live.DOMAIN, 7881/tcp, 7882/udp)
#   HARMONY_BOTS              y|n, default n (bot gateway)
#   HARMONY_DISCORD           y|n, default n (Discord bridge hosting; implies bots)
#   HARMONY_REGISTRATION      open|invite|closed, default open
#   HARMONY_SMTP_HOST, HARMONY_SMTP_PORT (587), HARMONY_SMTP_USER,
#   HARMONY_SMTP_PASS, HARMONY_SMTP_SENDER (noreply@DOMAIN)
#   HARMONY_TLS               acme|internal, default acme (internal: Caddy's own CA, LAN)
# Host and source:
#   HARMONY_DIR               install directory, default /opt/harmony
#   HARMONY_REPO              git URL, default https://github.com/y4my4my4m/harmony.git
#   HARMONY_REF               tag/branch for a new checkout, default the newest
#                             release that ships this installer, else master
#   HARMONY_VERSION           image tag (configure.sh derives it from the checkout)
#   HARMONY_BUILD=1           build Harmony's images here instead of pulling
#   HARMONY_HTTP_PORT, HARMONY_HTTPS_PORT   [address:]port, default 80 / 443
#   HARMONY_PUBLIC_IP         this server's public IPv4, when lookup fails
# Consent for changes to the host (default: ask; without a terminal: no):
#   HARMONY_INSTALL_DOCKER=y  install Docker with https://get.docker.com
#   HARMONY_INSTALL_PACKAGES=y  install missing git/openssl/curl
#   HARMONY_CREATE_SWAP=y     create a 2 GB /swapfile when RAM is under 4 GB and
#                             there is no swap
#   HARMONY_CLI_LINK=n        no /usr/local/bin/harmony link (made as root)
#   HARMONY_SKIP_DOCTOR=1     no doctor run at the end
# =============================================================================
set -euo pipefail

HARMONY_REPO="${HARMONY_REPO:-https://github.com/y4my4my4m/harmony.git}"
COMPOSE_MIN=2.24.4

# --- helpers until the checkout's lib.sh is available ------------------------
if [[ -t 1 ]]; then
	c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_bold=$'\033[1m'; c_reset=$'\033[0m'
else
	c_blue=""; c_green=""; c_yellow=""; c_red=""; c_bold=""; c_reset=""
fi
info() { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()   { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }
warn() { printf "%s ! %s%s\n" "$c_yellow" "$*" "$c_reset" >&2; }
die()  { printf "%sError:%s %s\n" "$c_red" "$c_reset" "$*" >&2; exit 1; }
truthy() { case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in y|yes|true|1|on) return 0 ;; *) return 1 ;; esac; }
interactive() { [[ "${HARMONY_NONINTERACTIVE:-0}" != 1 ]] && { : < /dev/tty; } 2>/dev/null; }
ask() {
	local __var="$1" __q="$2" __def="${3:-}" __ans=""
	if interactive; then
		if [[ -n "$__def" ]]; then read -rp "$__q [$__def]: " __ans < /dev/tty; else read -rp "$__q: " __ans < /dev/tty; fi
	fi
	printf -v "$__var" '%s' "${__ans:-$__def}"
}
ask_yn() { local __a; ask __a "$1 (y/n)" "$2"; truthy "$__a"; }
# consent "question" ENVVAR: explicit yes from the environment, else ask; no
# terminal means no.
consent() {
	local var="$2"
	if [[ -n "${!var:-}" ]]; then truthy "${!var}"; return; fi
	interactive || return 1
	ask_yn "$1" n
}
version_ge() {
	local IFS=. i
	local -a a b
	read -r -a a <<<"$1"; read -r -a b <<<"$2"
	for i in 0 1 2; do
		(( 10#${a[i]:-0} > 10#${b[i]:-0} )) && return 0
		(( 10#${a[i]:-0} < 10#${b[i]:-0} )) && return 1
	done
	return 0
}
is_root() { [[ $(id -u) -eq 0 ]]; }

# --- stage 1: host -------------------------------------------------------------
check_platform() {
	[[ "$(uname -s)" == Linux ]] || die "the installer runs on Linux (a VPS, a home server, a VM). See https://docs.mony.lol/self-hosting for other setups."
	case "$(uname -m)" in
		x86_64|amd64|aarch64|arm64) ;;
		*) truthy "${HARMONY_BUILD:-}" || die "no prebuilt images for $(uname -m) (amd64 and arm64 only); HARMONY_BUILD=1 builds Harmony's images on this machine, if Supabase's run here" ;;
	esac
	local os=""
	# shellcheck disable=SC1091
	[[ -r /etc/os-release ]] && os="$(. /etc/os-release && printf '%s %s' "${NAME:-}" "${VERSION_ID:-}")"
	ok "Linux $(uname -m)${os:+, $os}"
}

pkg_install() {
	if command -v apt-get >/dev/null; then
		DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
	elif command -v dnf >/dev/null; then dnf install -y -q "$@"
	elif command -v yum >/dev/null; then yum install -y -q "$@"
	elif command -v apk >/dev/null; then apk add --no-cache "$@"
	elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --needed "$@"
	elif command -v zypper >/dev/null; then zypper --non-interactive install "$@"
	else return 1
	fi
}

check_tools() {
	local missing=() t
	for t in tar awk sed getent; do command -v "$t" >/dev/null || die "$t is missing; this installer expects a standard Linux userland"; done
	for t in git curl openssl; do command -v "$t" >/dev/null || missing+=("$t"); done
	[[ ${#missing[@]} -eq 0 ]] && return 0
	if is_root && consent "Install ${missing[*]} with the package manager?" HARMONY_INSTALL_PACKAGES; then
		pkg_install "${missing[@]}" ca-certificates || die "could not install ${missing[*]}; install them and re-run"
		for t in "${missing[@]}"; do command -v "$t" >/dev/null || die "$t is still missing; install it and re-run"; done
		ok "Installed ${missing[*]}"
	else
		die "missing: ${missing[*]}. Install them (e.g. apt-get install -y ${missing[*]}) and re-run"
	fi
}

check_docker() {
	if ! command -v docker >/dev/null; then
		warn "Docker is not installed."
		if is_root && consent "Install Docker now with the official script (https://get.docker.com)?" HARMONY_INSTALL_DOCKER; then
			local tmp; tmp="$(mktemp)"
			curl -fsSL https://get.docker.com -o "$tmp" || die "could not download https://get.docker.com"
			sh "$tmp" || die "Docker installation failed; see the output above"
			rm -f "$tmp"
			command -v systemctl >/dev/null && systemctl enable --now docker >/dev/null 2>&1 || true
			ok "Docker installed"
		else
			die "Docker is required: https://docs.docker.com/engine/install/ (or re-run as root and accept the install)"
		fi
	fi
	if ! docker info >/dev/null 2>&1; then
		if docker info 2>&1 | grep -qi 'permission denied'; then
			die "this user cannot use Docker; run the installer as root (… | sudo bash) or join the docker group"
		fi
		die "the Docker daemon is not running; start it (systemctl start docker) and re-run"
	fi
	local cv
	cv="$(docker compose version --short 2>/dev/null | sed 's/^v//; s/[^0-9.].*//')"
	[[ -n "$cv" ]] || die "the Docker Compose plugin is missing: install docker-compose-plugin (Docker's repository) or docker-compose-v2 (Ubuntu), or reinstall Docker with https://get.docker.com"
	version_ge "$cv" "$COMPOSE_MIN" || die "Docker Compose $cv is too old; $COMPOSE_MIN or later is required (upgrade docker-compose-plugin)"
	ok "Docker $(docker version -f '{{.Server.Version}}' 2>/dev/null), Compose $cv"
}

check_memory() {
	local mem swap
	mem="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)"
	swap="$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo)"
	if (( mem < 1900 )); then
		warn "${mem} MB of RAM; Harmony needs 2 GB. Services may be killed under load."
	fi
	if (( swap == 0 && mem < 3900 )); then
		if [[ -e /swapfile ]]; then
			warn "no active swap, and /swapfile exists; enable it: swapon /swapfile"
		elif is_root && consent "${mem} MB RAM and no swap. Create a 2 GB swap file (/swapfile) as a safety margin?" HARMONY_CREATE_SWAP; then
			local free_kb; free_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
			(( free_kb > 6 * 1024 * 1024 )) || die "not enough disk space for a swap file"
			{ fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; } &&
				chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile ||
				die "could not create /swapfile"
			grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
			ok "2 GB swap file active (/swapfile, in /etc/fstab)"
		else
			warn "${mem} MB RAM and no swap; a 2 GB swap file is recommended"
		fi
	else
		ok "${mem} MB RAM, ${swap} MB swap"
	fi
}

check_disk() {
	local dir="$1" free_kb
	while [[ ! -d "$dir" ]]; do dir="$(dirname "$dir")"; done
	free_kb="$(df -Pk "$dir" | awk 'NR==2 {print $4}')"
	if (( free_kb < 4 * 1024 * 1024 )); then
		die "$((free_kb / 1024)) MB free on $(df -P "$dir" | awk 'NR==2 {print $6}'); the images alone take about 4 GB"
	elif (( free_kb < 10 * 1024 * 1024 )); then
		warn "$((free_kb / 1048576)) GB free; 10 GB or more leaves room for uploads and backups"
	else
		ok "$((free_kb / 1048576)) GB free disk"
	fi
}

# Sets DIR to the checkout to install; clones it when absent.
locate_checkout() {
	if [[ -n "$FROM_CHECKOUT" ]]; then
		DIR="$FROM_CHECKOUT"
		ok "Installing the checkout in $DIR"
		return
	fi
	DIR="${HARMONY_DIR:-/opt/harmony}"
	if [[ -d "$DIR/.git" && -f "$DIR/self-host/configure.sh" ]]; then
		ok "Using the existing checkout in $DIR ($(git -C "$DIR" describe --tags --always 2>/dev/null)); harmony update updates it"
		[[ -f "$DIR/self-host/install.sh" ]] || die "$DIR predates this installer; update it first: cd $DIR/self-host && bash update.sh"
		return
	fi
	if [[ -e "$DIR" && -n "$(ls -A "$DIR" 2>/dev/null)" ]]; then
		die "$DIR exists and is not a Harmony checkout; choose another directory: HARMONY_DIR=/path (or --dir)"
	fi
	check_disk "$DIR"
	local parent; parent="$(dirname "$DIR")"
	mkdir -p "$parent" 2>/dev/null && [[ -w "$parent" ]] ||
		die "cannot write to $parent: run the installer as root (curl ... | sudo bash) or set HARMONY_DIR to a directory of yours"
	info "Downloading Harmony into $DIR..."
	git clone -q "$HARMONY_REPO" "$DIR" || die "git clone $HARMONY_REPO failed"
	local ref="${HARMONY_REF:-}" tag
	if [[ -z "$ref" ]]; then
		while read -r tag; do
			[[ -n "$tag" ]] || continue
			if git -C "$DIR" cat-file -e "$tag:self-host/harmony" 2>/dev/null; then ref="$tag"; break; fi
		done < <(git -C "$DIR" tag -l 'v[0-9]*' --sort=-v:refname | grep -v -- - || true)
	fi
	if [[ -n "$ref" ]]; then
		if git -C "$DIR" rev-parse -q --verify "refs/remotes/origin/$ref" >/dev/null; then
			git -C "$DIR" checkout -q "$ref"
		else
			git -C "$DIR" checkout -q --detach "$ref" || die "no tag or branch $ref in $HARMONY_REPO"
		fi
		ok "Harmony $ref"
	else
		ok "Harmony $(git -C "$DIR" rev-parse --abbrev-ref HEAD) (no release ships this installer yet: edge images)"
	fi
}

# --- stage 2: in the checkout --------------------------------------------------
port_in_use() { # PORT tcp|udp
	local flag=-ltn; [[ "$2" == udp ]] && flag=-lun
	if command -v ss >/dev/null; then
		ss -H "$flag" "sport = :$1" 2>/dev/null | grep -q .
	else
		local hex; hex="$(printf ':%04X ' "$1")"
		grep -qi "$hex" "/proc/net/$2" "/proc/net/${2}6" 2>/dev/null
	fi
}

# Docker publishes Harmony's own ports; those are not conflicts on a re-run.
ours() { # PORT
	local id
	for id in $(compose ps -q 2>/dev/null); do
		docker port "$id" 2>/dev/null | grep -qE "[:.]$1\$" && return 0
	done
	return 1
}

check_ports() {
	local spec port proto bad=()
	local -a specs=("${HTTP_PORT}/tcp" "${HTTPS_PORT}/tcp")
	truthy "$VOICE" && specs+=(7881/tcp 7882/udp)
	for spec in "${specs[@]}"; do
		proto="${spec##*/}"; port="${spec%/*}"; port="${port##*:}"
		if port_in_use "$port" "$proto" && ! ours "$port"; then bad+=("$port/$proto"); fi
	done
	if [[ ${#bad[@]} -gt 0 ]]; then
		command -v ss >/dev/null && is_root && ss -ltnup 2>/dev/null | grep -E ":($(printf '%s|' "${bad[@]%/*}" | sed 's/|$//'))\b" >&2 || true
		die "port(s) ${bad[*]} are in use by another program. Stop it (often: systemctl disable --now nginx apache2), or see https://docs.mony.lol/self-hosting#behind-another-reverse-proxy"
	fi
	ok "Ports free: ${specs[*]}"
}

# yn VALUE DEFAULT: y/n for a stored true/false, DEFAULT when unset.
yn() { case "$1" in true|y|yes|1) echo y ;; false|n|no|0) echo n ;; *) echo "$2" ;; esac; }

valid_domain() { [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; }
valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }

questions() {
	local cur
	echo
	if $EXISTING; then
		info "Existing installation: answers default to its configuration; data and secrets are kept."
	else
		info "A few questions. Press Enter to accept the [default]."
	fi
	echo

	cur="${HARMONY_DOMAIN:-$(env_get "$ENV_FILE" DOMAIN)}"
	while :; do
		ask DOMAIN "Domain for your instance (e.g. chat.example.com)" "$cur"
		DOMAIN="$(printf '%s' "$DOMAIN" | lower)"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
		valid_domain "$DOMAIN" && break
		interactive || die "HARMONY_DOMAIN is required: the domain of the instance, e.g. chat.example.com"
		warn "'$DOMAIN' is not a domain name"; cur=""
	done

	cur="${HARMONY_ADMIN_EMAIL:-$(env_get "$ENV_FILE" ADMIN_EMAIL)}"
	while :; do
		ask ADMIN_EMAIL "Admin email (your login; also the Let's Encrypt and push contact)" "$cur"
		ADMIN_EMAIL="$(printf '%s' "${ADMIN_EMAIL#mailto:}" | lower)"
		valid_email "$ADMIN_EMAIL" && break
		interactive || die "HARMONY_ADMIN_EMAIL is required"
		warn "'$ADMIN_EMAIL' is not an email address"; cur=""
	done

	if $ADMIN_EXISTS; then
		ok "An admin account exists; it is left as is"
	else
		cur="${HARMONY_ADMIN_USERNAME:-$(printf '%s' "${ADMIN_EMAIL%%@*}" | lower | tr -cd 'a-z0-9_' | cut -c1-24)}"
		[[ ${#cur} -ge 3 ]] || cur=admin
		while :; do
			ask ADMIN_USERNAME "Admin username (3-24 of a-z 0-9 _)" "$cur"
			ADMIN_USERNAME="$(printf '%s' "$ADMIN_USERNAME" | lower)"
			[[ "$ADMIN_USERNAME" =~ ^[a-z0-9_]{3,24}$ ]] && break
			interactive || die "HARMONY_ADMIN_USERNAME must be 3-24 characters of a-z, 0-9 and _"
			warn "3-24 characters of a-z, 0-9 and _"; cur=""
		done
		ADMIN_PASSWORD="${HARMONY_ADMIN_PASSWORD:-}"
		if [[ -z "$ADMIN_PASSWORD" ]] && interactive; then
			while :; do
				ask_secret ADMIN_PASSWORD "Admin password (8+ characters; Enter generates one)"
				[[ -z "$ADMIN_PASSWORD" ]] && break
				if [[ ${#ADMIN_PASSWORD} -lt 8 ]]; then warn "at least 8 characters"; continue; fi
				local again; ask_secret again "Repeat it"
				[[ "$ADMIN_PASSWORD" == "$again" ]] && break
				warn "the passwords differ"
			done
		fi
		[[ -z "$ADMIN_PASSWORD" || ${#ADMIN_PASSWORD} -ge 8 ]] || die "HARMONY_ADMIN_PASSWORD needs at least 8 characters"
	fi

	cur="${HARMONY_INSTANCE_NAME:-$(env_get "$ENV_FILE" INSTANCE_NAME)}"
	ask INSTANCE_NAME "Instance name (shown in the app; changeable in the admin panel)" "${cur:-Harmony}"

	echo
	info "Voice and video calls need one more DNS name (live.$DOMAIN) and ports 7881/tcp, 7882/udp."
	cur="$(yn "${HARMONY_VOICE:-$(env_get "$ENV_FILE" ENABLE_VOICE)}" y)"
	if ask_yn "Enable voice and video?" "$cur"; then VOICE=y; else VOICE=n; fi

	info "The bot gateway runs bots and Discord bridges."
	cur="$(yn "${HARMONY_BOTS:-$(env_get "$ENV_FILE" ENABLE_BOTS)}" n)"
	truthy "${HARMONY_DISCORD:-}" && cur=y
	if ask_yn "Enable bots?" "$cur"; then BOTS=y; else BOTS=n; fi
	DISCORD=n
	if truthy "$BOTS"; then
		info "Discord bridge hosting: communities paste their Discord bot token in Harmony and this server"
		info "runs their bridge. Without it they run the bridge themselves."
		cur="$(yn "${HARMONY_DISCORD:-$(env_get "$ENV_FILE" ENABLE_DISCORD_BRIDGE)}" n)"
		if ask_yn "Host Discord bridges on this server?" "$cur"; then DISCORD=y; fi
	fi

	echo
	info "Email (SMTP) lets Harmony send password resets and address confirmations."
	info "Without it accounts work, but nobody can reset a forgotten password."
	local smtp_cur; smtp_cur="$(env_get "$SB_ENV" SMTP_HOST)"
	[[ "$smtp_cur" == supabase-mail ]] && smtp_cur=""
	if [[ -n "${HARMONY_SMTP_HOST:-}" ]]; then
		SMTP_HOST="$HARMONY_SMTP_HOST"
	elif interactive && ask_yn "Set up email (SMTP) now?" "$( [[ -n "$smtp_cur" ]] && echo y || echo n)"; then
		ask SMTP_HOST "SMTP server (e.g. smtp.mailgun.org)" "$smtp_cur"
		ask SMTP_PORT "SMTP port" "${HARMONY_SMTP_PORT:-$( [[ -n "$smtp_cur" ]] && env_get "$SB_ENV" SMTP_PORT || echo 587)}"
		ask SMTP_USER "SMTP username" "${HARMONY_SMTP_USER:-$( [[ -n "$smtp_cur" ]] && env_get "$SB_ENV" SMTP_USER)}"
		ask_secret SMTP_PASS "SMTP password${smtp_cur:+ (Enter keeps the current one)}"
		[[ -n "$SMTP_PASS" || -z "$smtp_cur" ]] || SMTP_PASS="$(env_get "$SB_ENV" SMTP_PASS)"
		ask SMTP_SENDER "Sender address" "${HARMONY_SMTP_SENDER:-$( [[ -n "$smtp_cur" ]] && env_get "$SB_ENV" SMTP_ADMIN_EMAIL || echo "noreply@$DOMAIN")}"
		export HARMONY_SMTP_HOST="$SMTP_HOST" HARMONY_SMTP_PORT="$SMTP_PORT" HARMONY_SMTP_USER="$SMTP_USER" \
			HARMONY_SMTP_PASS="$SMTP_PASS" HARMONY_SMTP_SENDER="$SMTP_SENDER"
	fi

	echo
	info "Registration: open = anyone can sign up; invite = only people you invite"
	info "(harmony admin invite EMAIL); closed = no new accounts."
	cur="${HARMONY_REGISTRATION:-$(env_get "$ENV_FILE" REGISTRATION)}"; cur="${cur:-open}"
	while :; do
		ask REGISTRATION "Registration (open/invite/closed)" "$cur"
		REGISTRATION="$(printf '%s' "$REGISTRATION" | lower)"
		case "$REGISTRATION" in open|invite|closed) break ;; invite-only) REGISTRATION=invite; break ;; esac
		interactive || die "HARMONY_REGISTRATION is open, invite or closed"
		warn "open, invite or closed"; cur=open
	done

	TLS="${HARMONY_TLS:-}"
	if [[ -z "$TLS" ]]; then
		if [[ "$(env_get "$ENV_FILE" CADDY_TLS)" == internal ]]; then TLS=internal; else TLS=acme; fi
	fi
	case "$TLS" in acme|internal) ;; *) die "HARMONY_TLS is acme or internal" ;; esac
}

check_dns() {
	local names=("$DOMAIN" "db.$DOMAIN") name a4 bad=() pub
	truthy "$VOICE" && names+=("live.$DOMAIN")
	echo
	info "Checking DNS..."
	pub="$(public_ip4)"
	while :; do
		bad=()
		for name in "${names[@]}"; do
			a4="$(resolve4 "$name" | tr '\n' ' ' | sed 's/ $//')"
			if [[ -z "$a4" ]]; then
				bad+=("$name")
				printf '   %-32s %s\n' "$name" "no A record"
			elif [[ -n "$pub" && " $a4 " != *" $pub "* ]]; then
				bad+=("$name")
				printf '   %-32s %s\n' "$name" "-> $a4 (this server is $pub)"
			else
				printf '   %-32s %s\n' "$name" "-> $a4 ✓"
			fi
		done
		if [[ -z "$pub" ]]; then
			warn "could not determine this server's public IP (set HARMONY_PUBLIC_IP to check DNS against it)"
		fi
		[[ ${#bad[@]} -eq 0 ]] && { ok "DNS points at this server"; return; }

		echo
		warn "Create these records at your DNS provider (type A; with Cloudflare: 'DNS only', grey cloud):"
		for name in "${bad[@]}"; do printf '      A    %-32s %s\n' "$name" "${pub:-<this server public IPv4>}"; done
		echo
		if [[ "$TLS" == internal ]]; then
			warn "Internal TLS: continuing; devices on your network must resolve these names to this server."
			return
		fi
		if ! interactive; then
			warn "Continuing: Caddy obtains the certificates once DNS points here (harmony doctor shows it)."
			return
		fi
		echo "   1) I've created the records, check again (DNS can take a few minutes)"
		echo "   2) This is a LAN / internal server: use Caddy's own certificates (no Let's Encrypt)"
		echo "   3) Continue anyway; certificates follow once DNS is right"
		echo "   4) Quit"
		local choice; ask choice "Choice" 1
		case "$choice" in
			1) sleep 5; continue ;;
			2) TLS=internal; return ;;
			3) return ;;
			*) die "stopped; re-run the installer when DNS is ready" ;;
		esac
	done
}

smtp_shown() {
	local h="${HARMONY_SMTP_HOST:-$(env_get "$SB_ENV" SMTP_HOST)}"
	[[ -n "$h" && "$h" != supabase-mail ]] && echo "$h" || echo "not set up"
}

summary_of_answers() {
	echo
	info "Settings"
	printf '   %-14s %s\n' "URL" "https://$DOMAIN" "Admin" "${ADMIN_USERNAME:-existing} <$ADMIN_EMAIL>" \
		"Name" "$INSTANCE_NAME" "Voice" "$VOICE" "Bots" "$BOTS" "Discord host" "$DISCORD" \
		"Email (SMTP)" "$(smtp_shown)" \
		"Registration" "$REGISTRATION" "TLS" "$( [[ $TLS == internal ]] && echo "internal CA" || echo "Let's Encrypt")" \
		"Directory" "$REPO_DIR"
	if interactive; then
		echo
		ask_yn "Install with these settings?" y || die "stopped; nothing was changed"
	fi
}

install_stack() {
	echo
	export HARMONY_DOMAIN="$DOMAIN" HARMONY_ADMIN_EMAIL="$ADMIN_EMAIL" HARMONY_INSTANCE_NAME="$INSTANCE_NAME" \
		HARMONY_TLS="$TLS" HARMONY_VOICE="$VOICE" HARMONY_BOTS="$BOTS" HARMONY_DISCORD="$DISCORD" \
		HARMONY_REGISTRATION="$REGISTRATION" HARMONY_HTTP_PORT="$HTTP_PORT" HARMONY_HTTPS_PORT="$HTTPS_PORT"
	info "Writing the configuration..."
	bash "$SELF_HOST_DIR/configure.sh" --non-interactive </dev/null

	pull_images
	info "Starting the stack..."
	compose up -d

	bash "$SELF_HOST_DIR/bootstrap.sh"
	# The worker started before harmony_listener existed.
	compose restart federation-worker >/dev/null

	info "Waiting for the services..."
	local svc
	for svc in auth rest kong federation-server; do
		wait_healthy "$svc" || die "$svc did not become healthy: harmony logs $svc"
	done
	ok "Services up"
}

create_admin() {
	ADMIN_RESULT_USER=""; ADMIN_PASSWORD_SHOWN=""
	if bash "$SELF_HOST_DIR/admin.sh" has-admin; then
		ok "Admin account exists"
		return
	fi
	# No admin yet: sign-up stays off until there is one.
	if [[ "$(env_get "$SB_ENV" DISABLE_SIGNUP)" != true ]]; then
		info "Closing sign-up until the admin account exists..."
		env_set "$SB_ENV" DISABLE_SIGNUP true
		compose up -d auth >/dev/null
		wait_healthy auth || die "auth did not restart: harmony logs auth"
	fi
	local generated=false result
	if [[ -z "${ADMIN_PASSWORD:-}" ]]; then ADMIN_PASSWORD="$(gen_password)"; generated=true; fi
	result="$(mktemp)"
	HARMONY_ADMIN_RESULT="$result" HARMONY_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
		bash "$SELF_HOST_DIR/admin.sh" create --email "$ADMIN_EMAIL" --username "$ADMIN_USERNAME" </dev/null
	ADMIN_RESULT_USER="$(sed -n 's/^username=//p' "$result")"
	if [[ "$(sed -n 's/^password_set=//p' "$result")" == true ]]; then
		$generated && ADMIN_PASSWORD_SHOWN="$ADMIN_PASSWORD" || ADMIN_PASSWORD_SHOWN="(the one you entered)"
	else
		ADMIN_PASSWORD_SHOWN="(unchanged: the account existed)"
	fi
	rm -f "$result"
}

link_cli() {
	is_root || return 0
	truthy "${HARMONY_CLI_LINK:-y}" || return 0
	local target=/usr/local/bin/harmony
	if [[ -L "$target" || ! -e "$target" ]]; then
		ln -sfn "$SELF_HOST_DIR/harmony" "$target" && CLI=harmony
	fi
}

final_summary() {
	echo
	printf '%s================================================================%s\n' "$c_green" "$c_reset"
	printf '%s Harmony is running%s\n' "$c_bold" "$c_reset"
	printf '%s================================================================%s\n' "$c_green" "$c_reset"
	printf '   %-16s %s\n' "Open" "https://$DOMAIN"
	if [[ -n "$ADMIN_RESULT_USER" ]]; then
		printf '   %-16s %s  (or @%s)\n' "Admin login" "$ADMIN_EMAIL" "$ADMIN_RESULT_USER"
		printf '   %-16s %s%s%s\n' "Password" "$c_bold" "$ADMIN_PASSWORD_SHOWN" "$c_reset"
		[[ "$ADMIN_PASSWORD_SHOWN" == "("* ]] || printf '   %-16s %s\n' "" "shown once: store it now. New one: $CLI admin reset-password"
	else
		printf '   %-16s %s\n' "Admin login" "the existing admin account (new password: $CLI admin reset-password)"
	fi
	printf '   %-16s %s\n' "Registration" "$REGISTRATION (change: $CLI registration open|invite|closed)"
	printf '   %-16s %s\n' "Admin panel" "in the app: user menu, Admin (instance name, rules, federation)"
	printf '   %-16s %s\n' "Database UI" "https://db.$DOMAIN  user supabase, password in supabase/.env (DASHBOARD_PASSWORD)"
	echo
	printf '   %-16s %s\n' "Secrets" "$SELF_HOST_DIR/{.env,federation.env,supabase/.env,...}"
	printf '   %-16s %s\n' "" "the only copy; '$CLI backup' saves them with the database"
	printf '   %-16s %s\n' "Firewall" "allow 80/tcp, 443/tcp, 443/udp$(truthy "$VOICE" && echo ", 7881/tcp, 7882/udp")"
	if [[ "$TLS" == internal ]]; then
		printf '   %-16s %s\n' "Certificates" "Caddy's own CA: trust its root on each device:"
		printf '   %-16s %s\n' "" "docker compose -f $SELF_HOST_DIR/docker-compose.yml cp caddy:/data/caddy/pki/authorities/local/root.crt ."
	fi
	echo
	printf '   %-16s %s\n' "Check" "$CLI doctor" "Update" "$CLI update" "Back up" "$CLI backup   (copy self-host/backups off this server)" \
		"Restore" "$CLI restore <backup>" "Logs" "$CLI logs [service]" "Change answers" "$CLI config"
	echo
	[[ "$CLI" == harmony ]] || info "harmony is $CLI (no /usr/local/bin link without root)"
	if ! truthy "${HARMONY_SKIP_DOCTOR:-}"; then
		info "Running harmony doctor..."
		bash "$SELF_HOST_DIR/doctor.sh" || true
	fi
}

# --- main ----------------------------------------------------------------------
FROM_CHECKOUT=""
main() {
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--dir) HARMONY_DIR="${2:?--dir needs a path}"; export HARMONY_DIR; shift ;;
			--ref) HARMONY_REF="${2:?--ref needs a tag or branch}"; export HARMONY_REF; shift ;;
			--non-interactive) export HARMONY_NONINTERACTIVE=1 ;;
			-h|--help) sed -n '2,50p' "${BASH_SOURCE[0]:-/dev/null}" 2>/dev/null || echo "see https://docs.mony.lol/self-hosting"; exit 0 ;;
			*) die "unknown argument: $1 (see --help)" ;;
		esac
		shift
	done
	# Under `curl | bash` stdin is this script; prompts read /dev/tty.
	exec </dev/null

	local self="${BASH_SOURCE[0]:-}" here=""
	if [[ -n "$self" && -f "$self" ]]; then
		here="$(cd "$(dirname "$self")/.." && pwd)"
		[[ -f "$here/self-host/lib.sh" && -f "$here/self-host/configure.sh" ]] && FROM_CHECKOUT="$here"
	fi

	if [[ "${HARMONY_INSTALL_STAGE:-}" != 2 ]]; then
		printf '\n%sHarmony installer%s\n\n' "$c_bold" "$c_reset"
		check_platform
		check_tools
		check_docker
		check_memory
		locate_checkout
		if [[ "$DIR" != "$FROM_CHECKOUT" ]]; then
			# Continue in the checkout's installer: its steps match its scripts.
			export HARMONY_INSTALL_STAGE=2
			exec bash "$DIR/self-host/install.sh"
		fi
		check_disk "$DIR"
	fi

	# shellcheck source=lib.sh
	source "$FROM_CHECKOUT/self-host/lib.sh"
	cd "$SELF_HOST_DIR"
	CLI="$SELF_HOST_DIR/harmony"

	EXISTING=false; ADMIN_EXISTS=false
	if [[ -f "$ENV_FILE" ]]; then
		EXISTING=true
		[[ -n "$(svc_id db)" ]] && bash "$SELF_HOST_DIR/admin.sh" has-admin && ADMIN_EXISTS=true
	fi
	HTTP_PORT="${HARMONY_HTTP_PORT:-$(env_get "$ENV_FILE" HARMONY_HTTP_PORT)}"; HTTP_PORT="${HTTP_PORT:-80}"
	HTTPS_PORT="${HARMONY_HTTPS_PORT:-$(env_get "$ENV_FILE" HARMONY_HTTPS_PORT)}"; HTTPS_PORT="${HTTPS_PORT:-443}"

	questions
	check_ports
	check_dns
	summary_of_answers
	install_stack
	create_admin
	bash "$SELF_HOST_DIR/admin.sh" registration "$REGISTRATION"
	link_cli
	final_summary
}

main "$@"; exit
