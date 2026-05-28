#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Harmony Interactive Installer
# =============================================================================
# Pure bash, no external dependencies. ANSI-styled TUI with colors, spinners,
# and Unicode box-drawing for a modern installer feel.
#
# Usage:
#   ./scripts/install.sh              # Full interactive install
#   ./scripts/install.sh --schema-setup-only   # Run only DB schema (init + migrations)
#   ./scripts/install.sh --move-dist          # Build frontend and deploy dist to web root (/var/www/harmony if under /root)
#   ./scripts/install.sh --move-dist --no-build  # Deploy existing dist only (no build)
#   ./scripts/install.sh --regenerate-keys [folder] # Regenerate JWT/anon/service_role (keeps passwords)
#   ./scripts/install.sh --regenerate-all [folder]  # Regenerate all keys AND passwords (folder e.g. spacious)
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Color & style constants
# ---------------------------------------------------------------------------
BOLD=$'\033[1m'
DIM=$'\033[2m'
UNDERLINE=$'\033[4m'
RESET=$'\033[0m'
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
BLUE=$'\033[0;34m'
MAGENTA=$'\033[0;35m'
CYAN=$'\033[0;36m'
WHITE=$'\033[1;37m'
BRED=$'\033[1;31m'
BGREEN=$'\033[1;32m'
BYELLOW=$'\033[1;33m'
BCYAN=$'\033[1;36m'

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
SUPABASE_INTERNAL_URL=""   # docker-internal URL for backend services
SUPABASE_JWT_SECRET=""
SUPABASE_ANON_KEY=""
SUPABASE_SERVICE_KEY=""
DATABASE_URL=""
DATABASE_POOL_URL=""       # Supavisor pooled connection (transaction mode, port 6543)
SUPABASE_PROJECT_NAME=""   # folder name for self-hosted supabase (e.g. supabase-project)
SUPABASE_PROJECT_DIR=""   # full path after setup
SUPABASE_SITE_DOMAIN=""   # domain for Supabase (site URL, etc.)
SUPABASE_DASHBOARD_PASSWORD=""  # password for Supabase Studio
SUPABASE_PG_PASSWORD=""         # postgres password for self-hosted Supabase
DB_SCHEMA_LOADED=false          # whether setup_database ran successfully
SCHEMA_SETUP_ONLY=false         # true when invoked with --schema-setup-only

ENABLE_FEDERATION=true
ENABLE_VOICE=true
ENABLE_BOTS=false
ENABLE_DOCS=false
ENABLE_MONITORING=false
BULL_BOARD_SUBDOMAIN=""  # subdomain for Bull Board (e.g. bq.example.com)
USE_DOCKER=true          # run backend services in Docker (vs native Node)
WEB_ROOT=""              # where nginx serves dist/ from (set during config gen)

LIVEKIT_API_KEY=""
LIVEKIT_API_SECRET=""
LIVEKIT_UDP_PORT=7882

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
        printf "  ${ARROW} ${BOLD}%s${RESET} ${DIM}[%s]${RESET}: " "$prompt_text" "$default" >&2
    else
        printf "  ${ARROW} ${BOLD}%s${RESET}: " "$prompt_text" >&2
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
        ((++i))
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
    printf "  ${DIM}Interactive Setup - v1.0${RESET}\n"
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

    local choice=0
    prompt_choice "Select deployment mode:" \
        "Production (VPS) - Full self-hosting with nginx, SSL, Docker" \
        "Local Development - Dev environment with hot-reload" || choice=$?
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

# Set ENABLE_EMAIL_AUTOCONFIRM in Supabase .env (docker-compose maps it to GOTRUE_MAILER_AUTOCONFIRM)
# true = skip verification (when no SMTP/Resend), false = require email verification
set_supabase_autoconfirm() {
    local val="$1"  # "true" or "false"
    local env_file="${SUPABASE_PROJECT_DIR:?}/.env"
    if grep -q "^ENABLE_EMAIL_AUTOCONFIRM=" "$env_file" 2>/dev/null; then
        sed -i.bak "s|^ENABLE_EMAIL_AUTOCONFIRM=.*|ENABLE_EMAIL_AUTOCONFIRM=$val|" "$env_file"
    else
        echo "ENABLE_EMAIL_AUTOCONFIRM=$val" >> "$env_file"
    fi
    rm -f "${env_file}.bak"
}

# ---------------------------------------------------------------------------
# Self-hosted Supabase Docker setup
# ---------------------------------------------------------------------------
setup_selfhosted_supabase_docker() {
    local parent_dir
    parent_dir="$(dirname "$PROJECT_DIR")"
    local clone_dir="$parent_dir/supabase"
    SUPABASE_PROJECT_DIR="$parent_dir/$SUPABASE_PROJECT_NAME"

    echo ""
    print_step "1" "Cloning Supabase repo"
    if [[ -d "$clone_dir" ]]; then
        print_info "Supabase repo already exists at $clone_dir, pulling latest..."
        (cd "$clone_dir" && git pull --depth 1 2>/dev/null) || true
    else
        run_with_spinner "Cloning supabase/supabase..." git clone --depth 1 https://github.com/supabase/supabase "$clone_dir"
    fi

    print_step "2" "Creating Supabase project directory"
    mkdir -p "$SUPABASE_PROJECT_DIR"

    print_step "3" "Copying Docker compose files"
    cp -rf "$clone_dir/docker/"* "$SUPABASE_PROJECT_DIR/"

    print_info "Configuring imgproxy for Harmony (higher resolution, animation frames)"
    if grep -q "IMGPROXY_MAX_SRC_RESOLUTION" "$SUPABASE_PROJECT_DIR/docker-compose.yml" 2>/dev/null; then
        # Bump max source resolution from 16.8 to 50 megapixels (modern phone photos can exceed 16.8)
        sed -i.bak 's/IMGPROXY_MAX_SRC_RESOLUTION:.*/IMGPROXY_MAX_SRC_RESOLUTION: 50/' "$SUPABASE_PROJECT_DIR/docker-compose.yml"
        rm -f "$SUPABASE_PROJECT_DIR/docker-compose.yml.bak"
        # Add animation frames if not present
        if ! grep -q "IMGPROXY_MAX_ANIMATION_FRAMES" "$SUPABASE_PROJECT_DIR/docker-compose.yml" 2>/dev/null; then
            sed -i.bak '/IMGPROXY_MAX_SRC_RESOLUTION:/a\      IMGPROXY_MAX_ANIMATION_FRAMES: 120' "$SUPABASE_PROJECT_DIR/docker-compose.yml"
            rm -f "$SUPABASE_PROJECT_DIR/docker-compose.yml.bak"
        fi
    else
        print_warn "Could not find IMGPROXY_MAX_SRC_RESOLUTION in docker-compose.yml; add manually:"
        print_info "  IMGPROXY_MAX_SRC_RESOLUTION: 50"
        print_info "  IMGPROXY_MAX_ANIMATION_FRAMES: 120"
    fi

    print_step "4" "Copying .env.example to .env"
    cp "$clone_dir/docker/.env.example" "$SUPABASE_PROJECT_DIR/.env"

    if [[ -n "$SUPABASE_SITE_DOMAIN" ]]; then
        local domain_clean="${SUPABASE_SITE_DOMAIN#http://}"
        domain_clean="${domain_clean#https://}"
        domain_clean="${domain_clean%/}"
        local site_url="https://$domain_clean"
        print_info "Updating .env with domain: $site_url"
        sed -i.bak "s|SITE_URL=.*|SITE_URL=$site_url|" "$SUPABASE_PROJECT_DIR/.env"
        sed -i.bak "s|SUPABASE_PUBLIC_URL=.*|SUPABASE_PUBLIC_URL=$site_url|" "$SUPABASE_PROJECT_DIR/.env"
        sed -i.bak "s|API_EXTERNAL_URL=.*|API_EXTERNAL_URL=$site_url|" "$SUPABASE_PROJECT_DIR/.env"
        sed -i.bak "s|PROXY_DOMAIN=.*|PROXY_DOMAIN=$domain_clean|" "$SUPABASE_PROJECT_DIR/.env"
        rm -f "$SUPABASE_PROJECT_DIR/.env.bak"
    fi

    print_step "4b" "Email verification for signups"
    echo ""
    print_info "Require new users to verify their email before signing in?"
    print_info "We recommend ${BOLD}Yes${RESET} and using a transactional email provider like ${BOLD}Resend${RESET} (resend.com - free tier available)."
    print_info "If you skip verification, anyone can sign up with any email without confirmation."
    echo ""
    if prompt_yn "Require email verification?" "y"; then
        # Verification enabled - need SMTP for emails to send
        if prompt_yn "Configure Resend now? (you need an API key from resend.com)" "y"; then
            local resend_key
            resend_key=$(prompt_input "Resend API key (starts with re_)" "")
            if [[ -n "$resend_key" ]]; then
                # Resend SMTP: smtp.resend.com, port 465 or 587, user=resend, pass=API key
                for line in \
                    "ENABLE_EMAIL_AUTOCONFIRM=false" \
                    "SMTP_HOST=smtp.resend.com" \
                    "SMTP_PORT=587" \
                    "SMTP_USER=resend" \
                    "SMTP_PASS=$resend_key"; do
                    local key="${line%%=*}"
                    if grep -q "^${key}=" "$SUPABASE_PROJECT_DIR/.env" 2>/dev/null; then
                        sed -i.bak "s|^${key}=.*|${line}|" "$SUPABASE_PROJECT_DIR/.env"
                    else
                        echo "$line" >> "$SUPABASE_PROJECT_DIR/.env"
                    fi
                done
                rm -f "$SUPABASE_PROJECT_DIR/.env.bak"
                print_success "Resend SMTP configured; email verification enabled"
            else
                set_supabase_autoconfirm true
                print_warn "No API key provided. Verification disabled for now. Add SMTP_HOST, SMTP_USER, SMTP_PASS to the Supabase .env later to enable."
            fi
        else
            set_supabase_autoconfirm true
            print_info "Autoconfirm enabled for now (no SMTP). Add SMTP_HOST, SMTP_USER, SMTP_PASS to .env and set ENABLE_EMAIL_AUTOCONFIRM=false when ready."
            printf "    ${CYAN}%s/.env${RESET}\n" "$SUPABASE_PROJECT_DIR"
        fi
    else
        set_supabase_autoconfirm true
        print_success "Email verification disabled (signups auto-confirmed)"
    fi
    echo ""

    print_step "5" "Pulling Docker images"
    (cd "$SUPABASE_PROJECT_DIR" && run_with_spinner "Pulling images..." docker compose pull)

    echo ""
    print_success "Supabase project ready at: ${BOLD}$SUPABASE_PROJECT_DIR${RESET}"
    echo ""
}

start_supabase() {
    if [[ -z "$SUPABASE_PROJECT_DIR" ]] || [[ ! -d "$SUPABASE_PROJECT_DIR" ]]; then
        print_warn "Supabase project directory not set or missing - cannot start Supabase."
        return 1
    fi

    print_info "Starting Supabase containers from ${BOLD}$SUPABASE_PROJECT_DIR${RESET}..."
    if ! (cd "$SUPABASE_PROJECT_DIR" && docker compose up -d); then
        print_error "Failed to start Supabase containers."
        print_info "Try manually: ${CYAN}cd $SUPABASE_PROJECT_DIR && docker compose up -d${RESET}"
        return 1
    fi

    local db_container="${SUPABASE_DB_CONTAINER:-supabase-db}"
    print_info "Waiting for PostgreSQL to be ready (this can take 1–2 minutes on first boot)..."

    local max_wait=120
    local waited=0
    local db_ready=false

    while [[ $waited -lt $max_wait ]]; do
        if docker logs "$db_container" 2>&1 | grep -q "PostgreSQL init process complete; ready for start up\.\|database system is ready to accept connections"; then
            db_ready=true
            break
        fi
        sleep 5
        waited=$((waited + 5))
        printf "    ${DIM}Waiting... (%ds / %ds)${RESET}\r" "$waited" "$max_wait"
    done
    echo ""

    if $db_ready; then
        print_success "Supabase PostgreSQL is ready"
    else
        print_warn "Timed out waiting for PostgreSQL. It may still be initializing."
        print_info "The schema setup step will retry connecting automatically."
    fi
    echo ""
    return 0
}

ensure_supabase_running() {
    if [[ "$SUPABASE_MODE" != "selfhosted" ]] || [[ -z "$SUPABASE_PROJECT_DIR" ]]; then
        return 0
    fi

    local db_container="${SUPABASE_DB_CONTAINER:-supabase-db}"

    if docker inspect "$db_container" &>/dev/null 2>&1 && \
       docker inspect -f '{{.State.Running}}' "$db_container" 2>/dev/null | grep -q true; then
        return 0
    fi

    print_info "Supabase is not running - starting it now..."
    start_supabase
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
        local choice=0
        prompt_choice "Local Supabase setup:" \
            "Already running (supabase start or Docker)" \
            "I need help setting it up" || choice=$?
        if [[ $choice -eq 0 ]]; then
            SUPABASE_MODE="cloud"  # reuse cloud path for existing local
            echo ""
            SUPABASE_URL=$(prompt_input "Supabase URL" "http://localhost:54321")
            SUPABASE_ANON_KEY=$(prompt_input "Anon key" "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE")
            SUPABASE_SERVICE_KEY=$(prompt_input "Service role key" "")
            DATABASE_URL=$(prompt_input "Database URL (for BullMQ LISTEN/NOTIFY)" "postgresql://postgres:postgres@localhost:54322/postgres")
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
            DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres"
        fi
    else
        local choice=0
        prompt_choice "Supabase hosting:" \
            "Supabase Cloud (supabase.com - free tier available)" \
            "Self-hosted Supabase (Docker on this VPS)" || choice=$?
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
            print_info "The installer will clone the Supabase repo and set up your project."
            echo ""

            SUPABASE_PROJECT_NAME=$(prompt_input "Supabase project folder name" "supabase-project")
            echo ""
            print_info "The Supabase API needs its own subdomain (separate from the app)."
            print_info "Example: if your app is at ${BOLD}$DOMAIN${RESET}, use ${BOLD}db.$DOMAIN${RESET}"
            SUPABASE_SITE_DOMAIN=$(prompt_input "Supabase API domain" "db.$DOMAIN")

            if ! require_cmd git; then
                print_error "git is required for self-hosted Supabase. Please install git first."
                exit 1
            fi
            if ! require_cmd docker; then
                print_error "Docker is required for self-hosted Supabase. Please install Docker first."
                exit 1
            fi

            setup_selfhosted_supabase_docker

            # Auto-generate all keys and write them into the Supabase .env
            # MUST happen before starting Supabase so Postgres initializes with the correct passwords
            generate_supabase_keys

            # Now start Supabase with the correct credentials baked in
            start_supabase

            SUPABASE_URL="https://$SUPABASE_SITE_DOMAIN"
            SUPABASE_INTERNAL_URL="http://supabase-kong:8000"
            DATABASE_URL="postgresql://postgres:${SUPABASE_PG_PASSWORD}@supabase-db:5432/postgres"
            DATABASE_POOL_URL="postgresql://postgres:${SUPABASE_PG_PASSWORD}@supabase-pooler:6543/postgres"
        fi
    fi

    # For cloud Supabase, DATABASE_POOL_URL is set by the user (or left empty)
    if [[ "$SUPABASE_MODE" == "cloud" ]] && [[ -z "${DATABASE_POOL_URL:-}" ]]; then
        DATABASE_POOL_URL=""
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

        echo ""
        print_info "LiveKit uses UDP mux - all media on a single port (${LIVEKIT_UDP_PORT}/udp)."
        print_info "Scaling is limited by CPU/bandwidth, not port count."
        if [[ "$MODE" == "production" ]]; then
            echo ""
            printf "    ${BYELLOW}Scaling tip:${RESET} For 200+ simultaneous voice users, consider running\n"
            printf "    LiveKit on a dedicated VPS with more CPU cores. LiveKit supports\n"
            printf "    multi-node clustering via Redis - just point additional nodes at\n"
            printf "    the same Redis instance and they coordinate automatically.\n"
            printf "    See: ${CYAN}https://docs.livekit.io/realtime/self-hosting/deployment/${RESET}\n"
            echo ""
        fi
    else
        ENABLE_VOICE=false
    fi

    # Bot Gateway
    echo ""
    printf "  ${BOLD}Bot Gateway${RESET}\n"
    print_info "Allows bots to connect to your instance via WebSocket."
    print_info "Optional - most instances don't need this initially."
    echo ""
    if prompt_yn "Enable bot gateway?" "n"; then
        ENABLE_BOTS=true
    else
        ENABLE_BOTS=false
    fi

    # Documentation site
    echo ""
    printf "  ${BOLD}Documentation Site${RESET}\n"
    print_info "Serves API and user docs at docs.$DOMAIN (VitePress)."
    print_info "You can always enable this later."
    echo ""
    if prompt_yn "Serve documentation site?" "n"; then
        ENABLE_DOCS=true
    else
        ENABLE_DOCS=false
    fi

    # Queue monitoring dashboard
    echo ""
    printf "  ${BOLD}Queue Monitoring (Bull Board)${RESET}\n"
    print_info "Web dashboard for monitoring federation job queues."
    print_info "Useful for debugging federation issues."
    echo ""
    if prompt_yn "Enable queue monitoring dashboard?" "n"; then
        ENABLE_MONITORING=true
        local default_bb_sub="bq.${DOMAIN}"
        printf "    Subdomain for Bull Board [${BOLD}${default_bb_sub}${RESET}]: "
        read -r bb_sub
        BULL_BOARD_SUBDOMAIN="${bb_sub:-$default_bb_sub}"
    else
        ENABLE_MONITORING=false
    fi

    # Deployment method (production only)
    if [[ "$MODE" == "production" ]]; then
        echo ""
        printf "  ${BOLD}Backend Deployment${RESET}\n"
        print_info "How should the backend services (federation, voice, bot-gateway) run?"
        print_info "The web app is always built to static files and served by nginx."
        print_info "Docker runs federation, LiveKit, Redis, and nginx in one stack - one-command deploy."
        echo ""

        local choice=0
        prompt_choice "Backend deployment:" \
            "Docker Compose (recommended - federation, LiveKit, nginx in containers)" \
            "Native Node.js (run federation/LiveKit directly on the host)" || choice=$?

        if [[ $choice -eq 0 ]]; then
            USE_DOCKER=true
        else
            USE_DOCKER=false
        fi
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
    if $ENABLE_DOCS; then
        printf "    ${BGREEN}[x]${RESET} Documentation Site (docs.$DOMAIN)\n"
    else
        printf "    ${DIM}[ ]${RESET} Documentation Site\n"
    fi
    if $ENABLE_MONITORING; then
        printf "    ${BGREEN}[x]${RESET} Queue Monitoring (Bull Board - ${BULL_BOARD_SUBDOMAIN})\n"
    else
        printf "    ${DIM}[ ]${RESET} Queue Monitoring\n"
    fi
    if [[ "$MODE" == "production" ]]; then
        if $USE_DOCKER; then
            printf "    ${BGREEN}[x]${RESET} Docker Compose deployment\n"
        else
            printf "    ${BGREEN}[x]${RESET} Native Node.js deployment\n"
        fi
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Generate LiveKit keys
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Generate Supabase JWT keys (for self-hosted)
# JWT_SECRET → ANON_KEY + SERVICE_ROLE_KEY (HS256 JWTs)
# ---------------------------------------------------------------------------
generate_supabase_jwt() {
    local role="$1"    # "anon" or "service_role"
    local secret="$2"  # JWT_SECRET

    local header
    header=$(printf '{"alg":"HS256","typ":"JWT"}' | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

    local now
    now=$(date +%s)
    local exp=$((now + 157680000))  # 5 years

    local payload
    payload=$(printf '{"role":"%s","iss":"supabase","iat":%d,"exp":%d}' "$role" "$now" "$exp" | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

    local body="${header}.${payload}"
    local signature
    signature=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -binary | openssl base64 -e -A | tr '+/' '-_' | tr -d '=')

    echo "${body}.${signature}"
}

generate_supabase_keys() {
    print_info "Generating secure Supabase credentials..."

    SUPABASE_JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
    SUPABASE_PG_PASSWORD=$(openssl rand -hex 24)
    SUPABASE_ANON_KEY=$(generate_supabase_jwt "anon" "$SUPABASE_JWT_SECRET")
    SUPABASE_SERVICE_KEY=$(generate_supabase_jwt "service_role" "$SUPABASE_JWT_SECRET")

    # VAULT_ENC_KEY must be exactly 32 bytes (Supavisor AES-256-GCM). Hex-16 = 32 chars = safe for .env
    local vault_key
    vault_key=$(openssl rand -hex 16)
    # PG_META_CRYPTO_KEY also needs exactly 32 chars (postgres-meta / Studio)
    local pg_meta_crypto
    pg_meta_crypto=$(openssl rand -hex 16)
    local secret_key_base
    secret_key_base=$(openssl rand -base64 48 | tr -d '\n')
    local logflare_public
    logflare_public=$(openssl rand -hex 32)
    local logflare_private
    logflare_private=$(openssl rand -hex 32)

    # Dashboard password (Studio UI login)
    SUPABASE_DASHBOARD_PASSWORD=$(openssl rand -hex 16 2>/dev/null || echo 'change-me-please')

    # Write all secrets into the Supabase project .env (must match Supabase's expected var names)
    if [[ -f "$SUPABASE_PROJECT_DIR/.env" ]]; then
        sed -i.bak \
            -e "s|JWT_SECRET=.*|JWT_SECRET=$SUPABASE_JWT_SECRET|" \
            -e "s|ANON_KEY=.*|ANON_KEY=$SUPABASE_ANON_KEY|" \
            -e "s|SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SUPABASE_SERVICE_KEY|" \
            -e "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$SUPABASE_PG_PASSWORD|" \
            -e "s|DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$SUPABASE_DASHBOARD_PASSWORD|" \
            -e "s|SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$secret_key_base|" \
            -e "s|VAULT_ENC_KEY=.*|VAULT_ENC_KEY=$vault_key|" \
            -e "s|PG_META_CRYPTO_KEY=.*|PG_META_CRYPTO_KEY=$pg_meta_crypto|" \
            -e "s|LOGFLARE_PUBLIC_ACCESS_TOKEN=.*|LOGFLARE_PUBLIC_ACCESS_TOKEN=$logflare_public|" \
            -e "s|LOGFLARE_PRIVATE_ACCESS_TOKEN=.*|LOGFLARE_PRIVATE_ACCESS_TOKEN=$logflare_private|" \
            "$SUPABASE_PROJECT_DIR/.env"
        rm -f "$SUPABASE_PROJECT_DIR/.env.bak"
    fi

    print_success "Generated all Supabase credentials (JWT, keys, passwords)"
}

generate_livekit_keys() {
    if $ENABLE_VOICE; then
        LIVEKIT_API_KEY="devkey$(openssl rand -hex 8)"
        LIVEKIT_API_SECRET="$(openssl rand -hex 32)"
        print_success "Generated LiveKit API key and secret"
    fi
    # Redis is a core service (caching, presence, rate limiting, LiveKit, federation)
    REDIS_PASSWORD=$(openssl rand -hex 24)
    print_success "Generated Redis password"

    if $ENABLE_MONITORING; then
        BULL_BOARD_PASSWORD=$(openssl rand -hex 12)
        print_success "Generated Bull Board dashboard password"
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

    local env_extra=""
    if [[ -n "${REDIS_PASSWORD:-}" ]]; then
        env_extra="
# Redis (used by LiveKit and/or federation-backend)
REDIS_PASSWORD=$REDIS_PASSWORD"
    fi

    if $ENABLE_VOICE; then
        env_extra+="

# LiveKit uses UDP mux on port $LIVEKIT_UDP_PORT - see webrtc/livekit.yaml
LIVEKIT_UDP_PORT=$LIVEKIT_UDP_PORT"
    fi

    if $ENABLE_MONITORING && [[ -n "${BULL_BOARD_PASSWORD:-}" ]]; then
        env_extra+="

# Bull Board queue monitoring dashboard (port 3003)
BULL_BOARD_USER=admin
BULL_BOARD_PASSWORD=$BULL_BOARD_PASSWORD"
    fi

    cat > "$env_file" << EOF
# Generated by Harmony installer - $(date '+%Y-%m-%d %H:%M:%S')
VITE_SUPABASE_URL=$SUPABASE_URL
VITE_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
VITE_DOMAIN=$DOMAIN
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
$env_extra
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
    local bullmq_enabled="false"
    local api_base_url="http://localhost:3001"

    if [[ "$MODE" == "production" ]]; then
        cors_origin="https://$DOMAIN"
    else
        cors_origin="https://har.mony.local"
    fi

    if [[ -n "$DATABASE_URL" ]]; then
        bullmq_enabled="true"
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
# Generated by Harmony installer - $(date '+%Y-%m-%d %H:%M:%S')
NODE_ENV=${MODE/local/development}
PORT=3001
API_BASE_URL=$api_base_url

# Use public URL in .env so federation works when run on host (pm2/node). Docker compose overrides with internal URL.
SUPABASE_URL=$SUPABASE_URL
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_KEY
# Public URL for generating externally-reachable media URLs (avatars, banners, emojis)
# Must be set when SUPABASE_URL is a Docker-internal address (e.g. http://supabase-kong:8000)
PUBLIC_SUPABASE_URL=$SUPABASE_URL
DATABASE_URL=$DATABASE_URL
# Supavisor transaction-mode pooler (port 6543) for better connection efficiency.
# Pools hundreds of logical connections into a small number of real PG connections.
# DATABASE_URL (session mode, port 5432) is kept for LISTEN/NOTIFY which needs a persistent connection.
DATABASE_POOL_URL=$DATABASE_POOL_URL

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

USE_BULLMQ_QUEUE=$bullmq_enabled
REDIS_URL=redis://:${REDIS_PASSWORD:-}@harmony-redis:6379

RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
LOG_LEVEL=info
EOF

    # Generate VAPID keys for Web Push notifications
    echo ""
    printf "  ${BOLD}Web Push Notifications (VAPID Keys)${RESET}\n"
    print_info "VAPID keys are required for browser push notifications."
    print_info "Push notifications let users receive alerts even when the tab is closed."
    echo ""

    local vapid_generated=false
    if prompt_yn "Generate VAPID keys for push notifications?" "y"; then
        if require_cmd node; then
            local vapid_json
            vapid_json=$(node -e "
const crypto = require('crypto');
const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();
const publicKey = ecdh.getPublicKey().toString('base64url');
const privateKey = ecdh.getPrivateKey().toString('base64url');
console.log(JSON.stringify({ publicKey, privateKey }));
" 2>/dev/null)
            if [[ -n "$vapid_json" ]]; then
                local vapid_pub vapid_priv
                vapid_pub=$(echo "$vapid_json" | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.parse(d).publicKey)" 2>/dev/null)
                vapid_priv=$(echo "$vapid_json" | node -e "const d=require('fs').readFileSync(0,'utf8');console.log(JSON.parse(d).privateKey)" 2>/dev/null)
                if [[ -n "$vapid_pub" && -n "$vapid_priv" ]]; then
                    local vapid_email="admin@${DOMAIN}"
                    {
                        echo ""
                        echo "# Web Push (VAPID) - generated by installer"
                        echo "VAPID_PUBLIC_KEY=$vapid_pub"
                        echo "VAPID_PRIVATE_KEY=$vapid_priv"
                        echo "VAPID_SUBJECT=$vapid_email"
                    } >> "$env_file"
                    vapid_generated=true
                    print_success "Generated VAPID keys and added to federation-backend/.env"
                fi
            fi
        fi
        if ! $vapid_generated; then
            print_warn "Could not auto-generate VAPID keys (Node.js required)."
            echo ""
            print_info "Generate them manually after installing federation-backend dependencies:"
            printf "    ${CYAN}cd federation-backend && npm ci${RESET}\n"
            printf "    ${CYAN}npx web-push generate-vapid-keys${RESET}\n"
            echo ""
            print_info "Then add to ${BOLD}federation-backend/.env${RESET}:"
            printf "    ${CYAN}VAPID_PUBLIC_KEY=<your-public-key>${RESET}\n"
            printf "    ${CYAN}VAPID_PRIVATE_KEY=<your-private-key>${RESET}\n"
            printf "    ${CYAN}VAPID_SUBJECT=admin@%s${RESET}\n" "$DOMAIN"
        fi
    else
        print_info "Skipped. To enable push notifications later, generate VAPID keys:"
        printf "    ${CYAN}cd federation-backend && npx web-push generate-vapid-keys${RESET}\n"
        print_info "Then add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT to federation-backend/.env"
    fi

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
# Generated by Harmony installer - $(date '+%Y-%m-%d %H:%M:%S')
NODE_ENV=${MODE/local/development}
PORT=3002
SUPABASE_URL=${SUPABASE_INTERNAL_URL:-$SUPABASE_URL}
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
    local log_level="info"
    if [[ "$MODE" == "local" ]]; then
        turn_domain="har.mony.local"
        log_level="debug"
    fi

    # Build redis config section
    # Use container name (harmony-redis) so the config works both when LiveKit
    # is in the same compose stack and when run via webrtc/docker-compose.yml
    local redis_section=""
    if [[ -n "$REDIS_PASSWORD" ]]; then
        redis_section="redis:
  address: harmony-redis:6379
  password: $REDIS_PASSWORD"
    else
        redis_section="redis:
  address: harmony-redis:6379"
    fi

    cat > "$config_file" << EOF
# Generated by Harmony installer - $(date '+%Y-%m-%d %H:%M:%S')
#
# UDP mux: all WebRTC media on port ${LIVEKIT_UDP_PORT} (single port).
# LiveKit demuxes by ICE session - one port serves thousands of participants.
# Scaling limits are CPU/bandwidth, not port count.
#
# Multi-node: deploy additional LiveKit instances pointing at the same Redis.
# See: https://docs.livekit.io/realtime/self-hosting/deployment/

port: 7880

log_level: $log_level

keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET

rtc:
  udp_port: $LIVEKIT_UDP_PORT
  tcp_port: 7881
  use_ice_lite: true
  use_external_ip: true

turn:
  enabled: true
  domain: $turn_domain
  udp_port: 3478
  # TLS handled by nginx - leave tls_port commented
  # tls_port: 5349

room:
  empty_timeout: 300
  departure_timeout: 20

$redis_section
EOF

    print_success "Generated ${BOLD}webrtc/livekit.yaml${RESET} (UDP mux port: ${LIVEKIT_UDP_PORT})"
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

    # Determine web root - nginx can't traverse /root/, so use /var/www/harmony
    if [[ "$PROJECT_DIR" == /root/* ]]; then
        WEB_ROOT="/var/www/harmony"
        print_warn "Project is inside /root/ - nginx cannot access it."
        print_info "Static files will be served from ${BOLD}$WEB_ROOT${RESET}"
    else
        WEB_ROOT="$PROJECT_DIR/dist"
    fi

    # Generate main harmony config (without the commented LiveKit block)
    # Replace dist root separately so /var/www/harmony works correctly
    sed -e "s/YOUR_DOMAIN/$DOMAIN/g" \
        -e "s|/path/to/harmony/dist|$WEB_ROOT|g" \
        -e "s|/path/to/harmony|$PROJECT_DIR|g" \
        "$template" | sed '/^# ====.*LIVEKIT/,$ d' > "$output"

    print_success "Generated ${BOLD}dev/nginx-harmony.conf${RESET} from template"

    # Generate separate Bull Board nginx config if monitoring is enabled
    if $ENABLE_MONITORING && [[ -n "$BULL_BOARD_SUBDOMAIN" ]]; then
        local bb_output="$PROJECT_DIR/dev/nginx-bullboard.conf"
        local skip_bb=false

        if [[ -f "$bb_output" ]]; then
            if ! prompt_yn "dev/nginx-bullboard.conf already exists. Overwrite?" "n"; then
                skip_bb=true
            fi
        fi

        if ! $skip_bb; then
            cat > "$bb_output" << BBEOF
# Bull Board queue monitoring - generated by Harmony installer
server {
    listen 80;
    server_name $BULL_BOARD_SUBDOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $BULL_BOARD_SUBDOMAIN;

    ssl_certificate /etc/letsencrypt/live/$BULL_BOARD_SUBDOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$BULL_BOARD_SUBDOMAIN/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3003;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
BBEOF
            print_success "Generated ${BOLD}dev/nginx-bullboard.conf${RESET}"
        fi
    fi

    # Generate separate LiveKit nginx config if voice is enabled
    if $ENABLE_VOICE && [[ -n "$LIVEKIT_SUBDOMAIN" ]]; then
        local lk_output="$PROJECT_DIR/dev/nginx-livekit.conf"
        local skip_lk=false

        if [[ -f "$lk_output" ]]; then
            if ! prompt_yn "dev/nginx-livekit.conf already exists. Overwrite?" "n"; then
                skip_lk=true
            fi
        fi

        if ! $skip_lk; then
            cat > "$lk_output" << LKEOF
# LiveKit WebSocket proxy - generated by Harmony installer
server {
    listen 80;
    server_name $LIVEKIT_SUBDOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name $LIVEKIT_SUBDOMAIN;

    ssl_certificate /etc/letsencrypt/live/$LIVEKIT_SUBDOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$LIVEKIT_SUBDOMAIN/privkey.pem;

    location / {
        proxy_pass http://localhost:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    access_log /var/log/nginx/livekit.access.log;
    error_log /var/log/nginx/livekit.error.log;
}
LKEOF
            print_success "Generated ${BOLD}dev/nginx-livekit.conf${RESET}"
        fi
    fi

    # Generate docs nginx config (only if docs enabled)
    if $ENABLE_DOCS; then
        local docs_template="$PROJECT_DIR/dev/nginx-docs.template.conf"
        local docs_output="$PROJECT_DIR/dev/nginx-docs.conf"
        local docs_web_root="$PROJECT_DIR/docs/.vitepress/dist"
        if [[ "$PROJECT_DIR" == /root/* ]]; then
            docs_web_root="/var/www/harmony-docs"
        fi

        if [[ -f "$docs_template" ]]; then
            sed -e "s/YOUR_DOMAIN/$DOMAIN/g" \
                -e "s|/path/to/harmony/docs/.vitepress/dist|$docs_web_root|g" \
                -e "s|/path/to/harmony|$PROJECT_DIR|g" \
                "$docs_template" > "$docs_output"
            print_success "Generated ${BOLD}dev/nginx-docs.conf${RESET} from template"
        fi
    fi
}

generate_docker_compose() {
    if [[ "$MODE" != "production" ]] || ! $USE_DOCKER; then
        return
    fi

    local output="$PROJECT_DIR/docker-compose.yml"

    if [[ -f "$output" ]]; then
        if ! prompt_yn "docker-compose.yml already exists. Overwrite?" "n"; then
            print_warn "Skipping docker-compose.yml"
            return
        fi
    fi

    local selfhosted_supabase=false
    [[ "$SUPABASE_MODE" == "selfhosted" ]] && selfhosted_supabase=true

    local compose="services:"

    # --- Redis (core service: caching, presence, rate limiting, LiveKit, federation) ---
    local needs_redis=true

    # --- Federation (split: server + worker) ---
    if $ENABLE_FEDERATION; then
        local fed_networks="      - harmony"
        local fed_env_base="      - NODE_ENV=production"

        if $selfhosted_supabase; then
            fed_networks+="
      - supabase_default"
            fed_env_base+="
      - SUPABASE_URL=http://supabase-kong:8000
      - USE_BULLMQ_QUEUE=true
      - DATABASE_URL=postgresql://postgres:${SUPABASE_PG_PASSWORD}@supabase-db:5432/postgres
      - DATABASE_POOL_URL=postgresql://postgres:${SUPABASE_PG_PASSWORD}@supabase-pooler:6543/postgres
      - REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379"
        fi

        compose+="
  federation-server:
    build:
      context: ./federation-backend
      dockerfile: Dockerfile
    container_name: harmony-federation-server
    restart: unless-stopped
    ports:
      - \"3001:3001\"
    env_file:
      - ./federation-backend/.env
    environment:
$fed_env_base
      - PORT=3001
      - FEDERATION_MODE=server
    healthcheck:
      test: [\"CMD\", \"node\", \"-e\", \"require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})\"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 15s
    networks:
$fed_networks
    depends_on:
      redis:
        condition: service_healthy

  federation-worker:
    build:
      context: ./federation-backend
      dockerfile: Dockerfile
    container_name: harmony-federation-worker
    restart: unless-stopped
    env_file:
      - ./federation-backend/.env
    environment:
$fed_env_base
      - FEDERATION_MODE=worker
    networks:
$fed_networks
    depends_on:
      redis:
        condition: service_healthy"
    fi

    # --- Redis container ---
    if $needs_redis; then
        compose+="

  redis:
    image: redis:7-alpine
    container_name: harmony-redis
    restart: unless-stopped
    volumes:
      - redis-data:/data
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    healthcheck:
      test: [\"CMD\", \"redis-cli\", \"-a\", \"${REDIS_PASSWORD}\", \"ping\"]
      interval: 10s
      timeout: 5s
      retries: 3
    networks:
      - harmony"
    fi

    # --- LiveKit ---
    if $ENABLE_VOICE; then
        compose+="

  livekit:
    image: livekit/livekit-server:latest
    container_name: harmony-livekit
    restart: unless-stopped
    ports:
      - \"7880:7880\"
      - \"7881:7881\"
      - \"7881:7881/udp\"
      - \"${LIVEKIT_UDP_PORT}:${LIVEKIT_UDP_PORT}/udp\"
      - \"3478:3478/udp\"
      - \"3478:3478/tcp\"
    volumes:
      - ./webrtc/livekit.yaml:/livekit.yaml:ro
    command: --config /livekit.yaml
    depends_on:
      - redis
    networks:
      - harmony"
    fi

    # --- Bot Gateway ---
    if $ENABLE_BOTS; then
        local bot_networks="      - harmony"
        local bot_env="      - NODE_ENV=production
      - PORT=3002"

        if $selfhosted_supabase; then
            bot_networks+="
      - supabase_default"
            bot_env+="
      - SUPABASE_URL=http://supabase-kong:8000"
        fi

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
$bot_env
    networks:
$bot_networks"
    fi

    # --- Bull Board (queue monitoring) ---
    if $ENABLE_MONITORING; then
        compose+="

  bull-board:
    build: ./bull-board
    container_name: harmony-bull-board
    restart: unless-stopped
    ports:
      - \"127.0.0.1:3003:3003\"
    environment:
      - REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379
      - BULL_BOARD_USER=\${BULL_BOARD_USER:-admin}
      - BULL_BOARD_PASSWORD=\${BULL_BOARD_PASSWORD:?Set BULL_BOARD_PASSWORD in .env}
      - BULL_BOARD_BASE_PATH=\${BULL_BOARD_BASE_PATH:-}
      - PORT=3003
    depends_on:
      - redis
    networks:
      - harmony"
    fi

    # --- Networks ---
    compose+="

networks:
  harmony:
    driver: bridge"

    if $selfhosted_supabase; then
        compose+="
  supabase_default:
    external: true"
    fi

    # --- Volumes ---
    if $needs_redis; then
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
        local skip_livekit=false
        local skip_bullboard=false

        if [[ -f /etc/nginx/sites-available/harmony ]]; then
            if ! prompt_yn "/etc/nginx/sites-available/harmony already exists. Overwrite?" "n"; then
                skip_app=true
            fi
        fi

        if $ENABLE_DOCS && [[ -f /etc/nginx/sites-available/harmony-docs ]]; then
            if ! prompt_yn "/etc/nginx/sites-available/harmony-docs already exists. Overwrite?" "n"; then
                skip_docs=true
            fi
        fi

        if $ENABLE_VOICE && [[ -f /etc/nginx/sites-available/livekit ]]; then
            if ! prompt_yn "/etc/nginx/sites-available/livekit already exists. Overwrite?" "n"; then
                skip_livekit=true
            fi
        fi

        if $ENABLE_MONITORING && [[ -f /etc/nginx/sites-available/bullboard ]]; then
            if ! prompt_yn "/etc/nginx/sites-available/bullboard already exists. Overwrite?" "n"; then
                skip_bullboard=true
            fi
        fi

        if ! $skip_app; then
            sudo cp "$PROJECT_DIR/dev/nginx-harmony.conf" /etc/nginx/sites-available/harmony
            sudo ln -sf /etc/nginx/sites-available/harmony /etc/nginx/sites-enabled/harmony
            print_success "Installed sites-available/harmony"
        fi

        if $ENABLE_DOCS && ! $skip_docs && [[ -f "$PROJECT_DIR/dev/nginx-docs.conf" ]]; then
            sudo cp "$PROJECT_DIR/dev/nginx-docs.conf" /etc/nginx/sites-available/harmony-docs
            sudo ln -sf /etc/nginx/sites-available/harmony-docs /etc/nginx/sites-enabled/harmony-docs
            print_success "Installed sites-available/harmony-docs"
        fi

        if $ENABLE_VOICE && ! $skip_livekit && [[ -f "$PROJECT_DIR/dev/nginx-livekit.conf" ]]; then
            sudo cp "$PROJECT_DIR/dev/nginx-livekit.conf" /etc/nginx/sites-available/livekit
            sudo ln -sf /etc/nginx/sites-available/livekit /etc/nginx/sites-enabled/livekit
            print_success "Installed sites-available/livekit"
        fi

        if $ENABLE_MONITORING && ! $skip_bullboard && [[ -f "$PROJECT_DIR/dev/nginx-bullboard.conf" ]]; then
            sudo cp "$PROJECT_DIR/dev/nginx-bullboard.conf" /etc/nginx/sites-available/bullboard
            sudo ln -sf /etc/nginx/sites-available/bullboard /etc/nginx/sites-enabled/bullboard
            print_success "Installed sites-available/bullboard"
            print_info "Remember to set up DNS and SSL for ${BOLD}${BULL_BOARD_SUBDOMAIN}${RESET}:"
            print_info "  sudo certbot certonly --nginx -d ${BULL_BOARD_SUBDOMAIN}"
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
    print_info "Obtains free SSL certificates before installing nginx configs."
    local cert_domains="${BOLD}$DOMAIN${RESET}"
    if $ENABLE_DOCS; then
        cert_domains+=", docs.$DOMAIN"
    fi
    print_info "Domains: $cert_domains"
    if $ENABLE_VOICE && [[ -n "$LIVEKIT_SUBDOMAIN" ]]; then
        print_info "LiveKit: ${BOLD}$LIVEKIT_SUBDOMAIN${RESET}"
    fi
    print_info "Uses standalone mode (temporarily binds port 80)."
    echo ""

    if prompt_yn "Run certbot?" "y"; then
        if require_cmd certbot; then
            # Stop nginx temporarily if it's running (certbot standalone needs port 80)
            local nginx_was_running=false
            if systemctl is-active --quiet nginx 2>/dev/null; then
                nginx_was_running=true
                sudo systemctl stop nginx 2>/dev/null || true
            fi

            # Main domain (+ docs subdomain if enabled)
            local certbot_domains="-d $DOMAIN"
            if $ENABLE_DOCS; then
                certbot_domains+=" -d docs.$DOMAIN"
            fi
            sudo certbot certonly --standalone $certbot_domains || {
                print_warn "Certbot failed for $DOMAIN. You can run it manually later:"
                printf "  ${CYAN}sudo certbot certonly --standalone %s${RESET}\n" "$certbot_domains"
            }

            # LiveKit subdomain needs its own cert
            if $ENABLE_VOICE && [[ -n "$LIVEKIT_SUBDOMAIN" ]]; then
                echo ""
                print_info "Obtaining SSL certificate for LiveKit subdomain..."
                sudo certbot certonly --standalone -d "$LIVEKIT_SUBDOMAIN" || {
                    print_warn "Certbot failed for $LIVEKIT_SUBDOMAIN. Run manually:"
                    printf "  ${CYAN}sudo certbot certonly --standalone -d %s${RESET}\n" "$LIVEKIT_SUBDOMAIN"
                }
            fi

            # Restart nginx if it was running
            if $nginx_was_running; then
                sudo systemctl start nginx 2>/dev/null || true
            fi
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

# ---------------------------------------------------------------------------
# Docker daemon log limits (prevent container logs from filling disk)
# ---------------------------------------------------------------------------
setup_docker_log_limits() {
    if [[ "$MODE" != "production" ]]; then
        return
    fi
    if ! require_cmd docker; then
        return
    fi

    echo ""
    printf "  ${BOLD}Configure Docker log limits?${RESET}\n"
    print_info "Container logs can fill the disk and affect the database. We recommend limiting them."
    print_info "This updates ${BOLD}/etc/docker/daemon.json${RESET} with max-size (e.g. 50m) and max-file (e.g. 3)."
    echo ""

    if ! prompt_yn "Configure Docker daemon log limits?" "y"; then
        return
    fi

    local daemon_json="/etc/docker/daemon.json"
    local max_size="50m"
    local max_file="3"

    if [[ ! -f "$daemon_json" ]]; then
        # Create new daemon.json
        sudo tee "$daemon_json" >/dev/null << EOF
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "$max_size",
    "max-file": "$max_file"
  }
}
EOF
        print_success "Created $daemon_json with log limits (max-size=$max_size, max-file=$max_file)"
    else
        # Merge into existing: ensure log-driver and log-opts exist (read via sudo)
        local tmp_read tmp_write
        tmp_read=$(mktemp)
        tmp_write=$(mktemp)
        sudo cat "$daemon_json" > "$tmp_read" 2>/dev/null || true
        if python3 -c "
import json
with open('$tmp_read') as f:
    try:
        d = json.load(f)
    except json.JSONDecodeError:
        d = {}
d['log-driver'] = 'json-file'
d.setdefault('log-opts', {})
d['log-opts']['max-size'] = '$max_size'
d['log-opts']['max-file'] = '$max_file'
with open('$tmp_write', 'w') as f:
    json.dump(d, f, indent=2)
" 2>/dev/null; then
            sudo cp "$tmp_write" "$daemon_json"
            print_success "Updated $daemon_json with log limits (max-size=$max_size, max-file=$max_file)"
        else
            print_warn "Could not merge into existing $daemon_json (python3 or JSON issue)."
            print_info "Add manually to $daemon_json:"
            printf "    ${CYAN}\"log-driver\": \"json-file\",${RESET}\n"
            printf "    ${CYAN}\"log-opts\": { \"max-size\": \"%s\", \"max-file\": \"%s\" }${RESET}\n" "$max_size" "$max_file"
            return
        fi
        rm -f "$tmp_read" "$tmp_write"
    fi

    echo ""
    print_info "Restart Docker for changes to take effect:"
    printf "    ${CYAN}sudo systemctl restart docker${RESET}\n"
    if prompt_yn "Restart Docker now?" "y"; then
        if sudo systemctl restart docker 2>/dev/null; then
            print_success "Docker restarted"
        else
            print_warn "Could not restart Docker. Run manually: sudo systemctl restart docker"
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
        print_info "Also: LiveKit (7880-7881), TURN (3478/udp, 5349), Media (${LIVEKIT_UDP_PORT}/udp)"
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
                sudo ufw allow ${LIVEKIT_UDP_PORT}/udp
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
    printf "  ${BOLD}Build frontend (static files)?${RESET}\n"
    print_info "The Vue app is built once into ${BOLD}dist/${RESET} - static HTML/JS/CSS."
    if $USE_DOCKER; then
        print_info "The nginx container will serve that folder; it does not build the app."
    fi
    print_info "Required for both Docker and native. Runs: npm ci && npm run build-only"
    echo ""

    if prompt_yn "Build frontend now?" "y"; then
        cd "$PROJECT_DIR"
        if require_cmd npm; then
            run_with_spinner "Installing frontend dependencies (npm ci)..." npm ci
            run_with_spinner "Building frontend..." npm run build-only

            # Copy dist to web root if it differs from the build output
            if [[ -n "$WEB_ROOT" && "$WEB_ROOT" != "$PROJECT_DIR/dist" && -d "$PROJECT_DIR/dist" ]]; then
                echo ""
                print_info "Deploying to ${BOLD}$WEB_ROOT${RESET}..."
                sudo mkdir -p "$WEB_ROOT"
                if require_cmd rsync; then
                    sudo rsync -a --delete "$PROJECT_DIR/dist/" "$WEB_ROOT/"
                else
                    sudo cp -a "$PROJECT_DIR/dist/"* "$WEB_ROOT/"
                fi
                sudo chown -R www-data:www-data "$WEB_ROOT"
                print_success "Static files deployed to $WEB_ROOT"
            fi

            # For native mode, also install backend deps
            if ! $USE_DOCKER; then
                if $ENABLE_FEDERATION && [[ -d "$PROJECT_DIR/federation-backend" ]]; then
                    echo ""
                    run_with_spinner "Installing federation-backend dependencies..." bash -c "cd $PROJECT_DIR/federation-backend && npm ci"
                    run_with_spinner "Building federation-backend..." bash -c "cd $PROJECT_DIR/federation-backend && npm run build-only"
                fi
                if $ENABLE_BOTS && [[ -d "$PROJECT_DIR/bot-gateway" ]]; then
                    run_with_spinner "Installing bot-gateway dependencies..." bash -c "cd $PROJECT_DIR/bot-gateway && npm ci"
                    run_with_spinner "Building bot-gateway..." bash -c "cd $PROJECT_DIR/bot-gateway && npm run build-only"
                fi
            fi
        else
            print_error "npm not found. Install Node.js first."
        fi
    fi
}

start_services() {
    if [[ "$MODE" == "production" ]] && ! $USE_DOCKER; then
        echo ""
        printf "  ${BOLD}Native deployment - manual service startup${RESET}\n"
        echo ""
        print_info "Start each service manually:"
        echo ""
        if $ENABLE_FEDERATION; then
            printf "    ${CYAN}cd federation-backend && npm ci && npm run build-only && npm start${RESET}\n"
        fi
        if $ENABLE_BOTS; then
            printf "    ${CYAN}cd bot-gateway && npm ci && npm run build-only && npm start${RESET}\n"
        fi
        if $ENABLE_VOICE; then
            printf "    ${CYAN}# Install LiveKit server: https://docs.livekit.io/home/self-hosting/local/${RESET}\n"
            printf "    ${CYAN}livekit-server --config webrtc/livekit.yaml${RESET}\n"
        fi
        echo ""
        print_info "Consider using pm2 or systemd to keep services running."
        printf "    ${CYAN}npm install -g pm2${RESET}\n"
        printf "    ${CYAN}pm2 start federation-backend/dist/index.js --name harmony-federation${RESET}\n"
        echo ""
        return
    fi

    echo ""
    printf "  ${BOLD}Start Harmony Services${RESET}\n"
    echo ""

    # Ensure Supabase is running first (self-hosted) - the Harmony compose
    # connects to the supabase_default network and needs it to exist.
    ensure_supabase_running

    if [[ "$MODE" == "production" ]]; then
        print_info "Building and starting: federation-server, federation-worker, redis, nginx..."
    else
        print_info "Runs: docker compose -f dev/docker-compose.yml up -d"
    fi
    echo ""

    if prompt_yn "Start services now?" "y"; then
        if require_cmd docker; then
            cd "$PROJECT_DIR"
            if [[ "$MODE" == "production" ]]; then
                if docker compose up -d --build --remove-orphans 2>&1; then
                    print_success "Docker services started"

                    # Verify federation containers are running
                    echo ""
                    sleep 3
                    local fed_ok=true
                    if $ENABLE_FEDERATION; then
                        if docker ps --format '{{.Names}}' | grep -q 'harmony-federation-server'; then
                            print_success "federation-server is running"
                        else
                            print_error "federation-server failed to start"
                            print_info "Check logs: ${CYAN}docker compose logs federation-server${RESET}"
                            fed_ok=false
                        fi
                        if docker ps --format '{{.Names}}' | grep -q 'harmony-federation-worker'; then
                            print_success "federation-worker is running"
                        else
                            print_error "federation-worker failed to start"
                            print_info "Check logs: ${CYAN}docker compose logs federation-worker${RESET}"
                            fed_ok=false
                        fi
                    fi
                    if docker ps --format '{{.Names}}' | grep -q 'harmony-redis'; then
                        print_success "redis is running"
                    else
                        print_error "redis failed to start"
                        fed_ok=false
                    fi
                    if ! $fed_ok; then
                        echo ""
                        print_info "Some services failed. Check logs with:"
                        printf "    ${CYAN}cd %s && docker compose logs -f${RESET}\n" "$PROJECT_DIR"
                    fi
                else
                    # Check if failure was due to missing supabase_default network
                    if [[ "$SUPABASE_MODE" == "selfhosted" ]] && \
                       ! docker network inspect supabase_default &>/dev/null 2>&1; then
                        print_warn "Docker compose failed because Supabase is not running."
                        print_info "Starting Supabase and retrying..."
                        echo ""
                        if start_supabase && docker compose up -d --build --remove-orphans 2>&1; then
                            print_success "Docker services started (after Supabase recovery)"
                        else
                            print_error "Docker compose still failing. Check the output above."
                            print_info "You can try running manually:"
                            printf "    ${CYAN}cd %s && docker compose up -d --build --remove-orphans${RESET}\n" "$PROJECT_DIR"
                        fi
                    else
                        print_error "Docker compose failed. Check the output above."
                        print_info "You can try running manually:"
                        printf "    ${CYAN}cd %s && docker compose up -d --build --remove-orphans${RESET}\n" "$PROJECT_DIR"
                    fi
                fi
            else
                cd dev
                if docker compose up -d --build 2>&1; then
                    print_success "Docker services started"
                else
                    print_error "Docker compose failed. Check the output above."
                fi
                cd "$PROJECT_DIR"
            fi
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
    if $ENABLE_MONITORING; then
        printf "    ${CHECK} Queue Monitoring ${DIM}(Bull Board - ${BULL_BOARD_SUBDOMAIN})${RESET}\n"
    else
        printf "    ${CROSS} Queue Monitoring ${DIM}(disabled)${RESET}\n"
    fi
    echo ""

    printf "  ${BOLD}Generated Files${RESET}\n"
    echo ""
    [[ -f "$PROJECT_DIR/.env" ]] && printf "    ${CHECK} .env\n"
    [[ -n "$SUPABASE_PROJECT_DIR" ]] && [[ -d "$SUPABASE_PROJECT_DIR" ]] && printf "    ${CHECK} Supabase project: %s\n" "$SUPABASE_PROJECT_DIR"
    [[ -f "$PROJECT_DIR/federation-backend/.env" ]] && printf "    ${CHECK} federation-backend/.env\n"
    [[ -f "$PROJECT_DIR/bot-gateway/.env" ]] && printf "    ${CHECK} bot-gateway/.env\n"
    [[ -f "$PROJECT_DIR/webrtc/livekit.yaml" ]] && printf "    ${CHECK} webrtc/livekit.yaml\n"
    [[ -f "$PROJECT_DIR/docker-compose.yml" ]] && printf "    ${CHECK} docker-compose.yml\n"
    [[ -f "$PROJECT_DIR/dev/nginx-harmony.conf" ]] && printf "    ${CHECK} dev/nginx-harmony.conf\n"
    [[ -f "$PROJECT_DIR/dev/nginx-livekit.conf" ]] && printf "    ${CHECK} dev/nginx-livekit.conf\n"
    [[ -f "$PROJECT_DIR/dev/nginx-docs.conf" ]] && printf "    ${CHECK} dev/nginx-docs.conf\n"
    if [[ -n "$WEB_ROOT" && "$WEB_ROOT" != "$PROJECT_DIR/dist" ]]; then
        printf "    ${CHECK} Web root: ${BOLD}%s${RESET}\n" "$WEB_ROOT"
        print_info "After rebuilding, re-deploy with:"
        printf "      ${CYAN}sudo cp -a dist/* %s/ && sudo chown -R www-data:www-data %s${RESET}\n" "$WEB_ROOT" "$WEB_ROOT"
    fi
    echo ""

    if [[ -n "$SUPABASE_DASHBOARD_PASSWORD" ]]; then
        printf "  ${BOLD}Supabase Studio${RESET} ${DIM}(save these!)${RESET}\n"
        echo ""
        if [[ -n "$SUPABASE_SITE_DOMAIN" ]]; then
            printf "    URL:        ${CYAN}https://%s${RESET}\n" "$SUPABASE_SITE_DOMAIN"
        fi
        printf "    Username:   ${CYAN}supabase${RESET}\n"
        printf "    Password:   ${CYAN}%s${RESET}\n" "$SUPABASE_DASHBOARD_PASSWORD"
        echo ""
        print_info "All keys (JWT, anon, service_role) are saved in:"
        printf "      ${CYAN}%s/.env${RESET}\n" "$SUPABASE_PROJECT_DIR"
        echo ""
    fi

    if $ENABLE_VOICE; then
        printf "  ${BOLD}LiveKit (Voice/Video)${RESET} ${DIM}(save these!)${RESET}\n"
        echo ""
        printf "    API Key:    ${CYAN}%s${RESET}\n" "$LIVEKIT_API_KEY"
        printf "    API Secret: ${CYAN}%s${RESET}\n" "$LIVEKIT_API_SECRET"
        printf "    UDP Mux:    ${CYAN}port %s${RESET} (single port, all media)\n" "$LIVEKIT_UDP_PORT"
        echo ""
        print_info "These are saved in federation-backend/.env and webrtc/livekit.yaml"
        print_info "Scaling is limited by CPU/bandwidth, not port count."
        print_info "For large deployments, run LiveKit on a dedicated VPS."
    fi

    if [[ -n "${DATABASE_POOL_URL:-}" ]]; then
        echo ""
        printf "  ${BOLD}Connection Pooling (Supavisor)${RESET}\n"
        echo ""
        printf "    ${CHECK} DATABASE_POOL_URL is configured (port 6543, transaction mode)\n"
        print_info "Supavisor pools hundreds of connections into a small PG connection pool."
    fi

    print_line 50
    echo ""

    if [[ "$MODE" == "production" ]]; then
        printf "  ${BOLD}Next Steps${RESET}\n"
        echo ""
        local step=1
        if [[ "$SUPABASE_MODE" == "selfhosted" ]] && [[ -n "$SUPABASE_PROJECT_DIR" ]]; then
            if ! $DB_SCHEMA_LOADED; then
                printf "    ${DIM}%d.${RESET} Start Supabase: ${CYAN}cd %s && docker compose up -d${RESET}\n" "$step" "$SUPABASE_PROJECT_DIR"
                ((++step))
                printf "    ${DIM}%d.${RESET} Load schema: ${CYAN}./scripts/install.sh --schema-setup-only${RESET}\n" "$step"
                ((++step))
                printf "    ${DIM}%d.${RESET} Start Harmony: ${CYAN}cd %s && docker compose up -d --build${RESET}\n" "$step" "$PROJECT_DIR"
                ((++step))
            fi
        fi
        printf "    ${DIM}%d.${RESET} Verify your DNS points to this server\n" "$step"
        ((++step))
        printf "    ${DIM}%d.${RESET} Visit ${CYAN}https://%s${RESET} and register\n" "$step" "$DOMAIN"
        ((++step))
        printf "    ${DIM}%d.${RESET} First registered user automatically becomes admin\n" "$step"
        echo ""
    else
        printf "  ${BOLD}Next Steps${RESET}\n"
        echo ""
        printf "    ${DIM}1.${RESET} Start Vite dev server: ${CYAN}npm run dev -- --host 0.0.0.0${RESET}\n"
        printf "    ${DIM}2.${RESET} Visit ${CYAN}https://har.mony.local${RESET}\n"
        printf "    ${DIM}3.${RESET} Register your first account\n"
        echo ""
    fi

    printf "  ${DIM}For the full manual guide: docs/self-hosting.md (https://docs.mony.lol/self-hosting)${RESET}\n"
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
# Database schema setup
# ---------------------------------------------------------------------------
setup_database() {
    print_box "Database Schema"

    if [[ "$SUPABASE_MODE" == "cloud" ]]; then
        print_info "For Supabase Cloud, run the schema via the SQL Editor or psql."
        echo ""
        print_info "Option A: ${BOLD}Supabase Dashboard → SQL Editor${RESET} - run files from db_schema/init/ then db_schema/migrations/ in order."
        echo ""
        print_info "Option B: Install PostgreSQL client, then from the project root:"
        echo ""
        printf "    ${CYAN}cd db_schema/init && psql \"%s\" -f init.sql${RESET}\n" "$DATABASE_URL"
        printf "    ${DIM}# init.sql includes the other init files via \\\\i; must run from db_schema/init${RESET}\n"
        echo ""
        printf "    ${CYAN}cd - && for f in db_schema/migrations/*.sql; do psql \"%s\" -f \"\$f\"; done${RESET}\n" "$DATABASE_URL"
        echo ""
        return
    fi

    # Self-hosted: determine connection params
    local db_host="localhost"
    local db_port="5432"
    local db_user="supabase_admin"
    local db_name="postgres"

    print_info "The database schema needs to be loaded into Supabase."
    print_info "This runs ${BOLD}init.sql${RESET} (full schema) and then all migrations."
    echo ""

    if ! $SCHEMA_SETUP_ONLY && ! prompt_yn "Set up database schema now?" "y"; then
        echo ""
        print_info "Run it manually (init.sql uses \\i to include other files - run from db_schema/init):"
        printf "    ${CYAN}cd db_schema/init && PGPASSWORD=... psql -h %s -p %s -U %s -d %s -f init.sql${RESET}\n" "$db_host" "$db_port" "$db_user" "$db_name"
        printf "    ${CYAN}cd - && for f in db_schema/migrations/*.sql; do psql -h %s -p %s -U %s -d %s -f \"\$f\"; done${RESET}\n" "$db_host" "$db_port" "$db_user" "$db_name"
        echo ""
        return
    fi

    local pg_pw="${SUPABASE_PG_PASSWORD:-postgres}"
    local use_docker_exec=false
    local db_container="${SUPABASE_DB_CONTAINER:-supabase-db}"

    # Ensure Supabase is running (self-hosted) before trying to connect
    ensure_supabase_running

    # Discover DB container if default doesn't exist (e.g. project in "spacious" → spacious-db)
    if require_cmd docker && ! docker inspect "$db_container" &>/dev/null 2>/dev/null; then
        local try_name
        for try_name in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '\-db$|_db_1$' || true); do
            if docker inspect "$try_name" &>/dev/null; then
                db_container="$try_name"
                break
            fi
        done
    fi

    # Determine how to run psql: docker exec into db container (best), local psql, or fallback
    if require_cmd docker && docker inspect "$db_container" &>/dev/null; then
        print_info "Found running ${BOLD}$db_container${RESET} container - will use docker exec."
        use_docker_exec=true
    elif require_cmd psql; then
        print_info "Using local psql client."
    else
        print_warn "Neither supabase-db container nor psql found."
        if require_cmd docker; then
            if [[ "$SUPABASE_MODE" == "selfhosted" ]] && [[ -n "$SUPABASE_PROJECT_DIR" ]]; then
                print_info "Attempting to start Supabase..."
                if start_supabase; then
                    db_container="${SUPABASE_DB_CONTAINER:-supabase-db}"
                    if docker inspect "$db_container" &>/dev/null; then
                        print_info "Found running ${BOLD}$db_container${RESET} container - will use docker exec."
                        use_docker_exec=true
                    fi
                fi
            fi
            if ! $use_docker_exec; then
                print_info "Start Supabase first, then re-run:"
                printf "    ${CYAN}./scripts/install.sh --schema-setup-only${RESET}\n"
                echo ""
                return
            fi
        else
            print_warn "Install the PostgreSQL client:"
            local pkg_mgr
            pkg_mgr=$(detect_pkg_manager)
            case "$pkg_mgr" in
                apt) printf "    ${CYAN}sudo apt install postgresql-client${RESET}\n" ;;
                dnf) printf "    ${CYAN}sudo dnf install postgresql${RESET}\n" ;;
                pacman) printf "    ${CYAN}sudo pacman -S postgresql-libs${RESET}\n" ;;
                brew) printf "    ${CYAN}brew install libpq${RESET}\n" ;;
                *) printf "    ${CYAN}Install postgresql-client for your platform${RESET}\n" ;;
            esac
            echo ""
            return
        fi
    fi

    # Helper: run psql command via docker exec or local psql (PGPASSWORD used by both)
    run_psql() {
        if $use_docker_exec; then
            docker exec -e PGPASSWORD="$pg_pw" -i "$db_container" psql -U "$db_user" -d "$db_name" "$@"
        else
            PGPASSWORD="$pg_pw" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" "$@"
        fi
    }

    # Test connection (with retries - Supabase init can take 60–90+ seconds on first boot)
    print_info "Testing database connection (Supabase init may take 1–2 minutes)..."
    try_db_connect() {
        run_psql -c "SELECT 1" &>/dev/null
    }

    local connected=false
    local auto_retries=12
    local retry_sleep=10
    for ((i=1; i<=auto_retries; i++)); do
        if try_db_connect; then
            connected=true
            break
        fi
        if [[ $i -lt $auto_retries ]]; then
            print_info "Waiting ${retry_sleep}s before retry ($i/$auto_retries)..."
            sleep "$retry_sleep"
        fi
    done

    # If supabase_admin fails, try postgres (Supabase roles.sql has a known bug leaving supabase_admin without password)
    if ! $connected && [[ "$db_user" == "supabase_admin" ]]; then
        print_info "supabase_admin failed - trying postgres (password from .env)..."
        db_user="postgres"
        for ((i=1; i<=3; i++)); do
            if try_db_connect; then
                connected=true
                print_success "Connected as postgres"
                print_info "supabase_admin has a known init bug in some Supabase postgres images (roles.sql omits it); analytics may fail. Schema will load."
                break
            fi
            [[ $i -lt 3 ]] && sleep 5
        done
    fi

    while ! $connected; do
        print_error "Cannot connect to database"
        print_info "Supabase may still be starting. You can retry or skip and run schema setup later."
        echo ""
        if prompt_yn "Retry in 10 seconds?" "y"; then
            print_info "Waiting 10 seconds..."
            sleep 10
            # Re-check if container appeared
            if $use_docker_exec || (require_cmd docker && docker inspect "$db_container" &>/dev/null); then
                use_docker_exec=true
            fi
            try_db_connect && connected=true
        else
            if prompt_yn "Skip and run schema setup later?" "y"; then
                print_info "Run when Supabase is ready: ${CYAN}./scripts/install.sh --schema-setup-only${RESET}"
                echo ""
                return
            fi
        fi
    done

    print_success "Database connection OK"

    # Copy schema files into the container (init.sql uses \i for relative includes)
    if $use_docker_exec; then
        print_info "Copying schema files into container..."
        docker cp "$PROJECT_DIR/db_schema" "$db_container:/tmp/db_schema"
    fi

    # Run init schema
    echo ""
    print_info "Loading init schema..."
    local init_ec=0
    if $use_docker_exec; then
        docker exec -e PGPASSWORD="$pg_pw" -w /tmp/db_schema/init "$db_container" psql -U "$db_user" -d "$db_name" -f init.sql 2>&1 | tail -15
        init_ec=${PIPESTATUS[0]}
    else
        (cd "$PROJECT_DIR/db_schema/init" && PGPASSWORD="$pg_pw" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -f init.sql) 2>&1 | tail -15
        init_ec=${PIPESTATUS[0]}
    fi
    if [[ $init_ec -ne 0 ]]; then
        print_error "Schema loading failed. Check errors above."
        $use_docker_exec && docker exec "$db_container" rm -rf /tmp/db_schema 2>/dev/null || true
        return
    fi
    print_success "Init schema loaded"

    # Run migrations in order
    local migration_count=0
    local migration_files
    migration_files=$(find "$PROJECT_DIR/db_schema/migrations" -name '*.sql' -type f 2>/dev/null | sort)

    if [[ -n "$migration_files" ]]; then
        echo ""
        print_info "Running migrations..."
        while IFS= read -r migration; do
            local fname
            fname=$(basename "$migration")
            local mig_ec=0
            if $use_docker_exec; then
                docker exec -e PGPASSWORD="$pg_pw" "$db_container" psql -U "$db_user" -d "$db_name" -f "/tmp/db_schema/migrations/$fname" &>/dev/null
                mig_ec=$?
            else
                PGPASSWORD="$pg_pw" psql -h "$db_host" -p "$db_port" -U "$db_user" -d "$db_name" -f "$migration" &>/dev/null
                mig_ec=$?
            fi
            if [[ $mig_ec -eq 0 ]]; then
                ((++migration_count))
            else
                print_warn "Migration may have had issues: $fname"
            fi
        done <<< "$migration_files"
        print_success "Ran $migration_count migrations"
    fi

    # Clean up copied files
    if $use_docker_exec; then
        docker exec "$db_container" rm -rf /tmp/db_schema 2>/dev/null || true
    fi

    # Tell PostgREST to reload its schema cache so it picks up the new tables
    echo "NOTIFY pgrst, 'reload schema';" | run_psql &>/dev/null && \
        print_success "PostgREST schema cache reloaded" || true

    # Set instance domain, name, and link preview backend URL
    echo ""
    print_info "Configuring instance_config..."
    local link_preview_url=""
    if $ENABLE_FEDERATION; then
        if [[ "$DOMAIN" != "localhost" ]] && [[ "$DOMAIN" != "127.0.0.1" ]]; then
            link_preview_url="https://$DOMAIN"
        else
            link_preview_url="https://har.mony.local"
        fi
    fi
    local update_cmd="UPDATE public.instance_config SET config_value = '\"$DOMAIN\"' WHERE config_key = 'domain';
         UPDATE public.instance_config SET config_value = '\"$INSTANCE_NAME\"' WHERE config_key = 'instance_name';"
    if [[ -n "$link_preview_url" ]]; then
        update_cmd+="
         UPDATE public.instance_config
         SET config_value = jsonb_set(config_value::jsonb, '{link_preview_backend_url}', '\"$link_preview_url\"'::jsonb, true)::text
         WHERE config_key = 'federation_settings';"
    fi
    local update_ec=0
    echo "$update_cmd" | run_psql &>/dev/null
    update_ec=$?
    if [[ $update_ec -eq 0 ]]; then
        print_success "Set domain=${BOLD}$DOMAIN${RESET}, name=${BOLD}$INSTANCE_NAME${RESET}"
        if [[ -n "$link_preview_url" ]]; then
            print_success "Set link_preview_backend_url=${BOLD}$link_preview_url${RESET}"
        fi
    else
        print_warn "Could not update instance_config - set manually in the admin panel"
    fi

    DB_SCHEMA_LOADED=true
    echo ""
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

        setup_ssl
        install_nginx_config
        setup_firewall
        setup_docker_log_limits
        build_frontend
        start_services
        setup_database
    else
        print_box "Local Dev Setup"

        setup_local_hosts
        setup_local_certs
        start_services
        setup_database
    fi

    show_summary
}

# ---------------------------------------------------------------------------
# --move-dist: build frontend (unless --no-build) and copy dist to web root
# ---------------------------------------------------------------------------
run_move_dist() {
    local do_build=true
    for a in "$@"; do
        [[ "$a" == "--no-build" ]] && do_build=false
    done

    echo ""
    print_box "Deploy Frontend to Web Root"
    print_info "Project: ${BOLD}$PROJECT_DIR${RESET}"
    echo ""

    # Same logic as generate_nginx_config: nginx can't read /root/
    local web_root
    if [[ "$PROJECT_DIR" == /root/* ]]; then
        web_root="/var/www/harmony"
        print_info "Project is under /root/ - deploying to ${BOLD}$web_root${RESET}"
    else
        web_root="$PROJECT_DIR/dist"
        print_info "Web root: ${BOLD}$web_root${RESET} (same as dist - no copy needed)"
        if $do_build; then
            cd "$PROJECT_DIR"
            if require_cmd npm; then
                run_with_spinner "Installing dependencies (npm ci)..." npm ci
                run_with_spinner "Building frontend..." npm run build-only
                print_success "Build complete. Nginx already serves from $web_root"
            fi
            return
        else
            print_success "No copy needed; nginx serves dist directly."
            return
        fi
    fi

    if $do_build; then
        cd "$PROJECT_DIR"
        if ! require_cmd npm; then
            print_error "npm not found. Install Node.js first."
            return 1
        fi
        run_with_spinner "Installing dependencies (npm ci)..." npm ci
        run_with_spinner "Building frontend..." npm run build-only
    fi

    if [[ ! -d "$PROJECT_DIR/dist" ]]; then
        print_error "dist/ not found. Run without --no-build to build first."
        return 1
    fi

    echo ""
    print_info "Deploying to ${BOLD}$web_root${RESET}..."
    sudo mkdir -p "$web_root"
    if require_cmd rsync; then
        sudo rsync -a --delete "$PROJECT_DIR/dist/" "$web_root/"
    else
        sudo cp -a "$PROJECT_DIR/dist/"* "$web_root/"
    fi
    sudo chown -R www-data:www-data "$web_root"
    print_success "Static files deployed to $web_root"
    echo ""
    print_info "Reload nginx if needed: ${CYAN}sudo systemctl reload nginx${RESET}"
}

# ---------------------------------------------------------------------------
# --schema-setup-only: load config from .env and run only database schema setup
# ---------------------------------------------------------------------------
run_schema_setup_only() {
    local env_file="$PROJECT_DIR/.env"
    local fed_env="$PROJECT_DIR/federation-backend/.env"
    local parent_dir
    parent_dir="$(dirname "$PROJECT_DIR")"

    echo ""
    print_box "Schema Setup Only"
    print_info "Reading config from installer-generated .env files."
    echo ""

    # 1. Read DOMAIN and INSTANCE_NAME from the Harmony .env
    if [[ -f "$env_file" ]]; then
        while IFS= read -r line; do
            [[ "$line" =~ ^VITE_INSTANCE_DOMAIN= ]] && DOMAIN="${line#VITE_INSTANCE_DOMAIN=}"
            [[ "$line" =~ ^VITE_INSTANCE_NAME= ]] && INSTANCE_NAME="${line#VITE_INSTANCE_NAME=}"
        done < <(grep -E '^VITE_INSTANCE_DOMAIN=|^VITE_INSTANCE_NAME=' "$env_file" 2>/dev/null || true)
        DOMAIN="${DOMAIN//\"/}"
        INSTANCE_NAME="${INSTANCE_NAME//\"/}"
    fi

    # 2. Find the Supabase project .env and read POSTGRES_PASSWORD from it
    #    The installer creates it as a sibling dir (e.g. ../supabase-project/.env, ../spacious/.env)
    local supabase_env=""
    for candidate in "$parent_dir"/supabase-project/.env "$parent_dir"/supabase/.env "$parent_dir"/supabase-docker/.env "$parent_dir"/spacious/.env; do
        if [[ -f "$candidate" ]]; then
            supabase_env="$candidate"
            break
        fi
    done

    if [[ -n "$supabase_env" ]]; then
        print_info "Found Supabase .env at: ${BOLD}$supabase_env${RESET}"
        SUPABASE_PROJECT_DIR="$(dirname "$supabase_env")"
        local pw_line
        pw_line=$(grep '^POSTGRES_PASSWORD=' "$supabase_env" 2>/dev/null || true)
        if [[ -n "$pw_line" ]]; then
            SUPABASE_PG_PASSWORD="${pw_line#POSTGRES_PASSWORD=}"
            SUPABASE_PG_PASSWORD="${SUPABASE_PG_PASSWORD//\"/}"
        fi
    fi

    # 3. Fall back: try parsing DATABASE_URL from federation-backend/.env
    if [[ -z "$SUPABASE_PG_PASSWORD" ]] && [[ -f "$fed_env" ]]; then
        local db_url_line
        db_url_line=$(grep '^DATABASE_URL=' "$fed_env" 2>/dev/null || true)
        if [[ -n "$db_url_line" ]]; then
            DATABASE_URL="${db_url_line#DATABASE_URL=}"
            # Extract password from postgresql://user:PASSWORD@host:port/db
            local pw_from_url
            pw_from_url=$(echo "$DATABASE_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
            if [[ -n "$pw_from_url" ]]; then
                SUPABASE_PG_PASSWORD="$pw_from_url"
            fi
        fi
    fi

    # Defaults
    DOMAIN="${DOMAIN:-localhost}"
    INSTANCE_NAME="${INSTANCE_NAME:-Harmony}"
    SUPABASE_MODE="selfhosted"
    MODE="production"
    SCHEMA_SETUP_ONLY=true

    # 4. If still no password, prompt
    if [[ -z "$SUPABASE_PG_PASSWORD" ]]; then
        print_warn "Could not find Postgres password in Supabase .env or DATABASE_URL."
        print_info "Check your Supabase project's .env for POSTGRES_PASSWORD."
        SUPABASE_PG_PASSWORD=$(prompt_input "Supabase Postgres password" "")
        [[ -z "$SUPABASE_PG_PASSWORD" ]] && SUPABASE_PG_PASSWORD="postgres"
    else
        print_success "Found Postgres password"
    fi

    echo ""
    print_info "Domain: ${BOLD}$DOMAIN${RESET}  |  Instance: ${BOLD}$INSTANCE_NAME${RESET}"
    echo ""

    setup_database
}

# ---------------------------------------------------------------------------
# --regenerate-keys / --regenerate-all: regenerate Supabase keys in-place
# ---------------------------------------------------------------------------
run_regenerate_keys() {
    local include_passwords="$1"  # "true" to also regenerate passwords
    shift
    local supabase_folder="$1"   # optional: e.g. "spacious" → look in ../spacious/.env

    echo ""
    print_box "Regenerate Supabase Keys"

    local env_file="$PROJECT_DIR/.env"
    local fed_env="$PROJECT_DIR/federation-backend/.env"
    local bot_env="$PROJECT_DIR/bot-gateway/.env"
    local parent_dir
    parent_dir="$(dirname "$PROJECT_DIR")"

    # Find the Supabase project .env (custom folder first if provided, then defaults)
    local supabase_env=""
    if [[ -n "$supabase_folder" ]]; then
        if [[ -f "$parent_dir/$supabase_folder/.env" ]]; then
            supabase_env="$parent_dir/$supabase_folder/.env"
        elif [[ -f "$supabase_folder/.env" ]]; then
            supabase_env="$supabase_folder/.env"
        fi
    fi
    if [[ -z "$supabase_env" ]]; then
        for candidate in "$parent_dir"/supabase-project/.env "$parent_dir"/supabase/.env "$parent_dir"/supabase-docker/.env; do
            if [[ -f "$candidate" ]]; then
                supabase_env="$candidate"
                break
            fi
        done
    fi

    if [[ -z "$supabase_env" ]]; then
        print_error "Could not find Supabase project .env"
        print_info "Looked in: $parent_dir/supabase-project/, supabase/, supabase-docker/"
        if [[ -n "$supabase_folder" ]]; then
            print_info "Also tried: $parent_dir/$supabase_folder/, $supabase_folder/"
        fi
        print_info "Usage: ./scripts/install.sh --regenerate-all [supabase-folder-name]"
        print_info "Example: ./scripts/install.sh --regenerate-all spacious"
        return 1
    fi

    print_info "Supabase .env: ${BOLD}$supabase_env${RESET}"
    echo ""

    # Read existing postgres password (needed for DATABASE_URL if not regenerating passwords)
    local existing_pg_pw=""
    existing_pg_pw=$(grep '^POSTGRES_PASSWORD=' "$supabase_env" 2>/dev/null | head -1 | cut -d= -f2-)
    existing_pg_pw="${existing_pg_pw//\"/}"

    # Generate new JWT secret and keys
    local new_jwt_secret
    new_jwt_secret=$(openssl rand -base64 48 | tr -d '\n')
    local new_anon_key
    new_anon_key=$(generate_supabase_jwt "anon" "$new_jwt_secret")
    local new_service_key
    new_service_key=$(generate_supabase_jwt "service_role" "$new_jwt_secret")

    local new_vault_key
    new_vault_key=$(openssl rand -hex 16)
    local new_pg_meta_crypto
    new_pg_meta_crypto=$(openssl rand -hex 16)
    local new_secret_key_base
    new_secret_key_base=$(openssl rand -base64 48 | tr -d '\n')
    local new_logflare_public
    new_logflare_public=$(openssl rand -hex 32)
    local new_logflare_private
    new_logflare_private=$(openssl rand -hex 32)

    # Update Supabase .env - keys always (must match Supabase's expected var names)
    sed -i.bak \
        -e "s|JWT_SECRET=.*|JWT_SECRET=$new_jwt_secret|" \
        -e "s|ANON_KEY=.*|ANON_KEY=$new_anon_key|" \
        -e "s|SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$new_service_key|" \
        -e "s|SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$new_secret_key_base|" \
        -e "s|VAULT_ENC_KEY=.*|VAULT_ENC_KEY=$new_vault_key|" \
        -e "s|PG_META_CRYPTO_KEY=.*|PG_META_CRYPTO_KEY=$new_pg_meta_crypto|" \
        -e "s|LOGFLARE_PUBLIC_ACCESS_TOKEN=.*|LOGFLARE_PUBLIC_ACCESS_TOKEN=$new_logflare_public|" \
        -e "s|LOGFLARE_PRIVATE_ACCESS_TOKEN=.*|LOGFLARE_PRIVATE_ACCESS_TOKEN=$new_logflare_private|" \
        "$supabase_env"
    rm -f "${supabase_env}.bak"
    print_success "Updated JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY, SECRET_KEY_BASE, VAULT_ENC_KEY, PG_META_CRYPTO_KEY, LOGFLARE_*"

    local pg_pw="${existing_pg_pw}"

    if [[ "$include_passwords" == "true" ]]; then
        pg_pw=$(openssl rand -hex 24)
        local new_dashboard_pw
        new_dashboard_pw=$(openssl rand -hex 16)

        sed -i.bak \
            -e "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pg_pw|" \
            -e "s|DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$new_dashboard_pw|" \
            "$supabase_env"
        rm -f "${supabase_env}.bak"
        print_success "Updated POSTGRES_PASSWORD, DASHBOARD_PASSWORD"
        echo ""
        printf "    ${BOLD}New Supabase Studio password:${RESET} ${CYAN}%s${RESET}\n" "$new_dashboard_pw"
        printf "    ${BOLD}New Postgres password:${RESET}        ${CYAN}%s${RESET}\n" "$pg_pw"
        echo ""
        print_warn "If the DB was already initialized, Postgres still uses the OLD password."
        print_info "Supabase restricts superuser - ALTER ROLE does not work. You must remove the DB volume and start fresh:"
        printf "    ${CYAN}cd %s && docker compose down -v && docker compose up -d${RESET}\n" "$(dirname "$supabase_env")"
        print_info "(-v removes volumes; DB will reinitialize with the new password. Re-run schema/migrations.)"
        echo ""
    fi

    # Update Harmony frontend .env
    if [[ -f "$env_file" ]]; then
        sed -i.bak \
            -e "s|VITE_SUPABASE_ANON_KEY=.*|VITE_SUPABASE_ANON_KEY=$new_anon_key|" \
            "$env_file"
        rm -f "${env_file}.bak"
        print_success "Updated .env (VITE_SUPABASE_ANON_KEY)"
    fi

    # Update federation-backend .env
    if [[ -f "$fed_env" ]]; then
        sed -i.bak \
            -e "s|SUPABASE_ANON_KEY=.*|SUPABASE_ANON_KEY=$new_anon_key|" \
            -e "s|SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$new_service_key|" \
            "$fed_env"
        if [[ "$include_passwords" == "true" ]]; then
            # Update DATABASE_URL password
            sed -i.bak2 \
                -e "s|postgresql://[^:]*:[^@]*@|postgresql://postgres:${pg_pw}@|" \
                "$fed_env"
            rm -f "${fed_env}.bak2"
        fi
        rm -f "${fed_env}.bak"
        print_success "Updated federation-backend/.env"
    fi

    # Update bot-gateway .env
    if [[ -f "$bot_env" ]]; then
        sed -i.bak \
            -e "s|SUPABASE_ANON_KEY=.*|SUPABASE_ANON_KEY=$new_anon_key|" \
            -e "s|SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$new_service_key|" \
            "$bot_env"
        rm -f "${bot_env}.bak"
        print_success "Updated bot-gateway/.env"
    fi

    # Update Redis password in livekit.yaml and docker-compose.yml
    if [[ "$include_passwords" == "true" ]]; then
        local new_redis_pw
        new_redis_pw=$(openssl rand -hex 24)

        local livekit_cfg="$PROJECT_DIR/webrtc/livekit.yaml"
        if [[ -f "$livekit_cfg" ]]; then
            sed -i.bak -e "s|password:.*|password: $new_redis_pw|" "$livekit_cfg"
            rm -f "${livekit_cfg}.bak"
            print_success "Updated webrtc/livekit.yaml (Redis password)"
        fi

        local compose_cfg="$PROJECT_DIR/docker-compose.yml"
        if [[ -f "$compose_cfg" ]]; then
            sed -i.bak \
                -e "s|--requirepass .*|--requirepass $new_redis_pw|" \
                -e "s|-a.*ping|-a\", \"$new_redis_pw\", \"ping|" \
                "$compose_cfg"
            rm -f "${compose_cfg}.bak"
            print_success "Updated docker-compose.yml (Redis password)"
        fi

        if [[ -f "$env_file" ]]; then
            sed -i.bak -e "s|REDIS_PASSWORD=.*|REDIS_PASSWORD=$new_redis_pw|" "$env_file"
            rm -f "${env_file}.bak"
        fi
    fi

    echo ""
    print_line 50
    echo ""
    print_warn "You must restart all services for new keys to take effect:"
    echo ""
    local supabase_dir
    supabase_dir="$(dirname "$supabase_env")"
    printf "    ${CYAN}cd %s && docker compose down && docker compose up -d${RESET}\n" "$supabase_dir"
    printf "    ${CYAN}cd %s && docker compose down && docker compose up -d${RESET}\n" "$PROJECT_DIR"
    echo ""
    if [[ "$include_passwords" == "true" ]]; then
        print_warn "Postgres password changed - if analytics fails with invalid_password, remove DB volume and restart:"
        printf "    ${CYAN}cd %s && docker compose down -v && docker compose up -d${RESET}\n" "$supabase_dir"
        echo ""
    fi
    print_info "Then rebuild the frontend (new anon key is baked into the build):"
    printf "    ${CYAN}npm run build-only && ./scripts/install.sh --move-dist --no-build${RESET}\n"
    echo ""
}

# Parse args for standalone flags
SCHEMA_SETUP_ONLY_ARG=
MOVE_DIST_ARG=
REGEN_KEYS_ARG=
REGEN_ALL_ARG=
ARGS=()
for arg in "$@"; do
    if [[ "$arg" == "--schema-setup-only" ]]; then
        SCHEMA_SETUP_ONLY_ARG=1
    elif [[ "$arg" == "--move-dist" ]]; then
        MOVE_DIST_ARG=1
        ARGS+=("$arg")
    elif [[ "$arg" == "--regenerate-keys" ]]; then
        REGEN_KEYS_ARG=1
    elif [[ "$arg" == "--regenerate-all" || "$arg" == "--regenerate-all-keys-and-passwords" ]]; then
        REGEN_ALL_ARG=1
    else
        ARGS+=("$arg")
    fi
done

if [[ -n "$SCHEMA_SETUP_ONLY_ARG" ]]; then
    run_schema_setup_only
elif [[ -n "$MOVE_DIST_ARG" ]]; then
    run_move_dist "${ARGS[@]}"
elif [[ -n "$REGEN_KEYS_ARG" ]]; then
    run_regenerate_keys "false" "${ARGS[0]:-}"
elif [[ -n "$REGEN_ALL_ARG" ]]; then
    run_regenerate_keys "true" "${ARGS[0]:-}"
else
    main "${ARGS[@]}"
fi
