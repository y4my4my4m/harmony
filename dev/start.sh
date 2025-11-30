#!/bin/bash
# =============================================================================
# Harmony Development Environment - Start Script
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🎵 Starting Harmony Development Environment"
echo ""

# Check if mkcert certs exist
if [ ! -f "$SCRIPT_DIR/certs/har.mony.local+3.pem" ]; then
    echo "⚠️  SSL certificates not found!"
    echo ""
    echo "Please generate them first:"
    echo "  1. Install mkcert: https://github.com/FiloSottile/mkcert"
    echo "  2. Run: mkcert -install"
    echo "  3. Run: cd $SCRIPT_DIR/certs && mkcert 'har.mony.local' 'live.mony.local' localhost 127.0.0.1"
    echo ""
    exit 1
fi

# Check /etc/hosts
if ! grep -q "har.mony.local" /etc/hosts; then
    echo "⚠️  /etc/hosts not configured!"
    echo ""
    echo "Please add this line to /etc/hosts:"
    echo "  127.0.0.1 har.mony.local live.mony.local"
    echo ""
fi

# Check if supabase network exists
if ! docker network ls | grep -q "supabase_default"; then
    echo "⚠️  Supabase network not found!"
    echo "   Please start Supabase first: cd /path/to/supabase && docker compose up -d"
    echo ""
fi

# Start LiveKit (if not running)
echo "📡 Starting LiveKit..."
cd "$ROOT_DIR/webrtc"
docker compose up -d

# Start Caddy proxy + Federation backend
echo "🔒 Starting Caddy (HTTPS proxy) + Federation Backend..."
cd "$SCRIPT_DIR"
docker compose up -d --build

echo ""
echo "✅ Infrastructure started!"
echo ""
echo "  Federation backend is running in Docker (connected to Supabase network)"
echo ""
echo "Next steps:"
echo "  1. Start Vite dev server:  cd $ROOT_DIR && npm run dev -- --host 0.0.0.0"
echo "  2. Open: https://har.mony.local"
echo ""
echo "Logs:"
echo "  docker logs -f harmony-dev-backend   # Federation backend"
echo "  docker logs -f harmony-dev-caddy     # Caddy proxy"
echo ""

