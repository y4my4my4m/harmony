#!/usr/bin/env bash
# =============================================================================
# Harmony self-host updater
# =============================================================================
# Pulls the latest code, rebuilds images, applies any new DB migrations, and
# restarts the stack with zero manual steps.
#
# Usage:  bash update.sh
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

c_blue=$'\033[34m'; c_green=$'\033[32m'; c_reset=$'\033[0m'
info() { printf "%s==>%s %s\n" "$c_blue" "$c_reset" "$*"; }
ok()   { printf "%s ✓ %s%s\n" "$c_green" "$*" "$c_reset"; }

# Carry forward the profiles that were started (voice/bots) so update keeps them.
PROFILES=()
docker inspect harmony-livekit     >/dev/null 2>&1 && PROFILES+=(--profile voice)
docker inspect harmony-bot-gateway >/dev/null 2>&1 && PROFILES+=(--profile bots)

info "Pulling latest code..."
git -C "$REPO_DIR" pull --ff-only

info "Rebuilding images..."
docker compose "${PROFILES[@]}" build

info "Restarting services..."
docker compose "${PROFILES[@]}" up -d

info "Applying any new migrations..."
bash "$SCRIPT_DIR/bootstrap.sh" --migrations-only

ok "Update complete."
