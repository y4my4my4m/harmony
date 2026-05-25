#!/usr/bin/env bash
# =============================================================================
# Harmony Voice/Video Benchmark Script
# =============================================================================
# Uses LiveKit's official CLI (lk) to load-test your LiveKit server.
#
# Prerequisites:
#   - LiveKit CLI installed: curl -sSL https://get.livekit.io/cli | bash
#   - LiveKit server running
#   - Run from a SEPARATE machine for accurate results (or at least separate
#     from the LiveKit server to avoid competing for CPU)
#
# Usage:
#   ./scripts/benchmark-voice.sh                        # interactive
#   ./scripts/benchmark-voice.sh --preset audio-small   # preset
#   ./scripts/benchmark-voice.sh --help                 # help
#
# Environment overrides:
#   LIVEKIT_URL          wss://live.yourdomain.com  (or ws://localhost:7880)
#   LIVEKIT_API_KEY      your API key
#   LIVEKIT_API_SECRET   your API secret
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# Defaults - can be overridden via env vars or flags
: "${LIVEKIT_URL:=}"
: "${LIVEKIT_API_KEY:=}"
: "${LIVEKIT_API_SECRET:=}"

ROOM="harmony-benchmark"
DURATION="60s"
AUDIO_PUBS=0
VIDEO_PUBS=0
SUBSCRIBERS=0
PRESET=""

# ---------------------------------------------------------------------------

usage() {
    cat << 'EOF'
Usage: benchmark-voice.sh [OPTIONS]

Options:
  --url URL              LiveKit server URL (wss://... or ws://...)
  --api-key KEY          LiveKit API key
  --api-secret SECRET    LiveKit API secret
  --duration DURATION    Test duration (default: 60s)
  --preset PRESET        Use a preset (see below)
  --help                 Show this help

Presets:
  audio-small     5 speakers, 50 listeners           (~small community)
  audio-medium    10 speakers, 200 listeners          (~medium server)
  audio-large     10 speakers, 1000 listeners         (~large event)
  video-small     10 video publishers, 10 subscribers (~small meeting)
  video-medium    50 video publishers, 50 subscribers (~large meeting)
  livestream      1 video publisher, 1000 subscribers (~livestream)

Environment variables:
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET

Notes:
  - Run from a DIFFERENT machine than the LiveKit server for accurate results
  - The load tester itself needs CPU/bandwidth; a 4+ core machine is recommended
  - Set ulimit -n 65535 before running large tests
  - Install CLI: curl -sSL https://get.livekit.io/cli | bash
EOF
    exit 0
}

# ---------------------------------------------------------------------------

apply_preset() {
    case "$1" in
        audio-small)
            AUDIO_PUBS=5; SUBSCRIBERS=50; DURATION="60s"
            ;;
        audio-medium)
            AUDIO_PUBS=10; SUBSCRIBERS=200; DURATION="60s"
            ;;
        audio-large)
            AUDIO_PUBS=10; SUBSCRIBERS=1000; DURATION="120s"
            ;;
        video-small)
            VIDEO_PUBS=10; SUBSCRIBERS=10; DURATION="60s"
            ;;
        video-medium)
            VIDEO_PUBS=50; SUBSCRIBERS=50; DURATION="90s"
            ;;
        livestream)
            VIDEO_PUBS=1; SUBSCRIBERS=1000; DURATION="120s"
            ;;
        *)
            echo -e "${RED}Unknown preset: $1${RESET}"
            echo "Run with --help for available presets."
            exit 1
            ;;
    esac
}

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --url)        LIVEKIT_URL="$2"; shift 2 ;;
        --api-key)    LIVEKIT_API_KEY="$2"; shift 2 ;;
        --api-secret) LIVEKIT_API_SECRET="$2"; shift 2 ;;
        --duration)   DURATION="$2"; shift 2 ;;
        --preset)     PRESET="$2"; apply_preset "$2"; shift 2 ;;
        --help|-h)    usage ;;
        *)            echo "Unknown option: $1"; usage ;;
    esac
done

# Check for lk CLI
if ! command -v lk &>/dev/null; then
    echo -e "${RED}LiveKit CLI (lk) not found.${RESET}"
    echo ""
    echo "Install it:"
    echo "  curl -sSL https://get.livekit.io/cli | bash"
    echo ""
    echo "Or on macOS:"
    echo "  brew install livekit/tap/livekit-cli"
    exit 1
fi

# Try to load from .env files if not set
load_env() {
    local env_file="$1"
    if [[ -f "$env_file" ]]; then
        while IFS='=' read -r key value; do
            key=$(echo "$key" | xargs)
            [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
            value=$(echo "$value" | xargs | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
            case "$key" in
                LIVEKIT_API_KEY)    [[ -z "$LIVEKIT_API_KEY" ]] && LIVEKIT_API_KEY="$value" ;;
                LIVEKIT_API_SECRET) [[ -z "$LIVEKIT_API_SECRET" ]] && LIVEKIT_API_SECRET="$value" ;;
                VITE_LIVEKIT_URL)   [[ -z "$LIVEKIT_URL" ]] && LIVEKIT_URL="$value" ;;
            esac
        done < "$env_file"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

load_env "$PROJECT_DIR/federation-backend/.env"
load_env "$PROJECT_DIR/.env"

# Interactive prompts for missing values
if [[ -z "$LIVEKIT_URL" ]]; then
    echo -ne "${CYAN}LiveKit URL${RESET} (e.g. wss://live.yourdomain.com): "
    read -r LIVEKIT_URL
fi
if [[ -z "$LIVEKIT_API_KEY" ]]; then
    echo -ne "${CYAN}API Key${RESET}: "
    read -r LIVEKIT_API_KEY
fi
if [[ -z "$LIVEKIT_API_SECRET" ]]; then
    echo -ne "${CYAN}API Secret${RESET}: "
    read -rs LIVEKIT_API_SECRET
    echo ""
fi

# Interactive preset selection if no preset given
if [[ -z "$PRESET" && $AUDIO_PUBS -eq 0 && $VIDEO_PUBS -eq 0 ]]; then
    echo ""
    echo -e "${BOLD}Select benchmark preset:${RESET}"
    echo -e "  ${CYAN}1${RESET}) Audio small   - 5 speakers, 50 listeners"
    echo -e "  ${CYAN}2${RESET}) Audio medium  - 10 speakers, 200 listeners"
    echo -e "  ${CYAN}3${RESET}) Audio large   - 10 speakers, 1000 listeners"
    echo -e "  ${CYAN}4${RESET}) Video small   - 10 publishers, 10 subscribers"
    echo -e "  ${CYAN}5${RESET}) Video medium  - 50 publishers, 50 subscribers"
    echo -e "  ${CYAN}6${RESET}) Livestream    - 1 publisher, 1000 subscribers"
    echo ""
    echo -ne "Choice [1]: "
    read -r choice
    choice="${choice:-1}"

    case "$choice" in
        1) apply_preset audio-small ;;
        2) apply_preset audio-medium ;;
        3) apply_preset audio-large ;;
        4) apply_preset video-small ;;
        5) apply_preset video-medium ;;
        6) apply_preset livestream ;;
        *) apply_preset audio-small ;;
    esac
fi

# Build lk command
CMD=(lk load-test
    --url "$LIVEKIT_URL"
    --api-key "$LIVEKIT_API_KEY"
    --api-secret "$LIVEKIT_API_SECRET"
    --room "$ROOM"
    --duration "$DURATION"
)

if [[ $AUDIO_PUBS -gt 0 ]]; then
    CMD+=(--audio-publishers "$AUDIO_PUBS")
fi
if [[ $VIDEO_PUBS -gt 0 ]]; then
    CMD+=(--video-publishers "$VIDEO_PUBS")
fi
if [[ $SUBSCRIBERS -gt 0 ]]; then
    CMD+=(--subscribers "$SUBSCRIBERS")
fi

TOTAL=$((AUDIO_PUBS + VIDEO_PUBS + SUBSCRIBERS))

echo ""
echo -e "${BOLD}Harmony Voice/Video Benchmark${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  Server:       ${CYAN}${LIVEKIT_URL}${RESET}"
echo -e "  Audio Pubs:   ${CYAN}${AUDIO_PUBS}${RESET}"
echo -e "  Video Pubs:   ${CYAN}${VIDEO_PUBS}${RESET}"
echo -e "  Subscribers:  ${CYAN}${SUBSCRIBERS}${RESET}"
echo -e "  Total:        ${CYAN}${TOTAL}${RESET} simulated participants"
echo -e "  Duration:     ${CYAN}${DURATION}${RESET}"
echo ""

if [[ $TOTAL -gt 500 ]]; then
    CURRENT_ULIMIT=$(ulimit -n 2>/dev/null || echo "unknown")
    if [[ "$CURRENT_ULIMIT" != "unknown" && "$CURRENT_ULIMIT" -lt 65535 ]]; then
        echo -e "${YELLOW}Note: Your open-file limit is ${CURRENT_ULIMIT}. For ${TOTAL} participants"
        echo -e "      each needing a socket, you may hit 'too many open files'.${RESET}"
        echo -e "${YELLOW}      Run ${BOLD}ulimit -n 65535${RESET}${YELLOW} in this shell first (temporary, resets on close).${RESET}"
        echo ""
    fi
fi

echo -e "${DIM}Running: ${CMD[*]}${RESET}"
echo ""

"${CMD[@]}"
