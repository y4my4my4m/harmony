#!/usr/bin/env bash
# =============================================================================
# Harmony accounts and registration, for the operator
# =============================================================================
#   bash admin.sh create [--email E] [--username U] [--password P] [--display-name N]
#   bash admin.sh reset-password (--email E | --username U) [--password P]
#   bash admin.sh invite <email> [--send]
#   bash admin.sh registration [open | invite | closed]
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
# A missing password is generated and printed. Calls run inside the
# federation-server container (Kong on the compose network, keys from its
# environment); nothing secret appears on a command line.
#
# registration maps the policy onto GoTrue and instance_config:
#   open     sign-up on (DISABLE_SIGNUP=false), open_registration true
#   invite   sign-up off; `invite` creates an invite link per address
#   closed   sign-up off, no invitations
# Without an argument it applies REGISTRATION from .env.
# =============================================================================
set -euo pipefail
# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

usage() { sed -n '2,28p' "${BASH_SOURCE[0]}"; }

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
		[[ ${#username} -ge 3 ]] || username=admin
		ask username "Admin username (3-24 of a-z, 0-9, _)" "$username"
	fi
	username="$(printf '%s' "$username" | lower)"
	valid_username "$username" || die "the username must be 3-24 characters of a-z, 0-9 and _"
	if [[ -z "$password" ]] && interactive; then
		ask_secret password "Admin password (empty generates one)"
		if [[ -n "$password" ]]; then
			local again; ask_secret again "Repeat the password"
			[[ "$password" == "$again" ]] || die "the passwords differ"
		fi
	fi
	if [[ -z "$password" ]]; then password="$(gen_password)"; generated=true; fi
	[[ ${#password} -ge 8 ]] || die "the password needs at least 8 characters"

	info "Creating the admin account $username <$email>..."
	local res
	node_call res "$NODE_CREATE" email "$email" username "$username" password "$password" display_name "$display"
	username="$(json_field "$res" username)"
	local fresh=false
	[[ "$(json_field "$res" created)" == true || "$(json_field "$res" passwordSet)" == true ]] && fresh=true
	if $fresh; then
		ok "Admin account ready: $username <$email>"
		if $generated; then
			printf '   Password: %s%s%s   (shown once; harmony admin reset-password sets a new one)\n' "$c_bold" "$password" "$c_reset"
		fi
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
	local res
	node_call res "$NODE_RESET" email "$email" username "$username" password "$password"
	ok "Password changed for $(json_field "$res" email)"
	$generated && printf '   Password: %s%s%s\n' "$c_bold" "$password" "$c_reset"
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

case "${1:-}" in
	create) shift; create "$@" ;;
	reset-password) shift; reset_password "$@" ;;
	invite) shift; invite "$@" ;;
	registration) shift; registration "$@" ;;
	has-admin) has_admin ;;
	-h|--help|"") usage ;;
	*) die "unknown command: $1 (create | reset-password | invite | registration)" ;;
esac
