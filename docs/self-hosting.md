# Self-hosting Harmony

Run your own Harmony instance: chat servers, DMs, voice and video, a social
feed that federates with Mastodon and other Harmony instances, bots and
Discord bridges. One command installs everything on a Linux server.

[[toc]]

## What you need

- **A server** running Linux, x86_64 or arm64, that you reach over SSH as
  root: a VPS, a home server or a VM.
  - 2 GB of RAM at least, 4 GB to be comfortable. Voice and video use CPU.
  - 20 GB of disk or more: about 4 GB of images, then the database, uploads
    and backups.
  - A public IPv4 address, for an instance others can reach.
- **A domain name** you can add DNS records to, for example `example.com`.
  Harmony takes a name like `chat.example.com` plus two names under it.
- **Optional: an email (SMTP) service** such as Mailgun, Postmark, Amazon SES
  or Brevo, so Harmony can send password resets and address confirmations.

Docker, Node and the rest come with the installer: nothing else to set up.

### Recommended VPS providers

| Provider | Specs | Monthly cost |
|----------|-------|--------------|
| [**Hostinger VPS**](https://hostinger.com?REFERRALCODE=HARMONY) | 1 vCPU, 4 GB RAM, 50 GB | **$4.99/mo** |

[KVM2](https://www.hostinger.com/cart?product=vps%3Avps_kvm_2&period=24&referral_type=cart_link&REFERRALCODE=HARMONY&referral_id=019b0812-725a-7338-81f9-cddc8eb68800)
gives more headroom than
[KVM1](https://www.hostinger.com/cart?product=vps%3Avps_kvm_1&period=24&referral_type=cart_link&REFERRALCODE=HARMONY&referral_id=019b0812-725a-7338-81f9-cddc8eb68800);
both run Harmony. Both include a free `.cloud` domain.

*These are affiliate links: they support Harmony's development at no extra
cost to you. Harmony is not affiliated with Hostinger.*

## 1. Point your domain at the server

At your DNS provider, create these records, using your server's public IPv4
address (shown in your provider's dashboard, or by `curl -4 ifconfig.me` on
the server):

| Type | Name | Value | For |
|------|------|-------|-----|
| A | `chat.example.com` | your server's IP | the app and federation |
| A | `db.chat.example.com` | your server's IP | sign-in, data and uploads (the Supabase API) |
| A | `live.chat.example.com` | your server's IP | voice and video (skip if you turn voice off) |

- Replace `chat.example.com` with your own name; the domain itself
  (`example.com`) works too.
- If your server also has an IPv6 address, add matching AAAA records, or
  none: an AAAA record pointing elsewhere makes certificate issuance fail.
- With Cloudflare, set the records to **DNS only** (grey cloud).
- DNS changes take a few minutes to an hour to reach everyone. The installer
  checks them and tells you what is still missing.

## 2. Install

Log in to the server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
```

Not logged in as root? Use `| sudo bash` instead.

The installer:

1. checks the server: Linux on x86_64 or arm64, memory and disk;
2. installs Docker with the official script from get.docker.com, if it is
   missing and you agree; offers a 2 GB swap file on small servers without
   swap;
3. downloads Harmony into `/opt/harmony` (the newest release);
4. asks the questions below;
5. checks that ports 80 and 443 (and 7881/7882 for voice) are free and that
   your DNS records point at this server;
6. writes the configuration, with fresh secrets;
7. downloads and starts the services (several GB on the first run: 5 to 15
   minutes);
8. loads the database, creates your admin account, and applies your
   registration choice;
9. prints a summary, then runs `harmony doctor`.

### The questions

Press Enter to accept the default shown in brackets.

| Question | What it means | Default |
|---|---|---|
| Domain | The name from step 1, e.g. `chat.example.com`. Handles look like `@you@chat.example.com`; the domain is permanent once others follow you. | |
| Admin email | Your login. Also the contact Let's Encrypt and push services see. | |
| Admin username | Your handle, 3-24 of `a-z`, `0-9`, `_`. | the part of the email before `@` |
| Admin password | 8 characters or more. Enter alone generates one, shown once at the end. | generated |
| Instance name | Shown in the app; the admin panel changes it later. | Harmony |
| Voice and video | Voice channels, calls and screen sharing (LiveKit). Needs `live.` DNS and ports 7881/tcp, 7882/udp. | yes |
| Bots | The bot gateway: bots and Discord bridges. | no |
| Discord bridge hosting | Run Discord bridges for your communities on this server (needs bots). See [Discord bridge hosting](#discord-bridge-hosting). | no |
| Email (SMTP) | Server, port (587), username, password and sender address of your email service. Skip it and add it later with `harmony config`. | skipped |
| Registration | `open`: anyone can sign up. `invite`: only people you invite. `closed`: no new accounts. | open |

When DNS is not ready yet, the installer shows the records to create and lets
you check again, continue anyway (certificates follow once DNS is right), or
switch to a [LAN install](#lan-and-internal-installs).

### At the end

The summary shows your URL, your admin login and password, and where the
secrets live. **Store the password now**; it is shown once.
`harmony admin reset-password` sets a new one if it gets lost.

Open `https://chat.example.com` and sign in. Then open the firewall, if your
server or provider has one:

```bash
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw allow 7881/tcp && ufw allow 7882/udp     # voice and video
```

Many providers also have a firewall in their dashboard: open the same ports
there.

### Running it again

The installer is safe to re-run: it keeps the configuration, secrets, data
and admin account, and uses the current answers as defaults. Re-run it to
repair an installation, or use `harmony config` to change answers.

### Scripted installs

Without a terminal, or with `--non-interactive`, every answer comes from the
environment:

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | \
  HARMONY_DOMAIN=chat.example.com \
  HARMONY_ADMIN_EMAIL=you@example.com \
  HARMONY_ADMIN_USERNAME=you \
  HARMONY_INSTANCE_NAME="Example Chat" \
  HARMONY_VOICE=y HARMONY_BOTS=n HARMONY_REGISTRATION=invite \
  HARMONY_INSTALL_DOCKER=y \
  bash
```

| Variable | Meaning |
|---|---|
| `HARMONY_DOMAIN` | required |
| `HARMONY_ADMIN_EMAIL` | required |
| `HARMONY_ADMIN_USERNAME` | default: the email's local part |
| `HARMONY_ADMIN_PASSWORD` | default: generated, printed in the summary |
| `HARMONY_INSTANCE_NAME` | default `Harmony` |
| `HARMONY_VOICE`, `HARMONY_BOTS`, `HARMONY_DISCORD` | `y` or `n`; defaults y, n, n |
| `HARMONY_REGISTRATION` | `open`, `invite` or `closed`; default `open` |
| `HARMONY_SMTP_HOST`, `HARMONY_SMTP_PORT`, `HARMONY_SMTP_USER`, `HARMONY_SMTP_PASS`, `HARMONY_SMTP_SENDER` | email; port 587 and `noreply@DOMAIN` by default |
| `HARMONY_TLS` | `acme` (Let's Encrypt, default) or `internal` |
| `HARMONY_DIR` | install directory, default `/opt/harmony` |
| `HARMONY_REF` | git tag or branch of a new checkout; default the newest release that ships the installer, else `master`. An existing checkout stays as it is (`harmony update --version` moves it). |
| `HARMONY_VERSION` | image tag; default from the checkout |
| `HARMONY_BUILD=1` | build Harmony's images on the server instead of downloading them |
| `HARMONY_HTTP_PORT`, `HARMONY_HTTPS_PORT` | `[address:]port` for Caddy, default 80 and 443 |
| `HARMONY_PUBLIC_IP` | this server's public IPv4, if the installer cannot look it up |
| `HARMONY_INSTALL_DOCKER=y` | consent to install Docker with get.docker.com |
| `HARMONY_INSTALL_PACKAGES=y` | consent to install missing git, curl, openssl |
| `HARMONY_CREATE_SWAP=y` | consent to create a 2 GB `/swapfile` (RAM under 4 GB, no swap) |
| `HARMONY_CLI_LINK=n` | no `/usr/local/bin/harmony` link |
| `HARMONY_SKIP_DOCTOR=1` | no doctor run at the end |

Without a terminal, changes to the host (Docker, packages, swap) happen only
with their variable set to `y`.

### LAN and internal installs

For a server on your home network, without public DNS, answer **2** at the
DNS step (or set `HARMONY_TLS=internal`). Caddy then signs certificates with
its own certificate authority instead of Let's Encrypt:

- Each device resolves the three names to the server: a local DNS server, your
  router's DNS, or `/etc/hosts` entries.
- Browsers warn until each device trusts Caddy's root certificate. Copy it off
  the server and install it as a trusted root:
  ```bash
  cd /opt/harmony/self-host
  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt harmony-root.crt
  ```
- Such an instance federates only with servers that reach and trust it.

## 3. After the install

### Your admin account and the admin panel

Sign in with the admin email and password from the summary. The admin panel
is in **Settings, Instance admin** (`https://chat.example.com/admin`): instance
name, description, rules, icon, terms and privacy URLs, federation settings,
users, reports, OAuth buttons.

The installer creates the admin account itself, before anyone can register:
sign-up stays closed until it exists. More admin accounts:

```bash
harmony admin create --email friend@example.com --username friend
```

An existing account given to `admin create` becomes an admin and keeps its
password.

### Registration

```bash
harmony registration open      # anyone can create an account
harmony registration invite    # only invited people
harmony registration closed    # nobody new
```

With `invite`, each invitation is a single-use link:

```bash
harmony admin invite friend@example.com           # prints the link; send it yourself
harmony admin invite friend@example.com --send    # emails it (needs SMTP)
```

The link opens Harmony's password page: the person chooses a password, signs
in, and picks a username. `invite` and `closed` also stop new sign-ups through OAuth
providers. Registration applies to Harmony's own sign-up (GoTrue's
`DISABLE_SIGNUP`) and is advertised to other servers (NodeInfo).

### Email (SMTP)

Without SMTP, accounts work as soon as they are created, but nobody can reset
a forgotten password and email addresses are not confirmed. To add it, run
`harmony config` and answer yes to email, or set these in
`/opt/harmony/self-host/supabase/.env` and run `docker compose up -d` in
`self-host/`:

```env
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_USER=postmaster@mg.example.com
SMTP_PASS=...
SMTP_ADMIN_EMAIL=noreply@chat.example.com   # the From address
SMTP_SENDER_NAME=Example Chat
ENABLE_EMAIL_AUTOCONFIRM=false              # new accounts confirm their address
```

The sender address must belong to a domain your email service lets you send
from. `harmony doctor` checks that the SMTP server accepts connections; many
VPS providers block outgoing ports 25 and 587 until asked.

### Sign in with Google, GitHub or Twitch

1. Create an OAuth app with the provider. Its callback URL is
   `https://db.chat.example.com/auth/v1/callback`.
2. In `self-host/supabase/.env`, add for each provider (`GOOGLE`, `GITHUB`,
   `TWITCH`):
   ```env
   GOOGLE_ENABLED=true
   GOOGLE_CLIENT_ID=...
   GOOGLE_SECRET=...
   ```
3. `docker compose up -d` in `self-host/`.
4. Admin panel, Instance, OAuth: turn on the matching buttons.

## Voice and video

With voice on, the stack runs LiveKit: signalling through Caddy at
`wss://live.chat.example.com`, media directly on **7881/tcp** and
**7882/udp** (one UDP port for all calls). `configure.sh` generates the keys
and writes `self-host/livekit.yaml` from `webrtc/livekit.yaml.example`.

- Open 7881/tcp and 7882/udp in every firewall between the internet and the
  server. Calls connect but stay silent when UDP is blocked; clients without
  UDP fall back to TCP 7881.
- LiveKit finds the server's public address over STUN (`rtc.use_external_ip`).
  On a LAN install, set `rtc.node_ip` in `livekit.yaml` to the server's LAN
  address, remove `use_external_ip`, and `docker compose restart livekit`.
- TURN is off: it relays through a UDP port range the stack does not publish.

Turn voice on or off with `harmony config`. [`webrtc/README.md`](https://github.com/y4my4my4m/harmony/blob/master/webrtc/README.md)
covers LiveKit in depth.

## Push notifications

Push works out of the box: `configure.sh` generates the Web Push (VAPID) key
pair and uses the admin email as its contact. The key pair never changes:
every browser and phone subscription is bound to it, so keep it in your
backups. Web Push covers browsers and the desktop app; Android uses
UnifiedPush or, with a Firebase project, FCM
(`FCM_SERVICE_ACCOUNT_JSON` or `FCM_SERVICE_ACCOUNT_FILE` in
`self-host/federation.env`). Details: [Push notifications](/PUSH_NOTIFICATIONS).

## Bots and the Discord bridge

With bots on, the bot gateway serves the bot API at
`https://chat.example.com/bot-gateway/` and its WebSocket at
`wss://chat.example.com/bot-gateway/gateway`. Users create bots in Settings,
My bots; [the bot API](/bot-api) documents it.

The Discord bridge mirrors channels between a Discord server and a Harmony
server. A community sets it up in **Server Settings, Discord Bridge** and
chooses which Discord bot relays and where the bridge runs:

- **Use this instance's bot**: your server's own public Discord bot. They
  click **Add to Discord**, pick their Discord server and come back to pair
  channels. Offered first when you set up the
  [instance bot](#this-instance-s-discord-bot), below.
- **Use your own bot, run on this instance**: they create their own Discord
  bot, with their own name and avatar, and paste its token into Harmony; your
  server runs it. Offered only when you turn on hosting, below.
- **Run it myself**: they run the bridge on a computer of theirs with one
  Docker command and a setup code from that page. Their Discord bot token
  never reaches your server. Nothing to do on your side beyond bots.

### Discord bridge hosting

1. Answer yes to bots and to Discord bridge hosting (`harmony config`, or
   `HARMONY_BOTS=y HARMONY_DISCORD=y` when installing). This starts the
   `discord-bridge-host` service (image
   `ghcr.io/y4my4my4m/harmony-discord-bridge`) with a secret it shares with the
   bot gateway (`BRIDGE_HOST_SECRET` in `bot-gateway.env` and
   `discord-bridge.env`).
2. In the admin panel, Instance, **Discord bridge**, **Let communities bring
   their own bot**: turn on **Run communities' own bots** (it saves at once)
   and set **Maximum hosted bridges** (**Save limit**).

The host runs every hosted bridge and picks up new ones within a minute. You
hold each community's Discord bot token, and a token reads every Discord
channel its bot can see; the app explains this to communities before they
choose. `harmony doctor` checks the shared secret and the service;
`harmony logs discord-bridge-host` shows what it runs.

### This instance's Discord bot

One public Discord application, owned by you, serves every community that
links it. The bridge host runs it (step 1 above; bridge 2.1.0 or later) on one
Discord connection.

1. In the [Discord Developer Portal](https://discord.com/developers/applications):
   **New Application**. Under **Bot**, switch on **Public Bot** and **Requires
   OAuth2 Code Grant**, and under **Privileged Gateway Intents** switch on
   **Message Content** and **Server Members** (**Presence** only for presence
   sync). Under **OAuth2**, **Redirects**, add
   `https://chat.example.com/bot-gateway/bridge/v2/discord/callback`: the
   bot gateway builds this address from `INSTANCE_DOMAIN` (or `PUBLIC_URL`) and
   Discord compares it exactly.
2. In the admin panel, Instance, **Discord bridge**, **This instance's
   Discord bot**: paste the Application ID, the client secret (OAuth2, Reset
   Secret) and the bot token (Bot, Reset Token) and **Save credentials**. Both
   secrets go to Supabase Vault and are never shown again. Then turn on
   **Offer this bot to communities**; **Presence sync** sits beside it. Both
   switches save at once; **Maximum linked Discord servers** (default 100) has
   its own **Save limit**.

With the code grant on, the bot joins a Discord server only when the gateway
exchanges the authorization code for a link the community started in Harmony.
The bridge host makes it leave a Discord server that no instance bridge has
linked for ten minutes (the bridge was disconnected or moved to another Discord
server); while Harmony is unreachable it leaves none. The invite carries the permissions the
bridge needs (`537259072`: View Channels, Send Messages, Manage Messages,
Embed Links, Attach Files, Read Message History, Add Reactions, Use External
Emojis, Manage Webhooks). Manage Messages lets bridge 2.2.0 delete a Discord
member's message on Discord when it is deleted on Harmony. A Discord server
linked under Harmony 1.6.15 or earlier lacks it until the community links the
same Discord server again (Server Settings, Discord Bridge, Maintenance,
**Re-link the bot**); until then such deletions stay on Harmony. Discord caps
an unverified bot at 100 servers; past that, apply for
verification and for the Message Content and Server Members intents (and
Presence, which Discord rarely grants). You run the bot, so you can read every
Discord channel a community gives it; the app tells communities so before they
choose it.

## Updating

```bash
harmony update
```

1. fetches the new code: the newest release when installed from a release,
   the latest `master` (the edge channel) when installed from master;
2. adds any new configuration keys (existing values stay);
3. downloads the new images; the running instance is untouched so far;
4. backs up the database and configuration into `self-host/backups/`;
5. applies new database migrations;
6. restarts what changed.

A failure stops the update at that step and says what state it left. A
specific version: `harmony update --version 1.7.0`; the edge channel:
`harmony update --version edge`. Read the release notes ("Notes for
self-hosters" in the [changelog](https://github.com/y4my4my4m/harmony/blob/master/CHANGELOG.md))
before updating.

Images: releases publish `ghcr.io/y4my4my4m/harmony-web`, `-federation` and
`-bot-gateway` tagged `X.Y.Z`; master publishes `edge` a few minutes after
each change. The tag follows the code (`HARMONY_VERSION` in `self-host/.env`).

## Backups

```bash
harmony backup
```

writes `self-host/backups/<date-time>/` with:

- `database.dump`: the whole database (accounts, messages, servers, posts),
- `roles.sql`: the database roles,
- `config.tar`: every configuration file and secret, and the key Supabase
  Vault encrypts with,
- `storage.tar`: uploaded files (avatars, attachments, emoji),
- `manifest`: date, version, domain.

**Copy backups off the server**; they hold every secret of the instance.
For example from your computer:
`scp -r root@your-server:/opt/harmony/self-host/backups ./harmony-backups`.

A daily backup at 04:00, as a root cron job (`crontab -e`):

```cron
0 4 * * * /opt/harmony/self-host/harmony backup >/var/log/harmony-backup.log 2>&1
```

Backups accumulate; delete old directories in `self-host/backups/` yourself.
`harmony update` takes a database-and-configuration backup before every
update (`--no-storage`).

### Restore

```bash
harmony restore /opt/harmony/self-host/backups/20261007-040000
```

Restore first backs up the current database and configuration, moves the
current database and uploads aside (`supabase/volumes/*.before-restore-<time>`,
nothing is deleted), then loads the backup into a fresh database, restores the
configuration and uploads, applies any newer migrations of the installed
version, and starts everything. Remove the moved-aside directories once the
restored instance works.

Moving to a new server: install Harmony there with the same domain, copy the
backup over, run `harmony restore <backup>`, then point DNS at the new
server. The configuration comes from the backup, so the answers given to the
installer are replaced.

## Checking an instance: `harmony doctor`

```bash
harmony doctor
```

Each check prints OK, WARN or FAIL with a one-line fix; the command exits
with status 1 when anything fails. It checks:

| Area | Checks |
|---|---|
| Host | Docker Compose version, memory and swap, free disk, age of the last backup |
| Containers | every enabled service running and healthy; containers on the configured images |
| Database | migrations at the installed version, `instance_config.domain` equal to the domain, an admin account, registration applied, the `harmony_listener` role |
| DNS | each name points at this server's public IP (A and AAAA) |
| TLS | each certificate served, its issuer, days left |
| Federation | WebFinger for the admin, NodeInfo and `/api/federation/instance-info` through the public URL |
| Services | push (VAPID) keys served, SMTP reachable, auth, bot gateway, Discord bridge host, LiveKit keys and reachability, media ports |
| Security | see [Security](#security) |
| Versions | installed version against the latest release; Supabase stack against the pinned commit |

`harmony doctor --offline` skips the checks that need the internet (public IP
lookup, port probes, latest release).

## Security

The stack publishes only Caddy (80, 443) and, with voice, LiveKit's media
ports. Postgres, Supavisor, Kong, Logflare and Redis stay on Docker's internal
network. **Never publish Postgres**: automated attacks scan the internet for
it. One such attack, seen on exposed Supabase databases, adds a function and
event triggers (`log_start`, `log_end`) that create a superuser with a known
password the next time an administrator runs any schema change. Ports
published by Docker bypass `ufw` and `firewalld` rules, so a published port is
open even when the firewall says otherwise.

- `configure.sh` generates every secret at random: the database password, the
  JWT secret, the Studio password, Redis, LiveKit, VAPID. None of Supabase's
  example values survive an install.
- `bootstrap.sh` removes the JWT secret that upstream Supabase stores as a
  database setting (`app.settings.jwt_secret`), where any database session
  could read it, and `supabase-overrides.yml` drops the copy PostgREST would
  set in every API request (`PGRST_APP_SETTINGS_JWT_SECRET`); no Harmony or
  Supabase service reads it there.

`harmony doctor` checks, under Security:

| Check | FAIL or WARN when |
|---|---|
| event triggers | one exists beyond Supabase's eight (`graphql_watch_ddl`, `graphql_watch_drop`, `issue_graphql_placeholder`, `issue_pg_cron_access`, `issue_pg_graphql_access`, `issue_pg_net_access`, `pgrst_ddl_watch`, `pgrst_drop_watch`) or points at another function; listed with its function |
| superusers | a superuser other than `supabase_admin` |
| login roles | a role that can log in beyond the stack's (`authenticator`, `harmony_listener`, `pgbouncer`, `postgres`, `supabase_admin`, `supabase_auth_admin`, `supabase_functions_admin`, `supabase_read_only_user`, `supabase_replication_admin`, `supabase_storage_admin`) |
| functions (WARN) | a function body creates or alters roles, grants `SUPERUSER`, or reaches the server's files or programs (`COPY ... PROGRAM`, `pg_read_server_files`, `pg_execute_server_program`, `lo_import`, `dblink_exec`) |
| extensions (WARN) | an untrusted language (`plpython3u`, `plperlu`, `pltclu`) or `dblink`, `adminpack`, `file_fdw` is installed |
| jwt secret (WARN) | `app.settings.jwt_secret` is still a database setting, or PostgREST still sets it per request |
| secrets | `supabase/.env` holds Supabase's example `POSTGRES_PASSWORD`, `JWT_SECRET` or `DASHBOARD_PASSWORD` |
| published | this stack publishes 5432, 6543, 54322, 8000, 8443, 4000 or 6379 beyond 127.0.0.1 (other containers on the host doing so: WARN) |
| reachable | one of those ports answers on the server's public IPv4 or IPv6 address |

A failing event trigger, superuser or login role check means the database
may be compromised, unless you created the object yourself. Stop publishing
the port that let it in, then restore a backup taken before the object
appeared (`harmony restore`), and change the secrets.

Changing a secret that is still Supabase's example value, in
`self-host/supabase/.env`:

- `DASHBOARD_PASSWORD`: set a random value, then `docker compose up -d kong`.
- `JWT_SECRET`: set a random value of 40 characters or more, then
  `bash configure.sh --non-interactive && docker compose up -d`; the anon and
  service keys are re-signed and everyone signs in again.
- `POSTGRES_PASSWORD`: it is the password of `postgres`, `supabase_admin`,
  `authenticator`, `pgbouncer`, `supabase_auth_admin`,
  `supabase_functions_admin` and `supabase_storage_admin`. Run
  `ALTER ROLE <role> PASSWORD '<new>';` for each, as `supabase_admin`
  (`docker compose exec db psql -U supabase_admin -h 127.0.0.1 -d postgres`),
  set the same value in `supabase/.env`, then `docker compose up -d`.

## Troubleshooting

| Symptom | Look at |
|---|---|
| The installer says a port is in use | Another web server holds 80/443: `ss -ltnp 'sport = :80'`. Stop and disable it (`systemctl disable --now nginx apache2`), or see [Behind another reverse proxy](#behind-another-reverse-proxy). |
| Browser shows a certificate error | `harmony doctor` (DNS and TLS rows), then `harmony logs caddy`. Let's Encrypt needs each name pointing here and ports 80 and 443 open from the internet. |
| The page loads, sign-in fails | `harmony doctor`; `harmony logs auth`. A `db.` record missing or pointing elsewhere breaks sign-in. |
| Other servers cannot find your users | The Federation rows of `harmony doctor`; `harmony logs federation`. |
| Calls connect but nobody hears anything | UDP 7882 or TCP 7881 blocked at a firewall, or LiveKit announcing a wrong address: `harmony logs livekit`. |
| Password reset emails never arrive | The email row of `harmony doctor`; `harmony logs auth`. |
| Push notifications never arrive | The push row of `harmony doctor`. |
| "No admin account" | `harmony admin create`. |
| Forgot the admin password | `harmony admin reset-password --email you@example.com`. |
| An update stopped | Its last lines name the step and the state; fix the cause and run `harmony update` again. |
| `harmony doctor` fails under Security | [Security](#security). |
| Services restart in a loop, `docker compose ps` shows exit 137 | Out of memory: add swap or memory. |

`harmony logs <service>` follows one service: `caddy`, `web`,
`federation-server`, `federation-worker`, `bot-gateway`, `livekit`, `redis`,
`db`, `auth`, `rest`, `realtime`, `storage`, `kong`. `harmony status` lists
them all with their state.

## Uninstall

This deletes the instance and its data. Back up first if anything should
survive.

```bash
cd /opt/harmony/self-host
harmony backup                  # optional: keep a copy, then move it off the server
docker compose down -v          # containers, networks, Caddy certificates, Redis, the Vault key
cd / && rm -rf /opt/harmony     # code, configuration, database, uploads, backups
rm -f /usr/local/bin/harmony
```

`docker image ls` lists the downloaded images; `docker image rm` removes them.

## Reference

### What runs

| Container | Role |
|---|---|
| `harmony-caddy` | HTTPS, routing; the only service with ports 80/443 |
| `harmony-web` | the web app |
| `harmony-federation-server`, `harmony-federation-worker` | ActivityPub, link previews, push, LiveKit tokens; the worker processes the queues |
| `harmony-redis` | queues, cache, presence, rate limits |
| `harmony-livekit` | voice and video (voice on) |
| `harmony-bot-gateway` | bot API and gateway (bots on) |
| `harmony-discord-bridge-host` | hosted Discord bridges (hosting on) |
| `supabase-db`, `supabase-auth`, `supabase-rest`, `realtime-dev.supabase-realtime`, `supabase-storage`, `supabase-imgproxy`, `supabase-kong`, `supabase-meta`, `supabase-studio`, `supabase-analytics`, `supabase-vector` | Supabase: Postgres, sign-in, API, realtime, uploads, image resizing, gateway, Studio, logs |

Caddy serves `https://DOMAIN` (the app; ActivityPub and discovery paths,
`/api/federation/*` with the prefix stripped, `/api/livekit/*`, `/health`,
`/link-preview`, `/webhooks/*` to the federation backend; `/bot-gateway/*` to
the bot gateway), `https://db.DOMAIN` (Supabase) and `https://live.DOMAIN`
(LiveKit).

### Ports

| Port | For |
|---|---|
| 80/tcp, 443/tcp | HTTPS, and Let's Encrypt validation |
| 443/udp | HTTP/3 (optional) |
| 7881/tcp, 7882/udp | voice and video media |

Everything else stays inside Docker's network.

### Files

All under `/opt/harmony/self-host/`:

| File | Holds |
|---|---|
| `.env` | domain, TLS, enabled services, image tag, registration, ports |
| `federation.env` | federation backend: Supabase keys, Redis, push (VAPID) and LiveKit keys |
| `bot-gateway.env` | bot gateway |
| `discord-bridge.env` | Discord bridge host secret |
| `livekit.yaml` | LiveKit |
| `supabase/.env` | Supabase: database password, JWT secret, SMTP, sign-in settings, OAuth providers |
| `supabase/volumes/db/data` | the database |
| `supabase/volumes/storage` | uploaded files |
| `backups/` | backups |

The `.env` files and `livekit.yaml` hold the only copy of the instance's
secrets. Supabase Studio, a database browser, is at `https://db.DOMAIN`: user
`supabase`, password `DASHBOARD_PASSWORD` in `supabase/.env`.

[`self-host/README.md`](https://github.com/y4my4my4m/harmony/blob/master/self-host/README.md)
describes the scripts and images.

## Advanced

### Building the images yourself

Forks and development builds:

```bash
cd /opt/harmony/self-host
HARMONY_BUILD=1 bash configure.sh --non-interactive
docker compose up -d --build
```

`harmony update` then builds instead of downloading. `HARMONY_BUILD=0`
returns to the published images. Building the web app needs about 4 GB of
memory.

### Behind another reverse proxy

When another proxy on the same server owns ports 80 and 443, publish Caddy
elsewhere and forward the three names to it, keeping the `Host` header and
passing TLS through (or proxying HTTPS to HTTPS):

```bash
HARMONY_HTTP_PORT=127.0.0.1:8080 HARMONY_HTTPS_PORT=127.0.0.1:8443 harmony install
```

Caddy obtains its certificates through the challenges that reach it: forward
port 80 to Caddy's HTTP port, or pass TLS through unmodified on 443. A proxy
that terminates TLS itself holds the public certificates and talks to Caddy
with `HARMONY_TLS=internal`.

### Cloudflare

Keep the records **DNS only** during the install. Afterwards Cloudflare's
proxy can front `DOMAIN` and `db.DOMAIN` (SSL/TLS mode **Full (strict)**);
`live.DOMAIN` stays DNS only. Behind the proxy, the federation backend's rate
limits see Cloudflare's addresses instead of your users'.

Cloudflare can cache public images. Storage serves public objects at
`/storage/v1/object/public/<bucket>/<path>` and renders at
`/storage/v1/render/image/public/<bucket>/<path>?width=&height=&resize=&quality=`.
A render is WebP when the request's `Accept` names `image/webp` and the source
format otherwise, under one ETag and without `Vary`, so a cache would serve
whichever variant it stored first. Caddy pins `Accept` to
`image/webp,*/*;q=0.8` on public renders; every Harmony client decodes WebP.
(nginx in front of Kong does the same with
`proxy_set_header Accept "image/webp,*/*;q=0.8";` in a
`location ^~ /storage/v1/render/image/public/` that repeats the other
directives of `location /`.)

`DOMAIN` gets no Cache Rule: `/invite/<code>` answers link-preview crawlers
and browsers differently under one URL, and Cloudflare's cache ignores
`Vary: User-Agent`.

Cache Rules (Caching, Cache Rules), in this order; where two rules set the
same option, the last match wins:

1. Bypass for the API host:
   `(http.host eq "db.example.com")`, Cache eligibility **Bypass cache**.
   Auth, REST, realtime and signed or authenticated storage URLs stay
   uncached, including paths ending in `.png` or `.jpg`.
2. Public objects:
   `(http.host eq "db.example.com" and starts_with(http.request.uri.path, "/storage/v1/object/public/") and not starts_with(http.request.uri.path, "/storage/v1/object/public/message_media/"))`
3. Public renders:
   `(http.host eq "db.example.com" and starts_with(http.request.uri.path, "/storage/v1/render/image/public/") and not starts_with(http.request.uri.path, "/storage/v1/render/image/public/message_media/"))`

Rules 2 and 3: Cache eligibility **Eligible for cache**; Edge TTL **Use
cache-control header if present, bypass cache if not**; Status code TTL
**greater than or equal 400: no-store**; Browser TTL **Respect origin**;
default cache key (the full URL with its query string). Only 200 responses
are stored. Deleting an object does not purge the edge: purge its URL when an
image has to disappear before its max-age ends.

### Manual installation with nginx on the host

The self-host stack is the supported path. A setup assembled by hand,
for example on a server where nginx already runs, reproduces what it does:

1. **Supabase**: the upstream Supabase Docker stack
   (`bash self-host/configure.sh` provisions it into `self-host/supabase/` at
   the pinned commit, Postgres `supabase/postgres:15.8.1.060`).
2. **Database**: write `self-host/.env` with `DOMAIN=` and `INSTANCE_NAME=`,
   and `self-host/federation.env` with `__LISTENER_PW=<a password>`, then run
   `SUPABASE_DB_CONTAINER=supabase-db bash self-host/bootstrap.sh`. It applies
   `db_schema/migrations/` and records them in
   `supabase_migrations.schema_migrations`, creates the `harmony_listener`
   role with that password, and sets `instance_config.domain`. On a database
   that already has a domain set, set it yourself:
   ```sql
   UPDATE public.instance_config SET config_value = to_jsonb('chat.example.com'::text)
    WHERE config_key = 'domain';
   ```
3. **Federation backend**: the `ghcr.io/y4my4my4m/harmony-federation` image
   twice, `FEDERATION_MODE=server` (port 3001) and `FEDERATION_MODE=worker`,
   with Redis; environment from `federation-backend/env.template`, including
   `FEDERATION_LISTENER_URL=postgresql://harmony_listener:<password>@<db host>:5432/postgres`.
   The root `docker-compose.prod.yml` and `docker-compose.full.yml` are
   starting points ([Docker](/guide/deployment/docker)).
4. **Web app**: the `ghcr.io/y4my4my4m/harmony-web` image with `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, `DOMAIN` and `INSTANCE_NAME`, or `npm run build-only`
   with the `VITE_*` variables of `.env.example` and nginx serving `dist/`.
5. **nginx**, from `dev/nginx-harmony.template.conf`:
   - `location /api/federation/ { proxy_pass http://localhost:3001/; }`: the
     trailing slash strips the prefix; the backend mounts most routes at the
     root (user lookup, GIFs, invites, instance probes, key generation);
   - `X-Real-IP` on every location proxied to the backend;
   - the `$invite_unfurl` map at the top of the file, which belongs to the
     `http` context, and the `/invite/` location using it: link-preview
     crawlers get the backend's invite card, people the app;
   - on the `db.` server block, `include` the logout rule of
     `dev/nginx-auth-logout.template.conf` (it refuses
     `/auth/v1/logout` without `?scope=local`), and the `Accept` pin on
     public renders shown under [Cloudflare](#cloudflare);
   - `live.` from `dev/nginx-livekit.template.conf`.
6. **Admin account**: keep sign-up disabled (`DISABLE_SIGNUP=true` in
   Supabase's `.env`), add yourself in Supabase Studio (Authentication, Add
   user, Auto Confirm User), sign in to Harmony and choose a username: the
   first local profile becomes the admin. Then enable sign-up if you want it.

[Production deployment](/guide/deployment/) lists the requirements of every
manual setup.

### Scaling

One server holds a small-to-medium community. Text chat is bound by Supabase
Realtime's WebSocket connections, voice by LiveKit's CPU. LiveKit nodes that
share one Redis coordinate rooms among themselves: a second LiveKit server
with the same API keys and Redis adds voice capacity. Federation workers share
the BullMQ queue in Redis, so more `federation-worker` containers spread
delivery work.

### Status page

An external status page tells users whether the instance is up when it is
not: [OpenStatus setup](/OPENSTATUS_SETUP).
