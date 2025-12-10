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

## Choose Your Path

| Feature | 🌐 Cloud (Free Tier) | 🖥️ Full Self-Host (VPS) |
|---------|---------------------|-------------------------|
| **Cost** | **$0/month** | **~$5-12/month** |
| Chat & Servers | ✅ | ✅ |
| Timeline/Social | ✅ Local only | ✅ Full federation |
| Voice/Video | ✅ | ✅ |
| **Cross-instance federation** | ❌ | ✅ |
| **Link previews** | ❌ | ✅ |
| **Bot gateway** | ❌ | ✅ |
| Control | Limited | Full |
| Difficulty | Easy | Moderate |

### Why does federation require a VPS?

The federation-backend is a **persistent Node.js service** that:
- Processes ActivityPub activities in a queue (realtime with pg-boss queue for reliability)
- Handles incoming federation requests
- Generates link previews
- Manages bot connections via WebSocket

**Serverless platforms like Vercel can't run persistent services.** They're designed for short-lived request/response cycles, not long-running processes.

---

# 🌐 Path A: Deploy with Free Tier Cloud Services

**Cost: $0/month** (with optional LiveKit Cloud for voice)

This method uses Vercel + Supabase. Perfect for:
- Personal instances
- Testing and development
- Local-only communities (no federation needed)

```
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│    Vercel     │       │    Supabase   │       │ LiveKit Cloud │
│   (Frontend)  │◄─────►│   (Database)  │◄─────►│(Voice/Video)  │
│     FREE      │       │     FREE      │       │     FREE      │
└───────────────┘       └───────────────┘       └───────────────┘
```

## A1. Set Up Supabase

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for database initialization (~2 minutes)
3. Go to **SQL Editor** and run each file from `db_schema/init/` in order:

   ```
   00_extensions.sql
   01_types.sql
   02_tables_core.sql → 06_tables_misc.sql
   30_rls_policies.sql
   50_realtime.sql
   90_federation_functions.sql
   95_livekit_tokens.sql
   98_seed_data.sql
   99_storage_buckets.sql
   ```

4. Enable required extensions in **Database > Extensions**:
   - `pgcrypto` ✅
   - `pgjwt` ✅ (for voice tokens)
   - `uuid-ossp` ✅

5. Update your domain:
   ```sql
   UPDATE instance_config 
   SET config_value = '"harmony.yourdomain.com"' 
   WHERE config_key = 'domain';
   ```

6. Note your credentials from **Settings > API**:
   - Project URL: `https://xxxxx.supabase.co`
   - Anon key: `eyJ...`

## A2. Deploy to Vercel

Vercel hosts **only the frontend**. The `vercel.json` is pre-configured for this.

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fy4my4my4m%2Fharmony&integration-ids=oac_VqOgBHqhEoFTPzGkPd7L0iH6)

### Manual Deploy

1. Fork this repository to your GitHub
2. Go to [vercel.com](https://vercel.com) and import your fork
3. Vercel auto-detects Vite framework
4. Configure environment variables:

| Variable | Value |
|----------|-------|
| `VITE_SUPABASE_URL` | `https://xxxxx.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your anon key |
| `VITE_INSTANCE_DOMAIN` | `harmony.yourdomain.com` |
| `VITE_INSTANCE_NAME` | `My Harmony` |
| `VITE_ENABLE_VOICE` | `true` |
| `VITE_ENABLE_FEDERATION` | `false` |

4. Deploy!

## A3. Add Voice/Video (Optional)

Voice works without a VPS! Tokens are generated directly in Supabase using `pgjwt`.

1. Sign up at [cloud.livekit.io](https://cloud.livekit.io) (free: 500 participant-minutes/month)
2. Create a project and get your credentials:
   - API Key: `APIxxxx`
   - API Secret: `xxxx...`
   - WebSocket URL: `wss://your-project.livekit.cloud`

3. Add to Vercel environment variables:

| Variable | Value |
|----------|-------|
| `VITE_LIVEKIT_URL` | `wss://your-project.livekit.cloud` |

4. Configure LiveKit in Supabase SQL Editor:

```sql
UPDATE instance_webrtc_settings SET
  livekit_url = 'wss://your-project.livekit.cloud',
  livekit_api_key = 'APIxxxx',
  livekit_api_secret = 'your-secret-here',
  webrtc_mode = 'sfu';
```

5. Redeploy Vercel to pick up the new env vars.

## A4. Add Custom Domain

1. In Vercel: **Settings > Domains** → Add `harmony.yourdomain.com`
2. Configure DNS as shown by Vercel
3. Update environment variables with your domain
4. Redeploy

---

# 🖥️ Path B: Full Self-Hosting on VPS

**Cost: ~$5-12/month** for everything

This method gives you full control and enables:
- ✅ Cross-instance federation (activitypub + chat/dm servers)
- ✅ Link previews
- ✅ Bot gateway
- ✅ Self-hosted LiveKit
- ✅ Full pg-boss queue for reliable delivery

## Recommended VPS Providers

| Provider | Specs | Monthly Cost |
|----------|-------|--------------|
| [**Hostinger VPS**](https://hostinger.com?REFERRALCODE=HARMONY) | 1 vCPU, 4GB RAM, 50GB | **$4.99/mo** |

We recommend using [KVM2](https://www.hostinger.com/cart?product=vps%3Avps_kvm_2&period=24&referral_type=cart_link&REFERRALCODE=HARMONY&referral_id=019b0812-725a-7338-81f9-cddc8eb68800) nodes for better performance. But [KVM1](https://www.hostinger.com/cart?product=vps%3Avps_kvm_1&period=24&referral_type=cart_link&REFERRALCODE=HARMONY&referral_id=019b0812-725a-7338-81f9-cddc8eb68800) should work fine as well, depends on your needs.

This also gives you a free .cloud domain for your instance.

> 💡 **Tip:** Use code `VPSRATES10` at Hostinger for 10% off

## B1. Initial Server Setup

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

## B2. Set Up Supabase

You can use **Supabase Cloud** (easier) or **self-host** (full control).

### Using Supabase Cloud (Recommended)

1. Create project at [supabase.com](https://supabase.com)
2. Run database schema (see Path A, Step A1)
3. Note your credentials:
   - Project URL
   - Anon key
   - Service role key
   - Database URL (for pg-boss): `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres`

### Self-Hosting Supabase

```bash
git clone https://github.com/supabase/supabase /opt/supabase
cd /opt/supabase/docker
cp .env.example .env
nano .env  # Set strong passwords!
docker compose up -d
```

## B3. Configure Environment

### Frontend

```bash
cd /opt/harmony
cp env.example .env
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

INSTANCE_DOMAIN=harmony.yourdomain.com
CORS_ORIGIN=https://harmony.yourdomain.com

# Enable reliable federation queue
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

## B4. Build Frontend

```bash
cd /opt/harmony
npm ci
npm run build-only
# Built files are in ./dist
```

## B5. Set Up LiveKit

```bash
mkdir -p webrtc
nano webrtc/livekit.yaml
```

```yaml
port: 7880
rtc:
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  your-api-key: your-api-secret  # Generate with: openssl rand -hex 16
turn:
  enabled: true
  domain: harmony.yourdomain.com
  tls_port: 5349
  udp_port: 3478
```

Generate keys:
```bash
echo "API Key: devkey$(openssl rand -hex 8)"
echo "API Secret: $(openssl rand -hex 32)"
```

## B6. Docker Compose

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

## B7. Configure Nginx

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
    location ~ ^/(\.well-known|users|nodeinfo|inbox|outbox|api|link-preview|health) {
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

## B8. Configure Firewall

```bash
ufw allow 22/tcp       # SSH
ufw allow 80/tcp       # HTTP
ufw allow 443/tcp      # HTTPS
ufw allow 7880/tcp     # LiveKit WebSocket
ufw allow 7881/tcp     # LiveKit RTC
ufw allow 3478/udp     # TURN
ufw allow 5349/tcp     # TURN TLS
ufw allow 50000:50100/udp  # Media
ufw enable
```

## B9. Verify Installation

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
2. Verify firewall allows UDP 50000-50100
3. Ensure `LIVEKIT_API_KEY` matches in both federation-backend and livekit.yaml
4. For cloud deployment: verify `instance_webrtc_settings` has correct credentials

## SSL issues
1. Test certificate renewal: `certbot renew --dry-run`
2. Check Nginx config: `nginx -t`

--

# Mixing Cloud and Self-Hosting

You can mix cloud and self-hosting, or self-host everything, the choice is yours. For example, you can use cloud for the frontend and self-host for the backend, etc.

---

# Next Steps

1. **Register first account** → automatically becomes admin
2. **Configure admin panel** → set instance name, description
3. **Invite users** or enable open registration
4. **Follow users** from other Mastodon/Harmony instances (if federation enabled)

---

*Some links in this guide are affiliate links. Using them helps support Harmony development at no extra cost to you. We are in no-way affiliated with Hostinger, but we appreciate their support.*

