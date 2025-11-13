# Running the Federation Backend

## Quick Start Options

### Option 1: Direct (Development)

```bash
cd federation-backend

# Install dependencies (first time)
npm install

# Start with hot reload
npm run dev
```

**Runs on**: `http://localhost:3001`

---

### Option 2: Docker (Production-like)

```bash
cd federation-backend

# Build and run
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

**Runs on**: `http://localhost:3001`

---

### Option 3: Docker Development (Hot Reload)

```bash
cd federation-backend

# Start dev environment with hot reload
docker compose -f docker-compose.dev.yml up

# Logs show automatically
```

**Runs on**: `http://localhost:3001`

---

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cd federation-backend
cp .env.example .env
```

**Key settings**:
- `SUPABASE_URL` - Point to your Supabase instance
- `INSTANCE_DOMAIN` - Your domain (for ActivityPub IDs)
- `LOG_LEVEL` - `debug` for development, `info` for production

---

## What It Does

The federation backend handles **ONLY** ActivityPub federation:

### Listens For (From Database):
- New posts (public/unlisted) → Federate to followers
- New DMs to remote users → Send via ActivityPub
- Server messages with remote members → Batch by instance
- Follow remote users → Send Follow activity
- Reactions on federated content → Send Like activity

### Serves (ActivityPub Endpoints):
- `GET /.well-known/webfinger` - User/server discovery
- `GET /.well-known/nodeinfo` - Instance metadata
- `GET /users/:username` - User Actor
- `POST /users/:username/inbox` - Receive activities
- `GET /users/:username/outbox` - Serve user activities
- `GET /servers/:serverId` - Server as Group
- `POST /servers/:serverId/inbox` - Server inbox
- `POST /inbox` - Shared inbox

---

## Testing

### Health Check
```bash
curl http://localhost:3001/health
```

Should return:
```json
{
  "status": "healthy",
  "database": "connected",
  "version": "1.0.0"
}
```

### WebFinger
```bash
curl "http://localhost:3001/.well-known/webfinger?resource=acct:username@yourdomain.com"
```

### NodeInfo
```bash
curl http://localhost:3001/.well-known/nodeinfo
```

---

## Logs

Watch for federation events:
```
📝 New post detected: post-id
🌐 Federating new post: post-id
📊 Server has members on 2 remote instances
✅ Queued delivery to instance.com for 5 members
```

---

## Troubleshooting

### Connection Errors
**Issue**: Can't connect to Supabase

**Fix**: 
- Check `SUPABASE_URL` is correct
- For Docker: Use `host.docker.internal:8000`
- For local: Use `localhost:8000`

### No Events
**Issue**: Backend starts but no federation events

**Check**:
1. Database triggers installed? (smart_message_routing.sql)
2. Supabase real-time working?
3. Posts created with `is_local = true`?

### Port Conflicts
**Issue**: Port 3001 already in use

**Fix**: Change PORT in .env or docker-compose.yml

---

## Development Workflow

```bash
# Terminal 1: Supabase
cd ~/gits/hobby/harmonious
docker compose up

# Terminal 2: Federation Backend
cd ~/gits/hobby/harmony/federation-backend
npm run dev

# Terminal 3: Frontend
cd ~/gits/hobby/harmony
npm run dev
```

---

## Production Deployment

### With Docker Compose

```bash
cd federation-backend
docker compose up -d
```

### Standalone

```bash
cd federation-backend
npm run build
npm start
```

---

**Federation backend is ready to use!** 🚀

Choose your preferred method and start it up!

