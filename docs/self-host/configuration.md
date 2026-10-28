---
title: Configuration reference
description: Where a self-hosted Harmony instance keeps its configuration, how to change it, and every variable each service reads.
---

# Configuration reference

This page is for operators. It explains where an instance's configuration
lives, how to change it on an installer-based instance and on a manual
deployment, and lists every variable each component reads. Examples use
`chat.example.com` and the installer's default directory, `/opt/harmony`.

## Where configuration lives

An instance has three layers of configuration:

- **Files** in `self-host/`: environment files and `livekit.yaml`. Containers
  read them when they start, so a change needs `docker compose up -d`.
- **The database**: `public.instance_config` and a few related tables,
  edited in the admin panel. A change applies without a restart.
- **The web bundle**: `VITE_*` values inlined at build time. Only a manual
  build uses them; the published web image carries none.

### Files of an installer-based instance

`self-host/configure.sh` writes every file below. The installer runs it, and
so do `harmony config` and `harmony update`.

| File | Read by | Written |
|---|---|---|
| `.env` | Docker Compose (variables in `docker-compose.yml`, the enabled profiles) and the `harmony` scripts | Always |
| `federation.env` | `federation-server`, `federation-worker` | Always |
| `bot-gateway.env` | `bot-gateway` | With bots on |
| `discord-bridge.env` | `discord-bridge-host` | With Discord bridge hosting on |
| `livekit.yaml` | `livekit` | With voice on; kept once it exists |
| `supabase/.env` | The Supabase stack, including the sign-in service (`auth`), and `supabase-overrides.yml` | Always |

The web container has no file of its own: `docker-compose.yml` passes it
values from `.env` (see [Web app](#web-app)).

These files hold the only copy of the instance's secrets. `harmony backup`
saves them with the database.

### Settings stored in the database

The admin panel is **User settings** → **Instance admin**
(`https://chat.example.com/admin`). Its **Config** tab has the sub-tabs
**General**, **Federation**, **Branding**, **Authentication**,
**Voice & video** and **Uploads**. Their values live in
`public.instance_config`, except those of **Voice & video**, which live in
`public.instance_webrtc_settings`.

Some settings exist both as a variable and in the database:

| Setting | Variable | Database | Which applies |
|---|---|---|---|
| Instance name | `INSTANCE_NAME` | `instance_config.instance_name` | `bootstrap.sh` copies the variable into a new database; afterwards the admin panel's name applies. The web app shows the variable until the instance settings load. The federation backend reports the variable in `/health` and `/instance-info`, and uses it in NodeInfo only when the database has no name |
| Domain | `DOMAIN` | `instance_config.domain` | Both must be the same. `bootstrap.sh` sets the database value on a new database; `harmony doctor` fails when they differ |
| OAuth buttons | `ENABLED_OAUTH_PROVIDERS` | `instance_config.oauth_providers` | The database list when it names at least one provider, else the variable. See [OAuth sign-in](/self-host/oauth) |
| Buttons of your own sign-in providers | none | `instance_config.custom_oauth_providers` | The database. `harmony auth add-provider` and `remove-provider` write it; **Authentication** lists it read-only. See [Your own identity provider](/self-host/oauth#your-own-identity-provider) |
| Terms and privacy links | `TERMS_URL`, `PRIVACY_URL` | `instance_config.terms_url`, `privacy_url` | The database value, empty included, once the instance settings load. A new database holds empty values, so set the links in **Config** → **Branding** |
| Registration | `REGISTRATION` | `instance_config.open_registration` | `harmony registration` sets both, together with `DISABLE_SIGNUP` in `supabase/.env` |
| Call transport, federated calls | `WEBRTC_MODE`, `ALLOW_FEDERATED_VOICE` | `instance_webrtc_settings` | The variables. The backend does not read the values the **Voice & video** tab stores |
| Upload ceiling | `FILE_SIZE_LIMIT` in `supabase/.env` | `instance_config.upload_ceiling_bytes` | Storage refuses a larger file whatever the database says. `harmony config --upload-ceiling` sets both; `bootstrap.sh` copies the variable into the database on every run. See [Upload limits](#upload-limits) |
| Storage origin | `DB_DOMAIN` | `instance_config.storage_origin` | `https://DB_DOMAIN`, where every public file URL starts. Sticker and emoji uploads under any other origin are refused. `bootstrap.sh` writes it on every run, `harmony update` included; `harmony doctor` warns when it is empty or differs |

### Drive storage

The admin panel's **Drive** tab, shown to instance admins only, holds the
settings of [Drive](/use/drive), the file storage of each account. They live
in `public.instance_config` and apply when you click **Save**.

| Setting | Key | Default | Meaning |
|---|---|---|---|
| **Storage per account** | `drive_quota_user_mb` | `1024` | Storage of an account that is neither instance admin nor moderator, in MB |
| **Storage per instance moderator** | `drive_quota_moderator_mb` | `25600` | Storage of an instance moderator, in MB |
| **Storage per instance admin** | `drive_quota_admin_mb` | `102400` | Storage of an instance admin, in MB |
| **Temporary files are kept** | `drive_ephemeral_days` | `30` | Days after which a temporary upload is deleted |
| **Temporary uploads per day once Drive is full** | `drive_ephemeral_daily_mb` | `2048` | MB of temporary uploads an account over its storage may make in 24 hours. Past it, the account's uploads are refused |
| **Files can be shared by link** | `drive_link_sharing` | `true` | Whether people can share a file by a link that needs no account. While it is off, existing links do not open |

An upload that would take an account past its storage is temporary. Storage
counts the files kept in Drive and in the trash; files with the same
contents count once, once the server has hashed them.

**Storage by account** lists the accounts that store files, largest first,
with their used and temporary bytes. Its **Storage** field sets one
account's limit in MB; clearing it returns the account to its role's limit.

**Blocked files** lists the file contents blocked from a report, with
**Unblock** to lift a block; see
[Remove a reported file](/run/moderation#remove-a-reported-file).

The federation worker hashes new files, deletes temporary files whose days
have passed and trash older than 30 days, and removes the stored bytes of
deleted files. It sweeps every 10 minutes.

### Upload limits

**Config** → **Uploads** sets the largest file an account may upload into
channels, threads, direct and group conversations and posts, or keep in
Drive. Profile pictures (5 MB), banners (10 MB), server and group icons
(5 MB), emoji (1 MB) and soundboard sounds (512 KB) keep their own limits.

| Setting | Key | Default | Meaning |
|---|---|---|---|
| **Largest file per account** | `upload_limit_user_mb` | `50` | An account that is neither instance admin nor moderator, in MB |
| **Largest file per instance moderator** | `upload_limit_moderator_mb` | `50` | An instance moderator, in MB |
| **Largest file per instance admin** | `upload_limit_admin_mb` | `50` | An instance admin, in MB |
| **Ceiling set by the server operator** | `upload_ceiling_bytes` | `52428800` | Read-only in the admin panel: storage's `FILE_SIZE_LIMIT`, in bytes. See [Raise the ceiling](#raise-the-ceiling) |

A MB is 1,048,576 bytes. **Save** refuses a limit above the ceiling; a limit
left above a ceiling lowered later counts as the ceiling. An instance updated
from 1.9.1 starts every limit at the larger of the two upload buckets' limits
(`message_media`, `user_media`), 50 MB unless you had changed them. A bucket
without a limit of its own was bounded by `FILE_SIZE_LIMIT` alone; if that is
larger, raise the limits in **Config** → **Uploads** after updating.

In **Users**, the upload button of a local account opens that account's
limit: its role's limit, the limit that applies now, and **Use the tier** or
**Custom limit** in MB. A custom limit applies instead of the role's, above
or below it, and never above the ceiling. Instance moderators see the
**Users** limits read-only; only instance admins change them. Each change is
in the activity log.

The limit is the size of the file as stored. The web app refuses a larger
file before sending a byte and says what the limit is, on the attachment and
in the transfers list. The database refuses it as well, so no other client
or direct call to the storage API passes it: the `storage_upload_limit`
trigger on `storage.objects` refuses a resumable upload when it is created,
from the size it declares, and a single-request upload once its bytes reach
storage, which then deletes them. Storage answers such a refusal as it
answers a permission refusal: `403`, `new row violates row-level security
policy`. Uploads made with the service role key (the Discord bridge's
mirrored attachments, the federation backend) have no per-account limit;
the ceiling still applies.

A file limit is not [Drive storage](#drive-storage). Storage counts every
file an account keeps; an upload within the file limit that would take an
account past its storage is kept as a temporary file.

#### Raise the ceiling

```bash
harmony config --upload-ceiling 2GB
```

This writes `FILE_SIZE_LIMIT` in `supabase/.env`, recreates the storage
container with it, and writes the same number into
`instance_config.upload_ceiling_bytes`. Then raise the limits in
**Config** → **Uploads**. A size is a number of bytes, or a number followed
by `MB` or `GB`, from 1 MB to 5 TB. `harmony config --upload-ceiling` alone
prints the current ceiling. It warns about limits above a lowered ceiling.
`harmony doctor` warns when storage, `supabase/.env` and the database
disagree.

The web app sends a file over 6 MB in 6 MB pieces through storage's
resumable (TUS) endpoint, so Caddy's 50 MB request body limit and
Cloudflare's 100 MB do not bound the size of a file.

Larger files cost storage. On the file backend they fill the disk under
`supabase/volumes/storage`. On Cloudflare R2 or another S3-compatible store
every stored byte is billed per GB-month, and each 6 MB piece of a resumable
upload is one multipart part request (a Class A operation on R2); R2 charges
no egress. Drive storage per account bounds what each account keeps, and
temporary files count until they expire.

### Emoji limits

**Config** → **Federation** holds the emoji limits. They live in
`public.instance_config` and apply when you click **Save changes**.

| Setting | Key | Default | Meaning |
|---|---|---|---|
| **Max custom emojis per server** | `max_custom_emojis_per_server` | `50` | Custom emoji a server holds, checked by the web app. `0` is no limit |
| **Personal emojis per user** | `max_personal_emojis_per_user` | `50` | Emoji each person keeps in **User settings** → **My emojis**, uploads and AI-generated together, `0` to `1000`. `0` turns personal emoji off. The database refuses an emoji past the limit; emoji already past a lowered limit stay |

### Sticker limits

**Config** → **Federation** also holds the sticker caps: `max_stickers_per_server` (`15`),
`max_instance_stickers` (`50`) and `max_personal_stickers_per_user` (`0`, personal stickers
off). [Stickers](/self-host/stickers) describes them with the file limits.

## Change a setting

### With harmony config

```bash
harmony config
```

`harmony config` runs `configure.sh` interactively. It asks again for the
domain, instance name, admin email, TLS mode, voice, bots, Discord bridge
hosting, registration policy and email (SMTP), each defaulting to the
current value. It then removes the containers of services you turned off,
pulls images, runs `docker compose up -d`, and applies the registration
policy once an admin exists. [The harmony command](/self-host/cli#harmony-config)
covers it in detail.

`harmony config` needs a terminal. For a scripted change, set answers as
environment variables and run `configure.sh` without prompts, then apply:

```bash
cd /opt/harmony/self-host
HARMONY_VOICE=y bash configure.sh --non-interactive
docker compose up -d
```

| Variable | Answer |
|---|---|
| `HARMONY_DOMAIN` | Public domain |
| `HARMONY_INSTANCE_NAME` | Display name |
| `HARMONY_ADMIN_EMAIL` | Let's Encrypt contact and Web Push (VAPID) contact |
| `HARMONY_TLS` | `acme` (Let's Encrypt) or `internal` (Caddy's local CA) |
| `HARMONY_VOICE` | `y` or `n`: LiveKit voice and video |
| `HARMONY_BOTS` | `y` or `n`: the bot gateway |
| `HARMONY_DISCORD` | `y` or `n`: Discord bridge hosting; `y` turns bots on |
| `HARMONY_REGISTRATION` | `open`, `invite` or `closed` |
| `HARMONY_SMTP_HOST` | SMTP server. Unset keeps the current email settings |
| `HARMONY_SMTP_PORT` | Default `587` |
| `HARMONY_SMTP_USER`, `HARMONY_SMTP_PASS` | SMTP credentials |
| `HARMONY_SMTP_SENDER` | From address, default `noreply@DOMAIN` |
| `HARMONY_VERSION` | Image tag. Default: `X.Y.Z` when the checkout sits on tag `vX.Y.Z`, otherwise `edge` |
| `HARMONY_BUILD` | `1` builds Harmony's images from the checkout; `0` returns to published images |
| `HARMONY_HTTP_PORT`, `HARMONY_HTTPS_PORT` | `[address:]port` Caddy publishes for 80 and 443 |
| `SUPABASE_REF` | Commit, tag or branch of the upstream Supabase stack, used by `--refresh-supabase` |

Every answer not given keeps its current value.

### By editing a file

Edit the file, then apply it from `self-host/`:

```bash
cd /opt/harmony/self-host
docker compose up -d
```

Compose recreates every container whose environment changed. `livekit.yaml`
is a mounted file, so a change to it needs `docker compose restart livekit`.

`configure.sh` runs again on every `harmony config` and `harmony update`. It
keeps every key it finds, adds missing ones, and never regenerates a secret.
The answers in `.env` (`DOMAIN`, `INSTANCE_NAME`, `ADMIN_EMAIL`,
`ENABLE_VOICE`, `ENABLE_BOTS`, `ENABLE_DISCORD_BRIDGE`, `REGISTRATION`,
`HARMONY_HTTP_PORT`, `HARMONY_HTTPS_PORT`) default to their current values,
so a hand edit of them stays and takes effect on the next run. The keys below
are recomputed on every run, and a hand edit of them is lost:

| File | Key | Recomputed from |
|---|---|---|
| `.env` | `CADDY_TLS` | `ADMIN_EMAIL`, or `internal` |
| `.env` | `COMPOSE_PROFILES` | The `ENABLE_*` answers |
| `.env` | `HARMONY_VERSION` | The checkout's tag, else `edge`; `HARMONY_VERSION` in the command's environment overrides it |
| `.env` | `SUPABASE_ANON_KEY` | `ANON_KEY` in `supabase/.env` |
| `federation.env` | `INSTANCE_NAME` | `.env` |
| `federation.env` | `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `supabase/.env` |
| `federation.env` | `VAPID_SUBJECT` | `ADMIN_EMAIL` |
| `federation.env` | `LIVEKIT_URL`, `LIVEKIT_PUBLIC_URL` | Removed while voice is off |
| `bot-gateway.env` | `SUPABASE_SERVICE_ROLE_KEY` | `supabase/.env` |
| `bot-gateway.env` | `INTERNAL_API_SECRET` | `federation.env` |
| `bot-gateway.env` | `BRIDGE_HOST_SECRET` | `discord-bridge.env`; removed while hosting is off |
| `supabase/.env` | `SMTP_*` | The email answers, when email is configured in that run |

Values derived from the domain (`DB_DOMAIN`, `LIVEKIT_DOMAIN`,
`INSTANCE_DOMAIN`, `API_BASE_URL`, `CORS_ORIGIN`, `PUBLIC_SUPABASE_URL`,
`LIVEKIT_PUBLIC_URL`, `PUBLIC_URL`, `FEDERATION_BACKEND_URL`, `SITE_URL`,
`API_EXTERNAL_URL`, `SUPABASE_PUBLIC_URL`, `ADDITIONAL_REDIRECT_URLS`, and
the `domain:` line of `livekit.yaml`) are rewritten only when the domain
changes.

::: warning
`REDIS_PASSWORD` in `.env` also appears inside `REDIS_URL` in
`federation.env` and under `redis:` in `livekit.yaml`. `configure.sh` does not
update those copies; change all three together.
:::

## Manual deployment

Without the installer, each component reads its own file. [Docker Compose and
reverse proxies](/self-host/docker-compose) describes the root compose files
that use them.

| Component | File | Template |
|---|---|---|
| Web app (static build) | `.env` at the repository root, read by Vite at build time; or a `config.json` next to `index.html` | `.env.example` |
| Federation backend | `federation-backend/.env` | `federation-backend/env.template` (production), `federation-backend/.env.example` (development) |
| Bot gateway | `bot-gateway/.env` | `bot-gateway/env.template` (production), `bot-gateway/.env.example` (development) |
| LiveKit | `webrtc/livekit.yaml` | `webrtc/livekit.yaml.example` |
| Supabase | the Supabase stack's own `.env` | upstream Supabase |

`docker-compose.prod.yml` and `docker-compose.full.yml` read `REDIS_PASSWORD`
and the Bull Board variables from the root `.env`; `docker-compose.full.yml`
also reads `LISTENER_PASSWORD`, the password of the `harmony_listener`
database role. Both files override some backend variables themselves
(`NODE_ENV`, `PORT`, `FEDERATION_MODE`; in `docker-compose.full.yml` also
`SUPABASE_URL`, `REDIS_URL`, `USE_BULLMQ_QUEUE` and
`FEDERATION_LISTENER_URL`).

The self-host stack's `supabase-overrides.yml` maps the OAuth variables onto
the sign-in service. A Supabase stack without it needs the
`GOTRUE_EXTERNAL_*` settings added to its `auth` service by hand; see
[OAuth sign-in](/self-host/oauth).

## Self-host .env

`self-host/.env` is read by Docker Compose and by the `harmony` scripts.

| Variable | Default | What it does |
|---|---|---|
| `DOMAIN` | required | Public domain of the app. Caddy serves it; the web container receives it as `DOMAIN` and as `APP_URL` (`https://DOMAIN`) |
| `DB_DOMAIN` | `db.DOMAIN` | Host of the Supabase API (Kong) behind Caddy. The web container receives `https://DB_DOMAIN` as `SUPABASE_URL` |
| `LIVEKIT_DOMAIN` | `live.DOMAIN` | Host of LiveKit signalling; Caddy defines it only with `ENABLE_VOICE=true` |
| `INSTANCE_NAME` | `Harmony` | Display name passed to the web container. `configure.sh` copies it to `federation.env` and uses it as the email sender name |
| `ADMIN_EMAIL` | none | `configure.sh` writes it to `VAPID_SUBJECT`, and to `CADDY_TLS` with public TLS. The `harmony admin` commands offer it as the default address |
| `CADDY_TLS` | `internal` | An email address: Let's Encrypt certificates with that contact. `internal`: Caddy's local CA, for LAN installs |
| `ENABLE_VOICE` | `false` | `true` defines the LiveKit site in Caddy. `configure.sh` adds the `voice` profile and the LiveKit URLs |
| `ENABLE_BOTS` | `false` | `configure.sh` adds the `bots` profile and writes `bot-gateway.env`; `harmony doctor` checks the gateway |
| `ENABLE_DISCORD_BRIDGE` | `false` | `configure.sh` adds the `discord` profile and writes `discord-bridge.env` |
| `REGISTRATION` | `open` | `open`, `invite` or `closed`. `harmony registration` without an argument applies it |
| `COMPOSE_PROFILES` | from `ENABLE_*` | Read by Docker Compose: the optional services (`voice`, `bots`, `discord`) `docker compose up -d` starts |
| `COMPOSE_FILE` | unset | `docker-compose.yml:docker-compose.build.yml` after `HARMONY_BUILD=1`: images are built from the checkout |
| `HARMONY_VERSION` | `edge` | Tag of the `ghcr.io/y4my4my4m/harmony-*` images. Rewritten by every `configure.sh` run; `harmony update --version` changes it |
| `DISCORD_BRIDGE_VERSION` | `2` | Tag of the Discord bridge image, versioned separately from Harmony |
| `HARMONY_HTTP_PORT` | `80` | `[address:]port` Caddy publishes for port 80 |
| `HARMONY_HTTPS_PORT` | `443` | `[address:]port` Caddy publishes for 443/tcp and 443/udp |
| `SUPABASE_ANON_KEY` | required | Supabase anon key for the web container; copied from `supabase/.env` |
| `ENABLED_OAUTH_PROVIDERS` | empty | Comma-separated OAuth buttons (`google`, `github`, `twitch`) for the web container |
| `TERMS_URL`, `PRIVACY_URL` | empty | Legal links for the web container; see the table above for which value applies |
| `STATUS_URL` | empty | Service status page (an Uptime Kuma status page, for example) linked under the sign-in form and in Settings; no link when empty |
| `REDIS_PASSWORD` | generated | Redis password (`requirepass`) |

## Supabase .env

`self-host/supabase/.env` starts as upstream Supabase's `.env.example`.
`configure.sh` sets these keys; the other upstream keys keep upstream's
values.

| Variable | Value `configure.sh` writes | What it does |
|---|---|---|
| `JWT_SECRET` | generated | Signs every Supabase token. Never change it on an existing database |
| `ANON_KEY`, `SERVICE_ROLE_KEY` | signed with `JWT_SECRET`, valid 10 years | API keys; re-signed when invalid or expiring within a year |
| `POSTGRES_PASSWORD` | generated | Database password |
| `DASHBOARD_PASSWORD` | generated | Password of Supabase Studio at `https://DB_DOMAIN` (user `supabase`) |
| `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`, `LOGFLARE_PUBLIC_ACCESS_TOKEN`, `LOGFLARE_PRIVATE_ACCESS_TOKEN` | generated | Upstream secrets, replaced on a new install |
| `SITE_URL` | `https://DOMAIN` | Where links in sign-in emails lead |
| `API_EXTERNAL_URL` | `https://DB_DOMAIN` | Public API URL; base of the OAuth callback |
| `SUPABASE_PUBLIC_URL` | `https://DB_DOMAIN` | Upstream's public URL setting |
| `ADDITIONAL_REDIRECT_URLS` | `https://DOMAIN` | Redirect targets the sign-in service accepts |
| `DISABLE_SIGNUP` | `true` on a new install | `harmony registration` sets it: `false` for `open`, `true` otherwise |
| `ENABLE_EMAIL_AUTOCONFIRM` | `true` without SMTP, `false` with | `false` makes new accounts confirm their address by email |
| `STUDIO_DEFAULT_PROJECT` | instance name | Project name in Studio |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` | from the email answers | Outgoing email. See [Email (SMTP)](/self-host/email) |
| `GOOGLE_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_SECRET`, and the same for `GITHUB` and `TWITCH` | not written | OAuth providers, mapped by `supabase-overrides.yml`. See [OAuth sign-in](/self-host/oauth) |
| `PROVIDER_LINKING_DOMAINS` | `github=github,google=google,twitch=twitch` while `ENABLE_EMAIL_AUTOCONFIRM=true` (`configure.sh`, for each built-in provider without an entry); `harmony auth add-provider` adds `custom:ID=custom:ID` per provider | Sign-in providers that never join an existing account by its address, as comma-separated `provider=domain` pairs (`GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS`); `PROVIDER=default` joins by address. `harmony auth linking` sets a built-in provider's entry. A value that is not such pairs stops the sign-in service from starting. See [Existing accounts](/self-host/oauth#existing-accounts) and [First sign-in and existing accounts](/self-host/oauth#first-sign-in-and-existing-accounts) |
| `FILE_SIZE_LIMIT` | not written; `harmony config --upload-ceiling` writes it | Largest file storage accepts, bytes, resumable uploads included; `52428800` when absent (`supabase-overrides.yml`). See [Upload limits](#upload-limits) |
| `GOTRUE_IMAGE` | `configure.sh` | The sign-in service's image: the Supabase stack's own `supabase/gotrue` image from `v2.196.0` on, otherwise `supabase/gotrue:v2.196.0`. A newer image set by hand stays |

### Sign-in service version

`supabase-overrides.yml` runs the sign-in service (`auth`) on
`GOTRUE_IMAGE` from `supabase/.env`. `configure.sh` (and so `harmony update`)
sets it to `supabase/gotrue:v2.196.0` while the Supabase stack's own image is
older, as the pinned upstream stack's `v2.177.0` is: sign-in through your own
identity provider needs it. From `v2.196.0` on, the stack's own image runs, so
a newer stack is never downgraded. On start the sign-in service carries the
`auth` schema forward with its own migrations, which add tables and nullable
columns. `supabase-overrides.yml` also sets
`GOTRUE_CUSTOM_OAUTH_EXTERNAL_URL` to `API_EXTERNAL_URL/auth/v1`, the base of
those providers' callback. The providers themselves are not configuration
files: `harmony auth add-provider` stores them in the sign-in service. See
[Your own identity provider](/self-host/oauth#your-own-identity-provider).

## Web app

The web app reads `/config.json` before it starts and falls back to the
`VITE_*` values inlined at build time (`src/services/runtimeConfig.ts`). A
non-empty key in `/config.json` wins.

- **Web image**: at container start,
  `self-host/web-entrypoint.d/40-harmony-config.sh` writes `/config.json` from
  the container environment. Each key reads the container variable, then the
  same name with the `VITE_` prefix. A change needs `docker compose up -d`,
  not a rebuild.
- **Static build**: the `VITE_*` values in `.env` at build time apply. A
  `config.json` next to `index.html`, served as `application/json`, overrides
  them. `VITE_RUNTIME_CONFIG=off` skips the request: the page starts without
  waiting a round trip for a file the instance does not serve.
- **Desktop and Android apps** read neither: they fetch the chosen
  instance's `GET /api/federation/instance-info`.

| `config.json` key | Container variable | Build variable | What it does |
|---|---|---|---|
| `supabaseUrl` | `SUPABASE_URL` | `VITE_SUPABASE_URL` | Public Supabase API URL, e.g. `https://db.chat.example.com`. Required |
| `supabaseAnonKey` | `SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` | Supabase anon key. Required |
| `domain` | `DOMAIN`, else `INSTANCE_DOMAIN` | `VITE_DOMAIN` | Host part of local handles and ActivityPub ids. Default: the page's host |
| `instanceDomain` | `INSTANCE_DOMAIN`, else `domain` | `VITE_INSTANCE_DOMAIN` | Instance domain shown until the instance settings load |
| `instanceName` | `INSTANCE_NAME` | `VITE_INSTANCE_NAME` | Instance name shown until the instance settings load. Default `Harmony` |
| `appUrl` | `APP_URL` | `VITE_APP_URL` | Public origin of the app: base of invite, post and thread links, and of password reset links. Default: the page's origin |
| `federationUrl` | `FEDERATION_URL` | `VITE_FEDERATION_URL` | Public origin of the federation backend, used for the channel webhook URLs and the Ko-fi and Stripe webhook URLs the app displays. Default: the page's origin |
| `storageDomain` | `STORAGE_DOMAIN` | `VITE_STORAGE_DOMAIN` | Comma-separated hosts, besides the Supabase URL's, that serve this instance's storage; image resizing applies to their URLs |
| `altDomains` | `HARMONY_ALT_DOMAINS` | `VITE_HARMONY_ALT_DOMAINS` | Comma-separated other host names of this instance, treated as local by link embeds |
| `termsUrl` | `TERMS_URL` | `VITE_TERMS_URL` | Terms of service link on the registration page |
| `privacyUrl` | `PRIVACY_URL` | `VITE_PRIVACY_URL` | Privacy policy link on the registration page |
| `statusUrl` | `STATUS_URL` | `VITE_STATUS_URL` | Service status page linked under the sign-in form and in Settings. No link when unset |
| `oauthProviders` | `ENABLED_OAUTH_PROVIDERS` | `VITE_ENABLED_OAUTH_PROVIDERS` | Comma-separated OAuth buttons when the database names none |

`self-host/docker-compose.yml` passes the web container `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `DOMAIN`, `INSTANCE_NAME`, `APP_URL`,
`ENABLED_OAUTH_PROVIDERS`, `TERMS_URL`, `PRIVACY_URL` and `STATUS_URL`. The other keys
reach it only through an edit to the `web` service's `environment:`.

Build-only variables:

| Variable | What it does |
|---|---|
| `VITE_DEBUG_LOGGING` | `true` turns on debug logging in development builds. Production builds ignore it |
| `VITE_DEFAULT_INSTANCE_URL` | Desktop and Android builds: the instance pre-filled in the first-launch instance picker |

The web app reads no other variable. It learns the LiveKit URL from
`GET /api/livekit/config` and the Web Push key from
`GET /api/federation/push/vapid-key`, both served by the federation backend.

## Federation backend

`self-host/federation.env`, or `federation-backend/.env` on a manual
deployment. `federation-backend/src/config/index.ts` validates the
environment at start: an invalid or missing required value stops the
process and names the variable.

### Required

| Variable | What it does |
|---|---|
| `SUPABASE_URL` | Supabase API URL as the backend reaches it: `http://supabase-kong:8000` in the self-host stack |
| `SUPABASE_ANON_KEY` | Supabase anon key; `/instance-info` hands it to the desktop and Android apps |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `INSTANCE_DOMAIN` | Public domain without scheme, e.g. `chat.example.com`. ActivityPub ids derive from it |

### Server

| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test`. The images set `production`, which hides error details in 500 responses, makes the SSRF guard refuse plain `http` URLs outside link previews, and refuses `REQUIRE_VALID_SIGNATURES=false` |
| `PORT` | `3001` | HTTP port |
| `FEDERATION_MODE` | `unified` | `server` (HTTP only), `worker` (queues only, no HTTP) or `unified` (both in one process). The compose files run one `server` and one `worker` container |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated browser origins allowed to call the backend. The origins of the desktop and Android apps are always allowed |
| `TRUST_PROXY` | `loopback, uniquelocal` | Express `trust proxy`: peers trusted to name the client in `X-Real-IP`, on which rate limits key |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `INSTANCE_NAME` | `Harmony` | Name in `/health` and `/instance-info`, and in NodeInfo when the database has none |
| `INSTANCE_DESCRIPTION` | `A federated social platform` | NodeInfo description when the database has none |
| `PUBLIC_SUPABASE_URL` | `SUPABASE_URL` | Public Supabase URL: storage URLs sent to other instances and the `supabaseUrl` in `/instance-info`. Set it whenever `SUPABASE_URL` is an internal address |
| `VERSION` | the release (`1.8.10`) | Version reported by `/health`, `/instance-info`, NodeInfo and the outgoing `User-Agent` |

### Queue and database

| Variable | Default | What it does |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis for the job queues, cache, presence and rate limits. Self-host: `redis://:PASSWORD@redis:6379` |
| `USE_BULLMQ_QUEUE` | `true` | Keep `true`. `false` starts the legacy Supabase Realtime listener, which receives no events since 1.8.7 (the `supabase_realtime` publication carries no table). `USE_PGBOSS_QUEUE` is read when this is unset |
| `FEDERATION_LISTENER_URL` | unset | Direct, session-mode Postgres URL (port 5432) on which the worker listens for new jobs. Self-host uses the least-privilege `harmony_listener` role. Unset, jobs wait for the 60-second sweep |
| `DATABASE_URL` | unset | Read when `FEDERATION_LISTENER_URL` is unset |

### Federation and media

| Variable | Default | What it does |
|---|---|---|
| `REQUIRE_VALID_SIGNATURES` | `true` | `false` accepts unsigned inbound activities. Refused with `NODE_ENV=production` |
| `MEDIA_URL_SECRET` | derived from the service role key | HMAC key, at least 32 characters, of attachment URLs sent to other instances. Changing it invalidates URLs already delivered |
| `MEDIA_PUBLIC_BASE_URL` | `https://INSTANCE_DOMAIN/api/federation` | Public prefix of the backend in those URLs, and in the media URLs of X, Instagram and Bluesky link previews |
| `INSTAGRAM_EMBED_MIRRORS` | `kkinstagram.com,uuinstagram.com,eeinstagram.com` | Instagram embed-fixer mirrors asked, in order, when instagram.com gives a link preview no media. Empty: none |
| `EMBED_RELAY_ENABLED` | empty | X and Bluesky video of link previews the backend streams; the rest gets a redirect without Referer. Empty or `0`: nothing, no video bytes pass through the instance. Chromium and Firefox send X a Referer on later byte ranges of a redirected video and are refused, so there an X video shows its still and plays in X's own embedded post after a click. `1`: X video for every engine but WebKit, which then plays in place everywhere. `all`: X and Bluesky video for every engine |
| `EMBED_RELAY_MAX_BYTES` | `209715200` (200 MiB) | Largest video that relay streams |
| `INTERNAL_API_SECRET` | the service role key | Bearer secret of `POST /link-preview/enrich-message`, which the bot gateway calls. Must equal the gateway's |

### Push notifications

| Variable | Default | What it does |
|---|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | unset | Web Push key pair, used for browsers and UnifiedPush. Unset turns both off |
| `VAPID_SUBJECT` | unset | Contact email for push services, with or without `mailto:`. A value that is not an email address stops the backend at start |
| `FCM_SERVICE_ACCOUNT_JSON` | unset | Firebase service account JSON, raw or base64, for the Android app over FCM |
| `FCM_SERVICE_ACCOUNT_FILE` | unset | Path to that JSON file. `FCM_SERVICE_ACCOUNT_JSON` wins when both are set |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | `false` | `true` accepts push endpoints on private, loopback or link-local addresses |
| `OUTGOING_WEBHOOKS_ALLOW_LOOPBACK` | `false` | For tests only: `true` sends [outgoing webhook](/build/outgoing-webhooks) deliveries to `http://localhost` and loopback addresses |

See [Push notifications](/self-host/push).

### Voice and video

| Variable | Default | What it does |
|---|---|---|
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | unset | A key pair from `keys` in `livekit.yaml` |
| `LIVEKIT_URL` | unset | LiveKit as the backend reaches it, e.g. `ws://livekit:7880`. LiveKit counts as configured when key, secret and this URL are all set |
| `LIVEKIT_PUBLIC_URL` | `LIVEKIT_URL` | URL clients connect to, e.g. `wss://live.chat.example.com` |
| `WEBRTC_MODE` | `hybrid` | `sfu` (LiveKit only), `p2p` (peer-to-peer only) or `hybrid` (LiveKit when configured, else peer-to-peer) |
| `ALLOW_FEDERATED_VOICE` | `true` | Calls with users on other instances |
| `VOICE_RECONCILE_INTERVAL_SECONDS` | `60` | Worker: seconds between checks of the voice participant list against LiveKit's rooms; `0` turns the check off |

See [Voice and video](/self-host/voice).

### GIFs and AI emoji

| Variable | Default | What it does |
|---|---|---|
| `KLIPY_API_KEY_ADS` | unset | Klipy API key with ads, served to regular users |
| `KLIPY_API_KEY_NOADS` | unset | Klipy API key without ads, served to supporters whose tier removes ads. One key alone serves everyone; with neither, GIF search is off |
| `KLIPY_BASE_URL` | `https://api.klipy.com` | Klipy API base |
| `AI_EMOJI_WEBHOOK_SECRET` | derived from the service role key | Token in the AI emoji callback URL |

`configure.sh` sets no Klipy key, so GIF search stays off on a new instance
until you add one to `federation.env`.

`federation.env` also holds two keys no service reads: `API_BASE_URL`, and
`__LISTENER_PW`, the listener role's password that `bootstrap.sh` applies.

## Bot gateway

`self-host/bot-gateway.env`, or `bot-gateway/.env` on a manual deployment.
The gateway stops at start without `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`.

| Variable | Default | What it does |
|---|---|---|
| `SUPABASE_URL` | required | Supabase API URL as the gateway reaches it |
| `SUPABASE_SERVICE_ROLE_KEY` | required | Supabase service role key |
| `PUBLIC_URL` | `SUPABASE_URL` | Public Supabase URL, put in place of `SUPABASE_URL` in the storage URLs (avatars, emoji, attachments) handed to bots and bridges |
| `INSTANCE_DOMAIN` | `localhost:3000` | The app's origin (host name or URL; `https` when no scheme). Base of the bridge pairing URLs, `https://INSTANCE_DOMAIN/bot-gateway` and `wss://INSTANCE_DOMAIN/bot-gateway/gateway` |
| `FEDERATION_BACKEND_URL` | `http://localhost:3001` | Federation backend asked for link previews of bot messages. The gateway sends its secret only to an `https` URL or to `localhost` |
| `INTERNAL_API_SECRET` | the service role key | Must equal the federation backend's |
| `NODE_ENV` | `development` | `development` returns error messages in 500 responses |
| `PORT` | `3002` | HTTP and WebSocket port |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express `trust proxy`. A number is a hop count; `true` and `false` are booleans |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window of the bot REST API rate limit, in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per bot, route and channel or server per window |
| `WS_HEARTBEAT_INTERVAL` | `30000` | Heartbeat interval sent to bots, in milliseconds |
| `WS_MAX_CONNECTIONS_PER_BOT` | `5` | Gateway connections one bot may hold; the identify past it closes with `4029` |
| `WS_IDENTIFY_TIMEOUT_MS` | `30000` | Time a new gateway connection has to identify, clamped to 1000-60000 ms; past it the connection closes with `4003` |
| `WS_REVALIDATE_INTERVAL_MS` | `30000` | Interval at which open connections are checked against their bot and token, clamped to 1000-60000 ms |
| `BRIDGE_HOST_SECRET` | unset | Shared secret of the Discord bridge host; under 32 characters, hosting stays off. Must equal the one in `discord-bridge.env` |
| `BRIDGE_CONFIG_POLL_MS` | `5000` | Interval of the bridge configuration poll, clamped to 1000-60000 ms |

## Discord bridge host

`self-host/discord-bridge.env` holds `BRIDGE_HOST_SECRET`, equal to the
gateway's. `docker-compose.yml` sets the host's other variables itself:
`BRIDGE_MODE=host`, `HARMONY_URL=http://bot-gateway:3002` and
`HARMONY_PUBLIC_URL=https://DOMAIN`. The image comes from the
[bridge repository](https://github.com/y4my4my4m/harmony-discord-bridge);
[Discord bridges](/self-host/discord-bridges) covers hosting it.

## LiveKit

LiveKit reads only `livekit.yaml`. These parts must agree with
`federation.env`:

| `livekit.yaml` | Must match |
|---|---|
| `keys` | `LIVEKIT_API_KEY: LIVEKIT_API_SECRET` |
| `webhook.api_key` | `LIVEKIT_API_KEY` |
| `webhook.urls` | The federation server's `/api/livekit/webhook`; `http://federation-server:3001/api/livekit/webhook` in the self-host stack |
| `redis.password` | `REDIS_PASSWORD` |

`harmony doctor` fails when `livekit.yaml` lacks the key pair of
`federation.env`.

## Bull Board

The queue dashboard in `bull-board/` reads:

| Variable | Default | What it does |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis holding the job queues |
| `BULL_BOARD_PASSWORD` | required | HTTP basic auth password; the dashboard exits at start without it |
| `BULL_BOARD_USER` | `admin` | HTTP basic auth user |
| `BULL_BOARD_BASE_PATH` | empty | Path prefix when served under a sub-path |
| `PORT` | `3003` | HTTP port |

See [Monitoring](/self-host/monitoring#queue-dashboard).
