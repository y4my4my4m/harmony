---
title: Docker Compose and reverse proxies
description: Run Harmony's Docker Compose stack without the installer, build its images, put it behind another proxy or Cloudflare, or route it with your own nginx.
---

# Docker Compose and reverse proxies

This page is for operators who run Harmony without the one-command
installer, or in front of or beside infrastructure they already have: the
self-host Compose stack run by hand, Caddy behind another reverse proxy or
Cloudflare, and the root compose files with your own nginx and Supabase. It
lists what any proxy in front of Harmony must route.

## Choose a setup

| Setup | Supabase | Proxy and TLS | Harmony's images | `harmony` command |
|---|---|---|---|---|
| `self-host/docker-compose.yml` through the [installer](/self-host/install) | Upstream Supabase stack, included | Caddy, automatic HTTPS | Published, or built with `HARMONY_BUILD=1` | Every command |
| `self-host/docker-compose.yml` by hand | Same | Same | Same | Every command, once the configuration exists |
| `docker-compose.prod.yml` | One you run elsewhere | nginx container, certificates from `/etc/letsencrypt` | Built from the checkout | None |
| `docker-compose.full.yml` | The upstream Supabase stack on the same host, started first | nginx container | Built from the checkout | None |

The self-host stack is the supported path: the `harmony` command, its
updates, backups and checks all assume its layout. The root compose files
are for setups that bring their own Supabase and nginx; you then apply
migrations, back up and update by hand.

## Run the self-host stack by hand

These are the installer's steps. In `self-host/` of a checkout:

```bash
bash configure.sh                         # writes the configuration, fetches the Supabase stack
docker compose pull                       # Harmony's images at HARMONY_VERSION
docker compose up -d
bash bootstrap.sh                         # migrations, harmony_listener, instance domain
docker compose restart federation-worker  # it started before harmony_listener existed
./harmony admin create                    # sign-up stays closed until an admin exists
./harmony registration                    # applies REGISTRATION from .env
```

The stack needs Docker Compose 2.24.4 or later: it uses `include:` with a
file list and `!reset`. [The harmony command](/self-host/cli#configure-sh)
lists the options of `configure.sh` and `bootstrap.sh`;
[Configuration](/self-host/configuration) describes the files they write.

### How the stack is assembled

- `docker-compose.yml` defines Caddy, the web app, the federation server
  and worker, Redis, the media cache, and the optional LiveKit (`voice`), bot
  gateway (`bots`) and Discord bridge host (`discord`) services.
- The media cache (`media-cache`, nginx with `media-cache.conf`) sits between
  Caddy and Kong for public storage reads: `GET` and `HEAD` of
  `/storage/v1/object/public/*` and `/storage/v1/render/image/public/*` on the
  `db.` host, the private `message_media` bucket aside. A post boosted to
  thousands of servers has each of them download the author's avatar and the
  post's media within minutes; the cache fetches each file from storage once and
  keeps it 10 minutes, so a file deleted in moderation stops being served within
  that time. `harmony doctor` reports whether reads go through it.
- Its `include:` pulls in `supabase/docker-compose.yml`, the upstream
  Supabase `docker/` directory at the pinned commit, with
  `supabase-overrides.yml` merged over it and `supabase/.env` for
  interpolation. The upstream files stay unmodified, so a refresh replaces
  them wholesale.
- `.env` in `self-host/` feeds Compose interpolation. `COMPOSE_PROFILES`
  there selects the optional services; `COMPOSE_FILE` adds the build
  overlay.

`supabase-overrides.yml` changes the upstream stack:

| Service | Change |
|---|---|
| `functions`, `supavisor` | Moved to a profile nothing enables: defined, never started. The federation backend replaces Edge Functions; Supavisor would publish Postgres on the host |
| `kong`, `analytics` | No host ports; Caddy reaches Kong as `supabase-kong:8000` |
| `rest` | `PGRST_APP_SETTINGS_JWT_SECRET` removed, so SQL run through the API cannot read the JWT secret |
| `imgproxy` | `IMGPROXY_MAX_SRC_RESOLUTION: 50` and `IMGPROXY_MAX_ANIMATION_FRAMES: 120`, for animated emoji and large images |
| `auth` | Image `GOTRUE_IMAGE` (at least `supabase/gotrue:v2.196.0`); Google, GitHub and Twitch sign-in and your own providers' linking (`PROVIDER_LINKING_DOMAINS`) from `supabase/.env`; see [OAuth sign-in](/self-host/oauth) |

### Networks and volumes

Every service shares the network `harmony`, so Harmony and Supabase reach
each other by service or container name (`supabase-kong:8000`,
`supabase-db:5432`, `redis:6379`, `livekit:7880`). Caddy also sits on a
second network, `selfcall`, under the alias of the public domain: the bot
gateway joins it to reach `https://DOMAIN` without hairpin NAT or public
DNS. The alias is absent from `harmony`, so the federation backend's SSRF
guard keeps seeing the public address for its own domain.

| Data | Where |
|---|---|
| Database | `supabase/volumes/db/data` (bind mount) |
| Uploads | `supabase/volumes/storage` (bind mount) |
| Vault encryption key | volume `db-config` |
| Caddy's certificates and state | volumes `caddy-data`, `caddy-config` |
| Redis | volume `redis-data` |
| Discord bridge host | volume `discord-bridge-data` |

### Build Harmony's images yourself

For forks and development builds, in `self-host/`:

```bash
HARMONY_BUILD=1 bash configure.sh --non-interactive   # adds docker-compose.build.yml through COMPOSE_FILE
docker compose up -d --build
HARMONY_BUILD=0 bash configure.sh --non-interactive   # back to the published images
```

The overlay builds `harmony-web:local` from `self-host/web.Dockerfile`
(repository root as context), and `harmony-federation:local` and
`harmony-bot-gateway:local` from `federation-backend/` and `bot-gateway/`.
`harmony update` then builds instead of pulling.

The web image carries no instance values. Its entrypoint,
`self-host/web-entrypoint.d/40-harmony-config.sh`, writes `/config.json`
from the container's environment (`SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`DOMAIN`, `INSTANCE_NAME`, and the optional keys
[Configuration](/self-host/configuration) lists), and the app reads it
before it starts. A change needs `docker compose up -d`, not a rebuild.
`VITE_*` build arguments are optional; a value passed at build time is
inlined and serves as the fallback for a key `/config.json` leaves out.

## Put Caddy behind another reverse proxy {#behind-another-reverse-proxy}

When another web server on the same host owns ports 80 and 443, publish
Caddy on other ports and have that server forward the three names to it:

```bash
HARMONY_HTTP_PORT=127.0.0.1:8080 HARMONY_HTTPS_PORT=127.0.0.1:8443 harmony install
```

On an existing instance, set the same two variables for
`bash configure.sh --non-interactive`, then `docker compose up -d`. The
front proxy keeps the `Host` header and passes WebSocket upgrades through.
Then choose one of:

- **Caddy keeps the public certificates.** Caddy obtains them through the
  challenges that reach it: forward port 80 to Caddy's HTTP port, or pass
  TLS through unmodified on 443 to Caddy's HTTPS port.
- **The front proxy holds the public certificates.** It terminates TLS and
  talks to Caddy over HTTPS, with Caddy on its own certificate authority
  (`HARMONY_TLS=internal`).

Caddy sets `X-Real-IP` to the address of the peer that connected to it, and
the federation backend keys its rate limits on that header. Behind another
proxy every request carries that proxy's address, so the per-client limits
count all clients together.

`harmony doctor` reaches Caddy through `HARMONY_HTTPS_PORT` for its local
checks.

## Use Cloudflare in front {#cloudflare}

- Keep the records **DNS only** (grey cloud) while Caddy obtains its
  certificates; the installer and `harmony doctor` check the records
  against the server's own address.
- Afterwards Cloudflare's proxy can front the domain and `db.` with SSL/TLS
  mode **Full (strict)**. Leave `live.` DNS only.
- Behind the proxy, `X-Real-IP` carries Cloudflare's addresses, so the
  federation backend's rate limits see those instead of your users'.

Storage serves public objects at
`/storage/v1/object/public/BUCKET/PATH` and resized images at
`/storage/v1/render/image/public/BUCKET/PATH?width=&height=&resize=&quality=`.
A render is WebP when the request's `Accept` names `image/webp` and the
source format otherwise, under one ETag and without `Vary`, so a cache would
serve whichever variant it stored first. Caddy pins `Accept` to
`image/webp,*/*;q=0.8` on public renders; every Harmony client decodes WebP.

Give the main domain no Cache Rule: `/invite/CODE` answers link-preview
crawlers and browsers differently under one URL. Cache Rules for `db.`, in
this order (where two rules set the same option, the last match wins):

1. Bypass for the API host: `(http.host eq "db.example.com")`, Cache
   eligibility **Bypass cache**. Auth, REST, realtime and signed or
   authenticated storage URLs stay uncached.
2. Public objects:
   `(http.host eq "db.example.com" and starts_with(http.request.uri.path, "/storage/v1/object/public/") and not starts_with(http.request.uri.path, "/storage/v1/object/public/message_media/"))`
3. Public renders:
   `(http.host eq "db.example.com" and starts_with(http.request.uri.path, "/storage/v1/render/image/public/") and not starts_with(http.request.uri.path, "/storage/v1/render/image/public/message_media/"))`

For rules 2 and 3: Cache eligibility **Eligible for cache**; Edge TTL **Use
cache-control header if present, bypass cache if not**; Status code TTL
**greater than or equal 400: no-store**; Browser TTL **Respect origin**;
the default cache key. Deleting an object does not purge the edge: purge its
URL when an image has to disappear before its max-age ends.

## Route Harmony with your own proxy

A proxy that routes to Harmony's services directly, instead of to Caddy,
reproduces `self-host/Caddyfile`. The Caddyfile mirrors
`dev/nginx-harmony.template.conf` location by location; both match paths
case-sensitively.

### The main domain

| Path | Goes to | Notes |
|---|---|---|
| `/.well-known/webfinger`, `/.well-known/host-meta`, `/.well-known/host-meta.json`, `/.well-known/nodeinfo` | federation server, path unchanged | Adds `Access-Control-Allow-Origin: *` |
| `/nodeinfo/2.0`, `/nodeinfo/2.1` | federation server | Adds `Access-Control-Allow-Origin: *` |
| `/inbox`, `/oembed` | federation server | The shared inbox |
| `/users/NAME/inbox`, `/outbox`, `/followers`, `/following`, `/featured` | federation server | |
| `/users/NAME/quote_authorizations/ID` | federation server | FEP-044f quote approvals |
| `/users/NAME/activities/UUID`, `/activities/UUID` | federation server | A post's `Create`, a boost's `Announce` |
| `/users/NAME` with `Accept` naming `application/activity+json`, `application/ld+json` or `application/json` | federation server | Any other request: 302 to `/@NAME` |
| `/servers/...` | federation server | Servers as ActivityPub Groups |
| `/posts/ID`, `/posts/ID/likes`, `/posts/ID/shares`, `/posts/ID/replies` | federation server | `/posts/ID` answers ActivityPub JSON or the post's public page |
| `/messages/UUID` | federation server | Chat and direct message `Note`s; 406 without an ActivityPub `Accept` |
| `/threads/UUID`, `/threads/UUID/members`, `/channels/UUID/threads` | federation server | Chat threads as `ChatThread`s; 406 without an ActivityPub `Accept` |
| `/invite/CODE` from a link-preview crawler | federation server | Decided by `User-Agent`; everyone else gets the web app |
| `/social/post/UUID` with an ActivityPub `Accept`, or from a link-preview crawler | federation server, rewritten to `/posts/UUID` | Everyone else gets the web app |
| `/social/profile/NAME` with an ActivityPub `Accept`, NAME of `[A-Za-z0-9_]` | federation server, rewritten to `/users/NAME` | Everyone else gets the web app |
| `/@NAME`, `/@NAME/ID` with the cookie `harmony_app=1` and no ActivityPub `Accept` | web app | The app sets the cookie while signed in |
| `/@NAME`, `/@NAME/ID`, any other request | federation server, path unchanged | An account's and a post's `url`: the actor and the `Note` for ActivityPub, the public page for everyone else |
| `/health...`, `/link-preview...` | federation server | Prefixes without a trailing slash |
| `/api/livekit/...` | federation server, path unchanged | |
| `/api/federation/...` | federation server, prefix stripped | `/api/federation/push/vapid-key` reaches `/push/vapid-key` |
| `/webhooks/channels/...` | federation server | Bodies up to 1 MB |
| `/webhooks/...` | federation server | Bodies up to 64 KB |
| `/bot-gateway/...` | bot gateway, prefix stripped | `/bot-gateway/gateway` is a WebSocket |
| everything else | web app | Its nginx serves `index.html` for unknown paths |

The crawler list is the `User-Agent` pattern in the Caddyfile and in the
nginx template's `$invite_unfurl` map (Discordbot, Slackbot, Twitterbot,
facebookexternalhit, Mastodon and others). The federation server listens on
3001 and the bot gateway on 3002. Other request bodies are capped at 50 MB.

On every location that reaches the federation server, set `X-Real-IP` to the
client's address: the backend keys its rate limits on it, and trusts it from
the peers `TRUST_PROXY` names (default `loopback, uniquelocal`). Keep the
`Host` header and pass `Signature`, `Date`, `Digest` and `Content-Type`
through unchanged, since the inboxes verify HTTP Signatures over the
request, and `Accept`, which selects ActivityPub JSON or HTML.
The federation backend mounts most routes at the root, which is why
`/api/federation/` loses its prefix; in nginx the trailing slash on both
sides does it:

```nginx
location /api/federation/ {
    proxy_pass http://localhost:3001/;
}
```

### The db. host

- Proxy everything to Kong (`supabase-kong:8000` on the Compose network,
  port 8000 on the host in the upstream stack), with WebSocket upgrades:
  Supabase Realtime runs over a WebSocket at `/realtime/v1/websocket`.
- Refuse `/auth/v1/logout` unless the query is exactly `scope=local`.
  GoTrue's logout accepts a token without the second factor, and its default
  global scope ends every session of the account, so a password alone could
  sign every device out. `dev/nginx-auth-logout.template.conf` is the nginx
  snippet; its header shows where it goes and how to test it.
- Pin `Accept` on public renders, as under [Cloudflare](#cloudflare). In
  nginx, a `location ^~ /storage/v1/render/image/public/` that repeats the
  directives of `location /` and adds:

  ```nginx
  proxy_set_header Accept "image/webp,*/*;q=0.8";
  ```

- Cache public storage reads unless a CDN already does: a boosted post has
  every receiving server download the author's avatar and the post's media at
  once, and each uncached avatar is resized again. `self-host/media-cache.conf`
  is the nginx configuration the self-host stack runs for this (`proxy_cache`
  with a lock, 10 minutes, `no-store` and `private` answers never kept); its
  `proxy_cache*` directives and the `map` go into the public object and render
  locations, `message_media` excluded.
- Keep Kong (8000) and GoTrue (9999) unreachable from outside: either port
  bypasses the logout rule. Postgres never faces the internet.

### The live. host

Proxy everything to LiveKit's signalling port, 7880, with WebSocket upgrades
and a long read timeout (the template uses 86400 s). Media does not pass
through the proxy: 7881/tcp and 7882/udp reach LiveKit directly.

### nginx templates

| Template | Serves |
|---|---|
| `dev/nginx-harmony.template.conf` | The main domain on host nginx: HTTP to HTTPS redirect, certbot certificates, the federation and bot gateway routes, and the web app from `dist/`. Its `$invite_unfurl` and `$ap_accept` maps belong to the `http` context |
| `dev/nginx-auth-logout.template.conf` | The logout rule, included in the `db.` server block |
| `dev/nginx-livekit.template.conf` | The `live.` host |
| `dev/nginx-bullboard.template.conf` | The Bull Board queue dashboard on its own subdomain, proxied to `127.0.0.1:3003` |

Replace `YOUR_DOMAIN` and `/path/to/harmony` in each copy. The templates
proxy to `localhost:3001` and `localhost:3002`, the ports the root compose
files publish. No template holds the `db.` server block itself.

## Root compose files

`docker-compose.prod.yml` and `docker-compose.full.yml` build the federation
backend and the bot gateway from the checkout and serve a static build of
the web app through an nginx container. Both define:

| Service | Container | Notes |
|---|---|---|
| `federation-server` | `harmony-federation-server` | `FEDERATION_MODE=server`, publishes 3001; environment from `federation-backend/.env` |
| `federation-worker` | `harmony-federation-worker` | `FEDERATION_MODE=worker` |
| `redis` | `harmony-redis` | `redis:7-alpine`, password `REDIS_PASSWORD` |
| `nginx` | `harmony-nginx` | Publishes 80 and 443; mounts `./dist`, `./docs/.vitepress/dist`, `./dev/nginx-harmony.conf`, `./dev/nginx-docs.conf` and `/etc/letsencrypt` |
| `bot-gateway` | `harmony-bot-gateway` | Profile `bots`; publishes 3002; environment from `bot-gateway/.env` |
| `bull-board` | `harmony-bull-board` | Profile `monitoring`; on `127.0.0.1:3003`; needs `BULL_BOARD_PASSWORD` |

`docker-compose.full.yml` also sets `SUPABASE_URL=http://supabase-kong:8000`
and a `FEDERATION_LISTENER_URL` for `harmony_listener` with the password
`LISTENER_PASSWORD`, joins the external `supabase_default` network of the
upstream Supabase stack, and adds the `voice` profile (`livekit`, mounting
`./webrtc/livekit.yaml`; publishes 7880, 7881/tcp and udp, 7882/udp, and
3478/tcp and udp).

Both read `REDIS_PASSWORD` and the `BULL_BOARD_*` values from the root
`.env`; Compose refuses either file while `REDIS_PASSWORD` is unset. In
`docker-compose.prod.yml`, `bull-board` defaults to
`REDIS_URL=redis://localhost:6379`, which inside its container is not Redis:
set `REDIS_URL` in the root `.env` (`redis://:PASSWORD@redis:6379`) to use
it.

The published ports (3001, 3002 and LiveKit's) listen on every interface,
and Docker-published ports bypass `ufw` and `firewalld`.

### Prepare a root compose setup

```bash
npm install
npm run build-only                                # the web app, into dist/
cp federation-backend/env.template federation-backend/.env
cp bot-gateway/env.template bot-gateway/.env      # with the bots profile
cp dev/nginx-harmony.template.conf dev/nginx-harmony.conf
cp dev/nginx-docs.template.conf dev/nginx-docs.conf
```

`npm run build-only` inlines the `VITE_*` values of the root `.env`; a
`dist/config.json` with the [runtime keys](/self-host/configuration)
overrides them without a rebuild.

The nginx templates target nginx on the host. Inside the `nginx` container,
`localhost` is the container itself, so the copies point at
`federation-server:3001`, `bot-gateway:3002`, `/usr/share/nginx/html` and
`/usr/share/nginx/docs` instead, and replace the placeholders. Then:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

With nginx on the host in front of the published ports, use the templates
unchanged and leave out the compose file's `nginx` service:

```bash
docker compose -f docker-compose.prod.yml up -d federation-server federation-worker redis
```

With `docker-compose.full.yml`, the `nginx` container sits only on the
`harmony` network, where Kong does not resolve: the `db.` host needs nginx on
the host, proxying to Kong's published port.

### Load the database

CI installs the schema on `supabase/postgres:15.8.1.060`, the image the
self-host stack pins; other Postgres builds are untested.

For Postgres in a container, `self-host/bootstrap.sh` applies
`db_schema/migrations/` and records them in
`supabase_migrations.schema_migrations`. It reads the domain and instance
name from `self-host/.env` and the listener password from
`self-host/federation.env`:

```bash
printf 'DOMAIN=chat.example.com\nINSTANCE_NAME=Example Chat\n' > self-host/.env
printf '__LISTENER_PW=%s\n' "$(openssl rand -hex 24)" > self-host/federation.env
SUPABASE_DB_CONTAINER=supabase-db bash self-host/bootstrap.sh
```

Start the whole Supabase stack first. Realtime and storage-api create part
of their schemas after Postgres starts, and migrations depend on them:
`bootstrap.sh` waits up to 300 s for Realtime to report healthy (when it is
in the database container's Compose project) and for those objects, then
stops with `still missing after 300 s: …`.

For Postgres outside a container, the Supabase CLI applies the same files
through the `supabase/migrations` link and keeps the same ledger:
`npx supabase db push --db-url "$DATABASE_URL"`. A database whose migrations
were applied by hand has no ledger; `scripts/baseline-migrations.sh` records
what it already has first. [Database migrations](/contribute/migrations)
covers both.

### Listener role

The federation worker holds a `LISTEN federation_jobs` connection to pick up
jobs as the database queues them. It needs a direct, session-mode connection
(port 5432, not a transaction pooler) as a role with nothing beyond
`CONNECT`. `bootstrap.sh` runs the equivalent of:

```sql
CREATE ROLE harmony_listener WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
ALTER ROLE harmony_listener WITH PASSWORD 'PASSWORD';
GRANT CONNECT ON DATABASE postgres TO harmony_listener;
```

The backend then gets
`FEDERATION_LISTENER_URL=postgresql://harmony_listener:PASSWORD@DB_HOST:5432/postgres`
(in `docker-compose.full.yml`, the password is `LISTENER_PASSWORD` in the
root `.env`). Without it the worker logs `No listener DB connection set` and
picks jobs up through a 60-second sweep and a 30-second delivery retry.

### Instance domain

`instance_config.domain` holds the public domain; handles and ActivityPub
ids read it. `bootstrap.sh` writes it only while it is still the seed value
`localhost`. Otherwise, as a database superuser:

```sql
UPDATE public.instance_config
   SET config_value = to_jsonb('chat.example.com'::text)
 WHERE config_key = 'domain';
```

### The first admin account

The first local profile created on the instance becomes its admin
(`promote_first_user_to_admin`). Keep sign-up disabled (`DISABLE_SIGNUP=true`
in Supabase's `.env`), add your account in Supabase Studio with its address
confirmed, sign in to Harmony and choose a username. Then open sign-up if you
want it, and set `instance_config.open_registration` to match.

### Update a root compose setup

```bash
git pull
npm run build-only
docker compose -f docker-compose.prod.yml up -d --build
```

Apply new migrations with `bootstrap.sh --migrations-only` or
`supabase db push`, and back up the database first: no command does it for
this setup.
