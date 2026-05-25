# How to Self-Host Harmony

A complete guide to deploying your own Harmony instance. Choose the path that fits your needs.

---

## Architecture Overview

Typical production layout:

```
                         Your domain (Nginx TLS)
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   Static SPA (dist/)     federation-server (HTTP :3001)   bot-gateway (:3002, optional)
          │                         │
          │                    Redis (BullMQ, cache, rate limits)
          │                         │
          │                 federation-worker (queue consumer, no public port)
          │                         │
          └─────────────────────────┴─────────────────────────┘
                                    │
                            Supabase (Postgres + Auth + Realtime)
                                    │
                         LiveKit (optional, profile `voice` - UDP mux, shares Redis)
```

- **federation-server** - ActivityPub HTTP (`/.well-known`, inbox/outbox, link previews, health). Same image as the worker; `FEDERATION_MODE=server`.
- **federation-worker** - BullMQ / job processing so heavy delivery work does not block the HTTP server. `FEDERATION_MODE=worker`. Requires **Redis** and `USE_BULLMQ_QUEUE=true` (see `federation-backend/.env`).
- **Redis** - Job queue persistence, caching, presence, rate limiting; LiveKit also uses it when you run voice.
- **federation-backend** (single container) - Optional **simple** profile: one process with `FEDERATION_MODE=unified` for small installs (`docker compose --profile simple`).

---

## Quick Start

For automated setup, run the interactive installer:

```bash
bash scripts/install.sh
```

The installer will guide you through all configuration. The rest of this document covers manual setup.

---

# 🖥️ Full Self-Hosting on VPS

**Cost: ~$5-12/month** for everything

This method gives you full control and enables:
- ✅ Cross-instance federation (activitypub + chat/dm servers)
- ✅ Link previews
- ✅ Bot gateway
- ✅ Self-hosted LiveKit
- ✅ BullMQ (Redis-backed) job queue for reliable delivery
- ✅ Bull Board dashboard for queue monitoring (optional)

## Recommended VPS Providers

| Provider | Specs | Monthly Cost |
|----------|-------|--------------|
| [**Hostinger VPS**](https://hostinger.com?REFERRALCODE=HARMONY) | 1 vCPU, 4GB RAM, 50GB | **$4.99/mo** |

We recommend using [KVM2](https://www.hostinger.com/cart?product=vps%3Avps_kvm_2&period=24&referral_type=cart_link&REFERRALCODE=HARMONY&referral_id=019b0812-725a-7338-81f9-cddc8eb68800) nodes for better performance. But [KVM1](https://www.hostinger.com/cart?product=vps%3Avps_kvm_1&period=24&referral_type=cart_link&REFERRALCODE=HARMONY&referral_id=019b0812-725a-7338-81f9-cddc8eb68800) should work fine as well, depends on your needs.

This also gives you a free .cloud domain for your instance.

## 1. Initial Server Setup

```bash
# SSH into your VPS
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose
apt install docker-compose-plugin -y

# Install Nginx and Certbot
apt install nginx certbot python3-certbot-nginx -y

# Install Node.js (for building frontend)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Create app directory
mkdir -p /opt/harmony
cd /opt/harmony

# Clone Harmony
git clone https://github.com/y4my4my4m/harmony.git .
```

## 2. Set Up Supabase

You can use **Supabase Cloud** or **self-host** Supabase.

### Using Supabase Cloud

1. Create project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run each file from `db_schema/init/` in order (00_extensions.sql through 99_storage_buckets.sql)
3. Note your credentials:
   - Project URL
   - Anon key
   - Service role key
   - Database URL (for LISTEN/NOTIFY bridge): `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres`

> **Note**: Supabase Cloud is not intensively tested yet, so use at your own risk. We recommend self-hosting Supabase if you are using an early version of Harmony.

### Self-Hosting Supabase

```bash
git clone https://github.com/supabase/supabase /opt/supabase
cd /opt/supabase/docker
cp .env.example .env
nano .env  # Set strong passwords!
docker compose up -d
```

## 3. Configure Environment

### Frontend

```bash
cd /opt/harmony
cp .env.example .env
nano .env
```

```env
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
VITE_INSTANCE_DOMAIN=harmony.yourdomain.com
VITE_INSTANCE_NAME=My Harmony
VITE_LIVEKIT_URL=wss://harmony.yourdomain.com:7880
VITE_ENABLE_VOICE=true
VITE_ENABLE_FEDERATION=true
```

### Federation Backend

```bash
cp federation-backend/env.template federation-backend/.env
nano federation-backend/.env
```

```env
NODE_ENV=production
PORT=3001

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
DATABASE_URL=postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres

# Supavisor connection pooler (transaction mode, port 6543) - recommended for production
# Pools many logical connections into a small number of real PG connections.
# Self-hosted: postgresql://postgres:PASSWORD@supabase-pooler:6543/postgres
# Cloud:       postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres
DATABASE_POOL_URL=postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres

INSTANCE_DOMAIN=harmony.yourdomain.com
CORS_ORIGIN=https://harmony.yourdomain.com

# Redis (shared by BullMQ, caching, presence, rate limiting, and LiveKit)
REDIS_URL=redis://:your-redis-password@redis:6379

# BullMQ federation queue (recommended for production; requires Redis)
USE_BULLMQ_QUEUE=true

# Local dev / single container only - omit or set unified in Docker:
# FEDERATION_MODE=server | worker | unified

# LiveKit
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
LIVEKIT_URL=ws://localhost:7880
```

### Bot Gateway (Optional)

```bash
cp bot-gateway/env.template bot-gateway/.env
nano bot-gateway/.env
```

```env
NODE_ENV=production
PORT=3002
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
INSTANCE_DOMAIN=harmony.yourdomain.com
```

## 4. Build Frontend

```bash
cd /opt/harmony
npm ci
npm run build-only
# Built files are in ./dist
```

### Customizing instance assets (optional)

The repository ships a small **default** set of background images and a single
default emoji pack (Twemoji). You can add your own without modifying source:

**Background images** (`public/backgrounds/login/`, `404/`, `offline/`)

Drop additional `.webp` images into the relevant folder before running
`npm run build-only`. The `scripts/build-background-manifest.mjs` step (run
automatically as part of `build-only`) will detect them and add them to
`public/backgrounds/manifest.json`. The frontend then rotates through every
file present in the folder.

```bash
# Example: add 30 personal login images
cp ~/my-wallpapers/*.webp public/backgrounds/login/
npm run build-only
```

These extra images are gitignored, so a `git pull` will not delete them.

**Emoji packs** (`public/assets/emojis/<pack>/`)

Drop a folder of SVG/PNG emojis into `public/assets/emojis/`. The default
Twemoji pack is shipped; additional packs are picked up at build time.

> ⚠️ Licensing reminder: if you install a NonCommercial-only emoji pack such
> as Mutant Standard (CC-BY-NC-SA 4.0), your instance must be operated
> non-commercially (no ads, no paid tiers, no commercial sponsorship), and
> you must display the required attribution somewhere in the UI.

## 5. Set Up LiveKit

```bash
mkdir -p webrtc
nano webrtc/livekit.yaml
```

```yaml
port: 7880
rtc:
  # UDP mux - all WebRTC media on a single port.
  # Scaling limits are CPU/bandwidth, not port count.
  udp_port: 7882
  tcp_port: 7881
  use_external_ip: true
keys:
  your-api-key: your-api-secret  # Generate with: openssl rand -hex 16
turn:
  enabled: true
  domain: harmony.yourdomain.com
  tls_port: 5349
  udp_port: 3478
# Required for multi-node scaling - all LiveKit nodes share state via Redis
redis:
  address: redis:6379
  password: your-redis-password
```

> **Scaling tip**: For 500+ simultaneous voice/video users, run LiveKit on a dedicated VPS with more CPU cores and a wider port range (e.g. 50000-60000). LiveKit supports multi-node clustering - additional instances pointed at the same Redis automatically coordinate room routing. See [LiveKit deployment docs](https://docs.livekit.io/realtime/self-hosting/deployment/).

Generate keys:
```bash
echo "API Key: devkey$(openssl rand -hex 8)"
echo "API Secret: $(openssl rand -hex 32)"
```

## 6. Docker Compose (repository files)

Do **not** hand-roll an old single-service `federation-backend` compose unless you want the minimal **simple** profile. The repo ships:

| File | Use case |
|------|----------|
| [`docker-compose.prod.yml`](../docker-compose.prod.yml) | Supabase **Cloud** (or external Supabase) + static `dist/` + Nginx volumes |
| [`docker-compose.full.yml`](../docker-compose.full.yml) | Self-hosted Supabase on Docker network `supabase_default` + Harmony + Redis + optional LiveKit |

**Default stack (production):** `federation-server` + `federation-worker` + **redis** + **nginx**. Federation env must include `DATABASE_URL`, `REDIS_URL`, and `USE_BULLMQ_QUEUE=true` (see comments at top of `docker-compose.prod.yml`).

**Root `.env` for Compose:** set `REDIS_PASSWORD` (required by the Redis service). In `federation-backend/.env`, set `REDIS_URL=redis://:YOUR_PASSWORD@redis:6379` to match.

**Optional Compose profiles:**

- `--profile simple` - one container `federation-backend` (`FEDERATION_MODE=unified`) instead of server+worker.
- `--profile bots` - `bot-gateway`.
- `--profile voice` - LiveKit (see `webrtc/livekit.yaml`; Redis required).
- `--profile monitoring` - Bull Board on `127.0.0.1:3003` (see [Queue Monitoring](#queue-monitoring-optional) below).

**Examples:**

```bash
# Supabase Cloud + built frontend (from repo root)
cp .env.example .env
# Set REDIS_PASSWORD=... in .env
npm ci && npm run build-only
docker compose -f docker-compose.prod.yml up -d

# With bots
docker compose -f docker-compose.prod.yml --profile bots up -d

# Self-hosted Supabase already running (same host)
docker compose -f docker-compose.full.yml up -d
```

After changes, rebuild images when the federation image changes: `docker compose -f docker-compose.prod.yml build && docker compose -f docker-compose.prod.yml up -d`.

## 7. Configure Nginx

```bash
nano /etc/nginx/sites-available/harmony
```

```nginx
server {
    listen 80;
    server_name harmony.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name harmony.yourdomain.com;

    # SSL (configured by certbot)
    ssl_certificate /etc/letsencrypt/live/harmony.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/harmony.yourdomain.com/privkey.pem;

    # Frontend
    root /opt/harmony/dist;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Federation Backend
    location ~ ^/(\.well-known|users|nodeinfo|inbox|outbox|api|link-preview|health|push|realtime) {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Bot Gateway
    location /bots {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable and get SSL:
```bash
ln -s /etc/nginx/sites-available/harmony /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
certbot --nginx -d harmony.yourdomain.com
systemctl reload nginx
```

## 8. Configure Firewall

```bash
ufw allow 22/tcp       # SSH
ufw allow 80/tcp       # HTTP
ufw allow 443/tcp      # HTTPS
ufw allow 7880/tcp     # LiveKit WebSocket
ufw allow 7881/tcp     # LiveKit RTC
ufw allow 3478/udp     # TURN
ufw allow 5349/tcp     # TURN TLS
ufw allow 7882/udp         # WebRTC media (UDP mux)
ufw enable
```

> Port 7882/udp is the LiveKit UDP mux port. If you changed `rtc.udp_port` in `webrtc/livekit.yaml`, update the firewall rule to match.

## 9. Verify Installation

```bash
# Frontend
curl https://harmony.yourdomain.com

# Federation
curl https://harmony.yourdomain.com/.well-known/nodeinfo

# Health
curl https://harmony.yourdomain.com/health
```

---

# Maintenance

## Updates

```bash
cd /opt/harmony
git pull
npm ci
npm run build-only
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
systemctl reload nginx
```

## Logs

```bash
docker compose -f docker-compose.prod.yml logs -f   # All services (adjust -f file)
docker compose -f docker-compose.prod.yml logs -f federation-server
docker compose -f docker-compose.prod.yml logs -f federation-worker
docker compose -f docker-compose.prod.yml logs -f redis
```

## Queue Monitoring (Optional)

Bull Board provides a web dashboard for monitoring federation job queues (BullMQ). It runs as a standalone Docker container with HTTP basic auth, accessible via a dedicated subdomain.

**Enable it (from repo root, same compose file you use for Harmony):**
```bash
docker compose -f docker-compose.prod.yml --profile monitoring up -d
```

**Set up the subdomain** (e.g. `bq.yourdomain.com`):

1. Point a DNS A record for `bq.yourdomain.com` to your server
2. Copy the generated nginx config (or use `dev/nginx-bullboard.template.conf` as a starting point):
```bash
sudo cp dev/nginx-bullboard.conf /etc/nginx/sites-available/bullboard
sudo ln -s /etc/nginx/sites-available/bullboard /etc/nginx/sites-enabled/
sudo certbot certonly --nginx -d bq.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```
3. Access at `https://bq.yourdomain.com` - log in with the `BULL_BOARD_USER` and `BULL_BOARD_PASSWORD` from your `.env`.

The port is bound to `127.0.0.1:3003` so it's only accessible through nginx, not directly from the internet.

**Alternative - SSH tunnel** (no DNS/SSL needed, for occasional debugging):
```bash
ssh -L 3003:localhost:3003 your-server
# Then open http://localhost:3003 in your browser
```

## Database Migrations

Run new migration files in Supabase SQL Editor (cloud) or via psql (self-hosted).

---

# Troubleshooting

## Federation not working
1. Verify containers: `docker compose -f docker-compose.prod.yml ps` (or `docker-compose.full.yml`)
2. Check **federation-server** logs: `docker compose ... logs federation-server`
3. If using BullMQ, check **federation-worker** and **redis**; confirm `USE_BULLMQ_QUEUE=true` and `REDIS_URL` match `REDIS_PASSWORD` in Compose
4. Ensure `INSTANCE_DOMAIN` matches your public domain exactly
5. Test WebFinger: `curl 'https://yourdomain.com/.well-known/webfinger?resource=acct:user@yourdomain.com'`

## Voice not working
1. Check LiveKit is running: `docker compose logs livekit`
2. Verify firewall allows UDP port 7882 (LiveKit media mux) and 3478 (TURN)
3. Ensure `LIVEKIT_API_KEY` matches in both federation-backend and livekit.yaml
4. For cloud deployment: verify `instance_webrtc_settings` has correct credentials

## SSL issues
1. Test certificate renewal: `certbot renew --dry-run`
2. Check Nginx config: `nginx -t`

--

# Mixing Cloud and Self-Hosting

You can mix cloud and self-hosting, or self-host everything, the choice is yours. For example, you can use cloud for the frontend and self-host for the backend, etc.

---

# Scaling

## Estimated Capacity (single server)

| Server Spec | Concurrent Text Users | Concurrent Voice Users |
|---|---|---|
| 1 vCPU / 4 GB RAM | 300–800 | ~50 |
| 2 vCPU / 8 GB RAM | 1,000–3,000 | ~100–200 |
| 4 vCPU / 16 GB RAM | 3,000–8,000 | ~200–400 |

The main bottleneck for text is Supabase Realtime (WebSocket connections). For voice, it's CPU (LiveKit SFU media routing).

## Connection Pooling (Supavisor)

Set `DATABASE_POOL_URL` in `federation-backend/.env` to use Supavisor's transaction-mode pooler on port 6543. This pools hundreds of logical connections into a small number of real PostgreSQL connections, removing the PG connection limit as a bottleneck.

- **Self-hosted**: `postgresql://postgres:PASSWORD@supabase-pooler:6543/postgres` - Supavisor ships with self-hosted Supabase Docker, no extra setup needed
- **Cloud**: `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres`

`DATABASE_URL` (session mode, port 5432) is kept for `LISTEN/NOTIFY` which requires a persistent connection.

## Scaling Voice (LiveKit)

LiveKit supports **multi-node clustering via Redis**. All LiveKit instances sharing the same Redis automatically coordinate room routing.

**To add a second LiveKit node:**

1. Deploy another VPS with LiveKit installed
2. Copy `webrtc/livekit.yaml` to the new server (same API keys)
3. Point the `redis` section at your existing Redis (or a shared Redis)
4. Open UDP port 7882 (or your `rtc.udp_port` value) on the new server's firewall
5. LiveKit handles routing automatically - no load balancer needed for media traffic

**Capacity**: LiveKit uses UDP mux - all media goes through a single port. One port can serve thousands of participants; the real limits are CPU, bandwidth, and kernel buffers. For multi-vCPU machines, you can widen the mux range (e.g. `udp_port: 7882-7890`) to spread kernel processing across cores.

## Scaling Services to Multiple Servers

When you outgrow a single server (~1,000+ users), split services:

| Service | Dedicated VPS | Why |
|---|---|---|
| **LiveKit** | 4+ vCPU, low-latency network | CPU-bound media routing |
| **PostgreSQL + Supabase** | High RAM, fast SSD | Database workloads |
| **Federation workers** | 2+ vCPU | Burst processing for ActivityPub |
| **Redis** | 2 GB+ RAM | Shared state (low resource usage) |

The `webrtc/docker-compose.yml` already runs LiveKit independently. Federation workers scale horizontally - add more `federation-worker` containers pointing at the same Redis and they share the BullMQ workload.

---

# Next Steps

1. **Register first account** → automatically becomes admin
2. **Configure admin panel** → set instance name, description
3. **Invite users** or enable open registration
4. **Follow users** from other Mastodon/Harmony instances (if federation enabled)
5. **Set up a status page** → deploy OpenStatus on a separate VPS so users can check availability (see [OPENSTATUS_SETUP.md](OPENSTATUS_SETUP.md))

---

*Some links in this guide are affiliate links. Using them helps support Harmony development at no extra cost to you. We are in no-way affiliated with Hostinger, but we appreciate their support.*

