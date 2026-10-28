# Account linking of sign-in providers. Sourced by lib.sh and configure.sh, never run; plain
# functions over values, no file or container access.
#
# PROVIDER_LINKING_DOMAINS in supabase/.env (GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS):
# comma-separated provider=domain pairs, parsed as GoTrue 2.196.0's
# conf.ProviderLinkingDomains.Decode does (split on ',', then on the first '=', both sides
# trimmed and non-empty; a later pair for the same provider wins). A provider without a pair
# is in the "default" domain: its first sign-in joins the existing account that has its
# address, the address counting as verified when GoTrue autoconfirms (ENABLE_EMAIL_AUTOCONFIRM).
# A value that does not parse stops GoTrue from starting.
#
# A first sign-in in any other domain joins only an identity of that domain with the same
# address, and makes a new account otherwise. GoTrue marks that account is_sso_user
# (api.createAccountFromExternalIdentity): it signs in only through its providers, with no
# password, address change, recovery or passkey (models.FindUserByEmailAndAudience,
# api.UserUpdate). Identities that exist sign in as before in every domain.

# OAuth providers of GoTrue 2.196.0 (the OAuthProviderConfiguration fields of
# conf.ProviderConfiguration); GOTRUE_EXTERNAL_<ID in capitals>_ENABLED turns one on.
GOTRUE_OAUTH_PROVIDERS="apple azure bitbucket discord facebook figma fly github gitlab google kakao keycloak linkedin linkedin_oidc notion slack slack_oidc snapchat spotify twitch twitter vercel_marketplace workos x zoom"

# Providers supabase-overrides.yml maps from <ID in capitals>_ENABLED in supabase/.env.
BUILTIN_OAUTH_PROVIDERS="github google twitch"

# linking_valid VALUE: status 0 when GoTrue parses VALUE; empty parses.
linking_valid() {
	LD="$1" awk 'BEGIN {
		v = ENVIRON["LD"]; gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", v)
		if (v == "") exit 0
		n = split(v, pairs, ",")
		for (i = 1; i <= n; i++) {
			eq = index(pairs[i], "=")
			if (eq == 0) exit 1
			p = substr(pairs[i], 1, eq - 1); d = substr(pairs[i], eq + 1)
			gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", p); gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", d)
			if (p == "" || d == "") exit 1
		}
		exit 0
	}'
}

# linking_domain VALUE PROVIDER: PROVIDER's linking domain; empty for the default domain.
# VALUE must parse (linking_valid).
linking_domain() {
	LD="$1" LP="$2" awk 'BEGIN {
		n = split(ENVIRON["LD"], pairs, ",")
		for (i = 1; i <= n; i++) {
			eq = index(pairs[i], "=")
			if (eq == 0) continue
			p = substr(pairs[i], 1, eq - 1); d = substr(pairs[i], eq + 1)
			gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", p); gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", d)
			if (p == ENVIRON["LP"]) found = d
		}
		printf "%s", found
	}'
}

# linking_set VALUE PROVIDER [DOMAIN]: VALUE without PROVIDER's pairs, then PROVIDER=DOMAIN
# appended when DOMAIN is given. Other pairs keep their order, trimmed. VALUE must parse.
linking_set() {
	LD="$1" LP="$2" LV="${3:-}" awk 'BEGIN {
		n = split(ENVIRON["LD"], pairs, ",")
		for (i = 1; i <= n; i++) {
			eq = index(pairs[i], "=")
			if (eq == 0) continue
			p = substr(pairs[i], 1, eq - 1); d = substr(pairs[i], eq + 1)
			gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", p); gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", d)
			if (p == ENVIRON["LP"]) continue
			out = out (out == "" ? "" : ",") p "=" d
		}
		if (ENVIRON["LV"] != "") out = out (out == "" ? "" : ",") ENVIRON["LP"] "=" ENVIRON["LV"]
		printf "%s", out
	}'
}

# linking_isolate VALUE PROVIDER...: VALUE with PROVIDER=PROVIDER appended for each PROVIDER
# that has no pair. A pair present stays, PROVIDER=default included. VALUE must parse.
linking_isolate() {
	local value="$1" p
	shift
	for p in "$@"; do
		[[ -n "$(linking_domain "$value" "$p")" ]] || value="$(linking_set "$value" "$p" "$p")"
	done
	printf '%s' "$value"
}

# linking_mode VALUE PROVIDER: how PROVIDER's first sign-in treats an existing account with its
# address. "by address": no pair, or the domain named default, which is GoTrue's pool of every
# provider without one: it joins the account. "separate": a domain no other provider has.
# "shared: DOMAIN": joins only accounts of the providers mapped to DOMAIN. VALUE must parse.
linking_mode() {
	LD="$1" LP="$2" awk 'BEGIN {
		n = split(ENVIRON["LD"], pairs, ",")
		for (i = 1; i <= n; i++) {
			eq = index(pairs[i], "=")
			if (eq == 0) continue
			p = substr(pairs[i], 1, eq - 1); d = substr(pairs[i], eq + 1)
			gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", p); gsub(/^[ \t\r\n\v\f]+|[ \t\r\n\v\f]+$/, "", d)
			dom[p] = d
		}
		me = ENVIRON["LP"]
		if (!(me in dom) || dom[me] == "default") { printf "by address"; exit }
		for (p in dom) if (p != me && dom[p] == dom[me]) { printf "shared: %s", dom[me]; exit }
		printf "separate"
	}'
}
