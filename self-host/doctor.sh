#!/usr/bin/env bash
# =============================================================================
# Harmony doctor: checks an installed instance, each check OK, WARN or FAIL
# with a one-line fix. Exit status 1 when any check FAILs.
#
#   bash doctor.sh [--offline]
#
# --offline skips the checks that need the internet: this host's public
# address (DNS and reachability compare against it) and the latest release.
#
# "From outside" checks request the public URL from this host, through DNS:
# they cover DNS, TLS and the proxy, but a firewall that only filters other
# networks passes them. Behind NAT without hairpinning they fail even when
# the instance is reachable; the local fallback then names that case.
# =============================================================================
set -uo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

OFFLINE=false
for arg in "$@"; do
	case "$arg" in
		--offline) OFFLINE=true ;;
		-h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) die "unknown argument: $arg (see --help)" ;;
	esac
done

N_OK=0; N_WARN=0; N_FAIL=0
report() { # LEVEL "check" "detail" ["fix"]
	local level="$1" check="$2" detail="$3" fix="${4:-}" tag
	case "$level" in
		OK)   tag="${c_green}[ OK ]${c_reset}"; N_OK=$((N_OK + 1)) ;;
		WARN) tag="${c_yellow}[WARN]${c_reset}"; N_WARN=$((N_WARN + 1)) ;;
		FAIL) tag="${c_red}[FAIL]${c_reset}"; N_FAIL=$((N_FAIL + 1)) ;;
	esac
	printf '%s %-14s %s\n' "$tag" "$check" "$detail"
	[[ -z "$fix" || "$level" == OK ]] || printf '       %-14s fix: %s\n' "" "$fix"
}
section() { printf '\n%s%s%s\n' "$c_bold" "$1" "$c_reset"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- context -------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" || ! -f "$FED_ENV" || ! -f "$SB_ENV" ]]; then
	report FAIL config "self-host/.env, federation.env or supabase/.env is missing" "harmony install"
	exit 1
fi
DOMAIN="$(env_get "$ENV_FILE" DOMAIN)"
DB_DOMAIN="$(env_get "$ENV_FILE" DB_DOMAIN)"; DB_DOMAIN="${DB_DOMAIN:-db.$DOMAIN}"
LIVEKIT_DOMAIN="$(env_get "$ENV_FILE" LIVEKIT_DOMAIN)"; LIVEKIT_DOMAIN="${LIVEKIT_DOMAIN:-live.$DOMAIN}"
TLS="$(env_get "$ENV_FILE" CADDY_TLS)"
INTERNAL_TLS=false; [[ "$TLS" == internal ]] && INTERNAL_TLS=true
VOICE=false; truthy "$(env_get "$ENV_FILE" ENABLE_VOICE)" && VOICE=true
BOTS=false; truthy "$(env_get "$ENV_FILE" ENABLE_BOTS)" && BOTS=true
DISCORD=false; truthy "$(env_get "$ENV_FILE" ENABLE_DISCORD_BRIDGE)" && DISCORD=true
VERSION="$(env_get "$ENV_FILE" HARMONY_VERSION)"

# Local entry point: HARMONY_HTTPS_PORT is [address:]port.
https_pub="$(env_get "$ENV_FILE" HARMONY_HTTPS_PORT)"; https_pub="${https_pub:-443}"
LOCAL_PORT="${https_pub##*:}"
LOCAL_ADDR=127.0.0.1
if [[ "$https_pub" == *:* ]]; then
	LOCAL_ADDR="${https_pub%:*}"
	case "$LOCAL_ADDR" in 0.0.0.0|"") LOCAL_ADDR=127.0.0.1 ;; "[::]") LOCAL_ADDR="[::1]" ;; esac
fi

printf '%sHarmony doctor%s  %s  (images %s, TLS %s)\n' "$c_bold" "$c_reset" "https://$DOMAIN" "${VERSION:-?}" "$( $INTERNAL_TLS && echo "internal CA" || echo "Let's Encrypt")"

PUBLIC4=""; PUBLIC6=""
if ! $OFFLINE && command -v curl >/dev/null; then
	PUBLIC4="$(public_ip4)"
	PUBLIC6="$(public_ip6)"
fi

# Caddy's local root, to verify internal certificates.
CA_ARGS=()
if $INTERNAL_TLS && [[ -n "$(svc_id caddy)" ]]; then
	if docker exec "$(svc_id caddy)" cat /data/caddy/pki/authorities/local/root.crt > "$TMP/root.crt" 2>/dev/null; then
		CA_ARGS=(--cacert "$TMP/root.crt")
	fi
fi

# fetch public|local URL OUTFILE [curl args]: HTTP status on stdout ("000"
# when no answer).
fetch() {
	local where="$1" url="$2" outfile="$3" host
	shift 3
	host="${url#https://}"; host="${host%%/*}"
	local -a args=(-sS -o "$outfile" -w '%{http_code}' --max-time 15 -H 'Accept: application/json' "$@")
	if [[ "$where" == local ]]; then
		args+=(--resolve "$host:$LOCAL_PORT:$LOCAL_ADDR")
		url="https://$host:$LOCAL_PORT${url#https://"$host"}"
	fi
	curl "${args[@]}" ${CA_ARGS[@]+"${CA_ARGS[@]}"} "$url" 2>"$outfile.err" || true
}

# --- host ----------------------------------------------------------------------
check_host() {
	section "Host"
	local cv mem avail swap kb_free
	cv="$(compose_version)"
	if version_ge "${cv:-0}" "$COMPOSE_MIN"; then
		report OK compose "Docker Compose $cv"
	else
		report FAIL compose "Docker Compose ${cv:-missing}; $COMPOSE_MIN or later is required" "upgrade the docker-compose-plugin package (or rerun https://get.docker.com)"
	fi

	mem="$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
	avail="$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
	swap="$(awk '/^SwapTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
	if [[ -n "$mem" ]]; then
		if (( mem < 1900 )); then
			report WARN memory "${mem} MB RAM, ${swap} MB swap; 2 GB is the minimum" "a larger server, or swap: harmony install offers a swap file"
		elif (( swap == 0 && mem < 3900 )); then
			report WARN memory "${mem} MB RAM, no swap; a memory peak can kill a service" "add a 2 GB swap file (fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile)"
		elif (( avail < 256 )); then
			report WARN memory "${avail} MB of ${mem} MB available" "check 'docker stats' for the service using it"
		else
			report OK memory "${mem} MB RAM (${avail} MB available), ${swap} MB swap"
		fi
	fi

	local dir mount
	for dir in "$SELF_HOST_DIR" "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)"; do
		[[ -d "$dir" ]] || continue
		mount="$(df -P "$dir" 2>/dev/null | awk 'NR==2 {print $6}')"
		kb_free="$(df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
		local pct; pct="$(df -P "$dir" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
		[[ -n "$kb_free" ]] || continue
		if (( kb_free < 1048576 )); then
			report FAIL disk "$((kb_free / 1024)) MB free on $mount ($dir)" "free space: old backups in self-host/backups, 'docker image prune' for unused images"
		elif (( kb_free < 5242880 || pct > 90 )); then
			report WARN disk "$((kb_free / 1048576)) GB free on $mount, ${pct}% used" "free space before uploads and the database fill it"
		else
			report OK disk "$((kb_free / 1048576)) GB free on $mount"
		fi
		[[ "$mount" == "$(df -P "$SELF_HOST_DIR" | awk 'NR==2 {print $6}')" && "$dir" != "$SELF_HOST_DIR" ]] && break
	done

	local last age
	last="$(latest_backup)"
	if [[ -z "$last" ]]; then
		report WARN backup "no backup in self-host/backups" "harmony backup, then copy it off this machine"
	else
		age=$(( ( $(date +%s) - $(stat -c %Y "$last/manifest") ) / 86400 ))
		if (( age > 7 )); then
			report WARN backup "last backup $age days old ($(basename "$last"))" "harmony backup (a cron job: 0 4 * * * $SELF_HOST_DIR/harmony backup)"
		else
			report OK backup "last backup $(basename "$last") ($age days old)"
		fi
	fi
}

# --- containers ----------------------------------------------------------------
check_containers() {
	section "Containers"
	local svc state health line bad=0 n=0
	local -A seen=()
	while IFS=$'\t' read -r svc state health; do
		[[ -n "$svc" ]] || continue
		seen[$svc]="$state/$health"
	done < <(compose ps --all --format '{{.Service}}\t{{.State}}\t{{.Health}}' 2>/dev/null)
	while read -r svc; do
		[[ -n "$svc" ]] || continue
		n=$((n + 1))
		line="${seen[$svc]:-}"
		state="${line%%/*}"; health="${line#*/}"
		if [[ -z "$line" ]]; then
			report FAIL "$svc" "not created" "docker compose up -d"
			bad=1
		elif [[ "$state" != running ]]; then
			report FAIL "$svc" "$state" "docker compose up -d; then harmony logs $svc"
			bad=1
		elif [[ "$health" == unhealthy ]]; then
			report FAIL "$svc" "running, unhealthy" "harmony logs $svc"
			bad=1
		elif [[ "$health" == starting ]]; then
			report WARN "$svc" "running, health check starting" "wait a minute and re-run"
			bad=1
		fi
	done < <(compose config --services 2>/dev/null)
	(( bad )) || report OK containers "all $n services running"

	# Containers run the image the configuration names.
	local id want have stale=()
	for svc in web federation-server federation-worker bot-gateway; do
		id="$(svc_id "$svc")"; [[ -n "$id" ]] || continue
		want="$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null)"
		have="$(docker inspect -f '{{.Image}}' "$id" 2>/dev/null)"
		[[ "$(docker image inspect -f '{{.Id}}' "$want" 2>/dev/null)" == "$have" ]] || stale+=("$svc")
	done
	if [[ ${#stale[@]} -gt 0 ]]; then
		report WARN images "${stale[*]} run an older image than ${VERSION:-configured}" "docker compose up -d"
	fi
}

# --- database ------------------------------------------------------------------
check_database() {
	section "Database"
	if ! db_ready; then
		report FAIL database "Postgres does not answer" "harmony logs db"
		return
	fi
	local applied files missing=() extra=0 v f
	applied="$(db_sql -c 'SELECT version FROM supabase_migrations.schema_migrations' 2>/dev/null)"
	for f in "$REPO_DIR"/db_schema/migrations/*.sql; do
		v="$(basename "$f")"; v="${v:0:14}"
		grep -qxF "$v" <<<"$applied" || missing+=("$v")
	done
	files="$(ls "$REPO_DIR"/db_schema/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')"
	while read -r v; do
		[[ -n "$v" && ! -e "$(ls "$REPO_DIR/db_schema/migrations/${v}"_*.sql 2>/dev/null | head -1)" ]] && extra=$((extra + 1))
	done <<<"$applied"
	if [[ ${#missing[@]} -gt 0 ]]; then
		report FAIL migrations "${#missing[@]} of $files migrations not applied (first: ${missing[0]})" "bash bootstrap.sh --migrations-only (harmony update does it)"
	elif (( extra > 0 )); then
		report WARN migrations "the database has $extra migration(s) this checkout lacks: the code is older than the database" "harmony update"
	else
		report OK migrations "$files applied, at the checkout's head"
	fi

	local cfg_domain
	cfg_domain="$(db_sql -c "SELECT config_value #>> '{}' FROM public.instance_config WHERE config_key = 'domain'" 2>/dev/null)"
	if [[ "$cfg_domain" == "$DOMAIN" ]]; then
		report OK domain "instance_config.domain = $DOMAIN"
	elif [[ -z "$cfg_domain" || "$cfg_domain" == localhost ]]; then
		report FAIL domain "instance_config.domain is '${cfg_domain:-unset}'" "bash bootstrap.sh"
	else
		report FAIL domain "instance_config.domain is $cfg_domain, .env has $DOMAIN: handles and ActivityPub ids disagree" "set one of them to the other (Admin, Instance; or HARMONY_DOMAIN=$cfg_domain harmony config)"
	fi

	local admins
	admins="$(db_sql -c 'SELECT count(*) FROM public.profiles WHERE is_local AND is_admin' 2>/dev/null)"
	if [[ "$admins" =~ ^[1-9] ]]; then
		ADMIN_USER="$(db_sql -c 'SELECT username FROM public.profiles WHERE is_local AND is_admin ORDER BY created_at LIMIT 1' 2>/dev/null)"
		report OK admin "$admins admin(s), first: @$ADMIN_USER"
	else
		report WARN admin "no admin account" "harmony admin create"
	fi

	local policy disable live open_reg
	policy="$(env_get "$ENV_FILE" REGISTRATION)"; policy="${policy:-open}"
	live="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(svc_id auth)" 2>/dev/null | sed -n 's/^GOTRUE_DISABLE_SIGNUP=//p')"
	open_reg="$(db_sql -c "SELECT config_value #>> '{}' FROM public.instance_config WHERE config_key = 'open_registration'" 2>/dev/null)"
	if [[ "$policy" == open ]]; then disable=false; else disable=true; fi
	if [[ "$live" == "$disable" && "$open_reg" == "$( [[ $disable == true ]] && echo false || echo true)" ]]; then
		report OK registration "$policy"
	else
		report WARN registration ".env says $policy; sign-up disabled=${live:-?}, open_registration=${open_reg:-?}" "harmony registration $policy"
	fi

	if db_sql -c "SELECT 1 FROM pg_roles WHERE rolname = 'harmony_listener'" 2>/dev/null | grep -q 1; then
		report OK listener "harmony_listener role exists"
	else
		report WARN listener "no harmony_listener role: queued jobs wait for the periodic sweep" "bash bootstrap.sh && docker compose restart federation-worker"
	fi
}

# --- DNS and TLS ---------------------------------------------------------------
check_dns() {
	section "DNS"
	local name a4 a6 level
	$INTERNAL_TLS && level=WARN || level=FAIL
	if [[ -z "$PUBLIC4" ]]; then
		$OFFLINE || report WARN "public IP" "could not determine this server's public address" "HARMONY_PUBLIC_IP=x.x.x.x harmony doctor"
	fi
	while read -r name; do
		[[ -n "$name" ]] || continue
		a4="$(resolve4 "$name" | tr '\n' ' ' | sed 's/ $//')"
		a6="$(resolve6 "$name" | tr '\n' ' ' | sed 's/ $//')"
		if [[ -z "$a4" && -z "$a6" ]]; then
			report "$level" "$name" "no DNS record" "create: A $name -> ${PUBLIC4:-<this server address>}"
		elif [[ -n "$PUBLIC4" && " $a4 " != *" $PUBLIC4 "* ]]; then
			report "$level" "$name" "points to ${a4:-$a6}, this server is $PUBLIC4" "set: A $name -> $PUBLIC4 (DNS only, not proxied, while certificates are issued)"
		elif [[ -n "$a6" && -n "$PUBLIC6" && " $a6 " != *" $PUBLIC6 "* ]]; then
			report WARN "$name" "AAAA $a6, this server's IPv6 is $PUBLIC6" "set: AAAA $name -> $PUBLIC6, or remove the AAAA record"
		elif [[ -n "$a6" && -z "$PUBLIC6" && -n "$PUBLIC4" ]]; then
			report WARN "$name" "has AAAA $a6 but this server has no public IPv6: Let's Encrypt tries IPv6 first" "remove the AAAA record of $name"
		else
			report OK "$name" "${a4:-$a6}"
		fi
	done < <(instance_names)
}

check_tls() {
	section "TLS certificates"
	local name end days issuer cert
	while read -r name; do
		[[ -n "$name" ]] || continue
		cert=""
		if ! $INTERNAL_TLS && [[ -n "$(resolve4 "$name")" ]]; then
			cert="$(timeout 15 openssl s_client -connect "$name:443" -servername "$name" </dev/null 2>/dev/null | openssl x509 2>/dev/null)"
		fi
		if [[ -z "$cert" ]]; then
			cert="$(timeout 15 openssl s_client -connect "$LOCAL_ADDR:$LOCAL_PORT" -servername "$name" </dev/null 2>/dev/null | openssl x509 2>/dev/null)"
		fi
		if [[ -z "$cert" ]]; then
			report FAIL "$name" "no certificate served" "harmony logs caddy (Let's Encrypt needs DNS and ports 80/443 reaching this server)"
			continue
		fi
		end="$(printf '%s\n' "$cert" | openssl x509 -noout -enddate | sed 's/^notAfter=//')"
		issuer="$(printf '%s\n' "$cert" | openssl x509 -noout -issuer | sed 's/^issuer= *//')"
		days=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
		if [[ "$issuer" == *"Caddy Local Authority"* ]]; then
			if $INTERNAL_TLS; then
				report OK "$name" "Caddy's internal CA (short-lived, renewed by Caddy; devices must trust its root)"
			else
				report FAIL "$name" "served by Caddy's internal CA, not Let's Encrypt" "check DNS and ports 80/443, then harmony logs caddy"
			fi
		elif (( days < 7 )); then
			report FAIL "$name" "expires in $days days ($issuer)" "harmony logs caddy: renewal is failing"
		elif (( days < 21 )); then
			report WARN "$name" "expires in $days days; Caddy renews 30 days ahead" "harmony logs caddy"
		else
			report OK "$name" "valid $days more days ($(printf '%s' "$issuer" | sed -n 's/.*O *= *\([^,]*\).*/\1/p'))"
		fi
	done < <(instance_names)
}

# --- federation and services ---------------------------------------------------
# probe "check" PATH VALIDATOR-REGEX FIX: public first, then local.
probe() {
	local check="$1" path="$2" expect="$3" fix="$4" code where
	if ! $INTERNAL_TLS && [[ -n "$(resolve4 "$DOMAIN")$(resolve6 "$DOMAIN")" ]]; then
		code="$(fetch public "https://$DOMAIN$path" "$TMP/body")"
		if [[ "$code" == 200 ]] && grep -qE "$expect" "$TMP/body"; then
			report OK "$check" "https://$DOMAIN$path"
			return
		fi
	fi
	code="$(fetch local "https://$DOMAIN$path" "$TMP/body")"
	where="https://$DOMAIN$path"
	if [[ "$code" == 200 ]] && grep -qE "$expect" "$TMP/body"; then
		if $INTERNAL_TLS; then
			report OK "$check" "$where (internal TLS; checked through $LOCAL_ADDR:$LOCAL_PORT)"
		else
			report FAIL "$check" "answers on this server but not at $where from here" "DNS of $DOMAIN, the firewall (80/443) or NAT"
		fi
	else
		report FAIL "$check" "$where: HTTP $code $(head -c 120 "$TMP/body" 2>/dev/null | tr -d '\n')$(head -c 120 "$TMP/body.err" 2>/dev/null | tr -d '\n')" "$fix"
	fi
}

check_federation() {
	section "Federation (the public URL)"
	if [[ -n "${ADMIN_USER:-}" ]]; then
		probe webfinger "/.well-known/webfinger?resource=acct:$ADMIN_USER@$DOMAIN" "\"subject\" *: *\"acct:$ADMIN_USER@$DOMAIN\"" \
			"harmony logs federation-server; harmony logs caddy"
	else
		report WARN webfinger "skipped: no admin account to look up" "harmony admin create"
	fi
	probe nodeinfo "/.well-known/nodeinfo" '"links"' "harmony logs federation-server; harmony logs caddy"
	probe instance-info "/api/federation/instance-info" "\"supabaseUrl\" *: *\"https://$DB_DOMAIN\"" \
		"Caddy must strip /api/federation; PUBLIC_SUPABASE_URL in federation.env must be https://$DB_DOMAIN"
}

check_services() {
	section "Services"
	local vpub vpriv vsubj code
	vpub="$(env_get "$FED_ENV" VAPID_PUBLIC_KEY)"; vpriv="$(env_get "$FED_ENV" VAPID_PRIVATE_KEY)"; vsubj="$(env_get "$FED_ENV" VAPID_SUBJECT)"
	if [[ ${#vpub} -ne 87 || ${#vpriv} -ne 43 || -z "$vsubj" ]]; then
		report FAIL push "VAPID keys or subject missing in federation.env" "bash configure.sh --non-interactive (generates them), then docker compose up -d"
	else
		code="$(fetch local "https://$DOMAIN/api/federation/push/vapid-key" "$TMP/vapid")"
		if [[ "$code" == 200 ]] && grep -q "$vpub" "$TMP/vapid"; then
			report OK push "VAPID configured (subject $vsubj)"
		else
			report FAIL push "the backend does not serve the VAPID key (HTTP $code)" "docker compose up -d federation-server; harmony logs federation-server"
		fi
	fi

	local smtp port
	smtp="$(env_get "$SB_ENV" SMTP_HOST)"; port="$(env_get "$SB_ENV" SMTP_PORT)"
	if [[ -z "$smtp" || "$smtp" == supabase-mail ]]; then
		report WARN email "no SMTP server: password reset and email confirmation do not work" "harmony config (answer y to SMTP)"
	elif timeout 6 bash -c "exec 3<>/dev/tcp/$smtp/${port:-587}" 2>/dev/null; then
		report OK email "SMTP $smtp:${port:-587} reachable"
	else
		report WARN email "SMTP $smtp:${port:-587} does not accept connections from this server" "check the host and port; many VPS providers block outgoing 25/587 until asked"
	fi

	code="$(fetch local "https://$DB_DOMAIN/auth/v1/health" "$TMP/auth" -H "apikey: $(env_get "$ENV_FILE" SUPABASE_ANON_KEY)")"
	if [[ "$code" == 200 ]]; then
		report OK auth "https://$DB_DOMAIN/auth/v1/health"
	else
		report FAIL auth "https://$DB_DOMAIN/auth/v1/health: HTTP $code" "harmony logs auth; harmony logs kong"
	fi

	if $BOTS; then
		probe bot-gateway "/bot-gateway/health" '"status" *: *"ok"' "harmony logs bot-gateway"
	fi

	if $DISCORD; then
		local s1 s2
		s1="$(env_get "$BOT_ENV" BRIDGE_HOST_SECRET)"; s2="$(env_get "$BRIDGE_ENV" BRIDGE_HOST_SECRET)"
		if [[ ${#s1} -lt 32 || "$s1" != "$s2" ]]; then
			report FAIL discord "BRIDGE_HOST_SECRET differs between bot-gateway.env and discord-bridge.env" "bash configure.sh --non-interactive, then docker compose up -d"
		elif [[ -z "$(svc_id discord-bridge-host)" ]]; then
			report FAIL discord "discord-bridge-host is not running" "docker compose up -d; harmony logs discord-bridge-host"
		else
			report OK discord "bridge host running; enable hosting in Admin, Instance"
		fi
	fi

	if $VOICE; then
		check_voice
	fi
}

check_voice() {
	local key secret yaml="$SELF_HOST_DIR/livekit.yaml" code pub addr
	key="$(env_get "$FED_ENV" LIVEKIT_API_KEY)"; secret="$(env_get "$FED_ENV" LIVEKIT_API_SECRET)"
	if [[ ! -f "$yaml" ]]; then
		report FAIL livekit "self-host/livekit.yaml is missing" "bash configure.sh --non-interactive"
		return
	fi
	if ! grep -q "^  $key: $secret\$" "$yaml"; then
		report FAIL livekit "livekit.yaml lacks LIVEKIT_API_KEY/SECRET of federation.env" "delete self-host/livekit.yaml, run bash configure.sh --non-interactive, docker compose up -d"
	elif [[ -z "$(env_get "$FED_ENV" LIVEKIT_URL)" || -z "$(env_get "$FED_ENV" LIVEKIT_PUBLIC_URL)" ]]; then
		report FAIL livekit "LIVEKIT_URL / LIVEKIT_PUBLIC_URL missing in federation.env" "bash configure.sh --non-interactive, docker compose up -d"
	else
		code="$(fetch local "https://$DOMAIN/api/livekit/health" "$TMP/lk")"
		if [[ "$code" == 200 ]] && grep -q '"healthy"' "$TMP/lk"; then
			report OK livekit "the backend reaches LiveKit"
		else
			report FAIL livekit "the backend cannot use LiveKit (HTTP $code: $(head -c 100 "$TMP/lk" 2>/dev/null))" "harmony logs livekit"
		fi
	fi

	code="$(fetch local "https://$LIVEKIT_DOMAIN/" "$TMP/lkroot")"
	if [[ "$code" == 200 ]]; then
		report OK signalling "https://$LIVEKIT_DOMAIN answers"
	else
		report FAIL signalling "https://$LIVEKIT_DOMAIN: HTTP $code" "harmony logs caddy; harmony logs livekit"
	fi

	# Media ports. TCP is tried against the published address (the public one
	# when bound to all interfaces); UDP cannot be probed from here.
	pub="$(compose port livekit 7881 2>/dev/null | head -1)"
	addr="${pub%:*}"; addr="${addr:-0.0.0.0}"
	case "$addr" in 0.0.0.0|"[::]"|::) addr="${PUBLIC4:-127.0.0.1}" ;; esac
	if [[ -n "$pub" ]] && timeout 6 bash -c "exec 3<>/dev/tcp/$addr/${pub##*:}" 2>/dev/null; then
		report OK "media tcp" "$addr:${pub##*:} accepts connections"
	else
		report WARN "media tcp" "${addr}:${pub##*:} (7881/tcp) not reachable from this server" "open 7881/tcp in the firewall (ufw allow 7881/tcp) and at the provider; test from another machine: nc -vz $addr 7881"
	fi
	local fw=""
	if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
		ufw status 2>/dev/null | grep -qE '^7882(/udp)?[[:space:]]+ALLOW' && fw=ok || fw=blocked
	fi
	if [[ "$fw" == blocked ]]; then
		report WARN "media udp" "ufw is active without a rule for 7882/udp" "ufw allow 7882/udp"
	else
		report OK "media udp" "7882/udp published$( [[ -n "$fw" ]] && echo ", allowed by ufw"); also open it at the provider's firewall"
	fi
}

# --- versions ------------------------------------------------------------------
check_versions() {
	section "Versions"
	local latest pinned cur
	if ! $OFFLINE; then
		latest="$(latest_release)"
		if [[ -z "$latest" ]]; then
			report WARN release "could not reach GitHub to compare versions" ""
		elif [[ "$VERSION" == edge ]]; then
			report OK release "edge channel (master); latest release ${latest}"
		elif [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && ! version_ge "$VERSION" "${latest#v}"; then
			report WARN release "running $VERSION, release ${latest} is available" "harmony update"
		else
			report OK release "running ${VERSION}; latest release ${latest}"
		fi
	fi
	pinned="$(sed -n 's/^SUPABASE_REF_DEFAULT=//p' "$SELF_HOST_DIR/configure.sh")"
	cur="$(cat "$SELF_HOST_DIR/supabase/.harmony-supabase-ref" 2>/dev/null)"
	if [[ -n "$cur" && "$cur" != "$pinned" ]]; then
		report WARN supabase "stack at ${cur:0:12}, this release pins ${pinned:0:12}" "harmony backup, then bash configure.sh --refresh-supabase && docker compose up -d"
	else
		report OK supabase "stack at ${cur:0:12} (pinned)"
	fi
}

# --- security ------------------------------------------------------------------
# Baseline of the pinned stack (supabase/postgres:15.8.1.060 with every service
# started once, plus harmony_listener). pgsodium_trg_mask_update is pgsodium's own
# trigger on older Supabase images. A known automated attack on exposed
# Postgres plants an event trigger whose function creates a superuser whenever
# an admin runs DDL; these checks look for its traces and for the exposure.
SEC_EVENT_TRIGGERS="graphql_watch_ddl=graphql.increment_schema_version
graphql_watch_drop=graphql.increment_schema_version
issue_graphql_placeholder=extensions.set_graphql_placeholder
issue_pg_cron_access=extensions.grant_pg_cron_access
issue_pg_graphql_access=extensions.grant_pg_graphql_access
issue_pg_net_access=extensions.grant_pg_net_access
pgrst_ddl_watch=extensions.pgrst_ddl_watch
pgrst_drop_watch=extensions.pgrst_drop_watch
pgsodium_trg_mask_update=pgsodium.trg_mask_update"
SEC_LOGIN_ROLES="authenticator harmony_listener pgbouncer postgres supabase_admin supabase_auth_admin supabase_functions_admin supabase_read_only_user supabase_replication_admin supabase_storage_admin"
# Host ports of Postgres, Supavisor, the Supabase CLI's Postgres, Kong,
# Logflare and Redis; none is published by this stack.
SEC_PORTS="5432 6543 54322 8000 8443 4000 6379"
SEC_FN_PATTERN='(create|alter)[[:space:]]+(role|user)|superuser|copy[[:space:]][^;]*[[:space:]]program|pg_read_server_files|pg_execute_server_program|lo_import|dblink_exec'

check_security() {
	section "Security"
	if ! db_ready; then
		report FAIL database "Postgres does not answer; security checks skipped" "harmony logs db"
		return
	fi
	local rows r bad=() list

	rows="$(db_sql -c "SELECT e.evtname || '=' || n.nspname || '.' || p.proname
		FROM pg_event_trigger e JOIN pg_proc p ON p.oid = e.evtfoid
		JOIN pg_namespace n ON n.oid = p.pronamespace ORDER BY 1" 2>/dev/null)"
	while read -r r; do
		[[ -n "$r" ]] || continue
		grep -qxF "$r" <<<"$SEC_EVENT_TRIGGERS" || bad+=("${r%%=*} -> ${r#*=}()")
	done <<<"$rows"
	if [[ ${#bad[@]} -gt 0 ]]; then
		report FAIL "event triggers" "not Supabase's: ${bad[*]}" \
			"unless you made them: DROP EVENT TRIGGER <name>; DROP FUNCTION <function>; then check roles below and restore from a backup older than them (docs: self-hosting#security)"
	else
		report OK "event triggers" "only Supabase's"
	fi

	bad=()
	rows="$(db_sql -c "SELECT rolname FROM pg_roles WHERE rolsuper ORDER BY 1" 2>/dev/null)"
	while read -r r; do
		[[ -n "$r" && "$r" != supabase_admin ]] || continue
		bad+=("$r")
	done <<<"$rows"
	if [[ " ${bad[*]} " == " postgres " ]]; then
		report WARN superusers "postgres is a superuser; it is not on the pinned image (supabase/postgres:15.8.1.060)" \
			"if your Supabase stack is not the pinned one, expected; otherwise: ALTER ROLE postgres NOSUPERUSER"
	elif [[ ${#bad[@]} -gt 0 ]]; then
		report FAIL superusers "${bad[*]} (only supabase_admin is expected)" \
			"unless you made them: DROP ROLE <name>; as supabase_admin (docker compose exec db psql -U supabase_admin -h 127.0.0.1)"
	else
		report OK superusers "supabase_admin only"
	fi

	bad=()
	rows="$(db_sql -c "SELECT rolname FROM pg_roles WHERE rolcanlogin ORDER BY 1" 2>/dev/null)"
	while read -r r; do
		[[ -n "$r" ]] || continue
		[[ " $SEC_LOGIN_ROLES " == *" $r "* ]] || bad+=("$r")
	done <<<"$rows"
	if [[ ${#bad[@]} -gt 0 ]]; then
		report FAIL "login roles" "unexpected: ${bad[*]}" \
			"unless you made them: ALTER ROLE <name> NOLOGIN, find how they appeared, then DROP ROLE"
	else
		report OK "login roles" "only the stack's"
	fi

	list="$(db_sql -c "SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY 1)
		FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
		WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND p.prosrc ~* '$SEC_FN_PATTERN'
		  AND (n.nspname, p.proname) <> ('extensions', 'grant_pg_net_access')
		  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
		                    AND d.objid = p.oid AND d.deptype = 'e')" 2>/dev/null)"
	if [[ -n "$list" ]]; then
		report WARN functions "bodies that manage roles or reach the server's files or programs: $list" \
			"read each (\\sf name in psql); drop any you did not write"
	else
		report OK functions "none manage roles or reach server files"
	fi

	list="$(db_sql -c "SELECT string_agg(x, ', ' ORDER BY x) FROM (
		SELECT lanname AS x FROM pg_language WHERE NOT lanpltrusted AND lanname NOT IN ('internal', 'c')
		UNION SELECT extname FROM pg_extension
		 WHERE extname IN ('dblink', 'adminpack', 'file_fdw', 'plpython3u', 'plperlu', 'pltclu')) s" 2>/dev/null)"
	if [[ -n "$list" ]]; then
		report WARN extensions "installed: $list (run code or reach files as the server)" "unless you need them: DROP EXTENSION <name>"
	else
		report OK extensions "no untrusted languages or risky extensions"
	fi

	if [[ "$(db_sql -c "SELECT count(*) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
		WHERE d.datname = current_database() AND s.setrole = 0
		  AND EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'app.settings.jwt\_secret=%')" 2>/dev/null)" != 0 ]]; then
		report WARN "jwt secret" "app.settings.jwt_secret is a database default: any session can read the JWT secret" \
			"bash bootstrap.sh --migrations-only (removes it)"
	else
		report OK "jwt secret" "not stored in the database settings"
	fi

	local key ex cur weak=()
	for key in POSTGRES_PASSWORD JWT_SECRET DASHBOARD_PASSWORD; do
		ex="$(env_get "$SELF_HOST_DIR/supabase/.env.example" "$key")"
		cur="$(env_get "$SB_ENV" "$key")"
		[[ -z "$cur" || ( -n "$ex" && "$cur" == "$ex" ) ]] && weak+=("$key")
	done
	if [[ ${#weak[@]} -gt 0 ]]; then
		report FAIL secrets "supabase/.env keeps Supabase's example value for ${weak[*]}" \
			"replace them with random values (docs: self-hosting#security); configure.sh generates them on a new install"
	else
		report OK secrets "Supabase secrets are not the example values"
	fi

	check_exposure
}

# Ports of SEC_PORTS published beyond loopback by Docker, and answering on the
# public address. A Docker-published port bypasses ufw/firewalld rules.
check_exposure() {
	local ours id name ports item addr port ip p who
	local -a items hits=() others=() open=()
	local -A owner=()
	ours=" $(compose ps -aq 2>/dev/null | tr '\n' ' ') "
	while IFS=$'\t' read -r id name ports; do
		[[ -n "$ports" ]] || continue
		IFS=',' read -r -a items <<<"$ports"
		for item in "${items[@]}"; do
			item="${item# }"
			[[ "$item" == *"->"* ]] || continue
			item="${item%%->*}"; port="${item##*:}"; addr="${item%:*}"
			[[ " $SEC_PORTS " == *" $port "* ]] || continue
			case "$addr" in 127.*|"[::1]"|::1) continue ;; esac
			owner[$port]="$name"
			if [[ "$ours" == *" $id "* ]]; then hits+=("$name $addr:$port"); else others+=("$name $addr:$port"); fi
		done
	done < <(docker ps --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.Ports}}' 2>/dev/null)
	if [[ ${#hits[@]} -gt 0 ]]; then
		report FAIL published "$(printf '%s, ' "${hits[@]}" | sed 's/, $//') published on every interface" \
			"remove those ports: entries from the compose files (only Caddy and LiveKit publish ports); docker compose up -d"
	else
		report OK published "no database, Kong, Logflare or Redis port published by this stack"
	fi
	if [[ ${#others[@]} -gt 0 ]]; then
		report WARN "other containers" "on this host publish $(printf '%s, ' "${others[@]}" | sed 's/, $//')" \
			"bind them to 127.0.0.1 or stop them: Docker-published ports bypass ufw"
	fi

	if $OFFLINE || [[ -z "$PUBLIC4$PUBLIC6" ]]; then
		$OFFLINE || report WARN reachable "public address unknown; ports not probed" "HARMONY_PUBLIC_IP=x.x.x.x harmony doctor"
		return
	fi
	local out="$TMP/ports"; : > "$out"
	for ip in $PUBLIC4 $PUBLIC6; do
		for p in $SEC_PORTS; do
			( timeout 3 bash -c "exec 3<>/dev/tcp/$ip/$p" 2>/dev/null && printf '%s %s\n' "$ip" "$p" >> "$out" ) &
		done
	done
	wait
	while read -r ip p; do
		[[ -n "$p" ]] || continue
		[[ "$ip" == *:* ]] && ip="[$ip]"
		who="${owner[$p]:-a process on the host, not Docker}"
		open+=("$ip:$p ($who)")
	done < <(sort -u "$out")
	if [[ ${#open[@]} -gt 0 ]]; then
		report FAIL reachable "listening on the public address (tried from this server): $(printf '%s, ' "${open[@]}" | sed 's/, $//')" \
			"unpublish or stop them, and block them at the provider's firewall; Postgres must never face the internet"
	else
		report OK reachable "$SEC_PORTS closed on ${PUBLIC4}${PUBLIC6:+ and $PUBLIC6}"
	fi
}

ADMIN_USER=""
check_host
check_containers
check_database
check_dns
check_tls
check_federation
check_services
check_security
check_versions

echo
printf '%s%d OK, %d WARN, %d FAIL%s\n' "$c_bold" "$N_OK" "$N_WARN" "$N_FAIL" "$c_reset"
[[ $N_FAIL -eq 0 ]]
