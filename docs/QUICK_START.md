# Harmony Quick Start Guide

Get Harmony running in 5 minutes.

## Choose Your Path

### Fastest: Supabase Cloud + your own host

1. Create a [Supabase](https://supabase.com) project
2. Run the schema from `db_schema/init/` (see `db_schema/init/README.md` in the repo; use `init.sql` or run numbered files in order)
3. Build the frontend (`npm install && npm run build-only`) and serve the `dist/` output yourself (Nginx/Caddy/S3+CloudFront, etc.). For a turnkey path, use the Docker Compose flow below.
4. Set the `VITE_*` environment variables (`.env`) to match your Supabase project before building

For a full production stack (Docker, federation, voice), use [HOW_TO_SELF_HOST.md](./HOW_TO_SELF_HOST.md). For desktop builds, see `npm run tauri:build`.

### Recommended: Docker Compose

```bash
# Clone
git clone https://github.com/y4my4my4m/harmony.git
cd harmony

# Build frontend
npm install && npm run build-only

# Configure
cp .env.example .env
cp federation-backend/env.template federation-backend/.env
# Edit .env files with your Supabase credentials

# Run
docker compose -f docker-compose.prod.yml up -d
```

See [HOW_TO_SELF_HOST.md](./HOW_TO_SELF_HOST.md) for details.

### Development Mode

```bash
# Clone
git clone https://github.com/y4my4my4m/harmony.git
cd harmony

# Install
npm install
cd federation-backend && npm install && cd ..

# Start Supabase (requires Docker)
# Clone supabase/supabase and run: docker compose up -d

# Configure .env files

# Run frontend
npm run dev

# Run backend (separate terminal)
cd federation-backend && npm run dev
```

## Environment Variables

### Frontend (.env)

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_INSTANCE_DOMAIN=harmony.example.com
```

### Backend (federation-backend/.env)

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://...
INSTANCE_DOMAIN=harmony.example.com
CORS_ORIGIN=https://harmony.example.com
```

## Database Setup

Run SQL files from `db_schema/init/` in order:
1. Extensions
2. Tables
3. RLS policies
4. Realtime config
5. Storage buckets

## Verify Installation

```bash
# Health check
curl http://localhost:3001/health

# WebFinger
curl http://localhost:5173/.well-known/webfinger?resource=acct:test@localhost

# NodeInfo
curl http://localhost:5173/.well-known/nodeinfo
```

## Next Steps

1. Register an account
2. Configure Admin Panel
3. Follow federated users
4. Create posts!

See the [installation guide](./guide/installation.md) and [self-hosting guide](./HOW_TO_SELF_HOST.md) for more detail.

