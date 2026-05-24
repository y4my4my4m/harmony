# Docker Deployment

Harmony provides two Docker Compose configurations depending on your Supabase setup.

## Compose Configurations

### With Supabase Cloud (`docker-compose.prod.yml`)

Use this when your Supabase project is hosted (supabase.co or self-hosted separately):

```bash
docker compose -f docker-compose.prod.yml up -d
```

Services: federation-backend, bot-gateway (optional), redis, nginx.

### Self-Hosted Supabase (`docker-compose.full.yml`)

Use this when running Supabase via its own Docker Compose alongside Harmony:

```bash
# Start Supabase first (in supabase/docker directory)
cd /path/to/supabase/docker
docker compose up -d

# Then start Harmony
cd /path/to/harmony
docker compose -f docker-compose.full.yml up -d
```

Additional services: connects to `supabase_default` network, LiveKit (optional).

## Prerequisites

### 1. Build the Frontend

```bash
npm install
npm run build-only
```

This outputs the Vue app to `dist/`.

### 2. Build the Documentation (Optional)

```bash
npm run docs:generate-all
```

This outputs the VitePress site to `docs/.vitepress/dist/`.

### 3. Configure Environment

```bash
# Federation backend
cp federation-backend/env.template federation-backend/.env
# Edit with your Supabase credentials and domain

# Bot gateway (if using bots profile)
cp bot-gateway/.env.example bot-gateway/.env
```

### 4. SSL Certificates

Obtain certificates via Let's Encrypt:

```bash
sudo certbot certonly --standalone -d your-domain.com -d docs.your-domain.com
```

## Services

### Federation Backend

- **Image**: Built from `federation-backend/Dockerfile` (Node 20 Alpine, multi-stage)
- **Port**: 3001
- **Health check**: `GET /health` every 30 seconds
- **Required env**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `INSTANCE_DOMAIN`, `CORS_ORIGIN`
- **Recommended**: Set `DATABASE_URL` and `USE_BULLMQ_QUEUE=true` for reliable federation delivery

### Bot Gateway (Optional)

Enabled with the `bots` profile:

```bash
docker compose -f docker-compose.prod.yml --profile bots up -d
```

- **Port**: 3002
- **Required env**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_URL`

### Redis

- **Image**: `redis:7-alpine`
- **Storage**: Persistent volume with append-only mode
- **Health check**: `redis-cli ping`
- Used for caching and rate limiting in the federation backend

### LiveKit (Optional, full stack only)

Enabled with the `voice` profile:

```bash
docker compose -f docker-compose.full.yml --profile voice up -d
```

- **Image**: `livekit/livekit-server:latest`
- **Ports**: 7880 (HTTP/WS), 7881 (TCP), 50000-50100/UDP (media)
- **Config**: Mount `webrtc/livekit.yaml`

### Nginx

- **Image**: `nginx:alpine`
- **Ports**: 80, 443
- **Volumes**:
  - `./dist` - Frontend static files
  - `./docs/.vitepress/dist` - Documentation site
  - `./dev/nginx-harmony.conf` - Nginx configuration
  - `/etc/letsencrypt` - SSL certificates

## Networking

- All Harmony services connect via the `harmony` bridge network
- The full-stack compose also connects to `supabase_default` (external) so federation-backend can reach Supabase containers directly

## Updating

```bash
# Pull latest code
git pull

# Rebuild frontend
npm run build-only

# Rebuild and restart containers
docker compose -f docker-compose.prod.yml up -d --build
```

## Troubleshooting

### Federation backend won't start

- Check logs: `docker logs harmony-federation`
- Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are correct
- Ensure the database is reachable (for BullMQ LISTEN/NOTIFY: check `DATABASE_URL`)

### Nginx returns 502

- Ensure federation-backend is healthy: `docker exec harmony-federation node -e "require('http').get('http://localhost:3001/health', r => console.log(r.statusCode))"`
- Check nginx config syntax: `docker exec harmony-nginx nginx -t`

### Cannot connect to Supabase (full stack)

- Verify the `supabase_default` network exists: `docker network ls | grep supabase`
- Ensure Supabase containers are running before starting Harmony

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/deployment/docker.md` and run `npm run docs:generate-guide` to update.
