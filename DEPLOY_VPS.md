# Harmony VPS Deployment Guide

Deploy Harmony on a VPS with full control. This is the **recommended method** for production.

## Cost Overview

| Provider | Specs | Monthly Cost | Promo |
|----------|-------|--------------|-------|
| [Hostinger VPS](https://hostinger.com?REFERRALCODE=HARMONY) | 1 vCPU, 4GB RAM, 50GB | **$4.99/mo** | Use code `VPSRATES10` for 10% off |
| DigitalOcean | 1 vCPU, 2GB RAM, 50GB | $12/mo | - |
| Hetzner | 2 vCPU, 4GB RAM, 40GB | €4.51/mo | - |
| Vultr | 1 vCPU, 2GB RAM, 55GB | $12/mo | - |

**Total cost**: ~$5-12/month for everything (database, backend, voice, bots)

---

## What You'll Deploy

### Option A: Full Stack (with Federation)
- ✅ Frontend (Nginx)
- ✅ Federation Backend (ActivityPub, link previews)
- ✅ Bot Gateway (optional)
- ✅ LiveKit (voice/video)
- ✅ Supabase Cloud (database) - OR self-hosted
- ✅ Full ActivityPub federation

### Option B: Local Only (no Federation)
- ✅ Frontend (Nginx)
- ✅ Voice/Video (LiveKit)
- ✅ Supabase Cloud (database)
- ❌ No federation (local instance only)
- ❌ No link previews
- ❌ No bots

---

## Prerequisites

- VPS with Ubuntu 22.04+ (or Debian 12+)
- Domain name pointing to your VPS
- Basic terminal knowledge

---

## Step 1: Initial Server Setup

```bash
# SSH into your VPS
ssh root@your-server-ip

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Install Docker Compose
apt install docker-compose-plugin -y

# Add your user to docker group (if not root)
usermod -aG docker $USER

# Install Nginx and Certbot for SSL
apt install nginx certbot python3-certbot-nginx -y

# Create app directory
mkdir -p /opt/harmony
cd /opt/harmony
```

---

## Step 2: Set Up Supabase

You have two options:

### Option A: Supabase Cloud (Recommended for beginners)

1. Go to [supabase.com](https://supabase.com) and create a project
2. Run database schema (see [db_schema/init/README.md](db_schema/init/README.md))
3. Note your credentials:
   - Project URL: `https://xxxxx.supabase.co`
   - Anon key: `eyJ...`
   - Service role key: `eyJ...`
   - Database URL: `postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres`

### Option B: Self-Hosted Supabase

```bash
# Clone Supabase Docker
git clone https://github.com/supabase/supabase
cd supabase/docker

# Copy and configure .env
cp .env.example .env
nano .env  # Set strong passwords!

# Start Supabase
docker compose up -d

# Wait for startup
docker compose logs -f  # Ctrl+C when stable
```

---

## Step 3: Clone Harmony

```bash
cd /opt/harmony
git clone https://github.com/YOUR_USERNAME/harmony.git .

# Or download release
# wget https://github.com/YOUR_USERNAME/harmony/archive/refs/heads/main.zip
```

---

## Step 4: Configure Environment

### Frontend Configuration

```bash
cp env.example .env
nano .env
```

```env
# Frontend (.env)
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-anon-key
VITE_INSTANCE_DOMAIN=harmony.yourdomain.com
VITE_INSTANCE_NAME=My Harmony

# Voice (if using LiveKit)
VITE_LIVEKIT_URL=wss://harmony.yourdomain.com:7880
VITE_ENABLE_VOICE=true

# Federation (set to false if not using federation-backend)
VITE_ENABLE_FEDERATION=true
```

### Federation Backend Configuration (Optional)

```bash
cp federation-backend/env.template federation-backend/.env
nano federation-backend/.env
```

```env
# Key settings
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...your-service-role-key
DATABASE_URL=postgresql://postgres.[ref]:[pwd]@[region].pooler.supabase.com:5432/postgres
INSTANCE_DOMAIN=harmony.yourdomain.com
CORS_ORIGIN=https://harmony.yourdomain.com

# LiveKit
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
LIVEKIT_URL=ws://localhost:7880

# Enable pg-boss for reliable federation
USE_PGBOSS_QUEUE=true

# Email (Resend recommended)
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=re_your_api_key
SMTP_FROM=notifications@yourdomain.com
```

---

## Step 5: Build Frontend

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install dependencies and build
npm ci
npm run build-only

# The built files are in ./dist
```

---

## Step 6: Set Up LiveKit (Voice/Video)

```bash
# Create LiveKit config
mkdir -p webrtc
nano webrtc/livekit.yaml
```

```yaml
# livekit.yaml
port: 7880
rtc:
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  your-api-key: your-api-secret
turn:
  enabled: true
  domain: harmony.yourdomain.com
  tls_port: 5349
  udp_port: 3478
```

Generate API keys:
```bash
# Generate random keys
echo "API Key: devkey$(openssl rand -hex 8)"
echo "API Secret: $(openssl rand -hex 32)"
```

---

## Step 7: Docker Compose

Choose your deployment:

### Full Stack (with Federation)

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
    environment:
      - NODE_ENV=production
      - PORT=3001

  bot-gateway:
    build: ./bot-gateway
    container_name: harmony-bots
    restart: unless-stopped
    ports:
      - "3002:3002"
    env_file:
      - ./bot-gateway/.env
    environment:
      - NODE_ENV=production
      - PORT=3002

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

### Minimal (Voice Only, No Federation)

```yaml
version: "3.8"

services:
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

**Note**: Without federation-backend, you need a token service. See [Setting Up Voice Without Federation](#voice-without-federation) below.

---

## Step 8: Start Services

```bash
docker compose up -d

# Check status
docker compose ps
docker compose logs -f
```

---

## Step 9: Configure Nginx

```bash
nano /etc/nginx/sites-available/harmony
```

```nginx
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name harmony.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    server_name harmony.yourdomain.com;

    # SSL (will be configured by certbot)
    ssl_certificate /etc/letsencrypt/live/harmony.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/harmony.yourdomain.com/privkey.pem;

    # Frontend static files
    root /opt/harmony/dist;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;

    # Frontend routes (SPA)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Federation Backend API
    location ~ ^/(\.well-known|users|nodeinfo|inbox|outbox|api|link-preview|health) {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Bot Gateway
    location /bots {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # LiveKit WebSocket
    location /livekit {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Enable and get SSL:

```bash
# Enable site
ln -s /etc/nginx/sites-available/harmony /etc/nginx/sites-enabled/
rm /etc/nginx/sites-enabled/default

# Test config
nginx -t

# Get SSL certificate
certbot --nginx -d harmony.yourdomain.com

# Reload Nginx
systemctl reload nginx
```

---

## Step 10: Configure Firewall

```bash
# Allow required ports
ufw allow 22/tcp      # SSH
ufw allow 80/tcp      # HTTP
ufw allow 443/tcp     # HTTPS
ufw allow 7880/tcp    # LiveKit WebSocket
ufw allow 7881/tcp    # LiveKit RTC
ufw allow 3478/udp    # TURN UDP
ufw allow 5349/tcp    # TURN TLS
ufw allow 50000:50100/udp  # LiveKit media

# Enable firewall
ufw enable
```

---

## Step 11: Verify Installation

```bash
# Test frontend
curl https://harmony.yourdomain.com

# Test federation (if enabled)
curl https://harmony.yourdomain.com/.well-known/nodeinfo

# Test health
curl https://harmony.yourdomain.com/health
```

---

## Voice Without Federation

If you want voice channels but NO cross-instance federation:

### Run Federation-Backend in "Local Only" Mode

The federation-backend handles LiveKit token generation. For local-only instances, just run it without federation:

```env
# federation-backend/.env
NODE_ENV=production
PORT=3001

SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

INSTANCE_DOMAIN=harmony.local
CORS_ORIGIN=https://harmony.local

# LiveKit token generation (this is all you need for local voice)
LIVEKIT_API_KEY=your-key
LIVEKIT_API_SECRET=your-secret
LIVEKIT_URL=ws://localhost:7880

# DISABLE federation processing
USE_PGBOSS_QUEUE=false
# Don't set DATABASE_URL - no federation queue needed
```

**What works:**
- ✅ Local voice channels (token generation)
- ✅ LiveKit config endpoint
- ✅ Health checks
- ❌ No cross-instance ActivityPub (local posts still work via Supabase)
- ❌ No link previews
- ❌ No remote user lookup

**Note:** Local ActivityPub features (posts, follows, timeline) work without federation-backend - they use Supabase directly. The backend is only needed for cross-instance communication and LiveKit tokens.

---

## Bot Gateway Setup

The bot gateway handles bot plugins for your instance.

### Configuration

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

### Running

Already included in the Docker Compose above. Access at `/bots` endpoint.

---

## Maintenance

### Updates

```bash
cd /opt/harmony
git pull
npm ci
npm run build-only
docker compose build
docker compose up -d
```

### Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f federation-backend
```

### Backups

If using self-hosted Supabase:
```bash
docker exec supabase-db pg_dump -U postgres postgres > backup.sql
```

---

## Troubleshooting

### Federation not working
1. Check backend is running: `docker compose ps`
2. Check logs: `docker compose logs federation-backend`
3. Verify `INSTANCE_DOMAIN` matches your actual domain
4. Test: `curl https://yourdomain.com/.well-known/nodeinfo`

### Voice not working
1. Check LiveKit is running: `docker compose logs livekit`
2. Verify firewall allows UDP ports 50000-50100
3. Test WebSocket: `wscat -c wss://yourdomain.com:7880`
4. Check LIVEKIT_API_KEY matches in both configs

### SSL issues
1. Run: `certbot renew --dry-run`
2. Check Nginx config: `nginx -t`

---

## Getting Help

- [GitHub Issues](https://github.com/YOUR_USERNAME/harmony/issues)
- [Documentation](docs/)

---

## Affiliate Disclosure

Some links in this guide are affiliate links. Using them helps support Harmony development at no extra cost to you.

- [Hostinger VPS](https://hostinger.com?REFERRALCODE=HARMONY) - Use code `VPSRATES10` for 10% off

