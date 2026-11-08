---
title: Sign-up limits
description: Limit how many accounts one network or email inbox can create, refuse disposable email domains, and make the client address reach the auth service. The per-IP limiters, what each limit counts, and why captcha is off.
---

# Sign-up limits

This page is for instance admins. Sign-up limits raise the cost of creating accounts in bulk,
such as registering short usernames to hoard or sell them. Usernames are immutable and one account
holds one, so each name taken in bulk takes one account. A person with a second account or a test
account stays under the defaults. Nothing here needs configuring: `harmony update` brings it.

The limits run in the auth service's `before-user-created` hook,
`public.before_user_created_hook`, before an account exists. A refused sign-up makes no
account and sends no email.

## The limits

Set them in **Admin, Invites, Sign-up limits**. A change applies to the next sign-up.

| Setting | Key in `instance_config` | Default | Refuses |
|---|---|---|---|
| **Apply sign-up limits** | `signup_limits_enabled` | `true` | With this off, the hook allows everything |
| **Accounts per network in 24 hours** | `signup_daily_ip_cap` | `5` | Past the cap, in a rolling 24 hours: counted, or HTTP 429 with enforcement on. `0` is no cap |
| **Accounts per email inbox in 30 days** | `signup_mailbox_cap` | `5` | HTTP 422 past the cap. `0` is no cap |
| **Accounts per email domain in 24 hours** | `signup_daily_domain_cap` | `10` | Past the cap, in a rolling 24 hours: counted, or HTTP 429 with enforcement on. `0` is no cap |
| **Refuse accounts past the network and domain caps** | `signup_enforce_caps` | `false` | Enforcement. Off, those two caps only observe |
| **Refuse disposable email addresses** | `signup_block_disposable_email` | `true` | HTTP 422 for the domains in `signup_disposable_domains` |
| **More email domains to refuse** | `signup_blocked_email_domains` | `[]` | HTTP 422 for these domains. Applies with the disposable list off |

- The network and domain caps observe by default, because a campus or an office shares one address and
  one email domain. An account past either is allowed and counted, and the panel shows these counts
  apart from refusals. To refuse past them, turn enforcement on; to enforce one alone, set the other
  to `0`. The inbox cap and the domain lists always refuse.
- A **network** is one IPv4 address or one IPv6 /56.
- An **inbox** is the address without its `+tag`. For Gmail, dots do not count and
  `googlemail.com` is `gmail.com`. `me+a@example.org` and `me+b@example.org` are one inbox;
  `m.e@example.org` and `me@example.org` are two.
- The domain cap spots one operator with many mailboxes on a domain of their own, from any network.
  Large mail providers are not counted: `signup_common_email_domains` lists them.
- A blocked domain also matches its subdomains. The domain cap counts each subdomain on its own.
- The inbox count starts with the accounts of the last 30 days when the migration runs.
- The disposable list is a snapshot of
  [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)
  (CC0), 10167 domains.

The panel shows, for the last 7 days, accounts past an observing cap and refusals per limit. [Reviewing signups](/run/signup-review) shows them per day, beside the accounts created.

### What is not limited

- Accounts an admin invites (`harmony admin invite`, **Admin, Invites**). The request comes from
  the instance itself.
- A first sign-in through the instance's own OAuth/OIDC provider or SSO: it vouches for its people,
  an office behind one address included. `signup_limit_own_providers` set to `true` in
  `instance_config` counts them toward the network cap, for a provider with open registration.
- Sign-ins of accounts that already exist. Limits apply when an account would be created.
- Clients with a private address (RFC 1918, RFC 6598, loopback, link-local, RFC 4193): a LAN install
  has no limits.
- A request with no client address, and a failure inside the hook, allow the account.

Limits count accounts at creation, confirmed or not. An account deleted later still counts until its
window ends. Someone who knows an address can fill its inbox limit with aliases: the owner of that
inbox then waits out the 30 days or asks an admin to raise the cap.

A first sign-in through Google, GitHub or Twitch counts toward the network cap only. The hook runs on
the provider's callback, and a refusal shows on the app's callback page.

### Clear a network

With enforcement on, for a network that hit the cap for a good reason, a classroom for example, raise
the cap for the day or clear that network:

```bash
docker compose exec -T db psql -U supabase_admin -h 127.0.0.1 -d postgres \
  -c "DELETE FROM public.signup_ledger WHERE network = '203.0.113.7/32'"
```

### What is stored

`signup_ledger` has one row per allowed account: the time, the network, the email domain and a
SHA-256 of the inbox, with no link to the account. The network and domain are erased after 24 hours
and the row after 30 days, hourly under `pg_cron` and on every allowed sign-up. `signup_refusal_counts` has counts per day and limit for 90 days.

## The client address {#client-address}

The auth service reads the client's address from `Sb-Forwarded-For` when
`GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED` is on. The self-host stack turns it on. The header
gives the sign-up hook its address and switches on the service's per-IP limiters, which otherwise do
not run at all: sign-in, `/verify`, `/recover`, `/otp` and MFA included.

Other headers do not work through Kong 2.8.5:

| Header | At the auth service |
|---|---|
| `Sb-Forwarded-For` | As the proxy set it |
| `X-Real-IP` | Replaced by Kong's peer: every client has the proxy's address |
| `X-Forwarded-For` | Kong appends its peer. The auth service reads the first value, which a client chooses |

The proxy in front of Kong overwrites `Sb-Forwarded-For` on the API host. A proxy that passes it through
lets a client name any address.

### Caddy (the installer's stack)

Nothing to configure. Caddy sets the header on `db.DOMAIN` to the client's address, for clients that
connect directly, through Cloudflare, through a Cloudflare Tunnel or through a proxy on the same host
or LAN that appends to `X-Forwarded-For`. It removes the header for a client with a private address
and on a token refresh (see [below](#per-ip)). Without the header no per-IP limiter runs.

Caddy cannot tell a proxy with a public address, other than Cloudflare, from a client. There every
client has that address. The network cap sets it aside once five or more accounts are active on it and
none on any other public address, and password sign-in shares one limit of 150 per 5 minutes. To give
such an instance its clients' addresses, name the proxy in `CADDY_TRUSTED_PROXIES` in `.env`.

### nginx

Copy `dev/nginx-auth-client-ip.template.conf` to `/etc/nginx/conf.d/harmony-auth-client-ip.conf`. It
maps each request to the client's address, or to nothing on a token refresh. On every location of the
API host that proxies to Kong:

```nginx
proxy_set_header Sb-Forwarded-For $harmony_sb_forwarded_for;
```

`$remote_addr` must be the client: behind a CDN, restore it with `set_real_ip_from` and
`real_ip_header` first. `proxy_set_header` at server level does not reach a location that has its
own `proxy_set_header` lines, and a location's first line drops what it inherited.

### Your own Supabase stack

The root compose files and a Supabase stack of your own need these on the auth service, after the
migrations ran:

```bash
GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED=true
GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true
GOTRUE_HOOK_BEFORE_USER_CREATED_URI=pg-functions://postgres/public/before_user_created_hook
GOTRUE_RATE_LIMIT_EMAIL_SENT=100
```

With the hook enabled and the function missing, every sign-up answers 500.

### Check it

`harmony doctor` reports `signup limits`. For the address itself, from a machine outside the server,
send a forged header and a disposable address:

```bash
curl -s -X POST "https://db.example.com/auth/v1/signup" -H "apikey: $SUPABASE_ANON_KEY" \
  -H 'content-type: application/json' -H 'Sb-Forwarded-For: 192.168.0.1' \
  -d '{"email":"check@mailinator.com","password":"check-the-hook-1"}'
```

The answer is `This email provider cannot be used to sign up on this instance.` A `200` means the
forged private address reached the hook: fix the proxy, and delete the account that was made.

The auth service logs the address it used as `remote_addr`. It must be that machine's:

```bash
harmony logs auth | grep '"path":"/signup"' | tail -1
```

## Per-IP limits of the auth service {#per-ip}

With the header present, the auth service limits each address. Values are per 5 minutes with a burst
of 30, and these are its defaults; set them with the `GOTRUE_` variable on the auth service.

| Variable | Default | Applies to |
|---|---|---|
| `GOTRUE_RATE_LIMIT_OTP` | `30` | `/signup`, `/recover`, `/resend`, `/magiclink`, `/otp`, `PUT /user` |
| `GOTRUE_RATE_LIMIT_TOKEN_REFRESH` | `150` | `/token`: password sign-in |
| `GOTRUE_RATE_LIMIT_VERIFY` | `30` | `/verify` |
| `GOTRUE_MFA_RATE_LIMIT_CHALLENGE_AND_VERIFY` | `15` per minute | MFA challenge and verify |

Lowering `GOTRUE_RATE_LIMIT_OTP` to slow sign-ups also slows password resets and profile changes; the
network cap is the setting for sign-ups, as one person's pace can stay under this limit all day.

A token refresh carries no address, so no limiter runs on it. `auth-js` removes the session on any 429
there, which would sign out everyone behind a shared address, and a refresh token cannot be guessed.
Calls from the instance's own services carry no address either. `GOTRUE_RATE_LIMIT_HEADER` stays
unset: the limiters read `Sb-Forwarded-For` first.

## Email budget

All mail of the instance shares one budget per hour when email confirmation is on:
`RATE_LIMIT_EMAIL_SENT` in `supabase/.env`, `100` here, `30` in the auth service itself. Past it, the
service refuses confirmations and password resets for everyone until the hour rolls.

## Email confirmation

The inbox limit and the domain lists count addresses, and only a confirmation proves an address. With
`ENABLE_EMAIL_AUTOCONFIRM=true`, any address at a domain that passes works, invented or not. Configure
[SMTP](/self-host/email) on a public instance.

## Captcha

Leave the auth service's captcha off (`GOTRUE_SECURITY_CAPTCHA_ENABLED`). It is not limited to sign-up:
the service then requires a token on password sign-in, `/recover`, `/resend`, `/magiclink`, `/otp`,
passkey sign-in and SSO as well. Harmony's clients send none, so nobody could sign in with a password.

## Selling accounts

A sale hands over the credentials of an account. The limits make accounts dearer to make in bulk and
cannot see a sale. Forbid it in the instance rules and act on reports.
