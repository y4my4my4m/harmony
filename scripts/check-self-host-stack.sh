#!/usr/bin/env bash
# The self-host stack as configure.sh assembles it: self-host/docker-compose.yml, upstream's
# docker/ directory at SUPABASE_REF_DEFAULT and self-host/supabase-overrides.yml.
#
#   check-self-host-stack.sh                    both checks below
#   check-self-host-stack.sh --images           image platforms only
#   check-self-host-stack.sh --gateway          Kong only
#   check-self-host-stack.sh --platforms IMAGE  platforms of the named images only
#
# Image platforms. install.sh offers amd64 and arm64, and one image without the host's platform
# stops install and update at the pull. Harmony's own three images are absent from the check: their
# platforms are images.yml's. Services of the profile nothing enables are absent too.
#
# Kong. Boots from the stack's own entrypoint and environment on this host's platform, with one
# stub nginx answering as every upstream. The E2E stack has no Kong, so nothing else runs it.
# Asserted: route auth (key-auth, ACL), paths reaching the upstream, and the client address contract
# of docs/self-host/signup-limits.md, which GoTrue's per-IP limiters and sign-up hook rely on.
#
# STACK_SUBNET: subnet of the compose network, for a host whose Docker address pools are exhausted.
# STACK_KONG_IMAGE: replaces Kong's image.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${CONTAINER_NAME:-harmony-stackcheck}"
OWN_IMAGES='^ghcr\.io/y4my4my4m/harmony-(web|federation|bot-gateway):'
REQUIRED_PLATFORMS='linux/amd64 linux/arm64'
ALL_PROFILES=(--profile voice --profile bots --profile discord --profile logs --profile studio)

log() { printf '\033[36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; }

FAILED=0
fail() { err "$*"; FAILED=$((FAILED + 1)); }

# Platforms of an image, one per line. Attestation entries have platform unknown.
image_platforms() {
  local manifest
  manifest="$(docker manifest inspect "$1")" || return 1
  printf '%s' "$manifest" | python3 -c '
import json, sys
doc = json.load(sys.stdin)
for m in doc.get("manifests") or []:
    p = m.get("platform") or {}
    if p.get("os") and p.get("os") != "unknown":
        print(p["os"] + "/" + p["architecture"])
'
}

check_platforms() {
  local image out platform missing attempt readable
  for image in "$@"; do
    out=""
    readable=0
    for attempt in 1 2 3; do
      if out="$(image_platforms "$image" 2>&1)"; then readable=1; break; fi
      [ "$attempt" = 3 ] || sleep "${STACK_RETRY_SECONDS:-5}"
    done
    if [ "$readable" = 0 ]; then
      fail "$image: manifest could not be read: $(printf '%s\n' "$out" | tail -1)"
      continue
    fi
    missing=""
    for platform in $REQUIRED_PLATFORMS; do
      printf '%s\n' "$out" | grep -qx "$platform" || missing="$missing $platform"
    done
    if [ -n "$missing" ]; then
      fail "$image: no image for$missing"
    else
      printf 'ok   %s\n' "$image"
    fi
  done
}

finish() {
  if [ "$FAILED" -gt 0 ]; then
    err "$FAILED check(s) failed"
    exit 1
  fi
  log "all checks passed"
}

if [ "${1:-}" = "--platforms" ]; then
  shift
  check_platforms "$@"
  finish
  exit 0
fi

RUN_IMAGES=1
RUN_GATEWAY=1
case "${1:-}" in
  --images) RUN_GATEWAY=0 ;;
  --gateway) RUN_IMAGES=0 ;;
  "") ;;
  *) err "unknown argument $1"; exit 2 ;;
esac

WORK="$(mktemp -d)"
STACK="$WORK/self-host"
compose_gateway() {
  docker compose --project-name "$PROJECT" --project-directory "$STACK/supabase" \
    --env-file "$STACK/supabase/.env" -f "$STACK/supabase/docker-compose.yml" \
    -f "$STACK/supabase-overrides.yml" -f "$STACK/gateway-check.yml" "$@"
}
cleanup() {
  [ -f "$STACK/gateway-check.yml" ] && compose_gateway down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

REF="$(sed -n 's/^SUPABASE_REF_DEFAULT=//p' "$ROOT/self-host/configure.sh")"
[ -n "$REF" ] || { err "SUPABASE_REF_DEFAULT not found in self-host/configure.sh"; exit 1; }
RAW="https://raw.githubusercontent.com/supabase/supabase/$REF/docker"
mkdir -p "$STACK/supabase/volumes/api"
cp "$ROOT/self-host/docker-compose.yml" "$ROOT/self-host/supabase-overrides.yml" "$STACK/"
curl -fsSL --retry 3 "$RAW/docker-compose.yml" -o "$STACK/supabase/docker-compose.yml"
curl -fsSL --retry 3 "$RAW/.env.example" -o "$STACK/supabase/.env"
curl -fsSL --retry 3 "$RAW/volumes/api/kong.yml" -o "$STACK/supabase/volumes/api/kong.yml"

if [ "$RUN_IMAGES" = 1 ]; then
  log "image platforms ($REQUIRED_PLATFORMS)"
  touch "$STACK/federation.env" "$STACK/bot-gateway.env" "$STACK/discord-bridge.env"
  grep -ohE '\$\{[A-Z0-9_]+:\?' "$STACK/docker-compose.yml" | sed -E 's/\$\{([A-Z0-9_]+):\?/\1=check/' | sort -u > "$STACK/.env"
  IMAGES="$(cd "$STACK" && docker compose "${ALL_PROFILES[@]}" config --images 2>/dev/null | sort -u)"
  [ -n "$IMAGES" ] || { err "compose rendered no images"; exit 1; }
  # shellcheck disable=SC2086
  check_platforms $(printf '%s\n' "$IMAGES" | grep -vE "$OWN_IMAGES")
fi

if [ "$RUN_GATEWAY" = 1 ]; then
  cat > "$STACK/stub.conf" <<'CONF'
server {
    listen 3000; listen 4000; listen 5000; listen 8080; listen 9000; listen 9999;
    default_type text/plain;
    return 200 "port=$server_port|uri=$request_uri|sbff=$http_sb_forwarded_for|xri=$http_x_real_ip|xff=$http_x_forwarded_for|apikey=$http_apikey|auth=$http_authorization|upgrade=$http_upgrade|consumer=$http_x_consumer_username\n";
}
CONF
  {
    cat <<CHECK
services:
  stub:
    image: ${NGINX_IMAGE:-nginx:alpine}
    volumes:
      - $STACK/stub.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      default:
        aliases: [auth, rest, realtime-dev.supabase-realtime, storage, meta, studio, functions, analytics]
  kong:
    container_name: !reset null
    depends_on: !reset {}
    ports: !override
      - "127.0.0.1::8000"
CHECK
    [ -z "${STACK_KONG_IMAGE:-}" ] || printf '    image: %s\n' "$STACK_KONG_IMAGE"
    if [ -n "${STACK_SUBNET:-}" ]; then
      printf 'networks:\n  default:\n    ipam:\n      config:\n        - subnet: %s\n' "$STACK_SUBNET"
    fi
  } > "$STACK/gateway-check.yml"

  KONG_IMAGE="$(compose_gateway config --images 2>/dev/null | grep -E '(^|/)kong:' | head -1)"
  log "Kong: $KONG_IMAGE on $(uname -m)"
  UP_OUTPUT="$(compose_gateway up -d --no-build kong stub 2>&1)" || {
    printf '%s\n' "$UP_OUTPUT" | tail -20
    compose_gateway logs kong 2>&1 | tail -20
    err "kong did not start"
    exit 1
  }

  BASE=""
  for _ in $(seq 1 120); do
    # The stack's restart policy holds a failing Kong in `restarting`, with no published port.
    KONG_ID="$(compose_gateway ps -aq kong)"
    case "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$KONG_ID" 2>/dev/null || true)" in
      exited*|restarting*|"running "[1-9]*) break ;;
    esac
    PORT="$(compose_gateway port kong 8000 2>/dev/null | sed 's/.*://' || true)"
    if [ -n "$PORT" ] && curl -s -o /dev/null -m 2 "http://127.0.0.1:$PORT/"; then
      BASE="http://127.0.0.1:$PORT"
      break
    fi
    sleep 1
  done
  if [ -z "$BASE" ]; then
    compose_gateway logs kong 2>&1 | tail -20
    err "kong did not answer"
    exit 1
  fi

  ANON="$(sed -n 's/^ANON_KEY=//p' "$STACK/supabase/.env")"
  SERVICE="$(sed -n 's/^SERVICE_ROLE_KEY=//p' "$STACK/supabase/.env")"

  # expect NAME STATUS BODY_SUBSTRING curl-args...
  expect() {
    local name="$1" status="$2" want="$3" body code
    shift 3
    body="$(curl -s -m 10 -w '\n%{http_code}' "$@")"
    code="${body##*$'\n'}"
    body="${body%$'\n'*}"
    if [ "$code" != "$status" ]; then
      fail "$name: status $code, expected $status: $body"
    elif [ -n "$want" ] && ! printf '%s' "$body" | grep -qF -- "$want"; then
      fail "$name: body lacks '$want': $body"
    else
      printf 'ok   %s\n' "$name"
    fi
  }

  log "routes"
  expect "open route without a key" 200 "port=9999|uri=/verify" "$BASE/auth/v1/verify"
  expect "data API refuses no key" 401 "" "$BASE/rest/v1/profiles?select=id"
  expect "data API refuses a wrong key" 401 "" -H "apikey: wrong" "$BASE/rest/v1/profiles?select=id"
  expect "data API with the anon key" 200 "port=3000|uri=/profiles?" -H "apikey: $ANON" "$BASE/rest/v1/profiles?select=id"
  expect "user token passes through" 200 "auth=Bearer usertoken" -H "apikey: $ANON" -H "Authorization: Bearer usertoken" "$BASE/rest/v1/profiles?select=id"
  expect "meta refuses the anon key" 403 "" -H "apikey: $ANON" "$BASE/pg/tables"
  expect "meta with the service key" 200 "port=8080|uri=/tables" -H "apikey: $SERVICE" "$BASE/pg/tables"
  expect "auth admin with the service key" 200 "port=9999|uri=/admin/users" -H "apikey: $SERVICE" "$BASE/auth/v1/admin/users"
  expect "storage keeps an encoded path" 200 "port=5000|uri=/object/public/b/a%20b.png" "$BASE/storage/v1/object/public/b/a%20b.png"
  expect "resumable upload route" 200 "port=5000|uri=/upload/resumable" -X POST "$BASE/storage/v1/upload/resumable"
  expect "realtime keeps the upgrade" 200 "upgrade=websocket" -H "Connection: Upgrade" -H "Upgrade: websocket" "$BASE/realtime/v1/websocket?apikey=$ANON&vsn=1.0.0"
  expect "realtime socket path" 200 "uri=/socket/websocket?" "$BASE/realtime/v1/websocket?apikey=$ANON&vsn=1.0.0"
  expect "CORS preflight" 200 "" -X OPTIONS -H "Origin: https://x.test" -H "Access-Control-Request-Method: GET" "$BASE/rest/v1/profiles"

  log "access log"
  # vector.yml parses nginx combined and drops anything else, so a changed default empties Studio's edge logs.
  ACCESS_LINE="$(compose_gateway logs --no-log-prefix kong 2>/dev/null | grep -F 'GET /auth/v1/verify ' | tail -1)"
  if printf '%s' "$ACCESS_LINE" | grep -qE '" [0-9]{3} [0-9]+ "[^"]*" "[^"]*"$'; then
    printf 'ok   combined format\n'
  else
    fail "access log is not combined: $ACCESS_LINE"
  fi

  log "client address contract"
  HEADERS="$(curl -s -m 10 -H "apikey: $ANON" -H "Sb-Forwarded-For: 203.0.113.9" -H "X-Real-IP: 198.51.100.1" -H "X-Forwarded-For: 198.51.100.2" "$BASE/auth/v1/user")"
  field() { printf '%s' "$HEADERS" | tr '|' '\n' | sed -n "s/^$1=//p"; }
  if [ "$(field sbff)" = "203.0.113.9" ]; then printf 'ok   Sb-Forwarded-For arrives unchanged\n'; else fail "Sb-Forwarded-For: $(field sbff)"; fi
  if [ "$(field xri)" != "198.51.100.1" ]; then printf 'ok   X-Real-IP is replaced by the peer\n'; else fail "X-Real-IP kept the client's value"; fi
  case "$(field xff)" in
    198.51.100.2,*) printf 'ok   X-Forwarded-For keeps the first value and appends the peer\n' ;;
    *) fail "X-Forwarded-For: $(field xff)" ;;
  esac
fi

finish
