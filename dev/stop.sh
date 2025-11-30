#!/bin/bash
# =============================================================================
# Harmony Development Environment - Stop Script
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🛑 Stopping Harmony Development Environment"
echo ""

# Stop Caddy
echo "Stopping Caddy..."
cd "$SCRIPT_DIR"
docker compose down

# Stop LiveKit
echo "Stopping LiveKit..."
cd "$ROOT_DIR/webrtc"
docker compose down

echo ""
echo "✅ All services stopped"
echo ""
echo "Note: Supabase is still running. Stop it separately if needed."

