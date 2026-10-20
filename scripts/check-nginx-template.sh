#!/usr/bin/env bash
# nginx -t on dev/nginx-harmony.template.conf, then the /invite/<code> routing: link-preview
# crawlers reach the federation backend, browsers and search engines the SPA.
#
# The template runs in a plain-HTTP nginx container: certificate directives dropped, the
# backend upstream pointed at a stub server in the same nginx that answers with the URI it
# was sent, dist/ replaced by an index.html reading SPA.
set -euo pipefail

IMAGE="${NGINX_IMAGE:-nginx:alpine}"
CONTAINER="${CONTAINER_NAME:-harmony-nginxcheck}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

mkdir -p "$WORK/conf" "$WORK/dist"
echo SPA > "$WORK/dist/index.html"
sed -e 's/listen 443 ssl;/listen 8443;/' -e '/http2 on;/d' -e '/ssl_/d' \
    -e 's/listen 80;/listen 8080;/' -e 's/server_name YOUR_DOMAIN;/server_name _;/' \
    -e 's|/path/to/harmony/dist|/srv/dist|' \
    -e 's|http://localhost:3001|http://127.0.0.1:18301|g' -e 's|http://localhost:3002|http://127.0.0.1:18302|g' \
    -e 's|access_log /var/log/nginx/harmony.access.log;|access_log off;|' \
    -e 's|error_log /var/log/nginx/harmony.error.log;|error_log stderr;|' \
    "$ROOT/dev/nginx-harmony.template.conf" > "$WORK/conf/harmony.conf"
cat > "$WORK/conf/stub.conf" <<'EOF'
server {
    listen 127.0.0.1:18301;
    location / {
        default_type text/plain;
        return 200 "backend $request_uri\n";
    }
}
EOF

log "nginx -t on dev/nginx-harmony.template.conf ($IMAGE)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -v "$WORK/conf:/etc/nginx/conf.d:ro" -v "$WORK/dist:/srv/dist:ro" "$IMAGE" >/dev/null
for _ in $(seq 1 20); do
  docker exec "$CONTAINER" nginx -t >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$CONTAINER" nginx -t
for _ in $(seq 1 20); do
  docker exec "$CONTAINER" wget -q -O /dev/null http://127.0.0.1:8443/ 2>/dev/null && break
  sleep 0.5
done

FAILED=0
# expect <user agent> <path> <first line of the body>
expect() {
  local got
  got="$(docker exec "$CONTAINER" wget -q -O - -U "$1" "http://127.0.0.1:8443$2" 2>/dev/null | head -1)" || true
  if [ "$got" = "$3" ]; then
    printf 'ok   %-40.40s %s -> %s\n' "$1" "$2" "$got"
  else
    err "$1 $2: expected '$3', got '$got'"
    FAILED=$((FAILED + 1))
  fi
}

DISCORD='Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
IMESSAGE='Mozilla/5.0 (Macintosh) AppleWebKit/601.2.4 (KHTML, like Gecko) facebookexternalhit/1.1 Facebot Twitterbot/1.0'
MASTODON='http.rb/5.1.1 (Mastodon/4.3.0; +https://social.example/)'
FIREFOX='Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'
GOOGLE='Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

log "/invite/<code> routing"
expect "$DISCORD"  /invite/ABCD1234          'backend /invite/ABCD1234'
expect "$DISCORD"  '/invite/ABCD1234/?a=1'   'backend /invite/ABCD1234/?a=1'
expect "$IMESSAGE" /invite/ABCD1234          'backend /invite/ABCD1234'
expect "$MASTODON" /invite/ABCD1234          'backend /invite/ABCD1234'
expect "$FIREFOX"  /invite/ABCD1234          'SPA'
expect "$GOOGLE"   /invite/ABCD1234          'SPA'
expect "$DISCORD"  /invite/ab                'SPA'
expect "$DISCORD"  /invite/ABCD1234/extra    'SPA'
expect "$FIREFOX"  /posts/00000000-0000-0000-0000-000000000001 'backend /posts/00000000-0000-0000-0000-000000000001'

log "ActivityPub-only paths"
STAMP=/users/fx_alice/quote_authorizations/00000000-0000-0000-0000-000000000002
expect "$MASTODON" $STAMP "backend $STAMP"
expect "$FIREFOX"  $STAMP "backend $STAMP"
for c in likes shares replies; do
  expect "$MASTODON" /posts/00000000-0000-0000-0000-000000000001/$c "backend /posts/00000000-0000-0000-0000-000000000001/$c"
done
expect "$MASTODON" /messages/00000000-0000-0000-0000-000000000003 'backend /messages/00000000-0000-0000-0000-000000000003'
THREAD=/threads/00000000-0000-0000-0000-000000000004
THREADS=/channels/00000000-0000-0000-0000-000000000005/threads
for p in $THREAD $THREAD/members "$THREAD/members?page=1" $THREADS "$THREADS?page=1"; do
  expect "$MASTODON" "$p" "backend $p"
done
expect "$FIREFOX" $THREAD "backend $THREAD"
CREATE=/users/fx_alice/activities/00000000-0000-0000-0000-000000000006
ANNOUNCE=/activities/00000000-0000-0000-0000-000000000007
expect "$MASTODON" $CREATE "backend $CREATE"
expect "$MASTODON" $ANNOUNCE "backend $ANNOUNCE"
expect "$FIREFOX" /activities 'SPA'
expect "$FIREFOX" /threads 'SPA'
expect "$FIREFOX" /channels/00000000-0000-0000-0000-000000000005 'SPA'
expect "$FIREFOX" $THREAD/messages 'SPA'

# expect_accept <accept> <path> <first line of the body>
expect_accept() {
  local got
  got="$(docker exec "$CONTAINER" wget -q -O - -U "$FIREFOX" --header "Accept: $1" "http://127.0.0.1:8443$2" 2>/dev/null | head -1)" || true
  if [ "$got" = "$3" ]; then
    printf 'ok   %-40.40s %s -> %s\n' "$1" "$2" "$got"
  else
    err "Accept $1 $2: expected '$3', got '$got'"
    FAILED=$((FAILED + 1))
  fi
}

POST=/social/post/00000000-0000-0000-0000-000000000001
AP_MASTODON='application/activity+json, application/ld+json; profile="https://www.w3.org/ns/activitystreams", text/html;q=0.1'
log "/social/post/<id> routing"
expect_accept "$AP_MASTODON"         $POST 'backend /posts/00000000-0000-0000-0000-000000000001'
expect_accept 'application/ld+json'  $POST 'backend /posts/00000000-0000-0000-0000-000000000001'
expect_accept 'text/html,*/*;q=0.8'  $POST 'SPA'
expect "$DISCORD" $POST 'backend /posts/00000000-0000-0000-0000-000000000001'
expect "$FIREFOX" $POST 'SPA'
expect "$DISCORD" /social/post/not-a-post-id 'SPA'

PROFILE=/social/profile/fx_alice
log "/social/profile/<name> routing"
expect_accept "$AP_MASTODON"         $PROFILE 'backend /users/fx_alice'
expect_accept 'application/ld+json'  $PROFILE 'backend /users/fx_alice'
expect_accept 'text/html,*/*;q=0.8'  $PROFILE 'SPA'
expect_accept "$AP_MASTODON"         /social/profile/fx_alice@remote.example 'SPA'

# The SPA answer varies by User-Agent and keeps the server-level headers.
headers="$(docker exec "$CONTAINER" wget -q -S -O /dev/null -U "$FIREFOX" http://127.0.0.1:8443/invite/ABCD1234 2>&1 || true)"
for h in 'Vary: User-Agent' 'X-Frame-Options: SAMEORIGIN' 'X-Content-Type-Options: nosniff'; do
  if grep -qi "$h" <<<"$headers"; then
    printf 'ok   SPA answer carries %s\n' "$h"
  else
    err "SPA answer for /invite/ABCD1234 lacks $h"
    FAILED=$((FAILED + 1))
  fi
done

[ "$FAILED" -eq 0 ] || { err "$FAILED routing check(s) failed"; exit 1; }
log "dev/nginx-harmony.template.conf parses and routes /invite/<code>, /social/post/<id>, /social/profile/<name> and the ActivityPub-only paths"
