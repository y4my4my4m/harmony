#!/usr/bin/env bash
# =============================================================================
# Harmony accounts and registration, for the operator
# =============================================================================
#   bash admin.sh create [--email E] [--username U] [--password P] [--display-name N]
#   bash admin.sh reset-password (--email E | --username U) [--password P]
#   bash admin.sh invite <email> [--send]
#   bash admin.sh registration [open | invite | closed]
#   bash admin.sh auth providers
#   bash admin.sh auth add-provider ID [--name N] (--issuer URL [--discovery-url URL] |
#            --authorize-url URL --token-url URL --userinfo-url URL) [--client-id ID]
#            [--client-secret-file FILE|-] [--scopes "S ..."] [--icon URL]
#            [--email-optional | --require-email] [--no-pkce | --pkce]
#            [--separate-accounts | --link-existing-accounts [--provider-verifies-email]]
#   bash admin.sh auth remove-provider ID
#   bash admin.sh auth linking PROVIDER (--separate-accounts |
#            --link-existing-accounts [--provider-verifies-email])
#   bash admin.sh has-admin           exit 0 when a local admin exists
#
# create makes an instance admin the way the app makes any account: GoTrue's
# admin API creates the user with the address confirmed, the user signs in
# (password grant) and inserts its profile row as NewProfile.vue does, then
# the federation backend generates its keys. promote_first_user_to_admin
# makes the first local profile an admin; any later one is promoted with the
# service role. An existing account becomes an admin and keeps its password;
# one that never created its profile takes the given password.
#
# A missing password is generated and shown once (reveal_secret, lib.sh). Calls run inside the
# federation-server container (Kong on the compose network, keys from its
# environment); nothing secret appears on a command line.
#
# registration maps the policy onto GoTrue and instance_config:
#   open     sign-up on (DISABLE_SIGNUP=false), open_registration true
#   invite   sign-up off; `invite` creates an invite link per address
#   closed   sign-up off, no invitations
# Without an argument it applies REGISTRATION from .env.
#
# auth manages sign-in through the instance's own OAuth 2.0 / OIDC providers (GoTrue
# custom providers, identifier custom:ID). add-provider creates or updates one: GoTrue
# fetches and checks the issuer's discovery document before it stores the provider and
# its client secret. The secret comes from --client-secret-file (- reads stdin),
# HARMONY_OAUTH_CLIENT_SECRET or a hidden prompt; empty keeps a stored one. The sign-in
# page shows instance_config.custom_oauth_providers, which add-provider and
# remove-provider keep in step.
#
# A new provider is kept apart: PROVIDER_LINKING_DOMAINS in supabase/.env gains
# custom:ID=custom:ID (linking.sh), so its first sign-in never joins an existing
# account by address. GoTrue reads that value at start: a change recreates the auth
# service, and the provider is saved only once the running service has the value.
# --link-existing-accounts drops the pair. With ENABLE_EMAIL_AUTOCONFIRM=true GoTrue takes
# every address a provider sends as verified, so linking is refused there unless
# --provider-verifies-email states the provider only hands out addresses it has checked.
# An update without either option keeps the provider's mode. remove-provider drops the pair
# after the provider.
#
# linking sets the mode of a GoTrue provider of its own (github, google, twitch, ...):
# PROVIDER=PROVIDER keeps it apart, PROVIDER=default joins existing accounts by address.
# configure.sh writes PROVIDER=PROVIDER for each built-in provider without a pair when
# ENABLE_EMAIL_AUTOCONFIRM is or was true, and leaves a pair present alone. GoTrue's GitHub
# provider passes every address of the GitHub account, unverified ones included, so linking
# GitHub is refused under ENABLE_EMAIL_AUTOCONFIRM=true, --provider-verifies-email or not.
# =============================================================================
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() { sed -n '2,62p' "${BASH_SOURCE[0]}"; }

# Node program run in federation-server. PARAMS is a JSON object whose values
# are base64, so any byte of a password survives the trip.
NODE_LIB='
const P = JSON.parse(Buffer.from(PARAMS_B64, "base64").toString("utf8"));
const arg = (k) => (P[k] == null ? "" : Buffer.from(P[k], "base64").toString("utf8"));
const BASE = process.env.SUPABASE_URL;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON = process.env.SUPABASE_ANON_KEY;
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

async function call(method, path, { key = SERVICE, bearer, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

function fail(msg, r) {
  let detail = "";
  if (r) {
    const j = r.json || {};
    detail = ` (HTTP ${r.status}: ${String(j.msg || j.message || j.error_description || j.error || r.text || "").slice(0, 300)})`;
  }
  out({ ok: false, error: msg + detail });
  process.exit(1);
}

async function findUserByEmail(email) {
  for (let page = 1; page <= 100; page++) {
    const r = await call("GET", `/auth/v1/admin/users?page=${page}&per_page=200&filter=${encodeURIComponent(email)}`);
    if (!r.ok) fail("listing accounts failed", r);
    const users = r.json?.users ?? [];
    const hit = users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if (users.length < 200) return null;
  }
  return null;
}

async function profileById(id) {
  const r = await call("GET", `/rest/v1/profiles?id=eq.${id}&select=id,username,is_admin,is_local`);
  if (!r.ok) fail("reading profiles failed", r);
  return r.json?.[0] ?? null;
}

const signIn = (email, password) =>
  call("POST", "/auth/v1/token?grant_type=password", { key: ANON, body: { email, password } });
const signOut = (token) => call("POST", "/auth/v1/logout?scope=local", { key: ANON, bearer: token });
'

NODE_CREATE='
const email = arg("email").toLowerCase();
const username = arg("username");
const password = arg("password");
const displayName = arg("display_name") || username;

const dr = await call("GET", "/rest/v1/instance_config?config_key=eq.domain&select=config_value");
if (!dr.ok) fail("reading instance_config failed", dr);
const domain = typeof dr.json?.[0]?.config_value === "string" ? dr.json[0].config_value : "";
if (!domain || domain === "localhost") fail("instance_config.domain is not set yet; run bootstrap.sh first");

let user = await findUserByEmail(email);
let created = false;
let passwordSet = false;
if (!user) {
  const r = await call("POST", "/auth/v1/admin/users", { body: { email, password, email_confirm: true } });
  if (!r.ok) fail("creating the account failed", r);
  user = r.json;
  created = true;
}

let profile = await profileById(user.id);
if (!profile) {
  const taken = await call("GET",
    `/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&domain=eq.${encodeURIComponent(domain)}&is_local=eq.true&select=id`);
  if (!taken.ok) fail("checking the username failed", taken);
  if (taken.json?.length) fail(`the username ${username} belongs to another account`);
  if (!created) {
    // An account that never finished onboarding: it takes the given password.
    const r = await call("PUT", `/auth/v1/admin/users/${user.id}`, { body: { password, email_confirm: true } });
    if (!r.ok) fail("setting the password failed", r);
    passwordSet = true;
  }
  const s = await signIn(email, password);
  if (!s.ok) fail("signing in as the new account failed", s);
  const token = s.json.access_token;
  const actor = `https://${domain}/users/${username}`;
  const pr = await call("POST", "/rest/v1/profiles", {
    key: ANON,
    bearer: token,
    headers: { Prefer: "return=representation" },
    body: {
      id: user.id,
      auth_user_id: user.id,
      username,
      display_name: displayName,
      color: "#0EA5E9",
      is_local: true,
      domain,
      federated_id: actor,
      inbox_url: `${actor}/inbox`,
      outbox_url: `${actor}/outbox`,
      followers_url: `${actor}/followers`,
      following_url: `${actor}/following`,
    },
  });
  await signOut(token);
  if (!pr.ok) fail("creating the profile failed", pr);
  profile = pr.json?.[0];
  try {
    await fetch("http://127.0.0.1:3001/generate-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: user.id }),
    });
  } catch {
    // The actor endpoint generates keys on first request.
  }
}

let promoted = false;
if (!profile.is_admin) {
  const r = await call("PATCH", `/rest/v1/profiles?id=eq.${user.id}`, {
    headers: { Prefer: "return=representation" },
    body: { is_admin: true },
  });
  if (!r.ok || !r.json?.[0]?.is_admin) fail("promoting the account to admin failed", r);
  promoted = true;
}
out({ ok: true, email, username: profile.username, created, passwordSet, promoted });
'

NODE_RESET='
const email = arg("email").toLowerCase();
const username = arg("username");
const password = arg("password");
let user = null;
if (email) {
  user = await findUserByEmail(email);
} else {
  const r = await call("GET", `/rest/v1/profiles?username=eq.${encodeURIComponent(username)}&is_local=eq.true&select=auth_user_id`);
  if (!r.ok) fail("reading profiles failed", r);
  const id = r.json?.[0]?.auth_user_id;
  if (id) {
    const u = await call("GET", `/auth/v1/admin/users/${id}`);
    if (u.ok) user = u.json;
  }
}
if (!user) fail("no such account");
const r = await call("PUT", `/auth/v1/admin/users/${user.id}`, { body: { password } });
if (!r.ok) fail("setting the password failed", r);
const s = await signIn(user.email, password);
if (!s.ok) fail("the new password does not sign in", s);
await signOut(s.json.access_token);
out({ ok: true, email: user.email });
'

NODE_INVITE='
const email = arg("email").toLowerCase();
const redirect = arg("redirect");
if (arg("send") === "1") {
  const r = await call("POST", `/auth/v1/invite?redirect_to=${encodeURIComponent(redirect)}`, { body: { email } });
  if (!r.ok) fail("sending the invitation failed", r);
  out({ ok: true, email, sent: true });
} else {
  const r = await call("POST", "/auth/v1/admin/generate_link", { body: { type: "invite", email, redirect_to: redirect } });
  if (!r.ok) fail("creating the invitation failed", r);
  const link = r.json?.action_link ?? r.json?.properties?.action_link;
  if (!link) fail("GoTrue returned no invitation link", r);
  out({ ok: true, email, link });
}
'

# Custom sign-in providers: GoTrue's admin API (/admin/custom-providers, 2.187.0+) holds the
# provider and its client secret; instance_config.custom_oauth_providers holds the button,
# [{id, name, icon}].
NODE_PROVIDER_LIB='
const PROVIDERS = "/auth/v1/admin/custom-providers";

async function gotrueProviders() {
  const r = await call("GET", PROVIDERS);
  if (r.status === 404 && r.json?.error_code === "feature_disabled") {
    fail("custom sign-in providers are turned off in the auth service (GOTRUE_CUSTOM_OAUTH_ENABLED)");
  }
  if (r.status === 404) {
    fail("this auth service has no custom sign-in providers; they need GoTrue 2.187.0 or later, which harmony update installs");
  }
  if (!r.ok) fail("listing the sign-in providers failed", r);
  return Array.isArray(r.json?.providers) ? r.json.providers : [];
}

async function shownProviders() {
  const r = await call("GET", "/rest/v1/instance_config?config_key=eq.custom_oauth_providers&select=config_value");
  if (!r.ok) fail("reading instance_config failed", r);
  const value = r.json?.[0]?.config_value;
  return Array.isArray(value) ? value.filter((p) => p && typeof p.id === "string") : [];
}

async function saveShown(list) {
  const r = await call("POST", "/rest/v1/instance_config?on_conflict=config_key", {
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: { config_key: "custom_oauth_providers", config_value: list, updated_at: new Date().toISOString() },
  });
  if (!r.ok) fail("updating the sign-in buttons in instance_config failed", r);
}
'

NODE_PROVIDER_LIST='
const providers = await gotrueProviders();
const shown = await shownProviders();
const rows = providers.map((p) => {
  const state = !p.enabled ? "disabled" : shown.some((s) => s.id === p.identifier) ? "shown" : "no button";
  const where = p.provider_type === "oidc" ? p.issuer : p.authorization_url;
  return [p.identifier, p.name, p.provider_type, state, where || ""].join("\t");
});
const stale = shown.filter((s) => !providers.some((p) => p.identifier === s.id)).map((s) => s.id);
out({ ok: true, count: providers.length, rows: Buffer.from(rows.join("\n")).toString("base64"), stale: stale.join(" ") });
'

NODE_PROVIDER_ADD='
const id = arg("id");
const type = arg("type");
const body = {};
if (arg("name")) body.name = arg("name");
if (arg("client_id")) body.client_id = arg("client_id");
if (arg("client_secret")) body.client_secret = arg("client_secret");
if (arg("scopes")) body.scopes = arg("scopes").split(/[\s,]+/).filter(Boolean);
if (arg("email_optional")) body.email_optional = arg("email_optional") === "1";
if (arg("pkce")) body.pkce_enabled = arg("pkce") === "1";
if (arg("issuer")) body.issuer = arg("issuer");
if (arg("discovery_url")) body.discovery_url = arg("discovery_url");
if (arg("authorize_url")) body.authorization_url = arg("authorize_url");
if (arg("token_url")) body.token_url = arg("token_url");
if (arg("userinfo_url")) body.userinfo_url = arg("userinfo_url");

const existing = (await gotrueProviders()).find((p) => p.identifier === id);
let provider;
if (existing) {
  if (type && type !== existing.provider_type) {
    fail(`${id} is an ${existing.provider_type} provider; remove it first to make it ${type}`);
  }
  const r = await call("PUT", `${PROVIDERS}/${id}`, { body });
  if (!r.ok) fail("updating the provider failed", r);
  provider = r.json;
} else {
  if (!type) fail("a new provider needs --issuer (OIDC) or --authorize-url, --token-url and --userinfo-url (OAuth 2.0)");
  for (const [field, flag] of [["name", "--name"], ["client_id", "--client-id"],
                              ["client_secret", "a client secret (prompt, --client-secret-file or HARMONY_OAUTH_CLIENT_SECRET)"]]) {
    if (!body[field]) fail(`a new provider needs ${flag}`);
  }
  if (type === "oidc" && !body.scopes) body.scopes = ["openid", "email", "profile"];
  const r = await call("POST", PROVIDERS, { body: { provider_type: type, identifier: id, ...body } });
  if (!r.ok) fail("adding the provider failed", r);
  provider = r.json;
}

const shown = await shownProviders();
const before = shown.find((s) => s.id === id);
const icon = arg("icon_set") === "1" ? arg("icon") : before?.icon || "";
const entry = icon ? { id, name: provider.name, icon } : { id, name: provider.name };
await saveShown(before ? shown.map((s) => (s.id === id ? entry : s)) : [...shown, entry]);
out({ ok: true, id, name: provider.name, type: provider.provider_type, created: !existing });
'

NODE_PROVIDER_EXISTS='
const id = arg("id");
out({ ok: true, exists: (await gotrueProviders()).some((p) => p.identifier === id) });
'

NODE_PROVIDER_REMOVE='
const id = arg("id");
const known = (await gotrueProviders()).some((p) => p.identifier === id);
if (known) {
  const r = await call("DELETE", `${PROVIDERS}/${id}`);
  if (!r.ok) fail("removing the provider failed", r);
}
const shown = await shownProviders();
const rest = shown.filter((s) => s.id !== id);
if (rest.length !== shown.length) await saveShown(rest);
out({ ok: true, id, removed: known, unlisted: rest.length !== shown.length });
'

# run_node PROGRAM KEY VALUE...: runs NODE_LIB + PROGRAM with the pairs as
# PARAMS; prints the program's JSON line.
run_node() {
	local prog="$1"; shift
	local json="{" sep=""
	while [[ $# -gt 0 ]]; do
		json+="$sep\"$1\":\"$(b64 "$2")\""
		sep=","
		shift 2
	done
	json+="}"
	printf 'const PARAMS_B64 = "%s";\n%s\n%s\n' "$(b64 "$json")" "$NODE_LIB" "$prog" | fed_node
}

# json_field JSON KEY: a top-level string, number or boolean value.
json_field() {
	printf '%s' "$1" | sed -n "s/.*\"$2\":\(\"\([^\"]*\)\"\|\([a-z0-9]*\)\).*/\2\3/p"
}

# node_call VAR PROGRAM KEY VALUE...: run_node into VAR; dies with the
# program's error.
node_call() {
	local __var="$1" __res="" __err; shift
	__res="$(run_node "$@")" || true
	if [[ "$(json_field "$__res" ok)" != true ]]; then
		__err="$(json_field "$__res" error)"
		die "${__err:-the admin command failed in federation-server: docker compose logs federation-server}"
	fi
	printf -v "$__var" '%s' "$__res"
}

# secret_target: a generated password needs somewhere to be shown (reveal_secret, lib.sh) before
# it is set; without one the command stops with the account unchanged.
secret_target() {
	secret_ready || die "nowhere to show a generated password: no terminal, and neither $SELF_HOST_DIR nor ${HOME:-\$HOME} is writable. Pass --password"
	trap secret_discard EXIT
}

valid_email() { [[ "$1" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; }
valid_username() { [[ "$1" =~ ^[a-z0-9_]{3,24}$ ]]; }

has_admin() {
	local n
	n="$(db_sql -c "SELECT count(*) FROM public.profiles WHERE is_local AND is_admin" 2>/dev/null || true)"
	[[ "$n" =~ ^[1-9] ]]
}

# --- create ------------------------------------------------------------------
create() {
	local email="" username="" password="" display="" generated=false
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--email) email="${2:-}"; shift ;;
			--username) username="${2:-}"; shift ;;
			--password) password="${2:-}"; shift ;;
			--display-name) display="${2:-}"; shift ;;
			*) die "unknown argument: $1 (see --help)" ;;
		esac
		shift
	done
	email="${email:-${HARMONY_ADMIN_EMAIL:-}}"
	username="${username:-${HARMONY_ADMIN_USERNAME:-}}"
	password="${password:-${HARMONY_ADMIN_PASSWORD:-}}"
	[[ -n "$email" ]] || ask email "Admin email" "$(env_get "$ENV_FILE" ADMIN_EMAIL)"
	email="$(printf '%s' "$email" | lower)"
	valid_email "$email" || die "'$email' is not an email address"
	if [[ -z "$username" ]]; then
		username="$(printf '%s' "${email%%@*}" | lower | tr -cd 'a-z0-9_' | cut -c1-24)"
		if [[ ${#username} -lt 3 ]] || reserved_username "$username" "$(env_get "$ENV_FILE" DOMAIN)"; then username=owner; fi
		ask username "Admin username (3-24 of a-z, 0-9, _)" "$username"
	fi
	username="$(printf '%s' "$username" | lower)"
	valid_username "$username" || die "the username must be 3-24 characters of a-z, 0-9 and _"
	if reserved_username "$username" "$(env_get "$ENV_FILE" DOMAIN)"; then die "the username $username is reserved; choose another"; fi
	if [[ -z "$password" ]] && interactive; then
		ask_secret password "Admin password (empty generates one)"
		if [[ -n "$password" ]]; then
			local again; ask_secret again "Repeat the password"
			[[ "$password" == "$again" ]] || die "the passwords differ"
		fi
	fi
	if [[ -z "$password" ]]; then password="$(gen_password)"; generated=true; fi
	[[ ${#password} -ge 8 ]] || die "the password needs at least 8 characters"
	$generated && secret_target

	info "Creating the admin account $username <$email>..."
	local res
	node_call res "$NODE_CREATE" email "$email" username "$username" password "$password" display_name "$display"
	username="$(json_field "$res" username)"
	local fresh=false
	[[ "$(json_field "$res" created)" == true || "$(json_field "$res" passwordSet)" == true ]] && fresh=true
	if $fresh; then
		ok "Admin account ready: $username <$email>"
		$generated && reveal_secret "Password for $email (harmony admin reset-password sets a new one)" "$password"
	else
		ok "Account $username <$email> exists; it is an admin (password unchanged)"
	fi
	# HARMONY_ADMIN_RESULT: file receiving username=, email=, password_set= for install.sh.
	if [[ -n "${HARMONY_ADMIN_RESULT:-}" ]]; then
		printf 'username=%s\nemail=%s\npassword_set=%s\n' "$username" "$email" "$fresh" > "$HARMONY_ADMIN_RESULT"
	fi
}

# --- reset-password ----------------------------------------------------------
reset_password() {
	local email="" username="" password="" generated=false
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--email) email="${2:-}"; shift ;;
			--username) username="${2:-}"; shift ;;
			--password) password="${2:-}"; shift ;;
			*) die "unknown argument: $1 (see --help)" ;;
		esac
		shift
	done
	if [[ -z "$email" && -z "$username" ]]; then
		ask email "Email of the account" "$(env_get "$ENV_FILE" ADMIN_EMAIL)"
	fi
	email="$(printf '%s' "$email" | lower)"
	username="$(printf '%s' "$username" | lower)"
	if [[ -z "$password" ]] && interactive; then
		ask_secret password "New password (empty generates one)"
		if [[ -n "$password" ]]; then
			local again; ask_secret again "Repeat the password"
			[[ "$password" == "$again" ]] || die "the passwords differ"
		fi
	fi
	if [[ -z "$password" ]]; then password="$(gen_password)"; generated=true; fi
	[[ ${#password} -ge 8 ]] || die "the password needs at least 8 characters"
	$generated && secret_target
	local res
	node_call res "$NODE_RESET" email "$email" username "$username" password "$password"
	ok "Password changed for $(json_field "$res" email)"
	$generated && reveal_secret "New password for $(json_field "$res" email)" "$password"
	return 0
}

# --- invite ------------------------------------------------------------------
invite() {
	local email="" send=0 domain smtp
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--send) send=1 ;;
			-*) die "unknown argument: $1 (see --help)" ;;
			*) email="$1" ;;
		esac
		shift
	done
	[[ -n "$email" ]] || die "usage: harmony admin invite <email> [--send]"
	email="$(printf '%s' "$email" | lower)"
	valid_email "$email" || die "'$email' is not an email address"
	domain="$(env_get "$ENV_FILE" DOMAIN)"
	smtp="$(env_get "$SB_ENV" SMTP_HOST)"
	if [[ $send == 1 && ( -z "$smtp" || "$smtp" == supabase-mail ) ]]; then
		die "--send needs SMTP (harmony config); without it, send the printed link yourself"
	fi
	local res
	# The link signs the person in on /reset-password, where they choose a password.
	node_call res "$NODE_INVITE" email "$email" redirect "https://$domain/reset-password" send "$send"
	if [[ $send == 1 ]]; then
		ok "Invitation emailed to $email"
	else
		ok "Invitation for $email (single use; send it to them):"
		printf '   %s\n' "$(printf '%s' "$res" | sed -n 's/.*"link":"\([^"]*\)".*/\1/p' | sed 's/\\u0026/\&/g')"
	fi
}

# --- registration ------------------------------------------------------------
registration() {
	local policy="${1:-}" disable open_reg
	policy="${policy:-$(env_get "$ENV_FILE" REGISTRATION)}"
	policy="$(printf '%s' "${policy:-open}" | lower)"
	case "$policy" in
		open) disable=false; open_reg=true ;;
		invite|invite-only) policy=invite; disable=true; open_reg=false ;;
		closed) disable=true; open_reg=false ;;
		*) die "registration is open, invite or closed" ;;
	esac
	if [[ "$policy" == open ]] && ! has_admin; then
		die "no admin exists yet; create one first (harmony admin create), then open registration"
	fi
	env_set "$ENV_FILE" REGISTRATION "$policy"
	env_set "$SB_ENV" DISABLE_SIGNUP "$disable"
	db_sql -c "UPDATE public.instance_config SET config_value = '$open_reg'::jsonb, updated_at = now() WHERE config_key = 'open_registration'" >/dev/null ||
		die "could not update instance_config.open_registration"
	# Recreated only when DISABLE_SIGNUP changed.
	compose up -d auth >/dev/null 2>&1 || die "could not apply DISABLE_SIGNUP to the auth service"
	wait_healthy auth || warn "the auth service is not healthy yet: docker compose logs auth"
	case "$policy" in
		open)   ok "Registration: open (anyone can create an account)" ;;
		invite) ok "Registration: invite only (harmony admin invite EMAIL)" ;;
		closed) ok "Registration: closed" ;;
	esac
}

# --- auth providers ------------------------------------------------------------
# GoTrue builds the custom providers' callback from GOTRUE_CUSTOM_OAUTH_EXTERNAL_URL,
# API_EXTERNAL_URL/auth/v1 (supabase-overrides.yml).
callback_url() { printf '%s/auth/v1/callback' "$(env_get "$SB_ENV" API_EXTERNAL_URL)"; }

show_callback() {
	printf '\n   Redirect (callback) URL to register with the provider:\n\n     %s%s%s\n\n' \
		"$c_bold" "$(callback_url)" "$c_reset"
}

# provider_id SLUG: custom:SLUG, GoTrue's identifier format (8-50 characters with the prefix).
provider_id() {
	local slug
	slug="$(printf '%s' "${1#custom:}" | lower)"
	[[ "$slug" =~ ^[a-z0-9]([a-z0-9-]{0,41}[a-z0-9])?$ ]] ||
		die "the provider id is 1-43 characters of a-z, 0-9 and -, starting and ending with a letter or digit (e.g. authentik)"
	printf 'custom:%s' "$slug"
}

need_https() { [[ -z "$2" || "$2" =~ ^https://[^[:space:]]+$ ]] || die "$1 must be an https:// URL"; }

linking_value() { env_get "$SB_ENV" PROVIDER_LINKING_DOMAINS; }
autoconfirm_on() { truthy "$(env_get "$SB_ENV" ENABLE_EMAIL_AUTOCONFIRM)"; }

refuse_autoconfirm_link() {
	die "ENABLE_EMAIL_AUTOCONFIRM=true in supabase/.env: the auth service counts every address a provider sends as verified, so whoever sets an address at the provider signs in to the Harmony account that has it, the admin's included. --provider-verifies-email states the provider hands out only addresses it has checked; otherwise configure SMTP first (harmony config)"
}

# linking_checked: PROVIDER_LINKING_DOMAINS, or a stop when GoTrue would not parse it.
linking_checked() {
	local value
	value="$(linking_value)"
	linking_valid "$value" ||
		die "PROVIDER_LINKING_DOMAINS in supabase/.env is not comma-separated provider=domain pairs ('$value'); the auth service does not start with it. Correct it, then docker compose up -d auth"
	printf '%s' "$value"
}

# apply_linking VALUE: writes PROVIDER_LINKING_DOMAINS, recreates the auth service and checks
# that the running container has the value (supabase-overrides.yml maps it to
# GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS).
apply_linking() {
	local value="$1" id running
	env_set "$SB_ENV" PROVIDER_LINKING_DOMAINS "$value"
	info "Recreating the auth service with PROVIDER_LINKING_DOMAINS=$value..."
	compose up -d auth >/dev/null 2>&1 || die "could not recreate the auth service: docker compose up -d auth"
	wait_healthy auth || die "the auth service is not healthy: docker compose logs auth"
	id="$(svc_id auth)"
	running="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" 2>/dev/null |
		sed -n 's/^GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS=//p')"
	[[ "$running" == "$value" ]] ||
		die "the auth service runs with GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS='$running', not '$value'; check supabase-overrides.yml"
}

# say_linking ID VALUE: the provider's mode, as harmony auth providers shows it.
say_linking() {
	case "$(linking_mode "$2" "$1")" in
		separate)   ok "Existing accounts: kept apart; a first sign-in through $1 makes a new account" ;;
		"by address")
			ok "Existing accounts: a first sign-in through $1 joins the account that has its address"
			if autoconfirm_on; then
				warn "ENABLE_EMAIL_AUTOCONFIRM=true: every address $1 sends counts as verified"
			fi ;;
		shared:*)   ok "Existing accounts: joined only with accounts of the providers in linking domain $(linking_domain "$2" "$1")" ;;
	esac
}

# auth_builtin_providers VALUE: GoTrue's own providers, the built-in ones and any other the
# auth service has on, with their mode; warns about one on that links by address while
# addresses are confirmed automatically.
auth_builtin_providers() {
	local value="$1" on pid state mode list rows="" open=""
	on=" $(oauth_enabled) "
	list="$BUILTIN_OAUTH_PROVIDERS"
	for pid in $on; do
		[[ " $list " == *" $pid "* ]] || list+=" $pid"
	done
	for pid in $list; do
		mode="$(linking_mode "$value" "$pid")"
		state=off
		if [[ "$on" == *" $pid "* ]]; then
			state=on
			[[ "$mode" != "by address" ]] || open+="${open:+ }$pid"
		fi
		rows+="$pid"$'\t'"$state"$'\t'"$mode"$'\n'
	done
	printf 'PROVIDER\tAUTH SERVICE\tEXISTING ACCOUNTS\n%s' "$rows" | align_tabs
	if [[ -n "$open" ]] && autoconfirm_on; then
		warn "$open join existing accounts by address, and ENABLE_EMAIL_AUTOCONFIRM=true counts every address they send as verified (harmony auth linking ID --separate-accounts keeps them apart)"
	fi
}

auth_providers() {
	local res rows stale value pid pname ptype pstate pwhere ids="" orphans="" open=""
	node_call res "$NODE_PROVIDER_LIB$NODE_PROVIDER_LIST"
	rows="$(printf '%s' "$(json_field "$res" rows)" | base64 -d)"
	value="$(linking_value)"
	if ! linking_valid "$value"; then
		warn "PROVIDER_LINKING_DOMAINS in supabase/.env is not provider=domain pairs ('$value'); the auth service does not start with it"
		value=""
	fi
	auth_builtin_providers "$value"
	echo
	if [[ -z "$rows" ]]; then
		info "No custom sign-in providers (harmony auth add-provider adds one)"
	else
		{
			printf 'ID\tNAME\tTYPE\tSIGN-IN PAGE\tEXISTING ACCOUNTS\tISSUER OR AUTHORIZE URL\n'
			while IFS=$'\t' read -r pid pname ptype pstate pwhere; do
				printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$pname" "$ptype" "$pstate" "$(linking_mode "$value" "$pid")" "$pwhere"
			done <<<"$rows"
		} | align_tabs
		while IFS=$'\t' read -r pid _; do
			[[ "$(linking_mode "$value" "$pid")" != "by address" ]] || open+="${open:+ }$pid"
			ids+=" $pid "
		done <<<"$rows"
	fi
	for pid in $(printf '%s' "$value" | tr ',' '\n' | sed -n 's/^[[:space:]]*\(custom:[^=[:space:]]*\)[[:space:]]*=.*/\1/p'); do
		[[ "$ids" == *" $pid "* ]] || orphans+="${orphans:+ }$pid"
	done
	if [[ -n "$open" ]] && autoconfirm_on; then
		warn "$open join existing accounts by address, and ENABLE_EMAIL_AUTOCONFIRM=true counts every address they send as verified (harmony auth add-provider ID --separate-accounts keeps them apart)"
	fi
	[[ -z "$orphans" ]] || info "PROVIDER_LINKING_DOMAINS names providers the auth service lacks: $orphans"
	stale="$(json_field "$res" stale)"
	[[ -z "$stale" ]] || warn "buttons without a provider in the auth service: $stale (harmony auth remove-provider ID removes them)"
	show_callback
}

auth_add_provider() {
	local id="" name="" issuer="" discovery="" authorize="" token="" userinfo="" client_id="" secret="" secret_file=""
	local scopes="" icon="" icon_set=0 email_optional="" pkce="" type="" res
	local link="" vouch=0 linking want
	if [[ $# -gt 0 && "$1" != -* ]]; then id="$1"; shift; fi
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--name) name="${2:-}"; shift ;;
			--issuer) issuer="${2:-}"; shift ;;
			--discovery-url) discovery="${2:-}"; shift ;;
			--authorize-url) authorize="${2:-}"; shift ;;
			--token-url) token="${2:-}"; shift ;;
			--userinfo-url) userinfo="${2:-}"; shift ;;
			--client-id) client_id="${2:-}"; shift ;;
			--client-secret-file) secret_file="${2:-}"; shift ;;
			--scopes) scopes="${2:-}"; shift ;;
			--icon) icon="${2:-}"; icon_set=1; shift ;;
			--email-optional) email_optional=1 ;;
			--require-email) email_optional=0 ;;
			--no-pkce) pkce=0 ;;
			--pkce) pkce=1 ;;
			--separate-accounts) [[ "$link" != 1 ]] || die "--separate-accounts and --link-existing-accounts exclude each other"; link=0 ;;
			--link-existing-accounts) [[ "$link" != 0 ]] || die "--separate-accounts and --link-existing-accounts exclude each other"; link=1 ;;
			--provider-verifies-email) vouch=1 ;;
			*) die "unknown argument: $1 (harmony help)" ;;
		esac
		shift
	done
	[[ $vouch -eq 0 || "$link" == 1 ]] || die "--provider-verifies-email goes with --link-existing-accounts"
	if [[ "$link" == 1 ]] && autoconfirm_on && [[ $vouch -eq 0 ]]; then
		refuse_autoconfirm_link
	fi
	[[ -n "$id" ]] || die "usage: harmony auth add-provider ID --name NAME --issuer URL --client-id ID [options] (harmony help)"
	id="$(provider_id "$id")"
	for pair in "--issuer:$issuer" "--discovery-url:$discovery" "--authorize-url:$authorize" \
		"--token-url:$token" "--userinfo-url:$userinfo" "--icon:$icon"; do
		need_https "${pair%%:*}" "${pair#*:}"
	done
	if [[ -n "$issuer$discovery" && -n "$authorize$token$userinfo" ]]; then
		die "give --issuer (OIDC) or --authorize-url, --token-url and --userinfo-url (OAuth 2.0), not both"
	fi
	if [[ -n "$issuer$discovery" ]]; then
		type=oidc
		[[ -n "$issuer" ]] || die "--discovery-url needs --issuer too"
	elif [[ -n "$authorize$token$userinfo" ]]; then
		type=oauth2
	fi
	[[ ${#name} -le 100 ]] || die "the name is at most 100 characters"

	if [[ -n "$secret_file" ]]; then
		if [[ "$secret_file" == - ]]; then
			secret="$(cat)"
		else
			[[ -r "$secret_file" ]] || die "cannot read $secret_file"
			secret="$(cat "$secret_file")"
		fi
	elif [[ -n "${HARMONY_OAUTH_CLIENT_SECRET:-}" ]]; then
		secret="$HARMONY_OAUTH_CLIENT_SECRET"
	else
		ask_secret secret "Client secret from the provider (empty keeps the stored one)"
	fi

	# Linking first: GoTrue must run with the provider's pair before the provider exists.
	linking="$(linking_checked)"
	case "$link" in
		1) want="$(linking_set "$linking" "$id")" ;;
		0) want="$(linking_set "$linking" "$id" "$id")" ;;
		*)
			want="$linking"
			if [[ "$(linking_mode "$linking" "$id")" == "by address" ]]; then
				node_call res "$NODE_PROVIDER_LIB$NODE_PROVIDER_EXISTS" id "$id"
				[[ "$(json_field "$res" exists)" == true ]] || want="$(linking_set "$linking" "$id" "$id")"
			fi ;;
	esac
	[[ "$want" == "$linking" ]] || apply_linking "$want"

	info "Saving sign-in provider $id..."
	node_call res "$NODE_PROVIDER_LIB$NODE_PROVIDER_ADD" id "$id" type "$type" name "$name" \
		issuer "$issuer" discovery_url "$discovery" authorize_url "$authorize" token_url "$token" \
		userinfo_url "$userinfo" client_id "$client_id" client_secret "$secret" scopes "$scopes" \
		icon "$icon" icon_set "$icon_set" email_optional "$email_optional" pkce "$pkce"
	if [[ "$(json_field "$res" created)" == true ]]; then
		ok "Sign-in provider $id ($(json_field "$res" name)) added; its button shows on the next load of the sign-in page"
	else
		ok "Sign-in provider $id ($(json_field "$res" name)) updated"
	fi
	say_linking "$id" "$want"
	show_callback
}

auth_remove_provider() {
	local id="${1:-}" res linking paired=false
	[[ -n "$id" ]] || die "usage: harmony auth remove-provider ID"
	id="$(provider_id "$id")"
	linking="$(linking_checked)"
	[[ -z "$(linking_domain "$linking" "$id")" ]] || paired=true
	node_call res "$NODE_PROVIDER_LIB$NODE_PROVIDER_REMOVE" id "$id"
	if [[ "$(json_field "$res" removed)" != true && "$(json_field "$res" unlisted)" != true ]] && ! $paired; then
		die "no sign-in provider $id (harmony auth providers lists them)"
	fi
	if [[ "$(json_field "$res" removed)" == true ]]; then
		ok "Sign-in provider $id removed"
		info "An account that signed in only through it has no way in until it gets a password (harmony admin reset-password)"
	elif [[ "$(json_field "$res" unlisted)" == true ]]; then
		ok "Button of $id removed from the sign-in page (the auth service had no such provider)"
	fi
	# After the provider: while it exists, its pair keeps it apart.
	if $paired; then
		apply_linking "$(linking_set "$linking" "$id")"
		ok "$id removed from PROVIDER_LINKING_DOMAINS"
	fi
}

auth_linking() {
	local id="${1:-}" link="" vouch=0 linking want domain
	[[ $# -gt 0 ]] && shift
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--separate-accounts) [[ "$link" != 1 ]] || die "--separate-accounts and --link-existing-accounts exclude each other"; link=0 ;;
			--link-existing-accounts) [[ "$link" != 0 ]] || die "--separate-accounts and --link-existing-accounts exclude each other"; link=1 ;;
			--provider-verifies-email) vouch=1 ;;
			*) die "unknown argument: $1 (harmony help)" ;;
		esac
		shift
	done
	id="$(printf '%s' "$id" | lower)"
	[[ -n "$id" && -n "$link" ]] ||
		die "usage: harmony auth linking PROVIDER (--separate-accounts | --link-existing-accounts [--provider-verifies-email])"
	[[ "$id" != custom:* ]] ||
		die "$id is your own provider: harmony auth add-provider ${id#custom:} --separate-accounts (or --link-existing-accounts)"
	[[ " $GOTRUE_OAUTH_PROVIDERS " == *" $id "* ]] || die "the auth service has no provider $id (it has: $GOTRUE_OAUTH_PROVIDERS)"
	[[ $vouch -eq 0 || "$link" == 1 ]] || die "--provider-verifies-email goes with --link-existing-accounts"
	if [[ "$link" == 1 ]] && autoconfirm_on; then
		[[ "$id" != github ]] ||
			die "ENABLE_EMAIL_AUTOCONFIRM=true in supabase/.env: GitHub hands the auth service every address of the GitHub account, unverified ones included, so whoever adds an address there signs in to the Harmony account that has it, the admin's included. Configure SMTP first (harmony config)"
		[[ $vouch -eq 1 ]] || refuse_autoconfirm_link
	fi

	# default, not no pair: configure.sh adds a pair to a built-in provider that has none.
	if [[ "$link" == 1 ]]; then domain=default; else domain="$id"; fi
	linking="$(linking_checked)"
	want="$linking"
	[[ "$(linking_domain "$linking" "$id")" == "$domain" ]] || want="$(linking_set "$linking" "$id" "$domain")"
	[[ "$want" == "$linking" ]] || apply_linking "$want"
	say_linking "$id" "$want"
	[[ " $(oauth_enabled) " == *" $id "* ]] || info "$id is off in the auth service; this applies once it is on"
}

auth_cmd() {
	local sub="${1:-}"
	[[ $# -gt 0 ]] && shift
	case "$sub" in
		providers) auth_providers ;;
		add-provider) auth_add_provider "$@" ;;
		remove-provider) auth_remove_provider "$@" ;;
		linking) auth_linking "$@" ;;
		*) die "usage: harmony auth providers | add-provider | remove-provider | linking" ;;
	esac
}

case "${1:-}" in
	create) shift; create "$@" ;;
	reset-password) shift; reset_password "$@" ;;
	invite) shift; invite "$@" ;;
	registration) shift; registration "$@" ;;
	auth) shift; auth_cmd "$@" ;;
	has-admin) has_admin ;;
	-h|--help|"") usage ;;
	*) die "unknown command: $1 (create | reset-password | invite | registration | auth)" ;;
esac
