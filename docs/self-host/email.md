---
title: Email (SMTP)
description: Connect a self-hosted Harmony instance to an SMTP server for address confirmations, password resets and invitations.
---

# Email (SMTP)

This page is for operators who want their instance to send email. Harmony's
own services send none: the Supabase sign-in service (the `auth` container,
`supabase-auth`) sends every message, through the SMTP server you give it.

## What email is used for

| Message | Sent when |
|---|---|
| Address confirmation | Someone registers and email confirmation is on. The app tells them it sent a confirmation link and returns to the sign-in page; they can sign in after following the link |
| Password reset | Someone uses **Forgot your password?** on the sign-in page. The link opens the app's password page (`/reset-password`) |
| Invitation | You turn on **Send by email** in the admin panel's **Invites**, or run `harmony admin invite <email> --send`. The single-use link opens the same password page, where the person chooses a password ([Invitation and password reset links](#invitation-and-password-reset-links)) |

Without SMTP the instance works, with these differences:

- New accounts are usable as soon as they are created; addresses are never
  confirmed (`ENABLE_EMAIL_AUTOCONFIRM=true`).
- Nobody can reset a forgotten password by email. You can set one from the
  server with `harmony admin reset-password --email user@example.com`.
- `harmony admin invite` prints the invitation link for you to send;
  `--send` refuses to run. In the admin panel's **Invites**, **Send by email**
  is off and the page gives you the link to copy.
- A first sign-in through Google, GitHub or Twitch makes a new account even
  when an account has the same address
  ([Existing accounts](/self-host/oauth#existing-accounts)).

Accounts made with `harmony admin create` are confirmed at creation and need
no email.

## Set up email with harmony config

You need an SMTP server: its host name, port, username and password, and an
address your email provider lets you send from.

1. Run the configuration again:

   ```bash
   harmony config
   ```

2. Answer `y` to **Configure outgoing email (SMTP) now?**, then give:

   | Question | Answer |
   |---|---|
   | SMTP host | e.g. `smtp.mailgun.org` |
   | SMTP port | Default `587` |
   | SMTP username | Your SMTP login |
   | SMTP password | Hidden; Enter keeps the current one |
   | Sender address (From) | Default `noreply@chat.example.com` |

   The other questions keep their current answers when you press Enter.

3. `harmony config` applies the change and restarts the sign-in service.
   Check it with `harmony doctor` (see [Test email](#test-email)).

The installer asks the same questions ("Set up email (SMTP) now?"), so an
instance can have email from the start.

The first time SMTP is configured, `configure.sh` also sets
`ENABLE_EMAIL_AUTOCONFIRM=false`: from then on, new accounts confirm their
address. Changing the SMTP settings later leaves that value alone, so a hand
edit of it stays. The built-in sign-in providers stay apart from existing
accounts, since those made before never confirmed theirs;
`harmony auth linking` changes that per provider.

### Without prompts

```bash
cd /opt/harmony/self-host
HARMONY_SMTP_HOST=smtp.mailgun.org \
HARMONY_SMTP_PORT=587 \
HARMONY_SMTP_USER=postmaster@mg.example.com \
HARMONY_SMTP_PASS='the-password' \
HARMONY_SMTP_SENDER=noreply@chat.example.com \
  bash configure.sh --non-interactive
docker compose up -d
```

`HARMONY_SMTP_PORT` defaults to `587` and `HARMONY_SMTP_SENDER` to
`noreply@DOMAIN`. Without `HARMONY_SMTP_HOST`, the current email settings
stay as they are.

`configure.sh` refuses:

- a host other than letters, digits, dots and hyphens
- a sender that is not an email address
- a username with spaces, quotes, `$` or `#`
- a password with a single quote or a line break

## Set up email by hand

Edit `self-host/supabase/.env`:

```bash
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@mg.example.com
SMTP_PASS='p@ss word$'
SMTP_ADMIN_EMAIL=noreply@chat.example.com
SMTP_SENDER_NAME=Example Chat
ENABLE_EMAIL_AUTOCONFIRM=false
```

Then apply it:

```bash
cd /opt/harmony/self-host
docker compose up -d
```

Docker Compose reads `$`, `#` and spaces in an unquoted value specially. Put
a password that contains them in single quotes, as above; `configure.sh`
does the same.

| Variable | What it does |
|---|---|
| `SMTP_HOST` | SMTP server. The upstream default, `supabase-mail`, counts as no SMTP |
| `SMTP_PORT` | SMTP port |
| `SMTP_USER`, `SMTP_PASS` | SMTP credentials |
| `SMTP_ADMIN_EMAIL` | From address |
| `SMTP_SENDER_NAME` | Sender name. `configure.sh` sets the instance name |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true`: accounts are usable at sign-up without confirming their address. `false`: they confirm it by email first |

The upstream Supabase compose file passes these to the sign-in service as
`GOTRUE_SMTP_HOST`, `GOTRUE_SMTP_PORT`, `GOTRUE_SMTP_USER`,
`GOTRUE_SMTP_PASS`, `GOTRUE_SMTP_ADMIN_EMAIL`, `GOTRUE_SMTP_SENDER_NAME` and
`GOTRUE_MAILER_AUTOCONFIRM`. A manual deployment with its own Supabase stack
sets the same keys in that stack's `.env`.

Links in the messages lead back to the app at `SITE_URL`
(`https://chat.example.com`), which `configure.sh` sets.

## Invitation and password reset links

The invitation and password reset emails link to the app's password page,
`SITE_URL/reset-password`, with the link's token in the address. Opening the
page uses nothing up; the token is spent when the person submits their new
password. A mail scanner or a link preview that opens the link first leaves it
working.

The sign-in service's own templates link to `https://DB_DOMAIN/auth/v1/verify`
instead, where the first visit spends the token: when a scanner gets there
first, the person finds **This invitation link does not work**. The self-host
stack therefore points the sign-in service at Harmony's templates, which the
`web` container serves:

| Email | Setting of the auth service | Value |
|---|---|---|
| Invitation | `GOTRUE_MAILER_TEMPLATES_INVITE` | `http://web/email-templates/invite.html` |
| Password reset | `GOTRUE_MAILER_TEMPLATES_RECOVERY` | `http://web/email-templates/recovery.html` |

The sign-in service fetches each template when it sends the first message and
keeps it in memory. When the fetch fails it sends its own template and logs
`templatemailer_template_body_http_error` (`harmony logs auth`).

To use templates of your own, set `MAILER_TEMPLATES_INVITE` and
`MAILER_TEMPLATES_RECOVERY` in `supabase/.env` to their URLs and run
`docker compose up -d auth`. A template is a Go HTML template; keep the
link's form:

```html
<a href="{{ .SiteURL }}/reset-password?invite=1&amp;token_hash={{ .TokenHash }}&amp;type=invite">Choose your password</a>
<a href="{{ .SiteURL }}/reset-password?token_hash={{ .TokenHash }}&amp;type=recovery">Choose a new password</a>
```

A deployment with its own Supabase stack sets the two `GOTRUE_MAILER_TEMPLATES_*`
variables to `https://DOMAIN/email-templates/invite.html` and
`https://DOMAIN/email-templates/recovery.html`, which the web app serves.
A `/auth/v1/verify` link still works when the person is the first to open it:
the page takes the sign-in it hands over.

The federation backend cannot see the sign-in service's settings. `configure.sh`
copies `SMTP_HOST` into `federation.env` as `GOTRUE_SMTP_HOST`; the admin
panel offers **Send by email** for invitations only when it is set and not
`supabase-mail`. After editing `SMTP_HOST` by hand, run `harmony config`, or
set `GOTRUE_SMTP_HOST` in `federation.env` and
`docker compose up -d federation-server`.

## Test email

`harmony doctor` reports email in its **Services** section:

| Result | Meaning |
|---|---|
| OK `SMTP host:port reachable` | The server accepts a TCP connection on that port |
| WARN `no SMTP server` | `SMTP_HOST` is empty or `supabase-mail` |
| WARN `does not accept connections from this server` | The host or port is wrong, or outgoing mail is blocked. Many VPS providers block outgoing ports 25 and 587 until you ask them to open them |

The check opens a connection only; it does not sign in or send. To send a
real message, open the sign-in page, choose **Forgot your password?** and
enter the address of an existing account. If nothing arrives, read the
sign-in service's log:

```bash
harmony logs auth
```

Authentication failures, refused sender addresses and timeouts appear
there.
