# Federation Backend - Docker Usage

A single `docker-compose.yml` covers development and production. Behavior is controlled through the `.env` file.

## Setup

```bash
cd federation-backend

cp .env.example .env
# Edit .env with your Supabase keys (from the Supabase dashboard).
```

## Development mode (hot reload)

In `.env`:

```bash
NODE_ENV=development
DOCKERFILE=Dockerfile.dev
LOG_LEVEL=debug
```

Run:

```bash
docker compose up
```

This uses `Dockerfile.dev` with hot reload (via `tsx watch`), debug logging, and rebuilds on code changes.

## Production mode

In `.env`:

```bash
NODE_ENV=production
DOCKERFILE=Dockerfile
LOG_LEVEL=info
```

Run:

```bash
docker compose up -d
```

This uses `Dockerfile` (optimized build), info logging, and runs the compiled code.

## Quick commands

```bash
docker compose up -d        # start
docker compose logs -f      # view logs
docker compose restart      # restart
docker compose down         # stop
docker compose up --build   # rebuild
```

## Environment variables

Required in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `INSTANCE_DOMAIN`

Optional (with defaults):

- `PORT` (default: 3001)
- `NODE_ENV` (default: development)
- `DOCKERFILE` (default: Dockerfile)
- `LOG_LEVEL` (default: debug)

## Security

Safe to commit: `docker-compose.yml`, `.env.example`, `Dockerfile`, `Dockerfile.dev`.

Never commit `.env` or any file containing `SERVICE_ROLE_KEY`. `.gitignore` already excludes `.env`.

## Connecting to Supabase

Self-hosted Supabase (Docker):

```bash
SUPABASE_URL=http://host.docker.internal:8000
```

Supabase Cloud:

```bash
SUPABASE_URL=https://your-project.supabase.co
```
