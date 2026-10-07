#!/bin/sh
# Writes the SPA's /config.json from the container environment before nginx
# starts. Keys and their meaning: src/services/runtimeConfig.ts.
#
# Each key reads the build variable's name without the VITE_ prefix, then the
# VITE_ name itself, so an existing .env works as the container environment:
#
#   supabaseUrl      SUPABASE_URL             (public URL, not the Docker-internal one)
#   supabaseAnonKey  SUPABASE_ANON_KEY
#   domain           DOMAIN, else INSTANCE_DOMAIN
#   instanceDomain   INSTANCE_DOMAIN, else domain
#   instanceName     INSTANCE_NAME
#   appUrl           APP_URL
#   federationUrl    FEDERATION_URL
#   storageDomain    STORAGE_DOMAIN
#   altDomains       HARMONY_ALT_DOMAINS
#   termsUrl         TERMS_URL
#   privacyUrl       PRIVACY_URL
#   oauthProviders   ENABLED_OAUTH_PROVIDERS
#
# Unset keys are omitted; the bundle then uses its build-time value, if any.
# No other variable reaches the file.
set -eu

out=${HARMONY_CONFIG_PATH:-/usr/share/nginx/html/config.json}

# First non-empty argument.
first() {
	for value in "$@"; do
		if [ -n "$value" ]; then
			printf '%s' "$value"
			return 0
		fi
	done
}

# JSON string body: control characters dropped, backslash and quote escaped.
json_escape() {
	printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

body=''
keys=''
add() {
	[ -n "$2" ] || return 0
	body="${body:+$body,
}  \"$1\": \"$(json_escape "$2")\""
	keys="${keys:+$keys }$1"
}

domain=$(first "${DOMAIN:-}" "${VITE_DOMAIN:-}" "${INSTANCE_DOMAIN:-}" "${VITE_INSTANCE_DOMAIN:-}")

add supabaseUrl "$(first "${SUPABASE_URL:-}" "${VITE_SUPABASE_URL:-}")"
add supabaseAnonKey "$(first "${SUPABASE_ANON_KEY:-}" "${VITE_SUPABASE_ANON_KEY:-}")"
add domain "$domain"
add instanceDomain "$(first "${INSTANCE_DOMAIN:-}" "${VITE_INSTANCE_DOMAIN:-}" "$domain")"
add instanceName "$(first "${INSTANCE_NAME:-}" "${VITE_INSTANCE_NAME:-}")"
add appUrl "$(first "${APP_URL:-}" "${VITE_APP_URL:-}")"
add federationUrl "$(first "${FEDERATION_URL:-}" "${VITE_FEDERATION_URL:-}")"
add storageDomain "$(first "${STORAGE_DOMAIN:-}" "${VITE_STORAGE_DOMAIN:-}")"
add altDomains "$(first "${HARMONY_ALT_DOMAINS:-}" "${VITE_HARMONY_ALT_DOMAINS:-}")"
add termsUrl "$(first "${TERMS_URL:-}" "${VITE_TERMS_URL:-}")"
add privacyUrl "$(first "${PRIVACY_URL:-}" "${VITE_PRIVACY_URL:-}")"
add oauthProviders "$(first "${ENABLED_OAUTH_PROVIDERS:-}" "${VITE_ENABLED_OAUTH_PROVIDERS:-}")"

tmp="$out.tmp.$$"
if [ -n "$body" ]; then
	printf '{\n%s\n}\n' "$body" >"$tmp"
else
	printf '{}\n' >"$tmp"
fi
chmod 0644 "$tmp"
mv -f "$tmp" "$out"

echo "$0: wrote $out (${keys:-no keys})"
missing=''
for key in supabaseUrl supabaseAnonKey; do
	case " $keys " in
	*" $key "*) ;;
	*) missing="${missing:+$missing, }$key" ;;
	esac
done
if [ -n "$missing" ]; then
	echo "$0: $missing missing: set SUPABASE_URL and SUPABASE_ANON_KEY, or build the image with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY" >&2
fi
