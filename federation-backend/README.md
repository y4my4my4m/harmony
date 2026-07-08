# Harmony Federation Backend

ActivityPub federation service for Harmony. This backend handles federation only.

## Scope

This service handles ActivityPub federation and nothing else. It does not:

- Create messages or posts (the frontend writes those to Supabase)
- Authenticate users (Supabase handles auth)
- Perform general CRUD (the frontend talks to Supabase directly)

What it does handle:

- **ActivityPub protocol** - inbox/outbox endpoints, WebFinger discovery, NodeInfo metadata, HTTP signature signing and verification
- **Outbound delivery** - listens for database events, converts them to ActivityPub, batches per instance, delivers to remote instances, and retries on failure
- **Federated servers** - Harmony servers are exposed as ActivityPub Groups, with local-first routing and multi-instance membership
- **Inbound activities** - receives from remote instances, verifies signatures, processes activities, and writes results to the database

## Getting started

### Prerequisites

- Node.js 18+
- A running Supabase instance (Docker or cloud)

### Installation

```bash
npm install

cp .env.example .env
# Edit .env with your Supabase keys. Do not commit .env.

npm run dev
```

### Configuration

Copy `.env.example` and fill in:

- `SUPABASE_URL` - your Supabase URL
- `SUPABASE_SERVICE_ROLE_KEY` - from the Supabase dashboard; keep it secret
- `INSTANCE_DOMAIN` - your instance domain

Never commit `.env` or the service role key. `.gitignore` already excludes `.env`, `.env.local`, and `.env.production`.

## Running

Development (hot reload):

```bash
npm run dev
```

Production:

```bash
docker compose up -d
```

Docker with hot reload:

```bash
docker compose -f docker-compose.dev.yml up
```

See [DOCKER_USAGE.md](DOCKER_USAGE.md) for details on the Docker setup.

## Endpoints

### ActivityPub

- `GET /.well-known/webfinger` - WebFinger discovery
- `GET /.well-known/nodeinfo` - NodeInfo metadata
- `GET /nodeinfo/2.0` - NodeInfo 2.0
- `GET /users/:username` - user Actor
- `POST /users/:username/inbox` - user inbox
- `GET /users/:username/outbox` - user outbox
- `GET /servers/:serverId` - server as Group
- `POST /servers/:serverId/inbox` - server inbox
- `GET /servers/:serverId/outbox` - server outbox
- `POST /inbox` - shared inbox

### Management

- `GET /health` - health check
- `POST /api/activitypub/process-delivery` - manual delivery trigger

## Development commands

```bash
npm run dev         # hot reload
npm run build       # production build
npm start           # run production build
npm run type-check  # type checking
```

## Logs

- `logs/combined.log` - all logs
- `logs/error.log` - errors only
- Console (development)

## License

Same as the Harmony repository: GNU AGPL-3.0 (see the root `LICENSE`).
