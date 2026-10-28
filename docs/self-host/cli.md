---
title: The harmony command
description: Reference for the harmony operator command of a self-hosted instance, every subcommand and flag, and every check harmony doctor runs.
---

# The harmony command

`harmony` is the operator command of an instance installed with the
[installer](/self-host/install). This page lists every subcommand with its
options and exit behaviour, every check `harmony doctor` runs, and the
scripts behind the commands.

The command is `self-host/harmony` in the checkout. Installed as root, the
installer links it as `/usr/local/bin/harmony`; otherwise run it by its path,
`/opt/harmony/self-host/harmony`. It finds the checkout through the link, so
it works from any directory.

## Synopsis

```text
harmony install [--dir DIR] [--ref REF] [--non-interactive]
harmony update [--version V]
harmony doctor [--offline]
harmony backup [--no-storage] [--label TEXT]
harmony restore <backup> [--yes]
harmony status
harmony logs [service ...] [-n N] [--no-follow]
harmony admin create [--email E] [--username U] [--password P] [--display-name N]
harmony admin reset-password (--email E | --username U) [--password P]
harmony admin invite <email> [--send]
harmony registration [open | invite | closed]
harmony auth providers
harmony auth add-provider ID [--name N] (--issuer URL | --authorize-url URL --token-url URL --userinfo-url URL)
                             [--client-id C] [--client-secret-file FILE|-] [options]
                             [--separate-accounts | --link-existing-accounts [--provider-verifies-email]]
harmony auth remove-provider ID
harmony config
harmony config --upload-ceiling [SIZE]
harmony version
harmony help
```

## Output and exit status

- Progress lines start with `==>`, successes with `✓`. Warnings start with
  `!` and go to standard error. Colours appear only on a terminal.
- An error prints `Error: ` and a message on standard error, and exits with
  status 1. Exceptions are noted per command below.
- `status`, `logs`, `backup`, `admin`, `registration` and `config` need an
  installed instance; without `self-host/.env` they stop with
  `not installed yet: /opt/harmony/self-host/harmony install`.
- An unknown command stops with `unknown command: NAME (harmony help)`.
- Prompts read the terminal (`/dev/tty`). With `HARMONY_NONINTERACTIVE=1`, or
  without a terminal, every prompt takes its default.

## harmony install

```text
harmony install [--dir DIR] [--ref REF] [--non-interactive]
```

Runs the installer, `install.sh`, on this checkout: a first install, or a
safe re-run that keeps the configuration, secrets, data and admin account and
offers the current answers as defaults. `--dir` and `--ref` choose where and
which version to download, so they apply when the installer is piped from
`curl`; a re-run uses the checkout it belongs to. [Install](/self-host/install)
describes the questions, the steps and every environment variable.

Exit status: 0 once the summary is printed; the `harmony doctor` run that
follows does not change it. 1 when a check or step fails.

## harmony update

```text
harmony update [--version V]
```

Updates the code, the configuration, the images and the database, then
recreates the containers that changed, taking a backup first.
[Update](/self-host/update-backup#update-an-instance) describes the steps.

| Option | Effect |
|---|---|
| `--version V`, `--version=V` | Target version. `X.Y.Z` means tag `vX.Y.Z`; `edge` means the `master` branch; any other value is a tag, branch or commit name |

Without `--version`, a checkout on a release tag moves to the newest release
and a checkout on a branch fast-forwards to its upstream.

| Environment variable | Effect |
|---|---|
| `HARMONY_REMOTE` | Git remote to fetch, default `origin` |
| `HARMONY_SKIP_BACKUP=1` | No backup before migrating |
| `HARMONY_BUILD=1` or `0` | Switch to building Harmony's images from the checkout, or back to published images |
| `HARMONY_VERSION` | Image tag for this run, instead of the one derived from the checkout |

Exit status: 0 after `Update complete (VERSION).`. On a failure it prints
`Update stopped during: STEP` and the state it left (see
[When an update stops](/self-host/update-backup#when-an-update-stops)), and
exits non-zero.

## harmony doctor

```text
harmony doctor [--offline]
```

Checks the instance. Each check prints one line, `[ OK ]`, `[WARN]` or
`[FAIL]`, then the check's name and a detail; a WARN or FAIL adds a `fix:`
line. The last line counts the results: `N OK, N WARN, N FAIL`.

| Option | Effect |
|---|---|
| `--offline` | Skips the checks that need the internet: the server's public address (DNS and port reachability compare against it) and the latest release |

| Environment variable | Effect |
|---|---|
| `HARMONY_PUBLIC_IP` | The server's public IPv4, when the lookup fails |

Exit status: 1 when any check FAILs, or when `self-host/.env`,
`federation.env` or `supabase/.env` is missing (check `config`, fix
`harmony install`). WARN results alone exit 0.

The checks that request the public URL run from the server itself, through
DNS. They cover DNS, TLS and the proxy, but a firewall that filters only
other networks passes them. Behind NAT without hairpinning they fail even
when the instance is reachable from outside; each such check then retries
through the server's own HTTPS port and says so.

The sections run in this order: Host, Containers, Database, DNS, TLS
certificates, Federation, Services, Security, Versions.

### Host

| Check | Tests | Result | Fix |
|---|---|---|---|
| `compose` | The Docker Compose version | FAIL when missing or older than 2.24.4 | Upgrade the `docker-compose-plugin` package, or re-run `https://get.docker.com` |
| `memory` | RAM, available memory and swap | WARN under 1900 MB of RAM; with no swap and under 3900 MB; with under 256 MB available | A larger server or a 2 GB swap file; `docker stats` names the service using the memory |
| `disk` | Free space where `self-host/` lives, and in Docker's data directory when that is another filesystem | FAIL under 1 GB free; WARN under 5 GB or over 90% used | Delete old backups in `self-host/backups`; `docker image prune` removes unused images |
| `backup` | The newest backup in `self-host/backups` | WARN when there is none, or when it is more than 7 days old | `harmony backup`, then copy it off the server; [schedule it](/self-host/update-backup#schedule-backups) |

### Containers

| Check | Tests | Result | Fix |
|---|---|---|---|
| the service's name | Each service of the enabled profiles is created, running and healthy | FAIL `not created`, a stopped state, or `running, unhealthy`; WARN `running, health check starting` | `docker compose up -d`, then `harmony logs SERVICE`; for a starting check, wait a minute and re-run |
| `containers` | Reported OK when every service runs | | |
| `images` | `web`, `federation-server`, `federation-worker` and `bot-gateway` run the image the configuration names | WARN when one runs an older image | `docker compose up -d` |

### Database

| Check | Tests | Result | Fix |
|---|---|---|---|
| `database` | Postgres answers | FAIL; the other database checks are skipped | `harmony logs db` |
| `migrations` | Every file in `db_schema/migrations/` is recorded in `supabase_migrations.schema_migrations` | FAIL when some are not applied; WARN when the database has migrations the checkout lacks (the code is older than the database) | `bash bootstrap.sh --migrations-only` (`harmony update` runs it); for the WARN, `harmony update` |
| `realtime-policies` | `realtime.messages` exists and has the receive, send and session AAL policies | FAIL when one is missing: every private Realtime channel (presence, calls, user events) is refused. FAIL when the table is missing: Realtime never created its schema | Run migration `20261025100001` again; it creates only the missing policies. In `self-host/`: `docker compose exec -T db psql -U supabase_admin -h 127.0.0.1 -d postgres -v ON_ERROR_STOP=1 < ../db_schema/migrations/20261025100001_realtime_policy_converge.sql`. `harmony update` does not: the ledger records it as applied. With the table missing, `harmony logs realtime` first |
| `security-notices` | The new-sign-in and second-factor triggers exist on `auth.sessions` and `auth.mfa_factors` | FAIL when one is missing: no security notice for a new sign-in or a changed second factor | Run `db_schema/migrations/20261025100003_auth_triggers_converge.sql` as printed (safe to re-run; `harmony update` runs it once) |
| `storage-policies` | The message media, soundboard, personal emoji and Drive policies on `storage.objects` and `storage.buckets`, the `message_media` and `soundboard` buckets and the Drive triggers on `storage.objects` exist | FAIL when one is missing: the uploads and reads that depend on it fail; a missing `storage_objects_session_aal` lets a session short of its second factor reach storage. FAIL when `storage.objects` or `storage.buckets` is missing | Run `db_schema/migrations/20261025100004_storage_converge.sql` as printed: it creates what is missing, replaces a superseded policy definition and keeps a bucket's configured limits. `harmony update` runs it once. With a table missing, `harmony logs storage` first |
| `upload-limits` | The `storage_upload_limit` trigger exists on `storage.objects` with its settings; the storage container's `FILE_SIZE_LIMIT`, the one in `supabase/.env` and `instance_config.upload_ceiling_bytes` agree | FAIL when the trigger or the settings are missing: per-account upload limits are not enforced. WARN when storage runs another `FILE_SIZE_LIMIT` than `supabase/.env`, or the database holds another ceiling | Run `db_schema/migrations/20261031100001_upload_limits.sql` as printed (safe to re-run); for a WARN, `harmony config --upload-ceiling SIZE` |
| `domain` | `instance_config.domain` equals `DOMAIN` in `.env` | FAIL when unset or still `localhost`; FAIL when the two differ, since handles and ActivityPub ids disagree | `bash bootstrap.sh`; for a difference, see [Domain mismatch](/self-host/troubleshooting#domain-mismatch) |
| `admin` | A local admin account exists | WARN when none does | `harmony admin create` |
| `registration` | `REGISTRATION` in `.env` matches the auth service's sign-up setting and `instance_config.open_registration` | WARN on a mismatch | `harmony registration POLICY` |
| `listener` | The `harmony_listener` role exists | WARN: queued jobs wait for the periodic sweep | `bash bootstrap.sh && docker compose restart federation-worker` |

### DNS

One line per name: the domain, `db.` the domain, and `live.` the domain with
voice on. With internal TLS (a LAN install or a Cloudflare Tunnel), each
FAIL here is a WARN, except a tunnel record set to DNS only, and a name
pointing at another public address passes as a proxy or tunnel in front of
the server.

| Check | Tests | Result | Fix |
|---|---|---|---|
| `public IP` | The server's public IPv4 can be looked up | WARN when it cannot (not run with `--offline`) | `HARMONY_PUBLIC_IP=x.x.x.x harmony doctor` |
| the name | Its A, AAAA and CNAME records | FAIL with no record; FAIL when no A record holds the server's IPv4; WARN when an AAAA record differs from the server's IPv6; WARN when an AAAA record exists and the server has no public IPv6 (Let's Encrypt tries IPv6 first); FAIL for a Cloudflare Tunnel record set to DNS only: a CNAME to `<tunnel id>.cfargotunnel.com`, which resolves to `fd10:aec2:5dae::` only (when nothing resolves here, Cloudflare's DNS-over-HTTPS resolver is asked for the CNAME, except with `--offline`); WARN when the name resolves only to private addresses. Loopback answers come from `/etc/hosts` (cloud-init writes `127.0.1.1 <fqdn>`) and are set aside: the public records are then read over DNS-over-HTTPS, or, with `--offline`, WARN | Create or correct the A record (DNS only, not proxied, while certificates are issued); correct or remove the AAAA record; set a tunnel record to Proxied ([Behind a Cloudflare Tunnel](/self-host/install#cloudflare-tunnel)); for `/etc/hosts`, `dig +short NAME` from another machine |

### TLS certificates

One line per name. The check reads the certificate served on 443 for the
name, or through the server's own HTTPS port when that fails.

| Result | Meaning | Fix |
|---|---|---|
| FAIL `no certificate served` | Caddy has no certificate for the name | `harmony logs caddy`; Let's Encrypt needs DNS and ports 80/443 reaching the server |
| FAIL `served by Caddy's internal CA, not Let's Encrypt` | Issuance failed and Caddy fell back to its own CA | Check DNS and ports 80/443, then `harmony logs caddy` |
| FAIL under 7 days left | Renewal is failing | `harmony logs caddy` |
| WARN under 21 days left | Caddy renews 30 days ahead, so renewal is overdue | `harmony logs caddy` |
| OK | Days left and issuer; with internal TLS, Caddy's internal CA | |

### Federation

Requests through the public URL, as other servers make them. A check that
fails publicly but answers through the server's own port reports
`answers on this server but not at URL from here`: look at the domain's DNS,
the firewall (80/443) or NAT. With internal TLS, the checks go through the
server's own port only.

| Check | Requests | Expects | Fix on failure |
|---|---|---|---|
| `webfinger` | `/.well-known/webfinger?resource=acct:ADMIN@DOMAIN` for the first admin | The admin's `subject`; WARN `skipped` without an admin | `harmony logs federation-server`; `harmony logs caddy` |
| `nodeinfo` | `/.well-known/nodeinfo` | A `links` list | `harmony logs federation-server`; `harmony logs caddy` |
| `instance-info` | `/api/federation/instance-info` | `supabaseUrl` equal to `https://db.DOMAIN` | The proxy must strip `/api/federation`; `PUBLIC_SUPABASE_URL` in `federation.env` must be `https://db.DOMAIN` |

### Services

| Check | Runs | Tests | Result and fix |
|---|---|---|---|
| `push` | always | `VAPID_PUBLIC_KEY` (87 characters), `VAPID_PRIVATE_KEY` (43) and `VAPID_SUBJECT` in `federation.env`, and the backend serving the public key at `/api/federation/push/vapid-key` | FAIL when missing: `bash configure.sh --non-interactive`, then `docker compose up -d`. FAIL when not served: `docker compose up -d federation-server`; `harmony logs federation-server` |
| `email` | always | `SMTP_HOST` in `supabase/.env` is set and accepts a TCP connection on `SMTP_PORT` (default 587) | WARN with no SMTP server: `harmony config`. WARN when unreachable: check the host and port; many VPS providers block outgoing 25 and 587 until asked |
| `auth` | always | `https://db.DOMAIN/auth/v1/health` answers 200 | FAIL: `harmony logs auth`; `harmony logs kong` |
| `auth linking` | always | `PROVIDER_LINKING_DOMAINS` in `supabase/.env` is comma-separated `provider=domain` pairs, the auth service runs with it, and no provider on the sign-in page joins accounts by address while `ENABLE_EMAIL_AUTOCONFIRM=true` | FAIL when it does not parse (the auth service does not start): correct it, then `docker compose up -d auth`. WARN when the service runs an older value: `docker compose up -d auth`. WARN for a provider joining by address: `harmony auth add-provider ID --separate-accounts` |
| `realtime` | always | A WebSocket upgrade at `wss://db.DOMAIN/realtime/v1/websocket` answers 101, on the server and, without internal TLS, through the public name | FAIL with the status on the server: 503, Realtime is down (`harmony logs realtime`); 401, `SUPABASE_ANON_KEY` differs from Kong's. FAIL through the public name only: with no answer, DNS, the firewall (80/443) or NAT, as for the federation checks; with another status, a proxy in front must pass WebSocket upgrades |
| `bot-gateway` | bots on | `/bot-gateway/health` reports `"status": "ok"` through the public URL | FAIL: `harmony logs bot-gateway` |
| `discord` | Discord bridge hosting on | `BRIDGE_HOST_SECRET` is at least 32 characters and equal in `bot-gateway.env` and `discord-bridge.env`; `discord-bridge-host` runs | FAIL: `bash configure.sh --non-interactive`, then `docker compose up -d`; `harmony logs discord-bridge-host` |
| `livekit` | voice on | `livekit.yaml` exists and holds `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` of `federation.env`; `LIVEKIT_URL` and `LIVEKIT_PUBLIC_URL` are set; `/api/livekit/health` reports healthy | FAIL for a key mismatch: delete `self-host/livekit.yaml`, run `bash configure.sh --non-interactive`, `docker compose up -d`. Otherwise `harmony logs livekit` |
| `signalling` | voice on | `https://live.DOMAIN` answers 200 | FAIL: `harmony logs caddy`; `harmony logs livekit` |
| `media tcp` | voice on | A TCP connection to the published 7881 on the public address | WARN: open 7881/tcp in the firewall and at the provider; test from another machine with `nc -vz ADDRESS 7881` |
| `media udp` | voice on | UDP cannot be probed; with `ufw` active, a rule allowing 7882/udp | WARN when `ufw` lacks it: `ufw allow 7882/udp`. OK reminds you to open it at the provider's firewall too |

### Security

These checks look for the traces of a known automated attack on exposed
Postgres, and for the exposure itself.
[Security checks](/self-host/troubleshooting#security) explains how to respond.

| Check | Tests | Result | Fix |
|---|---|---|---|
| `database` | Postgres answers | FAIL; the security checks are skipped | `harmony logs db` |
| `event triggers` | Every event trigger is one of Supabase's and calls Supabase's function: `graphql_watch_ddl`, `graphql_watch_drop`, `issue_graphql_placeholder`, `issue_pg_cron_access`, `issue_pg_graphql_access`, `issue_pg_net_access`, `pgrst_ddl_watch`, `pgrst_drop_watch`, `pgsodium_trg_mask_update` | FAIL, listing each other trigger with its function | Unless you made them: `DROP EVENT TRIGGER`, `DROP FUNCTION`, then check the roles and restore a backup older than them |
| `superusers` | Only `supabase_admin` is a superuser | WARN when `postgres` also is (it is not on the pinned image); FAIL for any other | For `postgres` on the pinned stack: `ALTER ROLE postgres NOSUPERUSER`. Others, unless you made them: `DROP ROLE` as `supabase_admin` |
| `login roles` | Only the stack's roles can log in: `authenticator`, `harmony_listener`, `pgbouncer`, `postgres`, `supabase_admin`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_read_only_user`, `supabase_replication_admin`, `supabase_storage_admin` | FAIL, listing the others | Unless you made them: `ALTER ROLE NAME NOLOGIN`, find how they appeared, then `DROP ROLE` |
| `functions` | No function body (outside extensions) creates or alters roles, mentions `superuser`, or uses `COPY ... PROGRAM`, `pg_read_server_files`, `pg_execute_server_program`, `lo_import` or `dblink_exec` | WARN, listing them | Read each (`\sf NAME` in psql); drop any you did not write |
| `extensions` | No untrusted procedural language, and none of `dblink`, `adminpack`, `file_fdw`, `plpython3u`, `plperlu`, `pltclu` | WARN, listing them | Unless you need them: `DROP EXTENSION NAME` |
| `jwt secret` | `app.settings.jwt_secret` is not a database default, and PostgREST does not set it per request | WARN for either | Database default: `bash bootstrap.sh --migrations-only`. PostgREST: `harmony update` (`supabase-overrides.yml` removes it) |
| `secrets` | `POSTGRES_PASSWORD`, `JWT_SECRET` and `DASHBOARD_PASSWORD` in `supabase/.env` are set and differ from Supabase's example values | FAIL, naming them | [Change them](/self-host/troubleshooting#change-supabase-s-example-secrets) |
| `published` | No container of this stack publishes 5432, 6543, 54322, 8000, 8443, 4000 or 6379 beyond 127.0.0.1 | FAIL, naming them | Remove those `ports:` entries from the compose files, then `docker compose up -d` |
| `other containers` | The same ports, for containers outside this stack | WARN, naming them | Bind them to 127.0.0.1 or stop them: Docker-published ports bypass `ufw` |
| `reachable` | Those ports are closed on the server's public IPv4 and IPv6 address, tried from the server | WARN when the public address is unknown; FAIL, naming each open port and its owner | Unpublish or stop them, and block them at the provider's firewall |

### Versions

| Check | Tests | Result | Fix |
|---|---|---|---|
| `release` | `HARMONY_VERSION` against the latest GitHub release (not run with `--offline`) | WARN when GitHub is unreachable; WARN when a newer release exists; OK on `edge` | `harmony update` |
| `gotrue` | The auth service's image against the Supabase stack's own `supabase/gotrue` image | WARN when the service runs an older one | `bash configure.sh --non-interactive` (sets `GOTRUE_IMAGE`), then `docker compose up -d auth` |
| `supabase` | The Supabase stack's commit (`supabase/.harmony-supabase-ref`) against the commit `configure.sh` pins | WARN when they differ | `harmony backup`, then `bash configure.sh --refresh-supabase && docker compose up -d` |

## harmony backup

```text
harmony backup [--no-storage] [--label TEXT]
```

Writes `self-host/backups/YYYYmmdd-HHMMSS[-TEXT]/` with the database, the
database roles, the configuration files and the Vault key, and the uploads.
It starts the database first when it is not running.
[Backups](/self-host/update-backup#back-up-an-instance) lists the contents.

| Option | Effect |
|---|---|
| `--no-storage` | Leaves out the uploads (`storage.tar`) |
| `--label TEXT` | Appends `-TEXT` to the directory name; characters other than letters, digits, `.`, `_` and `-` become `-` |

Exit status: 0 with `Backup: DIRECTORY (SIZE)`. 1 on a failure; a failed
database dump leaves no backup directory behind.

## harmony restore

```text
harmony restore <backup> [--yes]
```

Replaces the database, and the configuration and uploads when the backup
holds them. The current database and uploads move aside first.
[Restore](/self-host/update-backup#restore-a-backup) describes the steps.

| Argument or option | Effect |
|---|---|
| `<backup>` | A backup directory, a tar archive of one, or a bare `.dump` file (database only) |
| `--yes`, `-y` | No confirmation prompt |

Without `--yes` it shows what it replaces and asks; without a terminal it
stops with `restore replaces the running instance's data; pass --yes to
confirm`. A backup without `config.tar` needs an installed instance. Exit
status: 0 with `Restore complete.`, 1 on a failure, naming the moved-aside
data.

## harmony status

```text
harmony status
```

Prints the instance URL, then:

| Line | Shows |
|---|---|
| `code` | `git describe` of the checkout and its branch, or `detached` |
| `images` | `HARMONY_VERSION`, with `(built from this checkout)` when building locally |
| `profiles` | `COMPOSE_PROFILES`: `voice`, `bots`, `discord`, or `(none)` |
| `register` | The registration policy |
| `backup` | The newest backup's directory name, or `none` |

followed by a table of the services with their status and image.

## harmony logs

```text
harmony logs [service ...] [-n N] [--no-follow]
```

Shows the last lines of the named services' logs and follows them (Ctrl+C
stops). Without a service, all of them.

| Argument or option | Effect |
|---|---|
| `service` | A Compose service: `caddy`, `web`, `federation-server`, `federation-worker`, `redis`, `livekit`, `bot-gateway`, `discord-bridge-host`, `db`, `auth`, `rest`, `realtime`, `storage`, `imgproxy`, `kong`, `meta`, `studio`, `analytics`, `vector` |
| `federation` | `federation-server` and `federation-worker` |
| `supabase` | `db`, `auth`, `rest`, `realtime`, `storage` and `kong` |
| `-n N` | Lines of history per service, default 200 |
| `--no-follow` | Print and exit |

## harmony admin create

```text
harmony admin create [--email E] [--username U] [--password P] [--display-name N]
```

Creates an instance admin the way the app creates any account: the account
with its address confirmed, then its profile, then its federation keys. An
existing account becomes an admin.

| Option | Effect | When absent |
|---|---|---|
| `--email E` | The account's email | `HARMONY_ADMIN_EMAIL`, else asks (default: `ADMIN_EMAIL` in `.env`) |
| `--username U` | 3 to 24 characters of `a-z`, `0-9`, `_` | `HARMONY_ADMIN_USERNAME`, else asks (default: the email's local part, or `admin`) |
| `--password P` | 8 characters or more | `HARMONY_ADMIN_PASSWORD`, else asks twice; empty generates one |
| `--display-name N` | The profile's display name | the username |

| Account state | Result |
|---|---|
| No account with that email | Created with the given or generated password; a generated one is shown once, as for `reset-password` |
| Account and profile exist | Made an admin; the password stays as it is, even with `--password` |
| Account exists, profile never created | Takes the given or generated password, gets its profile, made an admin |

It fails with `the username U belongs to another account` when another local
profile has the username, and needs the `federation-server` container running
and the instance domain set (`bash bootstrap.sh`).

## harmony admin reset-password

```text
harmony admin reset-password (--email E | --username U) [--password P]
```

Sets a new password on any local account, found by email or username, and
confirms that it signs in. Without either option it asks for the email
(default: `ADMIN_EMAIL` in `.env`). Without `--password` it asks twice, without
echoing; an empty answer generates one. It fails with `no such account` when
nothing matches.

A generated password is never written to the command's output. In a terminal
it is shown on the terminal's alternate screen, which keeps no scrollback,
until you press Enter; Ctrl-C clears it too and stops the command. Without a
terminal (a script, a pipe), or with `HARMONY_NONINTERACTIVE=1`, it goes to
`self-host/.secret-<date>-<time>-<pid>` (`~/harmony-secret-XXXXXX` when
`self-host/` is not writable), readable by your user only, and only that path
is printed: delete the file once the password is stored. With neither, the
command stops before the password changes. `--password` puts the password in
your shell history; the prompt does not.

## harmony admin invite

```text
harmony admin invite <email> [--send]
```

Creates a single-use invitation for the address. The link signs the person
in on `https://DOMAIN/reset-password`, where they choose a password.

| Option | Effect |
|---|---|
| none | Prints the link; send it yourself |
| `--send` | Emails the invitation. Needs SMTP; without it, the command stops with `--send needs SMTP (harmony config); without it, send the printed link yourself` |

## harmony registration

```text
harmony registration [open | invite | closed]
```

Sets who can create an account. Without an argument it applies
`REGISTRATION` from `.env` (default `open`). `invite-only` is accepted for
`invite`.

| Policy | Sign-up | `open_registration` |
|---|---|---|
| `open` | on (`DISABLE_SIGNUP=false`) | `true` |
| `invite` | off; invitations through `harmony admin invite` | `false` |
| `closed` | off | `false` |

It writes `REGISTRATION` to `.env`, `DISABLE_SIGNUP` to `supabase/.env` and
`open_registration` to `instance_config`, then recreates the auth service
when `DISABLE_SIGNUP` changed. `open` stops with `no admin exists yet; create
one first (harmony admin create), then open registration` while there is no
admin.

## harmony auth

```text
harmony auth providers
harmony auth add-provider ID [--name N] (--issuer URL [--discovery-url URL] |
                             --authorize-url URL --token-url URL --userinfo-url URL)
                             [--client-id C] [--client-secret-file FILE|-] [--scopes "S ..."]
                             [--icon URL] [--email-optional | --require-email] [--no-pkce | --pkce]
                             [--separate-accounts | --link-existing-accounts [--provider-verifies-email]]
harmony auth remove-provider ID
```

Sign-in through an OpenID Connect or OAuth 2.0 provider you run, such as
Authentik or Keycloak. [OAuth sign-in](/self-host/oauth#your-own-identity-provider)
walks through it.

`providers` lists the providers the auth service knows, whether the sign-in
page shows them, what a first sign-in does with an existing account that has
the same address (**EXISTING ACCOUNTS**: `separate`, `by address`, or
`shared: NAME`), and the redirect (callback) URL to register with them,
`API_EXTERNAL_URL/auth/v1/callback`. It warns about buttons whose provider the
auth service no longer has, and about providers that join accounts by address
while `ENABLE_EMAIL_AUTOCONFIRM=true`.

`add-provider` creates the provider `custom:ID`, or updates it when it exists,
and puts its button on the sign-in page. `ID` is 1 to 43 characters of `a-z`,
`0-9` and `-`. The auth service fetches the issuer's discovery document first
and refuses the provider when it cannot.

| Option | Effect |
|---|---|
| `--name N` | Button text: **Continue with N**. Required for a new provider |
| `--issuer URL` | OIDC: the issuer, exactly as the provider's discovery document states it. Endpoints come from `URL/.well-known/openid-configuration` |
| `--discovery-url URL` | OIDC: the discovery document lives elsewhere |
| `--authorize-url`, `--token-url`, `--userinfo-url` | OAuth 2.0 without discovery: all three for a new provider |
| `--client-id C` | Client ID the provider issued. Required for a new provider |
| `--client-secret-file FILE` | Reads the client secret from `FILE`; `-` reads standard input |
| `--scopes "S ..."` | Space-separated. OIDC default: `openid email profile` (`openid` is always added) |
| `--icon URL` | `https://` image shown on the button; without it, a key |
| `--email-optional` | Accepts accounts the provider gives no address; `--require-email` undoes it |
| `--no-pkce` | For a provider without PKCE; `--pkce` undoes it |
| `--separate-accounts` | A first sign-in makes a new account, even when an account has the same address. The default for a new provider |
| `--link-existing-accounts` | A first sign-in joins the account that has the same verified address. Refused while `ENABLE_EMAIL_AUTOCONFIRM=true` unless `--provider-verifies-email` is given too |
| `--provider-verifies-email` | With `--link-existing-accounts`: states that the provider hands out no address it has not checked |

Without `--client-secret-file`, the secret comes from
`HARMONY_OAUTH_CLIENT_SECRET`, or else from a hidden prompt; empty keeps the
stored secret of an existing provider. A URL option must start with
`https://`. A provider's type (OIDC or OAuth 2.0) cannot change: remove it and
add it again.

The two account options write `PROVIDER_LINKING_DOMAINS` in
`supabase/.env` (`custom:ID=custom:ID` keeps the provider apart) and recreate
the auth service before the provider is saved. An update without either
keeps the provider's setting. See
[First sign-in and existing accounts](/self-host/oauth#first-sign-in-and-existing-accounts).

`remove-provider` deletes the provider and its button, then its entry in
`PROVIDER_LINKING_DOMAINS`. An account that signed in only through it has no
way in until it gets a password (`harmony admin reset-password`).

Messages from the auth service come through as they are, for example
`adding the provider failed (HTTP 400: URL cannot resolve to private network
addresses)`; [Troubleshooting](/self-host/oauth#troubleshooting-your-own-provider)
explains them.

## harmony config

```text
harmony config
```

Asks the configuration questions again, with the current answers as
defaults, and applies them:

| Question | Notes |
|---|---|
| Public domain for your instance | Changing it rewrites every URL derived from it; accounts other servers already know keep the old domain in their ids |
| Instance display name | |
| Admin email | Let's Encrypt and Web Push contact |
| Public HTTPS via Let's Encrypt? | `y`: public DNS and ports 80/443 reachable. `n`: Caddy's local CA |
| Enable voice/video? | LiveKit; needs the `live.` record, UDP 7882 and TCP 7881 |
| Enable the bot gateway? | Bots and Discord bridges |
| Host Discord bridges for your communities? | Asked with bots on |
| Registration | `open`, `invite` or `closed` |
| Configure outgoing email (SMTP) now? | Then SMTP host, port, username, password (empty keeps the current one) and sender address |

Then it removes the container of each service turned off (`livekit`,
`bot-gateway`, `discord-bridge-host`), pulls images, runs
`docker compose up -d`, and re-applies the registration policy when an admin
exists. It ends with `Configuration applied. Check it: harmony doctor`.

It needs a terminal; without one it stops with `harmony config asks
questions; for scripted changes run: HARMONY_...=... bash configure.sh
--non-interactive`. A scripted change, in `self-host/`:

```bash
HARMONY_VOICE=n bash configure.sh --non-interactive
docker compose --profile voice rm -sf livekit   # a service turned off keeps running otherwise
docker compose up -d
harmony registration
```

### Upload ceiling

```text
harmony config --upload-ceiling [SIZE]
```

Sets the largest file storage accepts, the ceiling of every upload limit in
**Config** → **Uploads**: writes `FILE_SIZE_LIMIT` in `supabase/.env`, runs
`docker compose up -d storage` so storage restarts with it, and writes the
same number into `instance_config.upload_ceiling_bytes`. `SIZE` is bytes, or a
number followed by `MB` or `GB` (1 MB is 1,048,576 bytes), from 1 MB to 5 TB.
Without `SIZE` it prints the current ceiling. Upload limits above a lowered
ceiling are named in a warning; they count as the ceiling until changed. It
needs no terminal. See [Upload limits](/self-host/configuration#upload-limits).

```bash
harmony config --upload-ceiling 2GB
```

## harmony version

```text
harmony version
```

Prints `git describe` of the checkout, then the image tag
(`HARMONY_VERSION`).

## harmony help

`harmony`, `harmony help`, `harmony -h` and `harmony --help` print the
usage.

## Scripts behind the commands

Each command is a thin layer over a script in `self-host/`. Run them from
there (`cd /opt/harmony/self-host`) for steps the command does not expose.

| Script | Behind | Direct use |
|---|---|---|
| `install.sh` | `harmony install` | `bash install.sh [--dir DIR] [--ref REF] [--non-interactive]` |
| `update.sh` | `harmony update` | `HARMONY_REF=REF bash update.sh` |
| `doctor.sh` | `harmony doctor` | `bash doctor.sh [--offline]` |
| `backup.sh` | `harmony backup`, `harmony restore` | `bash backup.sh create [--no-storage] [--label TEXT]`; `bash backup.sh restore <backup> [--yes]` |
| `admin.sh` | `harmony admin`, `harmony registration` | also `bash admin.sh has-admin`: exit status 0 when a local admin exists |
| `configure.sh` | `harmony config`, and every install, update and restore | see below |
| `bootstrap.sh` | install, update and restore | see below |
| `lib.sh` | | Shared helpers; sourced, never run |

### configure.sh

```text
bash configure.sh [--non-interactive | --refresh-supabase]
```

Writes `.env`, `federation.env`, `bot-gateway.env`, `discord-bridge.env`,
`livekit.yaml` and `supabase/.env`, and fetches the upstream Supabase stack
into `supabase/` when it is absent. It never starts or touches the running
stack; `docker compose up -d` applies its changes.

Re-running merges: a key already present keeps its value and a missing key
is added. Secrets of an existing install are never regenerated; values
derived from the domain are rewritten only when the domain changes. A new
`supabase/.env` has sign-up disabled until `harmony registration` runs.

| Option | Effect |
|---|---|
| `--non-interactive` | Answers from the environment (also the case without a terminal) |
| `--refresh-supabase` | Fetches `supabase/` again at `SUPABASE_REF`, keeping the answers; never touches the database or uploads, and refuses a stack whose Postgres major version differs from the database's |
| `-h`, `--help` | Prints its built-in help |

| Environment variable | Effect |
|---|---|
| `HARMONY_DOMAIN`, `HARMONY_INSTANCE_NAME`, `HARMONY_ADMIN_EMAIL`, `HARMONY_TLS`, `HARMONY_VOICE`, `HARMONY_BOTS`, `HARMONY_DISCORD`, `HARMONY_REGISTRATION`, `HARMONY_SMTP_HOST`, `HARMONY_SMTP_PORT`, `HARMONY_SMTP_USER`, `HARMONY_SMTP_PASS`, `HARMONY_SMTP_SENDER` | Answers, as for the [installer](/self-host/install#scripted-installs); each defaults to the configured value. SMTP changes only when `HARMONY_SMTP_HOST` is set |
| `HARMONY_VERSION` | Image tag; default from the checkout: `X.Y.Z` at tag `vX.Y.Z`, otherwise `edge` |
| `HARMONY_BUILD` | `1` builds Harmony's images from the checkout (`docker-compose.build.yml`); `0` returns to published images |
| `HARMONY_HTTP_PORT`, `HARMONY_HTTPS_PORT` | `[address:]port` Caddy publishes for 80 and 443 |
| `SUPABASE_REF` | Commit, tag or branch of the upstream Supabase stack; default the pinned commit |
| `SUPABASE_REPO` | Git URL of the Supabase repository |

### bootstrap.sh

```text
bash bootstrap.sh [--migrations-only]
```

Applies each pending file of `db_schema/migrations/` in version order and
records it in `supabase_migrations.schema_migrations`, the ledger the
Supabase CLI also reads. A failing file is not recorded and stops the run,
leaving the database at the last file that succeeded. It then removes the
JWT secret from the database settings (`app.settings.jwt_secret`) unless a
function reads it, and reloads PostgREST's schema cache.

On every run it also copies `FILE_SIZE_LIMIT` from `supabase/.env`
(`52428800` when absent) into `instance_config.upload_ceiling_bytes`.

Without `--migrations-only` it also creates or updates the
`harmony_listener` role from `__LISTENER_PW` in `federation.env`, and on a
new database (domain still `localhost`) writes the domain and instance name
into `instance_config`.

It needs the Realtime and Storage services of the Supabase stack running.
Both build their schemas through their own migrations after Postgres starts:
Realtime once its health check first passes, storage-api when it starts.
Before the first file, `bootstrap.sh` waits up to 300 s, in total, for
Realtime to report healthy (when it belongs to the database container's
Compose project) and for `realtime.messages` (partitioned), `realtime.send`
and the `storage.buckets` columns storage-api adds; past that it stops with
`still missing after 300 s: …`. A database whose schemas are complete passes
at once.

| Environment variable | Effect |
|---|---|
| `SUPABASE_DB_CONTAINER` | The Postgres container; default the stack's `db` service, else `supabase-db` |

### update.sh

| Environment variable | Effect |
|---|---|
| `HARMONY_REF` | Target tag, branch or commit (`harmony update --version` sets it) |
| `HARMONY_REMOTE` | Git remote, default `origin` |
| `HARMONY_SKIP_BACKUP=1` | No backup before migrating |

Nothing in it deletes volumes, data directories or backups.
