#!/usr/bin/env bash
# Routing of self-host/Caddyfile: ActivityPub-only paths reach the federation backend, the rest
# the SPA. /@<name> and /@<name>/<post id>: the SPA with the cookie harmony_app=1, the backend
# otherwise.
#
# db.<domain>: public storage reads (GET, HEAD) go to media-cache with the render Accept
# pinned, everything else to Kong.
#
# Caddy runs the Caddyfile as self-host/docker-compose.yml runs it (caddy:2-alpine, internal
# TLS). One stub nginx on the same network answers as federation-server, web, bot-gateway,
# supabase-kong and media-cache: the backend with the URI it was sent, the web container with
# SPA, Kong and the cache with their name, the method, the URI and the Accept they got.
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
server {
    listen 8000;
    location / {
        default_type text/plain;
        return 200 "kong $request_method $request_uri\n";
    }
}
server {
    listen 8080;
    location / {
        default_type text/plain;
        return 200 "media-cache $request_method $request_uri $http_accept\n";
    }
}
EOF

docker network create "$PREFIX-net" >/dev/null
docker run -d --name "$PREFIX-stub" --network "$PREFIX-net" \
  --network-alias federation-server --network-alias web \
  --network-alias supabase-kong --network-alias media-cache \
  -v "$WORK/stub.conf:/etc/nginx/conf.d/default.conf:ro" "$STUB_IMAGE" >/dev/null
docker run -d --name "$PREFIX" --network "$PREFIX-net" --add-host "$DOMAIN:127.0.0.1" \
  --add-host "db.$DOMAIN:127.0.0.1" \
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

# expect_ua <user agent> <path> <first line of the body>
expect_ua() {
  local got=''
  for _ in $(seq 1 20); do
    got="$(docker exec "$PREFIX" wget -q -O - --no-check-certificate -U "$1" \
      "https://$DOMAIN$2" 2>/dev/null | head -1)" && [ -n "$got" ] && break
    sleep 0.5
  done
  if [ "$got" = "$3" ]; then
    printf 'ok   %-28.28s %s -> %s\n' "$1" "$2" "$got"
  else
    err "User-Agent $1 $2: expected '$3', got '$got'"
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
for c in likes shares replies context; do
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
CREATE=/users/fx_alice/activities/00000000-0000-0000-0000-000000000006
ANNOUNCE=/activities/00000000-0000-0000-0000-000000000007
expect "$AP"   $CREATE                "backend $CREATE"
expect "$AP"   $ANNOUNCE              "backend $ANNOUNCE"

log "/social/post/<id>"
SOCIAL_POST=/social/post/00000000-0000-0000-0000-000000000001
expect "$AP"   $SOCIAL_POST           "backend $POST"
expect "$HTML" $SOCIAL_POST           'SPA'
expect_ua 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' $SOCIAL_POST "backend $POST"

log "/d/<token>"
DISCORD='Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
DRIVE_LINK=/d/h5KAj-hPSm5hwCpMfeKM8aZl
expect_ua "$DISCORD" $DRIVE_LINK      "backend $DRIVE_LINK"
expect_ua "$DISCORD" "$DRIVE_LINK/"   "backend $DRIVE_LINK/"
expect_ua 'http.rb/5.1.1 (Mastodon/4.3.0; +https://social.example/)' $DRIVE_LINK "backend $DRIVE_LINK"
expect_ua 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' $DRIVE_LINK 'SPA'
expect_ua "$DISCORD" /d/short         'SPA'
expect_ua "$DISCORD" /drive/file/00000000-0000-0000-0000-000000000001 'SPA'

log "/social/profile/<name>"
expect "$AP"   /social/profile/fx_alice 'backend /users/fx_alice'
expect 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' /social/profile/fx_alice 'backend /users/fx_alice'
expect "$HTML" /social/profile/fx_alice 'SPA'
expect "$AP"   /social/profile/fx_alice@remote.example 'SPA'

# expect_with <path> <first line of the body> [header...]
expect_with() {
  local path="$1" want="$2" got='' args=()
  shift 2
  for h in "$@"; do args+=(--header "$h"); done
  for _ in $(seq 1 20); do
    got="$(docker exec "$PREFIX" wget -q -O - --no-check-certificate "${args[@]}" \
      "https://$DOMAIN$path" 2>/dev/null | head -1)" && [ -n "$got" ] && break
    sleep 0.5
  done
  if [ "$got" = "$want" ]; then
    printf 'ok   %-28.28s %s -> %s\n' "${*:-no header}" "$path" "$got"
  else
    err "$* $path: expected '$want', got '$got'"
    FAILED=$((FAILED + 1))
  fi
}

log "/@<name> and /@<name>/<post id>"
APP_COOKIE='Cookie: theme=dark; harmony_app=1'
PAGE_POST=/@fx_alice/00000000-0000-0000-0000-000000000001
for p in /@fx_alice /@fx_alice/ '/@fx_alice?before=00000000-0000-0000-0000-000000000001' $PAGE_POST /@fx_alice@remote.example; do
  expect_with "$p" "backend $p" "Accept: $HTML"
  expect_with "$p" 'SPA' "Accept: $HTML" "$APP_COOKIE"
  expect_with "$p" "backend $p" "Accept: $AP"
  expect_with "$p" "backend $p" "Accept: $AP" "$APP_COOKIE"
done
expect_with /@fx_alice 'backend /@fx_alice' "Accept: $HTML" 'Cookie: harmony_app=0'
expect_with /@fx_alice/a/b 'SPA' "Accept: $HTML"
expect_with $POST "backend $POST" "Accept: $HTML" "$APP_COOKIE"
# A browser at an actor id goes to its public page.
expect_with /users/fx_alice 'backend /@fx_alice' "Accept: $HTML"
expect_with /users/fx_alice 'SPA' "Accept: $HTML" "$APP_COOKIE"
expect_with /users/fx_alice 'backend /users/fx_alice' "Accept: $AP"
headers="$(docker exec "$PREFIX" wget -q -S -O /dev/null --no-check-certificate --header "$APP_COOKIE" \
  "https://$DOMAIN/@fx_alice" 2>&1 || true)"
for h in 'Vary: Accept, Cookie' 'Cache-Control: private, no-cache'; do
  if grep -qi "$h" <<<"$headers"; then
    printf 'ok   SPA answer for /@<name> carries %s\n' "$h"
  else
    err "SPA answer for /@fx_alice lacks $h"
    FAILED=$((FAILED + 1))
  fi
done

log "everything else"
expect "$HTML" /                      'SPA'
expect "$HTML" /users/fx_alice/quote_authorizations 'SPA'
expect "$HTML" /servers               'SPA'
expect "$HTML" /threads               'SPA'
expect "$HTML" /channels/00000000-0000-0000-0000-000000000005 'SPA'
expect "$HTML" $THREAD/messages       'SPA'
expect "$HTML" /activities            'SPA'

log "db.<domain>: public storage reads through media-cache"
# expect_db <wget args...> -- <path> <first line of the body>
expect_db() {
  local args=() got=''
  while [ "$1" != -- ]; do args+=("$1"); shift; done
  shift
  for _ in $(seq 1 20); do
    got="$(docker exec "$PREFIX" wget -q -O - --no-check-certificate "${args[@]}" \
      "https://db.$DOMAIN$1" 2>/dev/null | head -1)" && [ -n "$got" ] && break
    sleep 0.5
  done
  if [ "$got" = "$2" ]; then
    printf 'ok   %-28.28s %s -> %s\n' "${args[*]:-GET}" "$1" "$got"
  else
    err "db ${args[*]} $1: expected '$2', got '$got'"
    FAILED=$((FAILED + 1))
  fi
}
OBJ=/storage/v1/object/public/avatars/u/avatar-1.webp
RENDER='/storage/v1/render/image/public/avatars/u/avatar-1.webp?width=256&height=256'
expect_db --header 'Accept: */*' -- $OBJ "media-cache GET $OBJ */*"
expect_db --header 'Accept: image/avif,*/*' -- "$RENDER" "media-cache GET $RENDER image/webp,*/*;q=0.8"
expect_db -- /storage/v1/object/sign/avatars/u/a.webp "kong GET /storage/v1/object/sign/avatars/u/a.webp"
expect_db -- /storage/v1/object/authenticated/user_media/u/a.png "kong GET /storage/v1/object/authenticated/user_media/u/a.png"
expect_db -- /storage/v1/render/image/sign/avatars/u/a.webp "kong GET /storage/v1/render/image/sign/avatars/u/a.webp"
expect_db -- '/rest/v1/profiles?select=id' 'kong GET /rest/v1/profiles?select=id'
expect_db --post-data x -- $OBJ "kong POST $OBJ"
expect_db -- /storage/v1/object/public/message_media/c/a.png "kong GET /storage/v1/object/public/message_media/c/a.png"
expect_db -- /storage/v1/render/image/public/message_media/c/a.png "kong GET /storage/v1/render/image/public/message_media/c/a.png"

[ "$FAILED" -eq 0 ] || { err "$FAILED routing check(s) failed"; exit 1; }
log "self-host/Caddyfile routes the ActivityPub-only paths to the federation backend"
