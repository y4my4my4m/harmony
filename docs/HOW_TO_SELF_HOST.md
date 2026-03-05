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
- ✅ Full pg-boss queue for reliable delivery

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
   - Database URL (for pg-boss): `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres`

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

## 8. Configure Firewall

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

