#!/usr/bin/env bash
# =============================================================================
# Harmony API & Realtime Benchmark Script
# =============================================================================
# Tests Supabase REST, Realtime (WebSocket), and federation API throughput.
#
# Two modes:
#   1. Quick smoke test (curl-based, zero dependencies)
#   2. Full load test (requires k6: https://grafana.com/docs/k6/latest/set-up/install-k6/)
#
# Usage:
#   ./scripts/benchmark-api.sh                    # interactive
#   ./scripts/benchmark-api.sh --mode quick       # curl smoke test
#   ./scripts/benchmark-api.sh --mode full        # k6 load test
#   ./scripts/benchmark-api.sh --help
#
# Environment overrides (or auto-read from .env):
#   SUPABASE_URL / VITE_SUPABASE_URL        http://localhost:8000
#   SUPABASE_ANON_KEY / VITE_SUPABASE_ANON_KEY  your anon key
#   FEDERATION_API_URL / VITE_FEDERATION_API_URL https://yourdomain.com
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Accept both VITE_* and plain names from env
: "${SUPABASE_URL:=${VITE_SUPABASE_URL:-}}"
: "${SUPABASE_ANON_KEY:=${VITE_SUPABASE_ANON_KEY:-}}"
: "${FEDERATION_API_URL:=${VITE_FEDERATION_API_URL:-}}"
: "${TEST_MODE:=}"

# k6 parameters (full mode)
K6_VUS="${K6_VUS:-50}"
K6_DURATION="${K6_DURATION:-30s}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
    cat << 'EOF'
Usage: benchmark-api.sh [OPTIONS]

Modes:
  --mode quick     Curl-based smoke test (no dependencies, ~30s)
                   Measures latency of key REST endpoints
  --mode full      k6 load test (requires k6 installed)
                   Concurrent users hammering endpoints

Options:
  --supabase-url URL     Supabase URL
  --anon-key KEY         Supabase anon key
  --federation-url URL   Federation backend URL
  --vus N                k6 virtual users (default: 50)
  --duration DURATION    k6 test duration (default: 30s)
  --help                 Show this help

Environment variables:
  SUPABASE_URL, SUPABASE_ANON_KEY, FEDERATION_API_URL

Install k6 (for --mode full):
  # Linux
  sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D68
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt update && sudo apt install k6
  # macOS
  brew install k6
  # Arch / Manjaro
  yay -S k6
EOF
    exit 0
}

# ---------------------------------------------------------------------------
# Env loading
# ---------------------------------------------------------------------------

load_env() {
    local env_file="$1"
    [[ -f "$env_file" ]] || return 0
    while IFS='=' read -r key value; do
        key=$(echo "$key" | xargs)
        [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
        value=$(echo "$value" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
        case "$key" in
            VITE_SUPABASE_URL)      [[ -z "$SUPABASE_URL" ]]     && SUPABASE_URL="$value" ;;
            VITE_SUPABASE_ANON_KEY) [[ -z "$SUPABASE_ANON_KEY" ]] && SUPABASE_ANON_KEY="$value" ;;
            VITE_FEDERATION_API_URL) [[ -z "$FEDERATION_API_URL" ]] && FEDERATION_API_URL="$value" ;;
        esac
    done < "$env_file"
}

load_env "$PROJECT_DIR/.env"
load_env "$PROJECT_DIR/federation-backend/.env"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)           TEST_MODE="$2"; shift 2 ;;
        --supabase-url)   SUPABASE_URL="$2"; shift 2 ;;
        --anon-key)       SUPABASE_ANON_KEY="$2"; shift 2 ;;
        --federation-url) FEDERATION_API_URL="$2"; shift 2 ;;
        --vus)            K6_VUS="$2"; shift 2 ;;
        --duration)       K6_DURATION="$2"; shift 2 ;;
        --help|-h)        usage ;;
        *)                echo "Unknown option: $1"; usage ;;
    esac
done

# Prompt for missing values
if [[ -z "$SUPABASE_URL" ]]; then
    echo -ne "${CYAN}Supabase URL${RESET} (e.g. https://db.yourdomain.com): "
    read -r SUPABASE_URL
fi
if [[ -z "$SUPABASE_ANON_KEY" ]]; then
    echo -ne "${CYAN}Supabase Anon Key${RESET}: "
    read -r SUPABASE_ANON_KEY
fi
if [[ -z "$FEDERATION_API_URL" ]]; then
    echo -ne "${CYAN}Federation API URL${RESET} (or press Enter to skip): "
    read -r FEDERATION_API_URL
fi

if [[ -z "$TEST_MODE" ]]; then
    echo ""
    echo -e "${BOLD}Select benchmark mode:${RESET}"
    echo -e "  ${CYAN}1${RESET}) Quick  - curl-based latency checks (~30s, no extra tools)"
    echo -e "  ${CYAN}2${RESET}) Full   - k6 concurrent load test (requires k6)"
    echo ""
    echo -ne "Choice [1]: "
    read -r choice
    choice="${choice:-1}"
    case "$choice" in
        1) TEST_MODE="quick" ;;
        2) TEST_MODE="full" ;;
        *) TEST_MODE="quick" ;;
    esac
fi

REST_BASE="${SUPABASE_URL}/rest/v1"
AUTH_HEADER="apikey: ${SUPABASE_ANON_KEY}"
AUTH_BEARER="Authorization: Bearer ${SUPABASE_ANON_KEY}"

echo ""
echo -e "${BOLD}Harmony API Benchmark${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Supabase:     ${CYAN}${SUPABASE_URL}${RESET}"
echo -e "  Federation:   ${CYAN}${FEDERATION_API_URL:-skipped}${RESET}"
echo -e "  Mode:         ${CYAN}${TEST_MODE}${RESET}"
[[ "$TEST_MODE" == "full" ]] && echo -e "  VUs:          ${CYAN}${K6_VUS}${RESET}" && echo -e "  Duration:     ${CYAN}${K6_DURATION}${RESET}"
echo ""

# =====================================================================
# QUICK MODE - curl latency probes
# =====================================================================

quick_test() {
    local label="$1"
    local url="$2"
    shift 2
    local extra_args=("$@")

    local TIMES=5
    local total_ms=0
    local min_ms=999999
    local max_ms=0
    local errors=0

    for i in $(seq 1 $TIMES); do
        result=$(curl -o /dev/null -s -w "%{http_code} %{time_total}" \
            -H "$AUTH_HEADER" -H "$AUTH_BEARER" \
            "${extra_args[@]}" \
            "$url" 2>&1) || true

        http_code=$(echo "$result" | awk '{print $1}')
        time_s=$(echo "$result" | awk '{print $2}')
        time_ms=$(echo "$time_s" | awk '{printf "%.0f", $1 * 1000}')

        if [[ "$http_code" -ge 200 && "$http_code" -lt 400 ]]; then
            total_ms=$((total_ms + time_ms))
            [[ $time_ms -lt $min_ms ]] && min_ms=$time_ms
            [[ $time_ms -gt $max_ms ]] && max_ms=$time_ms
        else
            errors=$((errors + 1))
        fi
    done

    local successes=$((TIMES - errors))
    if [[ $successes -gt 0 ]]; then
        local avg_ms=$((total_ms / successes))
        printf "  %-35s  avg %4dms  min %4dms  max %4dms" "$label" "$avg_ms" "$min_ms" "$max_ms"
        [[ $errors -gt 0 ]] && printf "  ${RED}(%d errors)${RESET}" "$errors"
        echo ""
    else
        printf "  %-35s  ${RED}ALL FAILED${RESET}\n" "$label"
    fi
}

run_quick() {
    echo -e "${BOLD}REST API Latency (5 requests each)${RESET}"
    echo ""

    quick_test "Health (PostgREST)"            "${SUPABASE_URL}/rest/v1/" \
        -H "Accept: application/json"

    quick_test "List servers (public)"          "${REST_BASE}/servers?select=id,name&limit=5"
    quick_test "List channels (public)"         "${REST_BASE}/channels?select=id,name&limit=5"
    quick_test "List profiles (public)"         "${REST_BASE}/profiles?select=id,display_name&limit=5"
    quick_test "List messages (latest 10)"      "${REST_BASE}/messages?select=id,content&limit=10&order=created_at.desc"
    quick_test "List reactions (latest 10)"     "${REST_BASE}/reactions?select=id,emoji&limit=10&order=created_at.desc"
    quick_test "Notifications (anon, expect 0)" "${REST_BASE}/notifications?select=id&limit=5"

    if [[ -n "$FEDERATION_API_URL" ]]; then
        echo ""
        echo -e "${BOLD}Federation API Latency${RESET}"
        echo ""
        quick_test "Federation health"             "${FEDERATION_API_URL}/health"
        quick_test "WebFinger (example)"           "${FEDERATION_API_URL}/.well-known/webfinger?resource=acme@example.com"
        quick_test "NodeInfo"                      "${FEDERATION_API_URL}/.well-known/nodeinfo"
    fi

    echo ""
    echo -e "${GREEN}Done.${RESET} These are unauthenticated latency probes."
    echo -e "For concurrency/throughput testing, run with ${BOLD}--mode full${RESET}."
}

# =====================================================================
# FULL MODE - k6 load test
# =====================================================================

run_full() {
    if ! command -v k6 &>/dev/null; then
        echo -e "${RED}k6 not found.${RESET} Install it first:"
        echo "  Arch/Manjaro: yay -S k6"
        echo "  Debian/Ubuntu: see --help"
        echo "  macOS: brew install k6"
        exit 1
    fi

    local K6_SCRIPT
    K6_SCRIPT=$(mktemp /tmp/harmony-bench-XXXXXX.js)

    cat > "$K6_SCRIPT" << JSEOF
import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const SUPABASE_URL   = '${SUPABASE_URL}';
const REST_BASE      = SUPABASE_URL + '/rest/v1';
const ANON_KEY       = '${SUPABASE_ANON_KEY}';
const FEDERATION_URL = '${FEDERATION_API_URL}';

const headers = {
    'apikey': ANON_KEY,
    'Authorization': 'Bearer ' + ANON_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
};

const errorRate      = new Rate('errors');
const listServers    = new Trend('list_servers_duration', true);
const listChannels   = new Trend('list_channels_duration', true);
const listMessages   = new Trend('list_messages_duration', true);
const listProfiles   = new Trend('list_profiles_duration', true);
const fedHealth      = new Trend('federation_health_duration', true);

export const options = {
    vus: ${K6_VUS},
    duration: '${K6_DURATION}',
    thresholds: {
        http_req_duration: ['p(95)<500'],
        errors: ['rate<0.1'],
    },
};

export default function () {
    // --- REST: list servers ---
    {
        const res = http.get(REST_BASE + '/servers?select=id,name&limit=10', { headers });
        listServers.add(res.timings.duration);
        const ok = check(res, { 'servers 2xx': (r) => r.status >= 200 && r.status < 300 });
        errorRate.add(!ok);
    }

    // --- REST: list channels ---
    {
        const res = http.get(REST_BASE + '/channels?select=id,name&limit=10', { headers });
        listChannels.add(res.timings.duration);
        const ok = check(res, { 'channels 2xx': (r) => r.status >= 200 && r.status < 300 });
        errorRate.add(!ok);
    }

    // --- REST: list messages ---
    {
        const res = http.get(REST_BASE + '/messages?select=id,content&limit=20&order=created_at.desc', { headers });
        listMessages.add(res.timings.duration);
        const ok = check(res, { 'messages 2xx': (r) => r.status >= 200 && r.status < 300 });
        errorRate.add(!ok);
    }

    // --- REST: list profiles ---
    {
        const res = http.get(REST_BASE + '/profiles?select=id,display_name&limit=10', { headers });
        listProfiles.add(res.timings.duration);
        const ok = check(res, { 'profiles 2xx': (r) => r.status >= 200 && r.status < 300 });
        errorRate.add(!ok);
    }

    // --- Federation health (if configured) ---
    if (FEDERATION_URL) {
        const res = http.get(FEDERATION_URL + '/health');
        fedHealth.add(res.timings.duration);
        const ok = check(res, { 'fed health 2xx': (r) => r.status >= 200 && r.status < 300 });
        errorRate.add(!ok);
    }

    sleep(0.3 + Math.random() * 0.5);
}
JSEOF

    echo -e "${DIM}Running k6 with ${K6_VUS} VUs for ${K6_DURATION}...${RESET}"
    echo ""

    k6 run "$K6_SCRIPT"

    rm -f "$K6_SCRIPT"
}

# =====================================================================
# Dispatch
# =====================================================================

case "$TEST_MODE" in
    quick) run_quick ;;
    full)  run_full ;;
    *)
        echo -e "${RED}Unknown mode: ${TEST_MODE}${RESET}"
        exit 1
        ;;
esac
