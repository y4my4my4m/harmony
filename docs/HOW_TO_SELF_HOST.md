# How to Self-Host Harmony

A complete guide to deploying your own Harmony instance. Choose the path that fits your needs.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Domain                             │
│                    harmony.yourdomain.com                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │
    ┌───────────────────────┼───────────────────────┐
    │                       │                       │
    ▼                       ▼                       ▼
┌───────────────┐   ┌───────────────┐       ┌───────────────┐
│   Frontend    │   │   Database    │       │  Voice/Video  │
│   (Vue/Vite)  │   │  (Supabase)   │       │   (LiveKit)   │
└───────────────┘   └───────────────┘       └───────────────┘
                            │
                            │  ← Required for federation
                            ▼
                    ┌───────────────┐
                    │   Federation  │
                    │    Backend    │
                    │     Server    │
                    └───────────────┘
```

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

> 💡 **Tip:** Use code `VPSRATES10` at Hostinger for 10% off

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

You can use **Supabase Cloud** (easier) or **self-host** (full control).

### Using Supabase Cloud (Recommended)

1. Create project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run each file from `db_schema/init/` in order (00_extensions.sql through 99_storage_buckets.sql)
3. Note your credentials:
   - Project URL
   - Anon key
   - Service role key
   - Database URL (for LISTEN/NOTIFY bridge): `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres`

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

# Supavisor connection pooler (transaction mode, port 6543) — recommended for production
# Pools many logical connections into a small number of real PG connections.
# Self-hosted: postgresql://postgres:PASSWORD@supabase-pooler:6543/postgres
# Cloud:       postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres
DATABASE_POOL_URL=postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres

INSTANCE_DOMAIN=harmony.yourdomain.com
CORS_ORIGIN=https://harmony.yourdomain.com

# Redis (shared by BullMQ, caching, presence, rate limiting, and LiveKit)
REDIS_URL=redis://:your-redis-password@redis:6379

# Enable BullMQ federation queue (recommended)
USE_PGBOSS_QUEUE=true

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

## 5. Set Up LiveKit

```bash
mkdir -p webrtc
nano webrtc/livekit.yaml
```

```yaml
port: 7880
rtc:
  # Each voice/video participant uses ~1-2 UDP ports.
  # 501 ports ≈ 200 concurrent users. Expand for more capacity.
  port_range_start: 50000
  port_range_end: 50500
  use_external_ip: true
keys:
  your-api-key: your-api-secret  # Generate with: openssl rand -hex 16
turn:
  enabled: true
  domain: harmony.yourdomain.com
  tls_port: 5349
  udp_port: 3478
# Required for multi-node scaling — all LiveKit nodes share state via Redis
redis:
  address: redis:6379
  password: your-redis-password
```

> **Scaling tip**: For 500+ simultaneous voice/video users, run LiveKit on a dedicated VPS with more CPU cores and a wider port range (e.g. 50000-60000). LiveKit supports multi-node clustering — additional instances pointed at the same Redis automatically coordinate room routing. See [LiveKit deployment docs](https://docs.livekit.io/realtime/self-hosting/deployment/).

Generate keys:
```bash
echo "API Key: devkey$(openssl rand -hex 8)"
echo "API Secret: $(openssl rand -hex 32)"
```

## 6. Docker Compose

```bash
nano docker-compose.yml
```

```yaml
version: "3.8"

services:
  federation-backend:
    build: ./federation-backend
    container_name: harmony-federation
    restart: unless-stopped
    ports:
      - "3001:3001"
    env_file:
      - ./federation-backend/.env

  bot-gateway:
    build: ./bot-gateway
    container_name: harmony-bots
    restart: unless-stopped
    ports:
      - "3002:3002"
    env_file:
      - ./bot-gateway/.env

  livekit:
    image: livekit/livekit-server:latest
    container_name: harmony-livekit
    restart: unless-stopped
    ports:
      - "7880:7880"
      - "7881:7881"
      - "3478:3478/udp"
      - "5349:5349"
      - "50000-50100:50000-50100/udp"
    volumes:
      - ./webrtc/livekit.yaml:/livekit.yaml:ro
    command: --config /livekit.yaml
```

Start services:
```bash
docker compose up -d
docker compose logs -f  # Verify everything starts
```

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
ufw allow 50000:50500/udp  # Media (increase to match your livekit.yaml port_range_end)
ufw enable
```

> Match `50000:50500` to the `port_range_end` in your `webrtc/livekit.yaml`. If you expanded the range during install, update the firewall rule to match.

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
docker compose build
docker compose up -d
systemctl reload nginx
```

## Logs

```bash
docker compose logs -f                    # All services
docker compose logs -f federation-backend # Specific service
```

## Queue Monitoring (Optional)

Bull Board provides a web dashboard for monitoring federation job queues (BullMQ). It runs as a standalone Docker container with HTTP basic auth, accessible via a dedicated subdomain.

**Enable it:**
```bash
docker compose --profile monitoring up -d
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
3. Access at `https://bq.yourdomain.com` — log in with the `BULL_BOARD_USER` and `BULL_BOARD_PASSWORD` from your `.env`.

The port is bound to `127.0.0.1:3003` so it's only accessible through nginx, not directly from the internet.

**Alternative — SSH tunnel** (no DNS/SSL needed, for occasional debugging):
```bash
ssh -L 3003:localhost:3003 your-server
# Then open http://localhost:3003 in your browser
```

## Database Migrations

Run new migration files in Supabase SQL Editor (cloud) or via psql (self-hosted).

---

# Troubleshooting

## Federation not working
1. Verify federation-backend is running: `docker compose ps`
2. Check logs: `docker compose logs federation-backend`
3. Ensure `INSTANCE_DOMAIN` matches your actual domain exactly
4. Test WebFinger: `curl https://yourdomain.com/.well-known/webfinger?resource=acct:user@yourdomain.com`

## Voice not working
1. Check LiveKit is running: `docker compose logs livekit`
2. Verify firewall allows UDP ports matching your `livekit.yaml` range (default: `50000-50500`)
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

- **Self-hosted**: `postgresql://postgres:PASSWORD@supabase-pooler:6543/postgres` — Supavisor ships with self-hosted Supabase Docker, no extra setup needed
- **Cloud**: `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:6543/postgres`

`DATABASE_URL` (session mode, port 5432) is kept for `LISTEN/NOTIFY` which requires a persistent connection.

## Scaling Voice (LiveKit)

LiveKit supports **multi-node clustering via Redis**. All LiveKit instances sharing the same Redis automatically coordinate room routing.

**To add a second LiveKit node:**

1. Deploy another VPS with LiveKit installed
2. Copy `webrtc/livekit.yaml` to the new server (same API keys)
3. Point the `redis` section at your existing Redis (or a shared Redis)
4. Open the same UDP port range on the new server's firewall
5. LiveKit handles routing automatically — no load balancer needed for media traffic

**Port range sizing**: each participant uses ~1–2 UDP ports. Default is 501 ports (50000–50500, supports ~200 concurrent voice users). Expand `port_range_end` in `webrtc/livekit.yaml` and the matching docker-compose/firewall rules for more capacity.

## Scaling Services to Multiple Servers

When you outgrow a single server (~1,000+ users), split services:

| Service | Dedicated VPS | Why |
|---|---|---|
| **LiveKit** | 4+ vCPU, low-latency network | CPU-bound media routing |
| **PostgreSQL + Supabase** | High RAM, fast SSD | Database workloads |
| **Federation workers** | 2+ vCPU | Burst processing for ActivityPub |
| **Redis** | 2 GB+ RAM | Shared state (low resource usage) |

The `webrtc/docker-compose.yml` already runs LiveKit independently. Federation workers scale horizontally — add more `federation-worker` containers pointing at the same Redis and they share the BullMQ workload.

---

# Next Steps

1. **Register first account** → automatically becomes admin
2. **Configure admin panel** → set instance name, description
3. **Invite users** or enable open registration
4. **Follow users** from other Mastodon/Harmony instances (if federation enabled)
5. **Set up a status page** → deploy OpenStatus on a separate VPS so users can check availability (see [OPENSTATUS_SETUP.md](OPENSTATUS_SETUP.md))

---

*Some links in this guide are affiliate links. Using them helps support Harmony development at no extra cost to you. We are in no-way affiliated with Hostinger, but we appreciate their support.*

