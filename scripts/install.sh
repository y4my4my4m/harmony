#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Harmony Interactive Installer
# =============================================================================
# Pure bash, no external dependencies. ANSI-styled TUI with colors, spinners,
# and Unicode box-drawing for a modern installer feel.
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Color & style constants
# ---------------------------------------------------------------------------
BOLD='\033[1m'
DIM='\033[2m'
UNDERLINE='\033[4m'
RESET='\033[0m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
BRED='\033[1;31m'
BGREEN='\033[1;32m'
BYELLOW='\033[1;33m'
BCYAN='\033[1;36m'

CHECK="${BGREEN}✓${RESET}"
CROSS="${BRED}✗${RESET}"
ARROW="${BCYAN}▸${RESET}"
DOT="${DIM}·${RESET}"

# ---------------------------------------------------------------------------
# State variables (filled during interactive prompts)
# ---------------------------------------------------------------------------
MODE=""               # "production" | "local"
INSTANCE_NAME=""
DOMAIN=""
LIVEKIT_SUBDOMAIN=""

SUPABASE_MODE=""      # "cloud" | "selfhosted"
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
SUPABASE_SERVICE_KEY=""
DATABASE_URL=""

ENABLE_FEDERATION=true
ENABLE_VOICE=true
ENABLE_BOTS=false

LIVEKIT_API_KEY=""
LIVEKIT_API_SECRET=""

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------
print_line() {
    local width=${1:-60}
    printf "${DIM}"
    printf '%.0s─' $(seq 1 "$width")
    printf "${RESET}\n"
}

print_box() {
    local title="$1"
    local width=60
    local title_len=${#title}
    local pad=$(( (width - title_len - 2) / 2 ))
    local pad_right=$(( width - title_len - 2 - pad ))

    echo ""
    printf "${CYAN}╭"
    printf '%.0s─' $(seq 1 "$width")
    printf "╮${RESET}\n"

    printf "${CYAN}│${RESET}"
    printf "%${pad}s" ""
    printf "${BOLD}${WHITE} %s ${RESET}" "$title"
    printf "%${pad_right}s" ""
    printf "${CYAN}│${RESET}\n"

    printf "${CYAN}╰"
    printf '%.0s─' $(seq 1 "$width")
    printf "╯${RESET}\n"
    echo ""
}

print_step() {
    local step_num="$1"
    local step_title="$2"
    echo ""
    printf "  ${BCYAN}[%s]${RESET} ${BOLD}%s${RESET}\n" "$step_num" "$step_title"
    print_line 50
}

print_info() {
    printf "  ${DIM}%s${RESET}\n" "$1"
}

print_success() {
    printf "  ${CHECK} %s\n" "$1"
}

print_warn() {
    printf "  ${BYELLOW}⚠${RESET} %s\n" "$1"
}

print_error() {
    printf "  ${CROSS} %s\n" "$1"
}

# Prompt for text input with a default value
prompt_input() {
    local prompt_text="$1"
    local default="$2"
    local result

    if [[ -n "$default" ]]; then
        printf "  ${ARROW} ${BOLD}%s${RESET} ${DIM}[%s]${RESET}: " "$prompt_text" "$default"
    else
        printf "  ${ARROW} ${BOLD}%s${RESET}: " "$prompt_text"
    fi
    read -r result
    if [[ -z "$result" ]]; then
        result="$default"
    fi
    echo "$result"
}

# Prompt for yes/no with a default
prompt_yn() {
    local prompt_text="$1"
    local default="$2"  # "y" or "n"
    local hint
    if [[ "$default" == "y" ]]; then
        hint="Y/n"
    else
        hint="y/N"
    fi

    printf "  ${ARROW} ${BOLD}%s${RESET} ${DIM}[%s]${RESET}: " "$prompt_text" "$hint"
    read -r answer
    answer="${answer:-$default}"
    [[ "${answer,,}" == "y" || "${answer,,}" == "yes" ]]
}

# Prompt for numbered choice
prompt_choice() {
    local prompt_text="$1"
    shift
    local options=("$@")

    echo ""
    printf "  ${BOLD}%s${RESET}\n" "$prompt_text"
    echo ""
    for i in "${!options[@]}"; do
        printf "    ${BCYAN}%d)${RESET} %s\n" "$((i + 1))" "${options[$i]}"
    done
    echo ""

    local choice
    while true; do
        printf "  ${ARROW} ${BOLD}Choose${RESET} ${DIM}[1-%d]${RESET}: " "${#options[@]}"
        read -r choice
        if [[ "$choice" =~ ^[0-9]+$ ]] && (( choice >= 1 && choice <= ${#options[@]} )); then
            return $((choice - 1))
        fi
        printf "  ${RED}Invalid choice. Try again.${RESET}\n"
    done
}

# Animated spinner for background tasks
spinner() {
    local pid=$1
    local msg="$2"
    local spin_chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0

    tput civis 2>/dev/null || true  # hide cursor
    while kill -0 "$pid" 2>/dev/null; do
        local c="${spin_chars:i%${#spin_chars}:1}"
        printf "\r  ${CYAN}%s${RESET} %s" "$c" "$msg"
        sleep 0.1
        ((i++))
    done
    wait "$pid" 2>/dev/null
    local exit_code=$?
    tput cnorm 2>/dev/null || true  # show cursor
    printf "\r"
    if [[ $exit_code -eq 0 ]]; then
        print_success "$msg"
    else
        print_error "$msg (failed)"
    fi
    return $exit_code
}

# Run a command with spinner
run_with_spinner() {
    local msg="$1"
    shift
    "$@" &>/dev/null &
    spinner $! "$msg"
}

# Detect package manager
detect_pkg_manager() {
    if command -v apt &>/dev/null; then
        echo "apt"
    elif command -v dnf &>/dev/null; then
        echo "dnf"
    elif command -v pacman &>/dev/null; then
        echo "pacman"
    elif command -v brew &>/dev/null; then
        echo "brew"
    else
        echo "unknown"
    fi
}

# Check if a command exists
require_cmd() {
    local cmd="$1"
    local name="${2:-$cmd}"
    if command -v "$cmd" &>/dev/null; then
        return 0
    else
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Welcome screen
# ---------------------------------------------------------------------------
show_welcome() {
    clear
    echo ""
    printf "${BCYAN}"
    cat << 'LOGO'
    ╦ ╦┌─┐┬─┐┌┬┐┌─┐┌┐┌┬ ┬
    ╠═╣├─┤├┬┘││││ │││││ ││
    ╩ ╩┴ ┴┴└─┴ ┴└─┘┘└┘└─┘
LOGO
    printf "${RESET}"
    printf "    ${DIM}Federated Social Platform${RESET}\n"
    echo ""
    print_line 42
    printf "  ${DIM}Interactive Setup — v1.0${RESET}\n"
    print_line 42
    echo ""
}

# ---------------------------------------------------------------------------
# Mode selection
# ---------------------------------------------------------------------------
select_mode() {
    print_box "Deployment Mode"

    print_info "Choose how you want to deploy Harmony:"
    echo ""

    prompt_choice "Select deployment mode:" \
        "Production (VPS) — Full self-hosting with nginx, SSL, Docker" \
        "Local Development — Dev environment with hot-reload"

    local choice=$?
    if [[ $choice -eq 0 ]]; then
        MODE="production"
    else
        MODE="local"
    fi

    echo ""
    print_success "Mode: ${BOLD}$MODE${RESET}"
}

# ---------------------------------------------------------------------------
# Instance configuration
# ---------------------------------------------------------------------------
configure_instance() {
    print_box "Instance Configuration"

    INSTANCE_NAME=$(prompt_input "Instance name" "Harmony")

    if [[ "$MODE" == "production" ]]; then
        echo ""
        print_info "Enter your domain (e.g., harmony.example.com)"
        print_info "This is the public URL users will visit."
        DOMAIN=$(prompt_input "Domain" "")
        while [[ -z "$DOMAIN" ]]; do
            print_error "Domain is required for production deployment."
            DOMAIN=$(prompt_input "Domain" "")
        done
        # Strip protocol if user included it
        DOMAIN="${DOMAIN#https://}"
        DOMAIN="${DOMAIN#http://}"
        DOMAIN="${DOMAIN%/}"
    else
        DOMAIN="har.mony.local"
        print_info "Using local development domain: ${BOLD}har.mony.local${RESET}"
    fi

    echo ""
    print_success "Instance: ${BOLD}$INSTANCE_NAME${RESET} at ${BOLD}$DOMAIN${RESET}"
}

# ---------------------------------------------------------------------------
# Supabase setup
# ---------------------------------------------------------------------------
configure_supabase() {
    print_box "Supabase Setup"

    print_info "Harmony uses Supabase as its database and auth backend."
    print_info "You can use their free cloud tier or self-host it."
    echo ""

    if [[ "$MODE" == "local" ]]; then
        prompt_choice "Local Supabase setup:" \
            "Already running (supabase start or Docker)" \
            "I need help setting it up"

        local choice=$?
        if [[ $choice -eq 0 ]]; then
            SUPABASE_MODE="cloud"  # reuse cloud path for existing local
            echo ""
            SUPABASE_URL=$(prompt_input "Supabase URL" "http://localhost:54321")
            SUPABASE_ANON_KEY=$(prompt_input "Anon key" "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE")
            SUPABASE_SERVICE_KEY=$(prompt_input "Service role key" "")
            DATABASE_URL=$(prompt_input "Database URL (for pg-boss)" "postgresql://supabase_admin:postgres@localhost:54322/postgres")
        else
            SUPABASE_MODE="selfhosted"
            echo ""
            print_info "To set up local Supabase:"
            echo ""
            printf "  ${DIM}1.${RESET} Install Supabase CLI: ${CYAN}npm install -g supabase${RESET}\n"
            printf "  ${DIM}2.${RESET} Run: ${CYAN}supabase start${RESET}\n"
            printf "  ${DIM}3.${RESET} Or use Docker: ${CYAN}git clone https://github.com/supabase/supabase${RESET}\n"
            printf "     ${CYAN}cd supabase/docker && cp .env.example .env && docker compose up -d${RESET}\n"
            printf "  ${DIM}4.${RESET} Then run the schema: ${CYAN}psql -h localhost -p 54322 -U postgres -f db_schema/init/init.sql${RESET}\n"
            echo ""
            print_warn "Start Supabase first, then re-run this installer."
            echo ""

            SUPABASE_URL=$(prompt_input "Supabase URL (once running)" "http://localhost:54321")
            SUPABASE_ANON_KEY=$(prompt_input "Anon key" "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE")
            SUPABASE_SERVICE_KEY=""
            DATABASE_URL="postgresql://supabase_admin:postgres@localhost:54322/postgres"
        fi
    else
        prompt_choice "Supabase hosting:" \
            "Supabase Cloud (supabase.com — free tier available)" \
            "Self-hosted Supabase (Docker on this VPS)"

        local choice=$?
        if [[ $choice -eq 0 ]]; then
            SUPABASE_MODE="cloud"
            echo ""
            print_info "Get credentials from: Supabase Dashboard → Settings → API"
            echo ""
            SUPABASE_URL=$(prompt_input "Project URL" "https://xxxxx.supabase.co")
            SUPABASE_ANON_KEY=$(prompt_input "Anon key" "")
            SUPABASE_SERVICE_KEY=$(prompt_input "Service role key" "")
            echo ""
            print_info "For reliable federation, you need the database connection string."
            print_info "Find it at: Dashboard → Project Settings → Database → Connection string"
            DATABASE_URL=$(prompt_input "Database URL" "")
        else
            SUPABASE_MODE="selfhosted"
            echo ""
            print_info "Self-hosted Supabase will run in Docker alongside Harmony."
            print_info "The installer will use docker-compose.full.yml which connects"
            print_info "to the Supabase docker network automatically."
            echo ""

            local pg_pass
            pg_pass=$(prompt_input "Supabase Postgres password" "your-super-secret-and-long-postgres-password")

            SUPABASE_URL="http://supabase-kong:8000"
            SUPABASE_ANON_KEY=$(prompt_input "Supabase anon key" "")
            SUPABASE_SERVICE_KEY=$(prompt_input "Service role key" "")
            DATABASE_URL="postgresql://supabase_admin:${pg_pass}@supabase-db:5432/postgres"
        fi
    fi

    echo ""
    print_success "Supabase: ${BOLD}$SUPABASE_MODE${RESET}"
}

# ---------------------------------------------------------------------------
# Feature toggles
# ---------------------------------------------------------------------------
configure_features() {
    print_box "Feature Selection"

    # Federation
    echo ""
    printf "  ${BOLD}Federation (ActivityPub)${RESET}\n"
    print_info "Enables federation with Mastodon, other Harmony instances, etc."
    print_info "Also provides link previews in chat."
    if [[ "$MODE" == "production" ]]; then
        print_info "Without it, your instance is standalone and won't have"
        print_info "URL previews (in this early version of Harmony)."
    fi
    echo ""
    if prompt_yn "Enable federation?" "y"; then
        ENABLE_FEDERATION=true
    else
        ENABLE_FEDERATION=false
        echo ""
        print_warn "Federation disabled. Link previews will not be available."
    fi

    # Voice/Video
    echo ""
    printf "  ${BOLD}Voice & Video (LiveKit)${RESET}\n"
    print_info "Provides voice and video calls using WebRTC."
    if [[ "$MODE" == "production" ]]; then
        print_info "Requires a subdomain (e.g., live.$DOMAIN) for WebSocket connections."
    fi
    echo ""
    if prompt_yn "Enable voice/video?" "y"; then
        ENABLE_VOICE=true
        if [[ "$MODE" == "production" ]]; then
            LIVEKIT_SUBDOMAIN=$(prompt_input "LiveKit subdomain" "live.$DOMAIN")
        else
            LIVEKIT_SUBDOMAIN="live.mony.local"
        fi
    else
        ENABLE_VOICE=false
    fi

    # Bot Gateway
    echo ""
    printf "  ${BOLD}Bot Gateway${RESET}\n"
    print_info "Allows bots to connect to your instance via WebSocket."
    print_info "Optional — most instances don't need this initially."
    echo ""
    if prompt_yn "Enable bot gateway?" "n"; then
        ENABLE_BOTS=true
    else
        ENABLE_BOTS=false
    fi

    # Summary
    echo ""
    print_line 50
    printf "  ${BOLD}Feature Summary${RESET}\n"
    echo ""
    if $ENABLE_FEDERATION; then
        printf "    ${BGREEN}[x]${RESET} Federation (ActivityPub + link previews)\n"
    else
        printf "    ${DIM}[ ]${RESET} Federation\n"
    fi
    if $ENABLE_VOICE; then
        printf "    ${BGREEN}[x]${RESET} Voice & Video (LiveKit)\n"
    else
        printf "    ${DIM}[ ]${RESET} Voice & Video\n"
    fi
    if $ENABLE_BOTS; then
        printf "    ${BGREEN}[x]${RESET} Bot Gateway\n"
    else
        printf "    ${DIM}[ ]${RESET} Bot Gateway\n"
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Generate LiveKit keys
# ---------------------------------------------------------------------------
generate_livekit_keys() {
    if $ENABLE_VOICE; then
        LIVEKIT_API_KEY="devkey$(openssl rand -hex 8)"
        LIVEKIT_API_SECRET="$(openssl rand -hex 32)"
        print_success "Generated LiveKit API key and secret"
    fi
}

# ---------------------------------------------------------------------------
# Config generation
# ---------------------------------------------------------------------------
generate_frontend_env() {
    local env_file="$PROJECT_DIR/.env"

    if [[ -f "$env_file" ]]; then
        if ! prompt_yn ".env already exists. Overwrite?" "n"; then
            print_warn "Skipping .env generation"
            return
        fi
    fi

    local app_url
    local federation_url=""
    local livekit_url=""

    if [[ "$MODE" == "production" ]]; then
        app_url="https://$DOMAIN"
        if $ENABLE_FEDERATION; then
            federation_url="https://$DOMAIN"
        fi
        if $ENABLE_VOICE; then
            livekit_url="wss://$LIVEKIT_SUBDOMAIN"
        fi
    else
        app_url="https://har.mony.local"
        if $ENABLE_FEDERATION; then
            federation_url="https://har.mony.local"
        fi
        if $ENABLE_VOICE; then
            livekit_url="wss://live.mony.local"
        fi
    fi

    cat > "$env_file" << EOF
# Generated by Harmony installer — $(date '+%Y-%m-%d %H:%M:%S')
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
VITE_INSTANCE_DOMAIN=$DOMAIN
VITE_INSTANCE_NAME=$INSTANCE_NAME
VITE_APP_URL=$app_url
VITE_FEDERATION_API_URL=$federation_url
VITE_LIVEKIT_URL=$livekit_url
VITE_ENABLE_FEDERATION=$ENABLE_FEDERATION
VITE_ENABLE_VOICE=$ENABLE_VOICE
VITE_ENABLE_E2E_ENCRYPTION=true
VITE_TENOR_API_KEY=
VITE_DEBUG_LOGGING=false
EOF

    print_success "Generated ${BOLD}.env${RESET}"
}

generate_federation_env() {
    if ! $ENABLE_FEDERATION; then
        return
    fi

    local env_file="$PROJECT_DIR/federation-backend/.env"

    if [[ -f "$env_file" ]]; then
        if ! prompt_yn "federation-backend/.env already exists. Overwrite?" "n"; then
            print_warn "Skipping federation-backend/.env"
            return
        fi
    fi

    local cors_origin
    local pgboss_enabled="false"
    local api_base_url="http://localhost:3001"

    if [[ "$MODE" == "production" ]]; then
        cors_origin="https://$DOMAIN"
    else
        cors_origin="https://har.mony.local"
    fi

    if [[ -n "$DATABASE_URL" ]]; then
        pgboss_enabled="true"
    fi

    local lk_url=""
    local lk_public_url=""
    if $ENABLE_VOICE; then
        if [[ "$MODE" == "production" ]]; then
            lk_url="ws://harmony-livekit:7880"
            lk_public_url="wss://$LIVEKIT_SUBDOMAIN"
        else
            lk_url="ws://harmony-livekit:7880"
            lk_public_url="wss://live.mony.local"
        fi
    fi

    cat > "$env_file" << EOF
# Generated by Harmony installer — $(date '+%Y-%m-%d %H:%M:%S')
NODE_ENV=${MODE/local/development}
PORT=3001
API_BASE_URL=$api_base_url

SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_KEY
DATABASE_URL=$DATABASE_URL

INSTANCE_DOMAIN=$DOMAIN
INSTANCE_NAME=$INSTANCE_NAME
INSTANCE_DESCRIPTION=A federated social platform

CORS_ORIGIN=$cors_origin
REQUIRE_VALID_SIGNATURES=true

LIVEKIT_API_KEY=$LIVEKIT_API_KEY
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET
LIVEKIT_URL=$lk_url
LIVEKIT_PUBLIC_URL=$lk_public_url
WEBRTC_MODE=hybrid
ALLOW_FEDERATED_VOICE=true

USE_PGBOSS_QUEUE=$pgboss_enabled

RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
LOG_LEVEL=info
EOF

    print_success "Generated ${BOLD}federation-backend/.env${RESET}"
}

generate_bot_gateway_env() {
    if ! $ENABLE_BOTS; then
        return
    fi

    local env_file="$PROJECT_DIR/bot-gateway/.env"

    if [[ -f "$env_file" ]]; then
        if ! prompt_yn "bot-gateway/.env already exists. Overwrite?" "n"; then
            print_warn "Skipping bot-gateway/.env"
            return
        fi
    fi

    local cors_origin
    if [[ "$MODE" == "production" ]]; then
        cors_origin="https://$DOMAIN"
    else
        cors_origin="https://har.mony.local"
    fi

    cat > "$env_file" << EOF
# Generated by Harmony installer — $(date '+%Y-%m-%d %H:%M:%S')
NODE_ENV=${MODE/local/development}
PORT=3002
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_KEY
INSTANCE_DOMAIN=$DOMAIN
CORS_ORIGIN=$cors_origin
LOG_LEVEL=info
MAX_BOT_CONNECTIONS=100
HEARTBEAT_INTERVAL=30000
CONNECTION_TIMEOUT=60000
EOF

    print_success "Generated ${BOLD}bot-gateway/.env${RESET}"
}

generate_livekit_config() {
    if ! $ENABLE_VOICE; then
        return
    fi

    local config_file="$PROJECT_DIR/webrtc/livekit.yaml"
    mkdir -p "$PROJECT_DIR/webrtc"

    if [[ -f "$config_file" ]]; then
        if ! prompt_yn "webrtc/livekit.yaml already exists. Overwrite?" "n"; then
            print_warn "Skipping livekit.yaml"
            return
        fi
    fi

    local turn_domain="$DOMAIN"
    if [[ "$MODE" == "local" ]]; then
        turn_domain="har.mony.local"
    fi

    cat > "$config_file" << EOF
# Generated by Harmony installer — $(date '+%Y-%m-%d %H:%M:%S')
port: 7880
rtc:
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
turn:
  enabled: true
  domain: $turn_domain
  tls_port: 5349
  udp_port: 3478
EOF

    print_success "Generated ${BOLD}webrtc/livekit.yaml${RESET}"
}

generate_nginx_config() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi

    local template="$PROJECT_DIR/dev/nginx-harmony.template.conf"
    local output="$PROJECT_DIR/dev/nginx-harmony.conf"

    if [[ ! -f "$template" ]]; then
        print_warn "nginx template not found at dev/nginx-harmony.template.conf"
        print_warn "Skipping nginx config generation."
        return
    fi

    if [[ -f "$output" ]]; then
        if ! prompt_yn "dev/nginx-harmony.conf already exists. Overwrite?" "n"; then
            print_warn "Skipping nginx config"
            return
        fi
    fi

    sed -e "s/YOUR_DOMAIN/$DOMAIN/g" \
        -e "s|/path/to/harmony|$PROJECT_DIR|g" \
        "$template" > "$output"

    # Uncomment LiveKit section if voice is enabled
    if $ENABLE_VOICE && [[ -n "$LIVEKIT_SUBDOMAIN" ]]; then
        sed -i "s/YOUR_DOMAIN/$DOMAIN/g" "$output"
        # Uncomment the LiveKit server block
        sed -i "/^# server {/,/^# }/ { s/^# //; }" "$output" 2>/dev/null || true
        sed -i "s/live\.YOUR_DOMAIN/$LIVEKIT_SUBDOMAIN/g" "$output"
    fi

    print_success "Generated ${BOLD}dev/nginx-harmony.conf${RESET} from template"

    # Generate docs nginx config
    local docs_template="$PROJECT_DIR/dev/nginx-docs.template.conf"
    local docs_output="$PROJECT_DIR/dev/nginx-docs.conf"

    if [[ -f "$docs_template" ]]; then
        sed -e "s/YOUR_DOMAIN/$DOMAIN/g" \
            -e "s|/path/to/harmony|$PROJECT_DIR|g" \
            "$docs_template" > "$docs_output"
        print_success "Generated ${BOLD}dev/nginx-docs.conf${RESET} from template"
    fi
}

generate_docker_compose() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi

    local output="$PROJECT_DIR/docker-compose.yml"

    if [[ -f "$output" ]]; then
        if ! prompt_yn "docker-compose.yml already exists. Overwrite?" "n"; then
            print_warn "Skipping docker-compose.yml"
            return
        fi
    fi

    local compose="version: \"3.8\"

services:"

    if $ENABLE_FEDERATION; then
        compose+="
  federation-backend:
    build:
      context: ./federation-backend
      dockerfile: Dockerfile
    container_name: harmony-federation
    restart: unless-stopped
    ports:
      - \"3001:3001\"
    env_file:
      - ./federation-backend/.env
    environment:
      - NODE_ENV=production
      - PORT=3001
    healthcheck:
      test: [\"CMD\", \"node\", \"-e\", \"require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
    networks:
      - harmony
    depends_on:
      - redis

  redis:
    image: redis:7-alpine
    container_name: harmony-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: [\"CMD\", \"redis-cli\", \"ping\"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - harmony"
    fi

    if $ENABLE_VOICE; then
        compose+="

  livekit:
    image: livekit/livekit-server:latest
    container_name: harmony-livekit
    restart: unless-stopped
    ports:
      - \"7880:7880\"
      - \"7881:7881\"
      - \"50000-50100:50000-50100/udp\"
    volumes:
      - ./webrtc/livekit.yaml:/livekit.yaml:ro
    command: --config /livekit.yaml
    networks:
      - harmony"
    fi

    if $ENABLE_BOTS; then
        compose+="

  bot-gateway:
    build:
      context: ./bot-gateway
      dockerfile: Dockerfile
    container_name: harmony-bot-gateway
    restart: unless-stopped
    ports:
      - \"3002:3002\"
    env_file:
      - ./bot-gateway/.env
    environment:
      - NODE_ENV=production
      - PORT=3002
    networks:
      - harmony"
    fi

    compose+="

  nginx:
    image: nginx:alpine
    container_name: harmony-nginx
    restart: unless-stopped
    ports:
      - \"80:80\"
      - \"443:443\"
    volumes:
      - ./dist:/usr/share/nginx/html:ro
      - ./docs/.vitepress/dist:/usr/share/nginx/docs:ro
      - ./dev/nginx-harmony.conf:/etc/nginx/conf.d/harmony.conf:ro
      - ./dev/nginx-docs.conf:/etc/nginx/conf.d/docs.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
    networks:
      - harmony"

    if $ENABLE_FEDERATION; then
        compose+="
    depends_on:
      - federation-backend"
    fi

    compose+="

networks:
  harmony:
    driver: bridge"

    if $ENABLE_FEDERATION; then
        compose+="

volumes:
  redis-data:"
    fi

    compose+="
"

    echo "$compose" > "$output"
    print_success "Generated ${BOLD}docker-compose.yml${RESET} (tailored to your features)"
}

# ---------------------------------------------------------------------------
# Installation actions (production)
# ---------------------------------------------------------------------------
install_nginx_config() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi

    echo ""
    printf "  ${BOLD}Install nginx configs?${RESET}\n"
    print_info "This will copy configs to /etc/nginx/sites-available/"
    print_info "and create symlinks in sites-enabled/."
    echo ""

    if prompt_yn "Install nginx configs?" "y"; then
        local skip_app=false
        local skip_docs=false

        if [[ -f /etc/nginx/sites-available/harmony ]]; then
            if ! prompt_yn "/etc/nginx/sites-available/harmony already exists. Overwrite?" "n"; then
                skip_app=true
            fi
        fi

        if [[ -f /etc/nginx/sites-available/harmony-docs ]]; then
            if ! prompt_yn "/etc/nginx/sites-available/harmony-docs already exists. Overwrite?" "n"; then
                skip_docs=true
            fi
        fi

        if ! $skip_app; then
            sudo cp "$PROJECT_DIR/dev/nginx-harmony.conf" /etc/nginx/sites-available/harmony
            sudo ln -sf /etc/nginx/sites-available/harmony /etc/nginx/sites-enabled/harmony
            print_success "Installed sites-available/harmony"
        fi

        if ! $skip_docs && [[ -f "$PROJECT_DIR/dev/nginx-docs.conf" ]]; then
            sudo cp "$PROJECT_DIR/dev/nginx-docs.conf" /etc/nginx/sites-available/harmony-docs
            sudo ln -sf /etc/nginx/sites-available/harmony-docs /etc/nginx/sites-enabled/harmony-docs
            print_success "Installed sites-available/harmony-docs"
        fi

        if sudo nginx -t 2>/dev/null; then
            print_success "Nginx config validated"
            sudo systemctl reload nginx 2>/dev/null && print_success "Nginx reloaded" || true
        else
            print_error "Nginx config validation failed. Check the config manually."
            print_info "Your existing nginx configs were not affected."
        fi
    fi
}

setup_ssl() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi

    echo ""
    printf "  ${BOLD}Set up SSL with Let's Encrypt?${RESET}\n"
    print_info "Runs certbot to obtain a free SSL certificate for $DOMAIN"
    echo ""

    if prompt_yn "Run certbot?" "y"; then
        if require_cmd certbot; then
            sudo certbot --nginx -d "$DOMAIN" -d "docs.$DOMAIN" ${ENABLE_VOICE:+-d "$LIVEKIT_SUBDOMAIN"} || {
                print_warn "Certbot failed. You can run it manually later:"
                printf "  ${CYAN}sudo certbot --nginx -d %s -d docs.%s${RESET}\n" "$DOMAIN" "$DOMAIN"
            }
        else
            print_warn "certbot not found. Install it first:"
            local pkg_mgr
            pkg_mgr=$(detect_pkg_manager)
            case "$pkg_mgr" in
                apt) printf "  ${CYAN}sudo apt install certbot python3-certbot-nginx${RESET}\n" ;;
                dnf) printf "  ${CYAN}sudo dnf install certbot python3-certbot-nginx${RESET}\n" ;;
                pacman) printf "  ${CYAN}sudo pacman -S certbot certbot-nginx${RESET}\n" ;;
                *) printf "  ${CYAN}Install certbot for your platform${RESET}\n" ;;
            esac
        fi
    fi
}

setup_firewall() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi

    echo ""
    printf "  ${BOLD}Configure firewall (UFW)?${RESET}\n"
    print_info "Opens ports: SSH (22), HTTP (80), HTTPS (443)"
    if $ENABLE_VOICE; then
        print_info "Also: LiveKit (7880-7881), TURN (3478/udp, 5349), Media (50000-50100/udp)"
    fi
    echo ""

    if prompt_yn "Configure firewall?" "y"; then
        if require_cmd ufw; then
            sudo ufw allow 22/tcp
            sudo ufw allow 80/tcp
            sudo ufw allow 443/tcp
            if $ENABLE_VOICE; then
                sudo ufw allow 7880/tcp
                sudo ufw allow 7881/tcp
                sudo ufw allow 3478/udp
                sudo ufw allow 5349/tcp
                sudo ufw allow 50000:50100/udp
            fi
            sudo ufw --force enable
            print_success "Firewall configured"
        else
            print_warn "ufw not found. Configure your firewall manually."
        fi
    fi
}

build_frontend() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi

    echo ""
    printf "  ${BOLD}Build frontend?${RESET}\n"
    print_info "Runs npm ci && npm run build-only to produce dist/"
    echo ""

    if prompt_yn "Build frontend now?" "y"; then
        cd "$PROJECT_DIR"
        if require_cmd npm; then
            run_with_spinner "Installing dependencies (npm ci)..." npm ci
            run_with_spinner "Building frontend..." npm run build-only
        else
            print_error "npm not found. Install Node.js first."
        fi
    fi
}

start_services() {
    echo ""
    printf "  ${BOLD}Start Docker services?${RESET}\n"

    if [[ "$MODE" == "production" ]]; then
        print_info "Runs: docker compose up -d"
    else
        print_info "Runs: docker compose -f dev/docker-compose.yml up -d"
    fi
    echo ""

    if prompt_yn "Start services now?" "y"; then
        if require_cmd docker; then
            cd "$PROJECT_DIR"
            if [[ "$MODE" == "production" ]]; then
                docker compose up -d --build 2>&1 | tail -5
            else
                cd dev
                docker compose up -d --build 2>&1 | tail -5
                cd "$PROJECT_DIR"
            fi
            print_success "Docker services started"
        else
            print_error "Docker not found. Install Docker first."
        fi
    fi
}

# ---------------------------------------------------------------------------
# Local dev helpers
# ---------------------------------------------------------------------------
setup_local_hosts() {
    echo ""
    printf "  ${BOLD}/etc/hosts configuration${RESET}\n"
    print_info "Local development needs these entries in /etc/hosts:"
    echo ""
    printf "    ${CYAN}127.0.0.1 har.mony.local live.mony.local${RESET}\n"
    echo ""

    if prompt_yn "Add entries to /etc/hosts?" "y"; then
        if ! grep -q "har.mony.local" /etc/hosts 2>/dev/null; then
            echo "127.0.0.1 har.mony.local live.mony.local" | sudo tee -a /etc/hosts >/dev/null
            print_success "Added to /etc/hosts"
        else
            print_info "Entries already exist in /etc/hosts"
        fi
    else
        print_info "Add manually: 127.0.0.1 har.mony.local live.mony.local"
    fi
}

setup_local_certs() {
    echo ""
    printf "  ${BOLD}Local HTTPS certificates${RESET}\n"
    print_info "Local dev uses mkcert for trusted HTTPS certificates."
    echo ""

    if require_cmd mkcert; then
        if prompt_yn "Generate certificates with mkcert?" "y"; then
            mkdir -p "$PROJECT_DIR/dev/certs"
            cd "$PROJECT_DIR/dev/certs"
            mkcert -install 2>/dev/null || true
            mkcert "har.mony.local" "live.mony.local" localhost 127.0.0.1
            cd "$PROJECT_DIR"
            print_success "Certificates generated in dev/certs/"
        fi
    else
        print_warn "mkcert not found. Install it:"
        local pkg_mgr
        pkg_mgr=$(detect_pkg_manager)
        case "$pkg_mgr" in
            apt) printf "    ${CYAN}sudo apt install mkcert${RESET}\n" ;;
            pacman) printf "    ${CYAN}sudo pacman -S mkcert${RESET}\n" ;;
            brew) printf "    ${CYAN}brew install mkcert${RESET}\n" ;;
            *) printf "    ${CYAN}See: https://github.com/FiloSottile/mkcert${RESET}\n" ;;
        esac
        echo ""
        print_info "After installing mkcert, re-run this installer or run:"
        printf "    ${CYAN}cd dev/certs && mkcert -install && mkcert \"har.mony.local\" \"live.mony.local\" localhost 127.0.0.1${RESET}\n"
    fi
}

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
show_summary() {
    print_box "Setup Complete"

    printf "  ${BOLD}Configuration${RESET}\n"
    echo ""
    printf "    ${DOT} Mode:       ${BOLD}%s${RESET}\n" "$MODE"
    printf "    ${DOT} Instance:   ${BOLD}%s${RESET}\n" "$INSTANCE_NAME"
    printf "    ${DOT} Domain:     ${BOLD}%s${RESET}\n" "$DOMAIN"
    printf "    ${DOT} Supabase:   ${BOLD}%s${RESET}\n" "$SUPABASE_MODE"
    echo ""

    printf "  ${BOLD}Features${RESET}\n"
    echo ""
    if $ENABLE_FEDERATION; then
        printf "    ${CHECK} Federation\n"
    else
        printf "    ${CROSS} Federation ${DIM}(disabled)${RESET}\n"
    fi
    if $ENABLE_VOICE; then
        printf "    ${CHECK} Voice/Video ${DIM}(%s)${RESET}\n" "$LIVEKIT_SUBDOMAIN"
    else
        printf "    ${CROSS} Voice/Video ${DIM}(disabled)${RESET}\n"
    fi
    if $ENABLE_BOTS; then
        printf "    ${CHECK} Bot Gateway\n"
    else
        printf "    ${CROSS} Bot Gateway ${DIM}(disabled)${RESET}\n"
    fi
    echo ""

    printf "  ${BOLD}Generated Files${RESET}\n"
    echo ""
    [[ -f "$PROJECT_DIR/.env" ]] && printf "    ${CHECK} .env\n"
    [[ -f "$PROJECT_DIR/federation-backend/.env" ]] && printf "    ${CHECK} federation-backend/.env\n"
    [[ -f "$PROJECT_DIR/bot-gateway/.env" ]] && printf "    ${CHECK} bot-gateway/.env\n"
    [[ -f "$PROJECT_DIR/webrtc/livekit.yaml" ]] && printf "    ${CHECK} webrtc/livekit.yaml\n"
    [[ -f "$PROJECT_DIR/docker-compose.yml" ]] && printf "    ${CHECK} docker-compose.yml\n"
    [[ -f "$PROJECT_DIR/dev/nginx-harmony.conf" ]] && printf "    ${CHECK} dev/nginx-harmony.conf\n"
    [[ -f "$PROJECT_DIR/dev/nginx-docs.conf" ]] && printf "    ${CHECK} dev/nginx-docs.conf\n"
    echo ""

    if $ENABLE_VOICE; then
        printf "  ${BOLD}LiveKit Credentials${RESET} ${DIM}(save these!)${RESET}\n"
        echo ""
        printf "    API Key:    ${CYAN}%s${RESET}\n" "$LIVEKIT_API_KEY"
        printf "    API Secret: ${CYAN}%s${RESET}\n" "$LIVEKIT_API_SECRET"
        echo ""
        print_info "These are also saved in federation-backend/.env and webrtc/livekit.yaml"
    fi

    print_line 50
    echo ""

    if [[ "$MODE" == "production" ]]; then
        printf "  ${BOLD}Next Steps${RESET}\n"
        echo ""
        printf "    ${DIM}1.${RESET} Verify your DNS points to this server\n"
        printf "    ${DIM}2.${RESET} Visit ${CYAN}https://%s${RESET} and register\n" "$DOMAIN"
        printf "    ${DIM}3.${RESET} First registered user becomes admin\n"
        echo ""
    else
        printf "  ${BOLD}Next Steps${RESET}\n"
        echo ""
        printf "    ${DIM}1.${RESET} Start Vite dev server: ${CYAN}npm run dev -- --host 0.0.0.0${RESET}\n"
        printf "    ${DIM}2.${RESET} Visit ${CYAN}https://har.mony.local${RESET}\n"
        printf "    ${DIM}3.${RESET} Register your first account\n"
        echo ""
    fi

    printf "  ${DIM}For the full manual guide: docs/HOW_TO_SELF_HOST.md${RESET}\n"
    echo ""

    if [[ "$MODE" == "production" ]]; then
        printf "  ${BOLD}Status Page (recommended)${RESET}\n"
        echo ""
        printf "    Deploy OpenStatus on a ${BOLD}separate VPS${RESET} so users can check\n"
        printf "    your instance status even when this server is down.\n"
        printf "    See: ${CYAN}docs/OPENSTATUS_SETUP.md${RESET}\n"
        echo ""
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    show_welcome

    select_mode
    configure_instance
    configure_supabase
    configure_features

    print_box "Generating Configuration"
    generate_livekit_keys
    generate_frontend_env
    generate_federation_env
    generate_bot_gateway_env
    generate_livekit_config
    generate_nginx_config
    generate_docker_compose

    if [[ "$MODE" == "production" ]]; then
        print_box "Installation"

        install_nginx_config
        setup_ssl
        setup_firewall
        build_frontend
        start_services
    else
        print_box "Local Dev Setup"

        setup_local_hosts
        setup_local_certs
        start_services
    fi

    show_summary
}

main "$@"
