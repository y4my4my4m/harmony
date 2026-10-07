# Docker Deployment

Harmony ships three compose setups:

| File | Supabase | Reverse proxy | Harmony images |
|---|---|---|---|
| `self-host/docker-compose.yml` | Included (upstream stack) | Caddy, automatic HTTPS | Prebuilt from ghcr.io |
| `docker-compose.prod.yml` | Elsewhere (Supabase Cloud or a separate stack) | nginx container | Built from the checkout |
| `docker-compose.full.yml` | Upstream Supabase stack on the same host | nginx container | Built from the checkout |

The self-host stack is the supported path; [Self-Hosting](/self-hosting) installs it with one command.

## Self-host stack

`self-host/docker-compose.yml` is the compose project `harmony` on the network `harmony`. It pulls in Supabase through `include:` from `self-host/supabase/` (the upstream `docker/` directory of github.com/supabase/supabase at the commit `configure.sh` pins) with `self-host/supabase-overrides.yml` merged over it, so the upstream files stay unmodified. `include` with a file list and `!reset` need Docker Compose 2.24.4 or later.

[Production Deployment](./) lists the containers, ports and images.

### Configuration files

`self-host/configure.sh` writes, and re-running it keeps every value already present:

| File | Read by |
|---|---|
| `self-host/.env` | Compose interpolation: `DOMAIN`, `DB_DOMAIN`, `LIVEKIT_DOMAIN`, `CADDY_TLS`, `COMPOSE_PROFILES`, `HARMONY_VERSION`, `SUPABASE_ANON_KEY`, `REDIS_PASSWORD`, ... |
| `self-host/federation.env` | `federation-server`, `federation-worker` |
| `self-host/bot-gateway.env` | `bot-gateway` (written with bots enabled) |
| `self-host/discord-bridge.env` | `discord-bridge-host` (written with Discord bridge hosting enabled) |
| `self-host/livekit.yaml` | `livekit` (written with voice enabled, from `webrtc/livekit.yaml.example`) |
| `self-host/supabase/.env` | The Supabase services |

The web container gets its values from `.env` through compose: `SUPABASE_URL=https://${DB_DOMAIN}`, `APP_URL=https://${DOMAIN}`, `DOMAIN`, `INSTANCE_NAME`, `SUPABASE_ANON_KEY`, `ENABLED_OAUTH_PROVIDERS`, `TERMS_URL`, `PRIVACY_URL`. `docker compose up -d` applies a change; no rebuild.

### By hand

The installer runs these steps; in `self-host/`:

```bash
bash configure.sh        # writes the files above, fetches the Supabase stack
docker compose pull      # Harmony images at HARMONY_VERSION
docker compose up -d
bash bootstrap.sh        # applies db_schema/migrations, creates harmony_listener, sets the domain
./harmony admin create   # the admin account; sign-up stays closed until one exists
./harmony registration   # applies REGISTRATION from .env
```

### Options

| Setting | Effect |
|---|---|
| `HARMONY_VERSION` (`.env`) | Image tag: `X.Y.Z`, `X.Y`, `latest`, `edge` or `sha-<short>` |
| `HARMONY_BUILD=1 bash configure.sh` | Adds `docker-compose.build.yml` through `COMPOSE_FILE` in `.env`: the web, federation and bot gateway images build from the checkout. `HARMONY_BUILD=0` removes it |
| `HARMONY_HTTP_PORT`, `HARMONY_HTTPS_PORT` (`.env`) | `[address:]port` Caddy publishes for 80 and 443 |
| `COMPOSE_PROFILES` (`.env`) | `voice`, `bots`, `discord` |
| `DISCORD_BRIDGE_VERSION` | Tag of `ghcr.io/y4my4my4m/harmony-discord-bridge` (default `2`) |

### Networking

Every service shares the `harmony` network, so Harmony and Supabase reach each other by service or container name (`supabase-kong:8000`, `supabase-db:5432`, `redis:6379`, `livekit:7880`). Caddy also sits on a second network, `selfcall`, under the alias of the public domain: the bot gateway reaches `https://DOMAIN` there without hairpin NAT or public DNS. Only Caddy publishes 80 and 443, and LiveKit its media ports.

## Root compose files

`docker-compose.prod.yml` and `docker-compose.full.yml` build the federation backend and bot gateway from the checkout and serve a static frontend build through an nginx container. Both define:

- `federation-server` (`FEDERATION_MODE=server`, publishes 3001) and `federation-worker` (`FEDERATION_MODE=worker`), from `federation-backend/.env`
- `redis` (`redis:7-alpine`, password `REDIS_PASSWORD`)
- `nginx` (publishes 80 and 443), mounting `./dist`, `./docs/.vitepress/dist`, `./dev/nginx-harmony.conf`, `./dev/nginx-docs.conf` and `/etc/letsencrypt`
- profile `bots`: `bot-gateway` (publishes 3002), from `bot-gateway/.env`
- profile `monitoring`: `bull-board` on `127.0.0.1:3003`

`docker-compose.full.yml` adds profile `voice` (`livekit`, mounting `./webrtc/livekit.yaml`; publishes 7880, 7881/tcp+udp, 7882/udp and 3478/tcp+udp), sets `SUPABASE_URL=http://supabase-kong:8000` and `FEDERATION_LISTENER_URL` (`harmony_listener`, password `LISTENER_PASSWORD`), and joins the external `supabase_default` network of the upstream Supabase stack, which must run first.

Both files read `REDIS_PASSWORD` and `BULL_BOARD_PASSWORD` from the root `.env`; Compose refuses either file while one is unset, whatever profiles are active.

### Preparing

```bash
npm install
npm run build-only                                # the SPA, into dist/
cp federation-backend/env.template federation-backend/.env
cp bot-gateway/.env.example bot-gateway/.env      # with the bots profile
cp dev/nginx-harmony.template.conf dev/nginx-harmony.conf
cp dev/nginx-docs.template.conf dev/nginx-docs.conf
```

`npm run build-only` inlines the `VITE_*` values from the root `.env`; a `dist/config.json` overrides them without a rebuild, and the next build removes it ([Environment Variables](../environment)). `npm run docs:generate-all` builds the documentation site the docs server block serves.

The nginx templates target nginx on the host: they proxy to `localhost:3001` and `localhost:3002` and serve `/path/to/harmony/dist` and `/path/to/harmony/docs/.vitepress/dist`. In the `nginx` container, `localhost` is the container itself, so the copies point at `federation-server:3001`, `bot-gateway:3002`, `/usr/share/nginx/html` and `/usr/share/nginx/docs` instead, and replace `YOUR_DOMAIN`. Host nginx in front of the published ports uses the templates unchanged; the compose file's `nginx` service is then left out (`docker compose -f docker-compose.prod.yml up -d federation-server federation-worker redis`).

No template holds the server block of the Supabase API host (`db.DOMAIN`) that `docker-compose.full.yml` needs. The header of `dev/nginx-auth-logout.template.conf` sketches it for host nginx (`proxy_pass http://127.0.0.1:8000`, Kong's port in the upstream stack), and the snippet itself goes inside it. The compose file's `nginx` service sits only on the `harmony` network, where Kong does not resolve.

### Updating

```bash
git pull
npm run build-only
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations apply separately ([Supabase Setup](./supabase)).

## Troubleshooting

### The federation server does not start

- `docker compose logs federation-server` (self-host: `harmony logs federation`). An invalid or missing variable stops the process with its name.
- `SUPABASE_URL` must resolve from inside the container: `http://supabase-kong:8000` on the self-host network.
- `REDIS_URL` must carry the Redis password: `redis://:<REDIS_PASSWORD>@redis:6379`.

### The proxy answers 502

- `docker compose ps`: `federation-server` reports `healthy` once `GET /health` returns 200.
- From the proxy container: `docker exec harmony-caddy wget -qO- http://federation-server:3001/health`.

### Jobs are slow to run

The worker logs `No listener DB connection set` without `FEDERATION_LISTENER_URL`; jobs then wait for the 60 s sweep. The URL uses the `harmony_listener` role, which `bootstrap.sh` creates.

### The root stack cannot reach Supabase

- `docker network ls | grep supabase_default`: the upstream Supabase stack must be up before `docker-compose.full.yml`.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/deployment/docker.md` and run `npm run docs:generate-guide` to update.
