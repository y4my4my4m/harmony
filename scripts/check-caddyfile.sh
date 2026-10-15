#!/usr/bin/env bash
# Routing of self-host/Caddyfile: ActivityPub-only paths reach the federation backend, the rest
# the SPA.
#
# Caddy runs the Caddyfile as self-host/docker-compose.yml runs it (caddy:2-alpine, internal
# TLS). One stub nginx on the same network answers as federation-server, web, bot-gateway and
# supabase-kong: the backend with the URI it was sent, the web container with SPA.
set -euo pipefail

IMAGE="${CADDY_IMAGE:-caddy:2-alpine}"
STUB_IMAGE="${NGINX_IMAGE:-nginx:alpine}"
PREFIX="${CONTAINER_NAME:-harmony-caddycheck}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
DOMAIN=harmony.check

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

remove_containers() {
  docker rm -f "$PREFIX" "$PREFIX-stub" >/dev/null 2>&1 || true
  docker network rm "$PREFIX-net" >/dev/null 2>&1 || true
}
cleanup() { remove_containers; rm -rf "$WORK"; }
trap cleanup EXIT
remove_containers

cat > "$WORK/stub.conf" <<'EOF'
server {
    listen 3001;
    location / {
        default_type text/plain;
        return 200 "backend $request_uri\n";
    }
}
server {
    listen 80;
    location / {
        default_type text/plain;
        return 200 "SPA\n";
    }
}
EOF

docker network create "$PREFIX-net" >/dev/null
docker run -d --name "$PREFIX-stub" --network "$PREFIX-net" \
  --network-alias federation-server --network-alias web \
  -v "$WORK/stub.conf:/etc/nginx/conf.d/default.conf:ro" "$STUB_IMAGE" >/dev/null
docker run -d --name "$PREFIX" --network "$PREFIX-net" --add-host "$DOMAIN:127.0.0.1" \
  -e DOMAIN="$DOMAIN" -e DB_DOMAIN="db.$DOMAIN" -e LIVEKIT_DOMAIN="live.$DOMAIN" \
  -e CADDY_TLS=internal -e ENABLE_VOICE=false \
  -v "$ROOT/self-host/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMAGE" >/dev/null

# caddy adapt parses without provisioning: a validate beside the running server races it for
# the internal CA's first key.
log "caddy adapt on self-host/Caddyfile ($IMAGE)"
docker exec "$PREFIX" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null

# expect <accept> <path> <first line of the body>
FAILED=0
expect() {
  local got=''
  for _ in $(seq 1 20); do
    got="$(docker exec "$PREFIX" wget -q -O - --no-check-certificate --header "Accept: $1" \
      "https://$DOMAIN$2" 2>/dev/null | head -1)" && [ -n "$got" ] && break
    sleep 0.5
  done
  if [ "$got" = "$3" ]; then
    printf 'ok   %-28.28s %s -> %s\n' "$1" "$2" "$got"
  else
    err "Accept $1 $2: expected '$3', got '$got'"
    FAILED=$((FAILED + 1))
  fi
}

AP='application/activity+json'
HTML='text/html'
POST=/posts/00000000-0000-0000-0000-000000000001
STAMP=/users/fx_alice/quote_authorizations/00000000-0000-0000-0000-000000000002

log "ActivityPub-only paths"
expect "$AP"   /inbox                 'backend /inbox'
expect "$AP"   /users/fx_alice/outbox 'backend /users/fx_alice/outbox'
expect "$AP"   $STAMP                 "backend $STAMP"
expect "$HTML" $STAMP                 "backend $STAMP"
for c in likes shares replies; do
  expect "$AP" $POST/$c "backend $POST/$c"
done
expect "$AP"   $POST                  "backend $POST"
expect "$AP"   /messages/00000000-0000-0000-0000-000000000003 'backend /messages/00000000-0000-0000-0000-000000000003'
THREAD=/threads/00000000-0000-0000-0000-000000000004
THREADS=/channels/00000000-0000-0000-0000-000000000005/threads
expect "$AP"   $THREAD                "backend $THREAD"
expect "$HTML" $THREAD                "backend $THREAD"
expect "$AP"   $THREAD/members        "backend $THREAD/members"
expect "$AP"   "$THREAD/members?page=1" "backend $THREAD/members?page=1"
expect "$AP"   $THREADS               "backend $THREADS"
expect "$AP"   "$THREADS?page=1"      "backend $THREADS?page=1"

log "everything else"
expect "$HTML" /                      'SPA'
expect "$HTML" /users/fx_alice/quote_authorizations 'SPA'
expect "$HTML" /servers               'SPA'
expect "$HTML" /threads               'SPA'
expect "$HTML" /channels/00000000-0000-0000-0000-000000000005 'SPA'
expect "$HTML" $THREAD/messages       'SPA'

[ "$FAILED" -eq 0 ] || { err "$FAILED routing check(s) failed"; exit 1; }
log "self-host/Caddyfile routes the ActivityPub-only paths to the federation backend"
