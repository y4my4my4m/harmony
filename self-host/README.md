# Harmony self-host stack

Everything a Harmony instance needs, in Docker: Caddy (HTTPS), the web app,
the federation backend, Redis and Supabase, plus LiveKit voice, the bot
gateway and Discord bridge hosting when enabled. Harmony's services run
prebuilt images from `ghcr.io/y4my4my4m`.

The guide for operators is **[docs/self-hosting.md](../docs/self-hosting.md)**
(also at <https://docs.mony.lol/self-hosting>). This file describes the
directory.

## Install

On a Linux server with a domain pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
```

or, from a checkout, `bash self-host/install.sh`. The installer checks the
host, asks a few questions, checks DNS, starts the stack, loads the database
and creates the admin account. It is safe to re-run.

## Commands

`harmony` (this directory's `harmony` script; linked to `/usr/local/bin`
when installed as root):

| Command | Does |
|---|---|
| `harmony install` | install, or re-run the install with the current answers as defaults |
| `harmony status` | URL, versions, enabled services, container states |
| `harmony doctor [--offline]` | checks DNS, certificates, containers, database, federation, voice, push, email, disk, memory, backups and versions; exit 1 on a failure |
| `harmony update [--version X.Y.Z]` | new code and images, a backup, migrations, restart |
| `harmony backup [--no-storage]` | database, roles, configuration and uploads into `backups/<time>/` |
| `harmony restore <backup> [--yes]` | load a backup; the current data moves aside first |
| `harmony logs [service] [-n N] [--no-follow]` | follow logs (`federation` = server and worker, `supabase` = its core services) |
| `harmony admin create [--email --username --password]` | an admin account |
| `harmony admin reset-password (--email E \| --username U)` | set a new password |
| `harmony admin invite <email> [--send]` | a single-use invitation link (emailed with `--send`) |
| `harmony registration open\|invite\|closed` | who can create an account |
| `harmony config` | change the install answers and apply them |

## Files

| File | Written by | Holds |
|---|---|---|
| `install.sh` | | the installer |
| `harmony` | | the operator command |
| `configure.sh` | | writes the configuration files below; merge-safe |
| `bootstrap.sh` | | applies `db_schema/migrations/`, creates `harmony_listener`, sets `instance_config.domain` |
| `update.sh`, `backup.sh`, `admin.sh`, `doctor.sh`, `lib.sh` | | behind `harmony update`, `backup`/`restore`, `admin`/`registration`, `doctor` |
| `docker-compose.yml` | | the stack; `include:`s Supabase |
| `docker-compose.build.yml` | | builds Harmony's images from the checkout (`HARMONY_BUILD=1`) |
| `supabase-overrides.yml` | | Harmony's changes to the upstream Supabase stack |
| `Caddyfile` | | routing and TLS |
| `web.Dockerfile`, `web-nginx.conf`, `web-entrypoint.d/` | | the web image and its runtime `/config.json` |
| `.env` | configure.sh | domain, TLS, enabled services, image tag, registration, ports |
| `federation.env` | configure.sh | federation backend: Supabase keys, Redis, VAPID and LiveKit keys, internal secret |
| `bot-gateway.env` | configure.sh | bot gateway (bots enabled) |
| `discord-bridge.env` | configure.sh | bridge host secret (Discord bridge hosting enabled) |
| `livekit.yaml` | configure.sh | LiveKit (voice enabled) |
| `supabase/` | configure.sh | upstream Supabase `docker/` at the pinned commit; `supabase/.env` holds its secrets, SMTP and auth settings; `supabase/volumes/` the database and uploads |
| `backups/` | harmony backup, update | backups |

`.env`, `federation.env`, `bot-gateway.env`, `discord-bridge.env`,
`livekit.yaml` and `supabase/.env` hold the only copy of the instance's
secrets. `harmony backup` saves them with the database.

## Images

| Image | Source |
|---|---|
| `ghcr.io/y4my4my4m/harmony-web` | `web.Dockerfile` (repository root context) |
| `ghcr.io/y4my4my4m/harmony-federation` | `federation-backend/Dockerfile` (server and worker) |
| `ghcr.io/y4my4my4m/harmony-bot-gateway` | `bot-gateway/Dockerfile` |
| `ghcr.io/y4my4my4m/harmony-discord-bridge` | the harmony-discord-bridge repository |

`.github/workflows/images.yml` publishes the first three for linux/amd64 and
linux/arm64: `X.Y.Z`, `X.Y` and `latest` for a release tag `vX.Y.Z`; `edge`
and `sha-<short>` for master. `HARMONY_VERSION` in `.env` is the tag; it
follows the checkout (`X.Y.Z` on tag `vX.Y.Z`, otherwise `edge`) and is
rewritten by every `configure.sh` run. `HARMONY_VERSION=<tag>` in the
environment of a command overrides it for that run.

The web image carries no instance values: its entrypoint writes
`/config.json` from the container environment (`SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `DOMAIN`, `INSTANCE_NAME`, `APP_URL`,
`ENABLED_OAUTH_PROVIDERS`, `TERMS_URL`, `PRIVACY_URL`; the full list is in
`web-entrypoint.d/40-harmony-config.sh`). The backend images run Node 24 as
uid 1000 (`node`).

Building locally instead (forks, development):

```bash
HARMONY_BUILD=1 bash configure.sh --non-interactive   # COMPOSE_FILE gains docker-compose.build.yml
docker compose up -d --build
HARMONY_BUILD=0 bash configure.sh --non-interactive   # back to published images
```

## Discord bridge hosting

Communities connect a Discord server in Server Settings, Discord Bridge.
The bridge runs either on a computer of theirs ("Run it myself") or, when the
operator offers it, on this instance ("Run it on this instance": they paste
their Discord bot token into Harmony).

Offering it takes the `discord` profile and a switch in the app:

1. Answer yes to bots and to Discord bridge hosting in `harmony install` or
   `harmony config` (non-interactive: `HARMONY_BOTS=y HARMONY_DISCORD=y`).
   `configure.sh` generates `BRIDGE_HOST_SECRET` into `bot-gateway.env` and
   `discord-bridge.env`, and the `discord-bridge-host` service starts
   (`ghcr.io/y4my4my4m/harmony-discord-bridge:${DISCORD_BRIDGE_VERSION:-2}`,
   `BRIDGE_MODE=host`, reaching the gateway at `http://bot-gateway:3002`).
2. In Harmony, Admin, Instance: turn on "Run Discord bridges for
   communities" and set the maximum number of hosted bridges.

The host runs every hosted bridge, one Discord connection each, and picks up
new ones within a minute. The operator holds each community's Discord bot
token, which reads every Discord channel that bot can see; the app tells
communities so before they choose. `harmony doctor` checks that the secrets
match and the host runs; `harmony logs discord-bridge-host` shows the
bridges it runs.

## Supabase version

`configure.sh` pins the upstream Supabase stack to the commit in
`SUPABASE_REF_DEFAULT` (Postgres image `supabase/postgres:15.8.1.060`, the one
Harmony's CI installs the schema on); `supabase/.harmony-supabase-ref` records
the commit in use. An install keeps its stack until refreshed:

```bash
harmony backup
bash configure.sh --refresh-supabase      # to the pinned commit
docker compose up -d
```

A refresh replaces the upstream compose and config files and adds new keys to
`supabase/.env`. It never touches `supabase/volumes/db/data` or
`supabase/volumes/storage`, and refuses a commit whose Postgres major version
differs from the existing database's.

Requires Docker Compose 2.24.4 or later (`include:` with a file list, `!reset`).
