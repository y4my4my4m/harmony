#!/usr/bin/env bash
# self-host/media-cache.conf as self-host/docker-compose.yml runs it: nginx loads it, a public
# object is fetched from upstream once for many concurrent and later reads, a render keeps its
# query in the key, a response storage marks no-store or private is fetched every time, and the
# cache's own lifetime applies whatever storage's max-age (a max-age=0 answer is kept).
#
# A stub nginx on the same network answers as supabase-kong:8000 and logs each request it gets,
# with a Cache-Control chosen by path.
set -euo pipefail

IMAGE="${MEDIA_CACHE_IMAGE:-$(sed -n 's/^ *image: \(nginx:[^ ]*\).*/\1/p' "$(dirname "${BASH_SOURCE[0]}")/../self-host/docker-compose.yml" | head -1)}"
PREFIX="${CONTAINER_NAME:-harmony-mediacachecheck}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

remove_containers() {
  docker rm -f "$PREFIX" "$PREFIX-kong" >/dev/null 2>&1 || true
  docker network rm "$PREFIX-net" >/dev/null 2>&1 || true
}
cleanup() { remove_containers; rm -rf "$WORK"; }
trap cleanup EXIT
remove_containers

cat > "$WORK/kong.conf" <<'EOF'
log_format uri '$request_method $request_uri';
server {
    listen 8000;
    access_log /dev/stdout uri;
    location /storage/v1/object/public/nostore/ {
        add_header Cache-Control "no-store";
        return 200 "fresh $request_uri\n";
    }
    location /storage/v1/object/public/maxage0/ {
        add_header Cache-Control "max-age=0";
        return 200 "object $request_uri\n";
    }
    location /storage/v1/object/public/private/ {
        add_header Cache-Control "private, max-age=3600";
        return 200 "fresh $request_uri\n";
    }
    location / {
        add_header Cache-Control "max-age=31536000";
        return 200 "object $request_uri\n";
    }
}
EOF

docker network create "$PREFIX-net" >/dev/null
docker run -d --name "$PREFIX-kong" --network "$PREFIX-net" --network-alias supabase-kong \
  -v "$WORK/kong.conf:/etc/nginx/conf.d/default.conf:ro" "$IMAGE" >/dev/null
docker run -d --name "$PREFIX" --network "$PREFIX-net" \
  -v "$ROOT/self-host/media-cache.conf:/etc/nginx/conf.d/default.conf:ro" "$IMAGE" >/dev/null

log "nginx -t on self-host/media-cache.conf ($IMAGE)"
docker exec "$PREFIX" nginx -t -q

FAILED=0
check() {
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    err "$1: expected '$3', got '$2'"
    FAILED=$((FAILED + 1))
  fi
}
get() { docker exec "$PREFIX" wget -q -O - "http://127.0.0.1:8080$1" 2>/dev/null | head -1; }
status() { docker exec "$PREFIX" wget -q -S -O /dev/null "http://127.0.0.1:8080$1" 2>&1 | sed -n 's/^ *X-Cache-Status: *//Ip' | tr -d '\r'; }
upstream() { docker logs "$PREFIX-kong" 2>/dev/null | grep -cxF "GET $1" || true; }

for _ in $(seq 1 20); do [ -n "$(get /storage/v1/object/public/warm/x 2>/dev/null)" ] && break; sleep 0.5; done

OBJ=/storage/v1/object/public/avatars/u/avatar-1.webp
log "50 concurrent reads of one object, then one more"
docker exec "$PREFIX" sh -c "for i in \$(seq 50); do wget -q -O /dev/null http://127.0.0.1:8080$OBJ & done; wait"
check "the object's body passes through" "$(get $OBJ)" "object $OBJ"
check "the next read is a cache hit" "$(status $OBJ)" "HIT"
check "upstream saw the object once" "$(upstream "$OBJ")" "1"

RENDER_A='/storage/v1/render/image/public/avatars/u/avatar-1.webp?width=256'
RENDER_B='/storage/v1/render/image/public/avatars/u/avatar-1.webp?width=64'
get "$RENDER_A" >/dev/null; get "$RENDER_A" >/dev/null; get "$RENDER_B" >/dev/null
check "a render is keyed by its query" "$(upstream "$RENDER_A")$(upstream "$RENDER_B")" "11"

for p in /storage/v1/object/public/nostore/a.png /storage/v1/object/public/private/a.png; do
  get "$p" >/dev/null; get "$p" >/dev/null
  check "upstream's Cache-Control decides: $p fetched each time" "$(upstream "$p")" "2"
done

SHORT=/storage/v1/object/public/maxage0/a.png
get "$SHORT" >/dev/null; get "$SHORT" >/dev/null
check "the cache's lifetime, not storage's max-age, decides" "$(upstream "$SHORT")" "1"
headers="$(docker exec "$PREFIX" wget -q -S -O /dev/null "http://127.0.0.1:8080$OBJ" 2>&1 || true)"
check "browsers still get storage's Cache-Control" "$(sed -n 's/^ *Cache-Control: *//Ip' <<<"$headers" | tr -d '\r')" "max-age=31536000"

[ "$FAILED" -eq 0 ] || { err "$FAILED media cache check(s) failed"; exit 1; }
log "self-host/media-cache.conf serves public storage reads from its cache"
