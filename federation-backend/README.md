# Harmony Federation Backend

Node service (Express, TypeScript) that speaks ActivityPub for Harmony and serves the server-side API the web and native clients use. Chat, posts and accounts are written by clients straight to Supabase; this service federates them and handles everything that needs a server:

- **ActivityPub**: WebFinger, NodeInfo, actors, inboxes and outboxes, HTTP Signatures, delivery with retries; Harmony servers federate as ActivityPub Groups
- **Queue worker**: BullMQ jobs fed by Postgres `LISTEN federation_jobs`, delivery, maintenance
- **Push**: Web Push, UnifiedPush and FCM ([docs/PUSH_NOTIFICATIONS.md](../docs/PUSH_NOTIFICATIONS.md))
- **Link previews**, the **GIF proxy** (Klipy), **LiveKit** tokens and webhook, **presence and typing**, signed **attachment URLs** for other instances, and the **Ko-fi** and **Stripe** donation webhooks

## Process modes

`FEDERATION_MODE` selects the role of a process:

| Mode | Runs |
|---|---|
| `server` | HTTP on `PORT` (3001) |
| `worker` | Queues, the `LISTEN` bridge, delivery, push sending, voice reconciliation; no HTTP |
| `unified` | Both (default) |

Production runs one `server` and one `worker` from the same image.

## Development

Requires Node.js 24, Supabase with the Harmony schema, and Redis.

```bash
cp env.template .env    # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, INSTANCE_DOMAIN
npm install
npm run dev             # unified, tsx watch
```

| Script | Effect |
|---|---|
| `npm run dev` | Unified, reloading on change |
| `npm run dev:server`, `npm run dev:worker` | One role, reloading on change |
| `npm run build` | Compile to `dist/` |
| `npm start`, `npm run start:server`, `npm run start:worker` | Run `dist/index.js` |
| `npm run type-check` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run backfill-posts` | Re-fetch remote posts or their link previews (`--dry-run`, `--limit N`, `--link-previews-only`) |

`src/config/index.ts` validates the environment at start and stops on an invalid value, naming it. `env.template` documents the variables; the [environment reference](../docs-source/guide/environment.md) lists every one the code reads. `.env` is ignored by git.

Logs go to the console at `LOG_LEVEL`, and to `logs/error.log` and `logs/combined.log` under the working directory.

## Docker

`Dockerfile` builds the image published as `ghcr.io/y4my4my4m/harmony-federation`: Node 24 Alpine, multi-stage, running `node dist/index.js` as uid 1000 (`node`). Its health check probes `GET /health` on `PORT`; the worker serves no HTTP, so compose files disable the check for it. The self-host stack runs this image as `harmony-federation-server` and `harmony-federation-worker` ([docs/self-hosting.md](../docs/self-hosting.md)).

`docker-compose.yml` in this directory runs one unified container (`harmony-federation-backend`) from `.env`:

```bash
mkdir -p logs           # mounted at /app/logs; must be writable by uid 1000
docker compose up -d --build
docker compose logs -f
```

It publishes `${PORT:-3001}`, joins the external `supabase_default` network (an upstream Supabase stack on the same host, reachable as `http://supabase-kong:8000`), and maps `host.docker.internal` to the host. `DOCKERFILE` selects the Dockerfile. `Dockerfile.dev` runs `npm run dev` against a `src/` mounted at `/app/src`, which this compose file does not mount.

## Endpoints

The service mounts most routes at the root. Behind the reverse proxy they are reached under `/api/federation/` with the prefix stripped, except the ActivityPub paths, `/health`, `/link-preview`, `/api/livekit/` and `/webhooks/`, which keep their path ([routing](../docs-source/guide/deployment/federation.md)).

### ActivityPub

| Route | |
|---|---|
| `GET /.well-known/webfinger`, `/.well-known/host-meta`, `/.well-known/host-meta.json` | Discovery |
| `GET /.well-known/nodeinfo`, `/nodeinfo/2.0`, `/nodeinfo/2.1` | NodeInfo |
| `GET /users/:username` | Actor; `/users/instance.actor` is the instance actor |
| `GET /users/:username/outbox`, `followers`, `following`, `featured` | Collections |
| `POST /users/:username/inbox`, `POST /inbox` | Personal and shared inbox |
| `GET /posts/:postId`, `/posts/:postId/likes`, `/posts/:postId/replies` | Notes; browsers get an HTML page |
| `GET /oembed` | oEmbed for posts |
| `GET /servers/:serverId`, `/outbox`, `/members` | Server as a Group |
| `GET /servers/:serverId/channels/:channelId[/messages\|/outbox]` | Channel and its messages |
| `POST /servers/:serverId/inbox` | Group inbox |

Private servers, and channels `@everyone` cannot view, are served only to a GET signed by a remote member who can view them; see [docs/FEDERATION.md](../docs/FEDERATION.md), "Who can read a server".

### Client API

| Mount | |
|---|---|
| `/health` | Health; `/health/key-consistency` and `POST /health/maintenance` for admins |
| `/push` | Push subscriptions |
| `/link-preview` | `POST /` previews one URL for a signed-in user; `POST /enrich-message` (bearer `INTERNAL_API_SECRET`) enriches a stored message for the bot gateway |
| `/gifs` | Klipy search, trending and AI emoji |
| `/api/livekit` | Config, tokens, rooms, federated calls, webhook |
| `/voice` | Federated voice channel join and leave |
| `/realtime` | Heartbeat, presence, typing |
| `/media` | Signed attachment URLs for other instances |
| `/instance-info` | Name, domain, version and public Supabase URL and anon key, for native clients |
| `/webhooks/kofi` | Ko-fi donations |
| `/webhooks/stripe` | Stripe Payment Link donations, credited by `client_reference_id` |
| `/lookup-user`, `/resolve-post`, `/fetch-posts`, `/fetch-replies`, `/fetch-reactions`, `/refetch-post` | Remote lookups for the client |
| `/servers/discover`, `/servers/join`, `/servers/leave`, `/invites/:code`, `/instances/probe` | Remote servers, invites, instance probing |
| `POST /api/activitypub/process-delivery` | Process the delivery queue on demand (admin) |

## License

Same as the Harmony repository: GNU AGPL-3.0 (see the root `LICENSE`).
