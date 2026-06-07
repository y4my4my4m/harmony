# Harmony — all-in-one self-hosting

Run a complete Harmony instance (app + database + federation + reverse proxy
with automatic HTTPS) with three commands and **no host toolchain** beyond
Docker. Ideal for VPS, homelab, and NAS setups.

```bash
cd self-host
bash configure.sh        # interactive: domain, TLS, secrets, trimmed Supabase
docker compose up -d     # builds the frontend + starts everything
bash bootstrap.sh        # loads the database schema (one time)
```

That's it. Open `https://<your-domain>` and create the first account.

To update later:

```bash
bash update.sh           # git pull + rebuild + migrate + restart
```

## What it runs

| Component | Container(s) | Notes |
|-----------|--------------|-------|
| Reverse proxy + TLS | `harmony-caddy` | Automatic HTTPS (Let's Encrypt) or local CA |
| Frontend (Vue SPA) | `harmony-web` | Built inside Docker — no host Node needed |
| Federation backend | `harmony-federation-server`, `-worker` | ActivityPub, link previews, push |
| Job queue / cache | `harmony-redis` | BullMQ, presence, rate limiting |
| Database & auth | `supabase-db`, `-auth`, `-rest`, `-realtime`, `-storage`, `-imgproxy`, `-kong`, `-meta`, `-studio` | Trimmed Supabase |

Optional profiles:

```bash
docker compose --profile voice up -d   # LiveKit voice/video
docker compose --profile bots  up -d   # bot gateway (Discord bridge, etc.)
```

## Why this is simpler than the old path

- **Trimmed Supabase.** `configure.sh` pulls the official Supabase Docker stack
  and removes the two services Harmony never uses — `edge-functions` (federation
  is a separate Node service) and the `supavisor` pooler (the federation worker
  now uses a least-privilege role directly). Removing the pooler also stops
  Postgres being published on the host.
- **One reverse proxy, auto-HTTPS.** Caddy fetches and renews certificates
  itself. No `certbot`, no hand-written nginx vhosts. For a NAS/LAN box without
  public DNS, choose the "local CA" option and Caddy issues its own cert.
- **No host build tools.** The frontend is built in a container, so a machine
  with only Docker can host Harmony.

## TLS options

- **Public HTTPS (recommended):** point `DOMAIN`, `db.DOMAIN` (and `live.DOMAIN`
  if using voice) at the server with DNS A/AAAA records and open ports 80 + 443.
  Caddy obtains Let's Encrypt certs automatically.
- **LAN / NAS (no public DNS):** pick the local-CA option in `configure.sh`.
  Caddy serves its own certificate; trust Caddy's root CA on your devices (find
  it in the `caddy-data` volume) to remove browser warnings.

## Admin / database access

- Supabase Studio: `https://db.<your-domain>` (login `supabase`, password is
  `DASHBOARD_PASSWORD` in `self-host/supabase/.env`).
- All generated secrets live in `self-host/.env`, `self-host/federation.env`,
  and `self-host/supabase/.env`. These are git-ignored — **back them up**.

## Pinning Supabase

`configure.sh` tracks Supabase `master` by default. For reproducible installs,
pin a specific ref:

```bash
SUPABASE_REF=<tag-or-commit> bash configure.sh --refresh-supabase
```

## Troubleshooting

- **Frontend can't reach the API:** the SPA is built with `VITE_SUPABASE_URL`
  baked in. If you change the domain, re-run `configure.sh` and
  `docker compose build web`.
- **Federation jobs are slow:** confirm `harmony_listener` exists
  (`bootstrap.sh` creates it) — without it the worker falls back to a 60s sweep.
- **Reset everything (DESTROYS DATA):**
  `docker compose down -v && rm -rf supabase .env federation.env bot-gateway.env`.
