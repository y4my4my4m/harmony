# Harmony Bot Gateway

Node service that serves Harmony's Bot API: a WebSocket gateway that pushes events to bots and a REST API under `/api/v1` that bots call to act. Bots authenticate with tokens issued in the Harmony web client. The service talks to Supabase with the service-role key and produces events by polling the `messages` and `reactions` tables.

Bot developers: the protocol reference is [docs/bot-api.md](../docs/bot-api.md).

## Routes

| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | Liveness: `{ "status": "ok", "uptime": <seconds>, "timestamp": <ISO 8601> }` |
| `WS /gateway` | bot token, sent in IDENTIFY | Event gateway |
| `/api/v1/*` | `Authorization: Bot <token>` | REST API |
| `GET /status` | Supabase user JWT | Connected bots: IDs, usernames, last heartbeat |
| `GET /bridged-users/:channelId`<br>`GET /bridged-users/server/:serverId` | Supabase user JWT, server membership | Discord members registered by a bridge bot; feeds mention autocomplete |
| `POST /attachments/refresh` | Supabase user JWT, server membership | Asks the owning bridge bot to re-sign expired Discord CDN URLs |
| `GET /bridge-setup/:pairingCode` | none | Resolves a Discord bridge pairing code (`HRM-XXXX-XXXX`) to a server ID and endpoint URLs |
| `POST /bridge/v2/redeem` | setup code, rate limited per IP | Discord bridge v2: trades a one-time setup code for the bridge bot's token and the instance URLs |
| `GET /bridge/v2/config`, `POST /bridge/v2/status`, `POST /bridge/v2/pairs`, `DELETE /bridge/v2/pairs/:discordChannelId` | bridge bot token | A bridge's configuration, heartbeat and Discord snapshot, and Discord-side `/bridge link` and `unlink` |
| `GET /bridge/v2/hosted`<br>`GET /bridge/v2/hosted/instance` | `X-Bridge-Host-Secret` | The bridge host's work: hosted bridges with their tokens; the instance Discord bot with its token, presence switch and linked bridges |
| `GET /bridge/v2/discord/authorize?state=` | link state, rate limited per IP | Redirects to Discord's consent screen for the instance Discord bot (bot and applications.commands scopes, permissions `537250880`) |
| `GET /bridge/v2/discord/callback` | link state, rate limited per IP | OAuth2 redirect URI. Exchanges the code, links the guild named in Discord's token response, and redirects to Server Settings → Discord Bridge with `linked=1` or `link_error=<code>` |

`/status`, `/bridged-users/*`, `/attachments/refresh` and `/bridge-setup/*` serve the Harmony web client and are not part of the Bot API. `/bridge/v2/*` serves the Discord bridge program and the instance Discord bot's OAuth2 flow.

## Public URLs

`self-host/Caddyfile` routes `handle_path /bot-gateway/*` to `bot-gateway:3002`. `handle_path` strips the prefix, so the service sees `/gateway`, `/api/v1/...` and `/health`.

| | Behind the proxy | Direct (local development) |
|---|---|---|
| Gateway | `wss://<instance>/bot-gateway/gateway` | `ws://localhost:3002/gateway` |
| REST base | `https://<instance>/bot-gateway/api/v1` | `http://localhost:3002/api/v1` |
| Health | `https://<instance>/bot-gateway/health` | `http://localhost:3002/health` |

Any other reverse proxy must forward the whole `/bot-gateway/` prefix, strip it, and pass WebSocket upgrades on `/bot-gateway/gateway`. The web client calls `/bot-gateway/bridged-users/*` and `/bot-gateway/attachments/refresh` on the app origin. The nginx equivalent is in [BOT_GATEWAY_SETUP.md](../docs/BOT_GATEWAY_SETUP.md).

## Configuration

The service loads `.env` from its working directory. `.env.example` (development values) and `env.template` (production values) list every variable.

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_URL` | required | Supabase API URL. An internal address works (`http://supabase-kong:8000` in the self-host stack). Fallback for `PUBLIC_URL`. |
| `SUPABASE_SERVICE_ROLE_KEY` | required | Service-role key. All queries bypass RLS; access control is enforced in the service. |
| `PUBLIC_URL` | `SUPABASE_URL` | Public Supabase origin. Base for absolute avatar URLs, mirrored attachment URLs and invite-preview URLs. |
| `PORT` | `3002` | HTTP and WebSocket port. |
| `NODE_ENV` | `development` | In `development`, 500 responses from the error handler include the error message. |
| `INSTANCE_DOMAIN` | `localhost:3000` | Harmony app origin, as a hostname or URL; `https://` is assumed without a scheme. `/bridge-setup` and `/bridge/v2` build their URLs from it, including the instance Discord bot's OAuth2 redirect `<origin>/bot-gateway/bridge/v2/discord/callback`, which must be registered on the Discord application exactly. |
| `WS_HEARTBEAT_INTERVAL` | `30000` | Heartbeat interval in ms, sent to bots in READY. Connections without a heartbeat for twice this interval are closed. |
| `WS_REVALIDATE_INTERVAL_MS` | `30000` | Interval in ms, clamped to 1000-60000, at which open connections are rechecked against `bot_tokens` and `bots`. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | REST rate-limit window in ms. |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | REST requests allowed per bot, per route and channel or server it names, per window. |
| `FEDERATION_BACKEND_URL` | `http://localhost:3001` | Federation backend. Receives a link-preview request after each bot message. Must be `https://` or a localhost address; otherwise no request is sent. |
| `INTERNAL_API_SECRET` | `SUPABASE_SERVICE_ROLE_KEY` | Bearer token for the link-preview request. |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express `trust proxy`. A number is a hop count; `true` and `false` are booleans. |
| `BRIDGE_HOST_SECRET` | unset | Shared secret of the Discord bridge host (`X-Bridge-Host-Secret`). Under 32 characters, `GET /bridge/v2/hosted` and `/bridge/v2/hosted/instance` answer 404. |
| `BRIDGE_CONFIG_POLL_MS` | `5000` | Interval in ms, clamped to 1000-60000, of the bridge configuration poll behind `BRIDGE_CONFIG_UPDATE`. |

The instance setting **Bridge attachments** (admin instance configuration, stored as `bridge_attachment_mode`) controls Discord CDN attachments posted by bots: `link` stores the URL, `mirror` copies the file into the channel's folder of the private `message_media` bucket, `refresh` enables `POST /attachments/refresh`.

## Running

Node 18 or later.

```bash
npm install
cp .env.example .env
npm run dev        # tsx watch src/index.ts
```

Production build:

```bash
npm run build      # tsc -> dist/
npm start          # node dist/index.js
```

### Docker

`Dockerfile` is a multi-stage `node:24-alpine` build (`NODE_VERSION`, default 24). It exposes 3002 and declares a `HEALTHCHECK` against `/health`. The build stage runs `npm run build-only` (`tsc --skipLibCheck || true`), which does not fail on type errors; run `npm run type-check` separately.

```bash
docker build -t harmony-bot-gateway bot-gateway
docker run --env-file bot-gateway/.env -p 3002:3002 harmony-bot-gateway
```

Compose files start the service under the `bots` profile:

| File | Env file | Command |
|---|---|---|
| `self-host/docker-compose.yml` | `self-host/bot-gateway.env`, written by `self-host/configure.sh` when bots are enabled | `docker compose --profile bots up -d` |
| `docker-compose.prod.yml` | `bot-gateway/.env` | `docker compose -f docker-compose.prod.yml --profile bots up -d` |
| `docker-compose.full.yml` | `bot-gateway/.env` | `docker compose -f docker-compose.full.yml --profile bots up -d` |

## Bots and tokens

Users create bots in the web client under **User Settings → My Bots → New bot**. The token is shown once, in a dialog after creation; Harmony stores its SHA-256 hash. Tokens have the form `harmony_bot_` followed by 64 hex characters. **Reset token** on the bot's page revokes the old token immediately and shows the new one once. The gateway verifies tokens at IDENTIFY and rechecks every open connection each `WS_REVALIDATE_INTERVAL_MS`: a connection whose token was revoked, rotated or expired, or whose bot was deactivated or deleted, closes with `4004`.

Server owners add bots from the bot's page (**Add to server**) or under **Server Settings → Advanced → Server Bots**, where they also set the bot's permissions. The gateway enforces `read_messages`, `send_messages`, `manage_messages`, `add_reactions`, `manage_channels` and `manage_roles`; see [docs/bot-api.md](../docs/bot-api.md#permissions).

## Events

| Event | Source |
|---|---|
| `READY` | Successful IDENTIFY |
| `MESSAGE_CREATE` | New row in `messages`, polled every 1 s |
| `MESSAGE_UPDATE` | Content change on a recently seen message, polled every 2 s |
| `MESSAGE_DELETE` | Soft or hard delete of a recently seen message, polled every 2 s |
| `MESSAGE_REACTION_ADD` | New row in `reactions`, polled every 2 s |
| `MESSAGE_REACTION_REMOVE` | Deleted row in `reactions`, polled every 2 s |
| `REFRESH_ATTACHMENTS` | `POST /attachments/refresh`; sent only to the bridge bot that authored the message |

Message and reaction events go to every bot with an active installation holding `read_messages` that sees the channel (`botCanSeeChannel`): the installation's `allowed_channel_ids` names it, whatever @everyone's override denies, or, when that column is NULL, @everyone keeps `VIEW_CHANNEL` there after the channel's @everyone override. REST writes addressed by channel or message, typing and bridge registration (op 6) need the same visibility; REST writes also need the write's bit (`SEND_MESSAGES`, `ADD_REACTIONS`, `MANAGE_MESSAGES`) after @everyone's override, unless `allowed_channel_ids` names the channel (`botCanWriteChannel`). The @everyone layer is cached per channel for 10 seconds. Encrypted messages produce no `MESSAGE_CREATE` or `MESSAGE_UPDATE`. Direct messages produce no events. The installation lookup is cached per server for 5 minutes, so permission changes and removals reach event delivery within that time; REST checks read the database on every request.

## Operational notes

- The dispatcher starts from the process start time. Messages and reactions created while the service is down are never dispatched.
- Connections, bridge member lists and the attachment-refresh dedupe live in process memory. A second replica shares none of it; run one instance. Bridge presence updates (op 7) change the cached member lists in place; the web client reads them through `/bridged-users/*`.
- IDENTIFY writes `bot_presence` (status `online`, connection time) and `bots.last_online_at`. Heartbeats update `bot_presence.last_heartbeat_at` and `latency_ms`. Disconnects set `bot_presence.status` to `offline`. The web client treats a bot as online only while its last heartbeat is under 90 s old, so a process that exits without closing its sockets does not leave bots shown online.
- REST writes `bot_audit_log` rows for message send, edit and delete; channel, category and role creation; role update and delete; and emoji creation.
- `SIGTERM` and `SIGINT` close all sockets with code 1000, stop polling and exit. The process exits with status 1 if shutdown takes longer than 10 s.

## Source layout

```
bot-gateway/
├── Dockerfile
├── .env.example
├── package.json
├── tsconfig.json
├── tsconfig.typecheck.json
├── vitest.config.ts              # unit tests
├── vitest.db.config.ts           # database contract tests
├── src/
│   ├── index.ts                  # HTTP server, /gateway mount, /api/v1 mount, web-client routes
│   ├── config/supabase.ts        # Service-role client, environment
│   ├── auth/BotAuthMiddleware.ts # Bot token verification, per-route rate limiting
│   ├── auth/botPermissions.ts    # Bot permission bits, channel visibility, role caps
│   ├── api/BotRestAPI.ts         # /api/v1 routes
│   ├── gateway/
│   │   ├── WebSocketGateway.ts   # Connections, IDENTIFY, heartbeats, bridge member lists
│   │   └── EventDispatcher.ts    # Polling, event fan-out
│   └── utils/
│       ├── mirrorExternalMedia.ts # Bridge attachment policy
│       └── TTLCache.ts           # Bounded TTL cache
└── tests/db/gatewayRpcContract.test.ts
```

Unit tests sit in `__tests__/` next to the code they cover.

## Tests

```bash
npm test           # unit tests; Supabase is mocked, no services required
npm run test:db    # requires Docker
npm run type-check
```

`npm run test:db` builds a Postgres database from `../db_schema/migrations/` in a container and calls the RPCs the gateway depends on (`verify_bot_token`, `check_and_increment_bot_rate_limit`, `create_federated_emoji`) through psql, checks every RPC name and argument the source uses against the schema, and verifies that a token issued by `create_bot` authenticates under the hash the gateway computes.

## License

GNU AGPL-3.0, as the rest of the repository (see the root `LICENSE`).
