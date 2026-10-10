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
log "dev/nginx-harmony.template.conf parses and routes /invite/<code> by User-Agent"
