#!/usr/bin/env bash
# nginx -t on dev/nginx-harmony.template.conf, then the /invite/<code> and /d/<token> routing:
# link-preview crawlers reach the federation backend, browsers and search engines the SPA.
# /@<name> and /@<name>/<post id>: the SPA with the cookie harmony_app=1, the backend otherwise.
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

DRIVE_LINK=/d/h5KAj-hPSm5hwCpMfeKM8aZl
log "/d/<token> routing"
expect "$DISCORD"  $DRIVE_LINK               "backend $DRIVE_LINK"
expect "$DISCORD"  "$DRIVE_LINK/"            "backend $DRIVE_LINK/"
expect "$MASTODON" $DRIVE_LINK               "backend $DRIVE_LINK"
expect "$IMESSAGE" $DRIVE_LINK               "backend $DRIVE_LINK"
expect "$FIREFOX"  $DRIVE_LINK               'SPA'
expect "$GOOGLE"   $DRIVE_LINK               'SPA'
expect "$DISCORD"  /d/short                  'SPA'
expect "$DISCORD"  $DRIVE_LINK/extra         'SPA'
expect "$DISCORD"  /drive/file/00000000-0000-0000-0000-000000000001 'SPA'

log "/api/federation/embed-media routing"
expect "$FIREFOX" '/api/federation/embed-media?u=https%3A%2F%2Fvideo.twimg.com%2Fv.mp4' 'backend /embed-media?u=https%3A%2F%2Fvideo.twimg.com%2Fv.mp4'
expect "$FIREFOX" /api/federation/embed-media/instagram/DcCH2ZygIiP/0/poster 'backend /embed-media/instagram/DcCH2ZygIiP/0/poster'
expect "$FIREFOX" /api/federation/media/c/x 'backend /media/c/x'

log "ActivityPub-only paths"
STAMP=/users/fx_alice/quote_authorizations/00000000-0000-0000-0000-000000000002
expect "$MASTODON" $STAMP "backend $STAMP"
expect "$FIREFOX"  $STAMP "backend $STAMP"
for c in likes shares replies context; do
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

# expect_with <path> <first line of the body> [header...]
expect_with() {
  local path="$1" want="$2" got args=()
  shift 2
  for h in "$@"; do args+=(--header "$h"); done
  got="$(docker exec "$CONTAINER" wget -q -O - -U "$FIREFOX" "${args[@]}" "http://127.0.0.1:8443$path" 2>/dev/null | head -1)" || true
  if [ "$got" = "$want" ]; then
    printf 'ok   %-40.40s %s -> %s\n' "${*:-no header}" "$path" "$got"
  else
    err "$* $path: expected '$want', got '$got'"
    FAILED=$((FAILED + 1))
  fi
}

APP_COOKIE='Cookie: theme=dark; harmony_app=1'
PAGE_POST=/@fx_alice/00000000-0000-0000-0000-000000000001
log "/@<name> and /@<name>/<post id> routing"
for p in /@fx_alice /@fx_alice/ '/@fx_alice?before=00000000-0000-0000-0000-000000000001' $PAGE_POST /@fx_alice@remote.example; do
  expect_with "$p" "backend $p"
  expect_with "$p" 'SPA' "$APP_COOKIE"
  expect_with "$p" "backend $p" 'Accept: application/activity+json'
  expect_with "$p" "backend $p" "Accept: $AP_MASTODON" "$APP_COOKIE"
done
expect_with /@fx_alice 'backend /@fx_alice' 'Cookie: harmony_app=0'
expect_with /@fx_alice 'backend /@fx_alice' 'Cookie: not_harmony_app=1'
expect "$DISCORD" /@fx_alice 'backend /@fx_alice'
expect_with /@fx_alice/a/b 'SPA'
expect_with /posts/00000000-0000-0000-0000-000000000001 'backend /posts/00000000-0000-0000-0000-000000000001' "$APP_COOKIE"
# A browser at an actor id goes to its public page.
expect_with /users/fx_alice 'backend /@fx_alice'
expect_with /users/fx_alice 'SPA' "$APP_COOKIE"
expect_with /users/fx_alice 'backend /users/fx_alice' 'Accept: application/activity+json'

# The SPA answer for /@<name> is not shared-cacheable and keeps the server-level headers; the
# backend's keeps its own Cache-Control alone.
headers="$(docker exec "$CONTAINER" wget -q -S -O /dev/null -U "$FIREFOX" --header "$APP_COOKIE" http://127.0.0.1:8443/@fx_alice 2>&1 || true)"
for h in 'Vary: Accept, Cookie' 'Cache-Control: private, no-cache' 'X-Frame-Options: SAMEORIGIN' 'X-Content-Type-Options: nosniff'; do
  if grep -qi "$h" <<<"$headers"; then
    printf 'ok   SPA answer for /@<name> carries %s\n' "$h"
  else
    err "SPA answer for /@fx_alice lacks $h"
    FAILED=$((FAILED + 1))
  fi
done
headers="$(docker exec "$CONTAINER" wget -q -S -O /dev/null -U "$FIREFOX" http://127.0.0.1:8443/posts/00000000-0000-0000-0000-000000000001 2>&1 || true)"
if grep -qi 'Cache-Control' <<<"$headers"; then
  err "/posts/<id> answer carries a Cache-Control the backend did not send"
  FAILED=$((FAILED + 1))
else
  printf 'ok   /posts/<id> answer carries no Cache-Control of its own\n'
fi

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
headers="$(docker exec "$CONTAINER" wget -q -S -O /dev/null -U "$FIREFOX" "http://127.0.0.1:8443$DRIVE_LINK" 2>&1 || true)"
for h in 'Vary: User-Agent' 'X-Frame-Options: SAMEORIGIN' 'X-Content-Type-Options: nosniff'; do
  if grep -qi "$h" <<<"$headers"; then
    printf 'ok   SPA answer for /d/<token> carries %s\n' "$h"
  else
    err "SPA answer for $DRIVE_LINK lacks $h"
    FAILED=$((FAILED + 1))
  fi
done

# Embed media answers keep the backend's Referrer-Policy: no-referrer alone. A server-level
# policy after it is the one browsers apply, and the redirect then sends X a Referer (403).
headers="$(docker exec "$CONTAINER" wget -q -S -O /dev/null -U "$FIREFOX" http://127.0.0.1:8443/api/federation/embed-media/instagram/DcCH2ZygIiP/0 2>&1 || true)"
if grep -qi 'Referrer-Policy' <<<"$headers"; then
  err "embed-media answer carries the server-level Referrer-Policy"
  FAILED=$((FAILED + 1))
else
  printf 'ok   embed-media answer carries no server-level Referrer-Policy\n'
fi

[ "$FAILED" -eq 0 ] || { err "$FAILED routing check(s) failed"; exit 1; }
log "dev/nginx-harmony.template.conf parses and routes /invite/<code>, /d/<token>, /social/post/<id>, /social/profile/<name>, /@<name> and the ActivityPub-only paths"
