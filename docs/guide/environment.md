# Environment Variables

All frontend environment variables are prefixed with `VITE_` and accessible at build time via `import.meta.env`.

## Frontend (`.env`)

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_SUPABASE_URL` | Supabase API URL | `https://xyz.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key | `eyJhbGc...` |
| `VITE_INSTANCE_DOMAIN` | Instance domain (no protocol) | `har.mony.lol` |
| `VITE_INSTANCE_NAME` | Display name for the instance | `Harmony` |
| `VITE_APP_URL` | Full app URL for CORS and redirects | `https://har.mony.lol` |

### Feature Flags

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_ENABLE_FEDERATION` | `false` | Enable ActivityPub federation |
| `VITE_ENABLE_VOICE` | `false` | Enable voice/video channels |
| `VITE_ENABLE_E2E_ENCRYPTION` | `false` | Enable end-to-end encryption |
| `VITE_ENABLED_OAUTH_PROVIDERS` | `""` | OAuth providers (e.g., `google,github,twitch`) |

### Federation

| Variable | Description |
|----------|-------------|
| `VITE_DOMAIN` | Domain used for ActivityPub actor URIs (set same as `VITE_INSTANCE_DOMAIN`) |
| `VITE_FEDERATION_API_URL` | Federation API base URL (e.g., `https://har.mony.lol`) |

### Voice/Video

| Variable | Description |
|----------|-------------|
| `VITE_LIVEKIT_URL` | LiveKit WebSocket URL (e.g., `wss://live.har.mony.lol`) |

### Push Notifications

| Variable | Description |
|----------|-------------|
| `VITE_VAPID_PUBLIC_KEY` | VAPID public key for web push |

### Media

| Variable | Description |
|----------|-------------|
| `VITE_TENOR_API_KEY` | Tenor API key for GIF search |

### Debugging

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_DEBUG_LOGGING` | `false` | Enable debug logging |
| `VITE_DEBUG_FEDERATION` | `false` | Federation debug output |
| `VITE_DEBUG_VOICE` | `false` | Voice/WebRTC debug output |
| `VITE_DEV_MODE` | `false` | Development mode flag |

### Other

| Variable | Description |
|----------|-------------|
| `VITE_HARMONY_ALT_DOMAINS` | Comma-separated alternate domains for embed detection |

## Federation Backend (`federation-backend/.env`)

Copy from `federation-backend/env.template`.

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `SUPABASE_URL` | Supabase API URL | `https://xyz.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | `eyJhbGc...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `eyJhbGc...` |
| `INSTANCE_DOMAIN` | Instance domain (no protocol) | `har.mony.lol` |
| `CORS_ORIGIN` | Frontend origin for CORS | `https://har.mony.lol` |

### Job Queue (BullMQ)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string for LISTEN/NOTIFY bridge |
| `USE_BULLMQ_QUEUE` | `true` to enable reliable job queue (recommended) |

### Optional

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: `3001`) |
| `NODE_ENV` | `development` or `production` |
| `INSTANCE_NAME` | Display name |
| `INSTANCE_DESCRIPTION` | Instance description |
| `REDIS_URL` | Redis URL for caching (e.g., `redis://localhost:6379`) |
| `LOG_LEVEL` | `error`, `warn`, `info`, or `debug` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window |
| `REQUIRE_VALID_SIGNATURES` | Enforce HTTP signature validation |

### Voice/Video (LiveKit)

| Variable | Description |
|----------|-------------|
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `LIVEKIT_URL` | Internal LiveKit URL (e.g., `ws://localhost:7880`) |
| `LIVEKIT_PUBLIC_URL` | Public-facing LiveKit URL |
| `WEBRTC_MODE` | `sfu`, `p2p`, or `hybrid` |
| `ALLOW_FEDERATED_VOICE` | Allow voice across federated instances |

### Push Notifications

| Variable | Description |
|----------|-------------|
| `VAPID_PUBLIC_KEY` | VAPID public key |
| `VAPID_PRIVATE_KEY` | VAPID private key |
| `VAPID_SUBJECT` | VAPID subject (e.g., `mailto:admin@example.com`) |

## Bot Gateway (`bot-gateway/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | Yes | Supabase API URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role key |
| `PUBLIC_URL` | Yes | Public-facing URL |
| `PORT` | No | Server port (default: `3002`) |
| `NODE_ENV` | No | Environment |

## LiveKit / WebRTC (`webrtc/`)

Copy `webrtc/env.example` and `webrtc/livekit.yaml.example`:

| Variable | Description |
|----------|-------------|
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `LIVEKIT_URL` | Internal LiveKit WebSocket URL |
| `LIVEKIT_PUBLIC_URL` | Client-facing LiveKit WebSocket URL |
| `INSTANCE_DOMAIN` | Instance domain |
| `TURN_DOMAIN` | TURN server domain |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis for LiveKit clustering |
| `MAX_PARTICIPANTS` | Max room participants |
| `EMPTY_ROOM_TIMEOUT` | Room timeout when empty |

## Integration Tests (`.env.test`)

| Variable | Description |
|----------|-------------|
| `TEST_SUPABASE_URL` | Test Supabase URL |
| `TEST_SUPABASE_ANON_KEY` | Test anon key |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Test service role key |
| `TEST_DATABASE_URL` | Direct PostgreSQL connection |

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/environment.md` and run `npm run docs:generate-guide` to update.
