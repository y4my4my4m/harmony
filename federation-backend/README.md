# Harmony Federation Backend

**ActivityPub federation server for Harmony - FEDERATION ONLY!**

## Purpose

This backend handles ONLY ActivityPub federation. It does NOT handle:
- Creating messages (frontend → Supabase)
- Creating posts (frontend → Supabase)
- User authentication (Supabase handles this)
- CRUD operations (frontend → Supabase)

## What It DOES Handle

✅ **ActivityPub Protocol**
- Inbox/Outbox endpoints
- WebFinger discovery
- NodeInfo metadata
- HTTP signature signing/verification

✅ **Federation Delivery**
- Listen for database events
- Convert to ActivityPub format
- Queue for delivery
- Send to remote instances
- Handle retries

✅ **Federated Discord Servers** (Innovation!)
- Servers as ActivityPub Groups
- Smart local-first routing
- Efficient batching by instance
- Multi-instance communities

✅ **Incoming Activities**
- Receive from remote instances
- Verify signatures
- Process activities
- Write to database

---

## Getting Started

### Prerequisites

- Node.js 18+
- Supabase running (Docker or cloud)

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
nano .env  # Add your Supabase keys (NEVER commit .env!)

# 3. Start development server
npm run dev
```

### Configuration

**IMPORTANT**: Never commit `.env` with real keys!

Copy `.env.example` and fill in:
- `SUPABASE_URL` - Your Supabase URL
- `SUPABASE_SERVICE_ROLE_KEY` - From Supabase dashboard (KEEP SECRET!)
- `INSTANCE_DOMAIN` - Your actual domain

---

## Running Options

### Option 1: Direct (Development)
```bash
npm run dev
```

### Option 2: Docker (Production)
```bash
docker compose up -d
```

### Option 3: Docker Dev (Hot Reload)
```bash
docker compose -f docker-compose.dev.yml up
```

---

## Endpoints

### ActivityPub (Federation)
- `GET /.well-known/webfinger` - WebFinger discovery
- `GET /.well-known/nodeinfo` - NodeInfo metadata
- `GET /nodeinfo/2.0` - NodeInfo 2.0
- `GET /users/:username` - User Actor
- `POST /users/:username/inbox` - User inbox
- `GET /users/:username/outbox` - User outbox
- `GET /servers/:serverId` - Server as Group
- `POST /servers/:serverId/inbox` - Server inbox
- `GET /servers/:serverId/outbox` - Server outbox
- `POST /inbox` - Shared inbox

### Management
- `GET /health` - Health check
- `POST /api/activitypub/process-delivery` - Manual delivery trigger

---

## Security

**⚠️ NEVER commit these to git**:
- `.env` file
- `SUPABASE_SERVICE_ROLE_KEY`
- Production credentials

The `.gitignore` is configured to exclude:
- `.env`
- `.env.local`
- `.env.production`

**Always use `.env.example` for documentation!**

---

## Docker Setup

### Using Docker Compose

```bash
# 1. Create .env file (from .env.example)
cp .env.example .env
nano .env  # Add your keys

# 2. Start
docker compose up -d

# 3. View logs
docker compose logs -f

# 4. Stop
docker compose down
```

### Environment Variables

Docker Compose reads from `.env` file automatically!

**Never put real keys in docker-compose.yml!**

---

## Development

```bash
# Hot reload (watches for file changes)
npm run dev

# Build for production
npm run build

# Run production build
npm start

# Type checking
npm run type-check
```

---

## Logs

Logs are written to:
- `logs/combined.log` - All logs
- `logs/error.log` - Errors only
- Console (development)

---

## License

Same as the Harmony repository: **GNU AGPL-3.0** (see root `LICENSE`).
