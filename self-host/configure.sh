#!/usr/bin/env bash
# =============================================================================
# Harmony self-host configurator
# =============================================================================
# Generates every secret and env file the all-in-one stack needs, and
# provisions a trimmed copy of the upstream Supabase Docker stack (edge
# functions + connection pooler removed - Harmony needs neither).
#
# Usage:
#   bash configure.sh                 # interactive
#   bash configure.sh --refresh-supabase   # only re-pull/re-trim Supabase
#
# After this completes:
#   docker compose up -d              # build + start everything
#   bash bootstrap.sh                 # load the DB schema (one time)
#
# Idempotent: existing secrets in .env are reused, so re-running never rotates
# keys (which would lock you out of an existing database).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUPABASE_DIR="$SCRIPT_DIR/supabase"
SUPABASE_REF="${SUPABASE_REF:-master}"   # pin to a tag/commit for reproducibility

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_bold=$'\033[1m'; c_reset=$'\033[0m'
info()  { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()    { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }
warn()  { printf "%s ! %s%s\n" "$c_yellow" "$*" "$c_reset"; }
die()   { printf "Error: %s\n" "$*" >&2; exit 1; }

command -v openssl >/dev/null || die "openssl is required"
command -v git >/dev/null     || die "git is required"
command -v python3 >/dev/null || die "python3 is required (used to trim the Supabase compose)"

# --- helpers -----------------------------------------------------------------
rand_hex()  { openssl rand -hex "${1:-24}"; }
rand_b64()  { openssl rand -base64 "${1:-48}" | tr -d '\n'; }

# HS256 JWT signed with the Supabase JWT secret (same scheme as scripts/install.sh)
sign_jwt() {
	local role="$1" secret="$2" now exp header payload body sig
	now=$(date +%s); exp=$((now + 157680000)) # 5 years
	header=$(printf '{"alg":"HS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
	payload=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$role" "$now" "$exp" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
	body="${header}.${payload}"
	sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -binary | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')
	printf '%s.%s' "$body" "$sig"
}

# Read a KEY=value from an existing env file (so re-runs reuse secrets).
existing() { [[ -f "$1" ]] && sed -n "s/^$2=//p" "$1" | head -1 || true; }

prompt() { # prompt VAR "question" "default"
	local __var="$1" __q="$2" __def="${3:-}" __ans
	if [[ -n "$__def" ]]; then read -rp "$__q [$__def]: " __ans; else read -rp "$__q: " __ans; fi
	printf -v "$__var" '%s' "${__ans:-$__def}"
}

ENV_FILE="$SCRIPT_DIR/.env"
SB_ENV="$SUPABASE_DIR/.env"
FED_ENV="$SCRIPT_DIR/federation.env"
BOT_ENV="$SCRIPT_DIR/bot-gateway.env"

# =============================================================================
if [[ "${1:-}" != "--refresh-supabase" ]]; then
	echo
	info "Harmony self-host configuration"
	echo

	DOMAIN_DEFAULT="$(existing "$ENV_FILE" DOMAIN)"
	prompt DOMAIN "Public domain for your instance (e.g. chat.example.com)" "${DOMAIN_DEFAULT:-}"
	[[ -n "$DOMAIN" ]] || die "A domain is required"

	prompt INSTANCE_NAME "Instance display name" "$(existing "$ENV_FILE" INSTANCE_NAME || true)"
	INSTANCE_NAME="${INSTANCE_NAME:-Harmony}"

	echo
	info "TLS: Caddy can fetch free public certificates (Let's Encrypt) automatically,"
	info "or use its own local CA for LAN/NAS setups without public DNS."
	prompt TLS_CHOICE "Use public HTTPS via Let's Encrypt? (y = needs public DNS + open 80/443, n = local CA)" "y"
	if [[ "$TLS_CHOICE" =~ ^[Yy] ]]; then
		prev_tls="$(existing "$ENV_FILE" CADDY_TLS)"
		[[ "$prev_tls" == internal ]] && prev_tls=""
		prompt ACME_EMAIL "Contact email for Let's Encrypt" "$prev_tls"
		[[ -n "$ACME_EMAIL" ]] || die "An email is required for Let's Encrypt"
		CADDY_TLS="$ACME_EMAIL"
	else
		CADDY_TLS="internal"
		warn "Using Caddy's local CA - browsers will warn unless you trust Caddy's root cert."
	fi

	prompt VOICE_CHOICE "Enable voice/video (LiveKit)?" "n"
	[[ "$VOICE_CHOICE" =~ ^[Yy] ]] && ENABLE_VOICE=true || ENABLE_VOICE=false
	prompt BOTS_CHOICE "Enable the bot gateway (Discord bridge etc.)?" "n"
	[[ "$BOTS_CHOICE" =~ ^[Yy] ]] && ENABLE_BOTS=true || ENABLE_BOTS=false
else
	# refresh mode: reuse existing values
	DOMAIN="$(existing "$ENV_FILE" DOMAIN)"; [[ -n "$DOMAIN" ]] || die "Run a full configure first"
	INSTANCE_NAME="$(existing "$ENV_FILE" INSTANCE_NAME)"; INSTANCE_NAME="${INSTANCE_NAME:-Harmony}"
	CADDY_TLS="$(existing "$ENV_FILE" CADDY_TLS)"; CADDY_TLS="${CADDY_TLS:-internal}"
fi

# --- secrets (reuse existing if present) -------------------------------------
JWT_SECRET="$(existing "$SB_ENV" JWT_SECRET)";                 JWT_SECRET="${JWT_SECRET:-$(rand_b64 48)}"
POSTGRES_PASSWORD="$(existing "$SB_ENV" POSTGRES_PASSWORD)";   POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(rand_hex 24)}"
DASHBOARD_PASSWORD="$(existing "$SB_ENV" DASHBOARD_PASSWORD)"; DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-$(rand_hex 16)}"
SECRET_KEY_BASE="$(existing "$SB_ENV" SECRET_KEY_BASE)";       SECRET_KEY_BASE="${SECRET_KEY_BASE:-$(rand_b64 48)}"
VAULT_ENC_KEY="$(existing "$SB_ENV" VAULT_ENC_KEY)";           VAULT_ENC_KEY="${VAULT_ENC_KEY:-$(rand_hex 16)}"
PG_META_CRYPTO_KEY="$(existing "$SB_ENV" PG_META_CRYPTO_KEY)"; PG_META_CRYPTO_KEY="${PG_META_CRYPTO_KEY:-$(rand_hex 16)}"
REDIS_PASSWORD="$(existing "$ENV_FILE" REDIS_PASSWORD)";       REDIS_PASSWORD="${REDIS_PASSWORD:-$(rand_hex 24)}"
LISTENER_PASSWORD="$(existing "$FED_ENV" __LISTENER_PW)";      LISTENER_PASSWORD="${LISTENER_PASSWORD:-$(rand_hex 24)}"
ANON_KEY="$(sign_jwt anon "$JWT_SECRET")"
SERVICE_ROLE_KEY="$(sign_jwt service_role "$JWT_SECRET")"

# =============================================================================
# Provision the trimmed Supabase stack
# =============================================================================
provision_supabase() {
	local clone="$SCRIPT_DIR/.supabase-src"
	info "Fetching upstream Supabase Docker stack (ref: $SUPABASE_REF)..."
	rm -rf "$clone"
	git clone --depth 1 --branch "$SUPABASE_REF" --filter=blob:none --sparse \
		https://github.com/supabase/supabase "$clone" 2>/dev/null || \
		git clone --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase "$clone"
	( cd "$clone" && git sparse-checkout set docker )

	rm -rf "$SUPABASE_DIR"
	mkdir -p "$SUPABASE_DIR"
	cp -r "$clone/docker/." "$SUPABASE_DIR/"
	rm -rf "$clone"

	info "Trimming Supabase: removing edge-functions + connection pooler..."
	python3 "$SCRIPT_DIR/trim-supabase.py" "$SUPABASE_DIR/docker-compose.yml"
	ok "Supabase stack provisioned at self-host/supabase"
}

if [[ ! -f "$SUPABASE_DIR/docker-compose.yml" || "${1:-}" == "--refresh-supabase" ]]; then
	provision_supabase
else
	info "Reusing existing self-host/supabase (use --refresh-supabase to re-pull)"
fi

# --- Supabase .env -----------------------------------------------------------
# Start from upstream's example, then inject our secrets + public URLs.
cp "$SUPABASE_DIR/.env.example" "$SB_ENV"
python3 - "$SB_ENV" <<PY
import sys, re
path = sys.argv[1]
vals = {
    "JWT_SECRET": r"""$JWT_SECRET""",
    "ANON_KEY": r"""$ANON_KEY""",
    "SERVICE_ROLE_KEY": r"""$SERVICE_ROLE_KEY""",
    "POSTGRES_PASSWORD": r"""$POSTGRES_PASSWORD""",
    "DASHBOARD_PASSWORD": r"""$DASHBOARD_PASSWORD""",
    "SECRET_KEY_BASE": r"""$SECRET_KEY_BASE""",
    "VAULT_ENC_KEY": r"""$VAULT_ENC_KEY""",
    "PG_META_CRYPTO_KEY": r"""$PG_META_CRYPTO_KEY""",
    "SITE_URL": "https://$DOMAIN",
    "API_EXTERNAL_URL": "https://db.$DOMAIN",
    "SUPABASE_PUBLIC_URL": "https://db.$DOMAIN",
    "ADDITIONAL_REDIRECT_URLS": "https://$DOMAIN",
    "ENABLE_EMAIL_AUTOCONFIRM": "true",
    "STUDIO_DEFAULT_PROJECT": "$INSTANCE_NAME",
}
lines = open(path).read().splitlines()
seen = set()
out = []
for ln in lines:
    m = re.match(r"^([A-Z0-9_]+)=", ln)
    if m and m.group(1) in vals:
        k = m.group(1); seen.add(k); out.append(f"{k}={vals[k]}")
    else:
        out.append(ln)
for k, v in vals.items():
    if k not in seen:
        out.append(f"{k}={v}")
open(path, "w").write("\n".join(out) + "\n")
PY
ok "Wrote self-host/supabase/.env"

# --- project .env (consumed by docker-compose.yml) ---------------------------
cat > "$ENV_FILE" <<EOF
# Generated by configure.sh on $(date '+%Y-%m-%d %H:%M:%S') - reused on re-run.
DOMAIN=$DOMAIN
DB_DOMAIN=db.$DOMAIN
LIVEKIT_DOMAIN=live.$DOMAIN
INSTANCE_NAME=$INSTANCE_NAME
CADDY_TLS=$CADDY_TLS

# Frontend build-time config (Vite inlines these into the bundle).
VITE_SUPABASE_URL=https://db.$DOMAIN
VITE_SUPABASE_ANON_KEY=$ANON_KEY
VITE_LIVEKIT_URL=$([[ "${ENABLE_VOICE:-false}" == true ]] && echo "wss://live.$DOMAIN" || echo "")
VITE_ENABLE_FEDERATION=true
VITE_ENABLE_VOICE=${ENABLE_VOICE:-false}
VITE_ENABLE_E2E_ENCRYPTION=true

REDIS_PASSWORD=$REDIS_PASSWORD
EOF
ok "Wrote self-host/.env"

# --- federation backend env --------------------------------------------------
cat > "$FED_ENV" <<EOF
# Generated by configure.sh - federation backend
NODE_ENV=production
INSTANCE_DOMAIN=$DOMAIN
INSTANCE_NAME=$INSTANCE_NAME
API_BASE_URL=https://$DOMAIN
CORS_ORIGIN=https://$DOMAIN

SUPABASE_URL=http://supabase-kong:8000
PUBLIC_SUPABASE_URL=https://db.$DOMAIN
SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY

REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
USE_BULLMQ_QUEUE=true

# Least-privilege LISTEN connection (role provisioned by bootstrap.sh).
FEDERATION_LISTENER_URL=postgresql://harmony_listener:$LISTENER_PASSWORD@supabase-db:5432/postgres

# Internal marker so re-running configure.sh reuses the listener password.
__LISTENER_PW=$LISTENER_PASSWORD
EOF
ok "Wrote self-host/federation.env"

if [[ "${ENABLE_BOTS:-false}" == true ]]; then
	cat > "$BOT_ENV" <<EOF
NODE_ENV=production
SUPABASE_URL=http://supabase-kong:8000
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
PUBLIC_URL=https://db.$DOMAIN
EOF
	ok "Wrote self-host/bot-gateway.env"
fi

echo
ok "Configuration complete."
echo
info "Next steps:"
echo "  1) docker compose up -d            # build + start the whole stack"
echo "  2) bash bootstrap.sh               # load the database schema (one time)"
[[ "${ENABLE_VOICE:-false}" == true ]] && echo "     (voice)  docker compose --profile voice up -d"
[[ "${ENABLE_BOTS:-false}"  == true ]] && echo "     (bots)   docker compose --profile bots up -d"
echo
info "Supabase Studio admin login: user 'supabase', password in self-host/supabase/.env (DASHBOARD_PASSWORD)"
