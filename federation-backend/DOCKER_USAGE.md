# Federation Backend - Docker Usage

## Single docker-compose.yml for Everything!

Uses `.env` file to control behavior.

---

## Setup

```bash
cd federation-backend

# 1. Copy example
cp .env.example .env

# 2. Edit with YOUR keys
nano .env
```

**Set your Supabase keys** (from your Supabase dashboard)!

---

## Development Mode (Hot Reload)

**In `.env`**:
```bash
NODE_ENV=development
DOCKERFILE=Dockerfile.dev
LOG_LEVEL=debug
```

**Run**:
```bash
docker compose up
```

**What happens**:
- Uses `Dockerfile.dev` (has hot reload)
- Debug logging
- Rebuilds on code changes (via tsx watch)

---

## Production Mode

**In `.env`**:
```bash
NODE_ENV=production
DOCKERFILE=Dockerfile
LOG_LEVEL=info
```

**Run**:
```bash
docker compose up -d
```

**What happens**:
- Uses `Dockerfile` (optimized build)
- Info logging
- Runs compiled code

---

## Quick Commands

```bash
# Start
docker compose up -d

# View logs
docker compose logs -f

# Restart
docker compose restart

# Stop
docker compose down

# Rebuild
docker compose up --build
```

---

## Environment Variables

**Required in `.env`**:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `INSTANCE_DOMAIN`

**Optional** (have defaults):
- `PORT` (default: 3001)
- `NODE_ENV` (default: development)
- `DOCKERFILE` (default: Dockerfile)
- `LOG_LEVEL` (default: debug)

---

## Security

✅ **Safe to commit**:
- `docker-compose.yml` (no secrets!)
- `.env.example` (template only!)
- `Dockerfile`, `Dockerfile.dev`

❌ **NEVER commit**:
- `.env` (has your keys!)
- Any file with `SERVICE_ROLE_KEY`

`.gitignore` already excludes `.env` ✅

---

## Connecting to Supabase

**Self-hosted Supabase** (Docker):
```bash
SUPABASE_URL=http://host.docker.internal:8000
```

**Supabase Cloud**:
```bash
SUPABASE_URL=https://your-project.supabase.co
```

---

**One file, controlled by `.env`!** Simple and safe! 🎯

