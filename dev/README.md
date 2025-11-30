# Harmony Local Development Environment

This directory contains the configuration for running Harmony locally with **HTTPS** support.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser                                   │
│   https://har.mony.local                                        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                    ┌───────▼───────┐
                    │    Caddy      │  (HTTPS termination)
                    │  (port 443)   │
                    └───────┬───────┘
                            │
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  Vite Dev     │   │  Federation   │   │   LiveKit     │
│  (port 5173)  │   │  Backend      │   │  (port 7880)  │
│               │   │  (port 3001)  │   │               │
└───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                    ┌───────▼───────┐
                    │   Supabase    │
                    │  (PostgreSQL) │
                    └───────────────┘
```

## Prerequisites

### 1. Install mkcert

**Arch/Manjaro:**
```bash
sudo pacman -S mkcert nss
```

**macOS:**
```bash
brew install mkcert
```

**Ubuntu/Debian:**
```bash
sudo apt install libnss3-tools
# Download mkcert binary from: https://github.com/FiloSottile/mkcert/releases
```

### 2. Install the Local CA

```bash
mkcert -install
```

This adds a local Certificate Authority to your system's trust store.

### 3. Generate Certificates

```bash
cd dev/certs
mkcert "har.mony.local" "live.mony.local" localhost 127.0.0.1
```

This creates:
- `har.mony.local+3.pem` (certificate)
- `har.mony.local+3-key.pem` (private key)

### 4. Update /etc/hosts

Add these lines to `/etc/hosts`:

```
127.0.0.1 har.mony.local live.mony.local
```

## Running the Development Environment

### Step 1: Start Supabase (if not already running)

```bash
cd /path/to/supabase
docker compose up -d
```

### Step 2: Start LiveKit

```bash
cd webrtc
docker compose up -d
```

### Step 3: Start the Dev Proxy (Caddy)

```bash
cd dev
docker compose up -d
```

### Step 4: Start the Vite Dev Server

```bash
npm run dev -- --host 0.0.0.0
```

### Step 6: Open the App

Navigate to: **https://har.mony.local**

## Environment Configuration

Make sure your `.env` files are configured correctly:

### Frontend (.env or .env.local)

```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_FEDERATION_BACKEND_URL=https://har.mony.local/api
VITE_LIVEKIT_URL=wss://live.mony.local
```

### Federation Backend (federation-backend/.env)

```env
PORT=3001
INSTANCE_DOMAIN=har.mony.local
SUPABASE_URL=http://supabase-kong:8000
SUPABASE_SERVICE_ROLE_KEY=your-service-key
DATABASE_URL=postgres://postgres:your-db-password@supabase-db:5432/postgres

# LiveKit
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_URL=ws://harmony-livekit:7880
LIVEKIT_PUBLIC_URL=wss://live.mony.local
WEBRTC_MODE=hybrid
ALLOW_FEDERATED_VOICE=false
```

## Troubleshooting

### Certificate errors in browser

1. Make sure you ran `mkcert -install`
2. Restart your browser after installing the CA
3. Check that the cert files exist in `dev/certs/`

### Cannot connect to Supabase

1. Check that Supabase containers are running: `docker ps | grep supabase`
2. Verify the network exists: `docker network ls | grep supabase`
3. Make sure federation-backend can reach PostgreSQL (check DATABASE_URL)

### LiveKit connection issues

1. Verify LiveKit is running: `docker ps | grep livekit`
2. Check the webrtc docker-compose is connected to supabase_default network
3. Test direct access: `curl http://localhost:7880/healthcheck`

### Caddy cannot reach services

1. Ensure services are running on the host, not just in Docker
2. Check `host.docker.internal` is resolving (Docker Desktop feature)
3. On Linux without Docker Desktop, you may need to add:
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```

## Quick Commands

```bash
# Start everything
./dev/start.sh

# Stop everything
./dev/stop.sh

# View Caddy logs
docker logs -f harmony-dev-caddy

# View LiveKit logs
docker logs -f harmony-livekit

# Regenerate certificates
cd dev/certs && mkcert "har.mony.local" "*.har.mony.local" localhost 127.0.0.1 ::1
```

## Production Notes

This setup is for **local development only**. For production:

1. Use real domain names with Let's Encrypt certificates
2. Run all services behind a proper reverse proxy (nginx, Caddy, Traefik)
3. Use proper secrets management
4. Enable rate limiting and other security features

