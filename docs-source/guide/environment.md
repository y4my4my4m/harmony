# Environment Variables

Each Harmony service reads its own environment. The self-host stack writes all of it: `self-host/configure.sh` (run by the installer) generates `self-host/.env`, `federation.env`, `bot-gateway.env`, `discord-bridge.env`, `livekit.yaml` and `supabase/.env`, and re-running it keeps every value already present. See [Self-Hosting](/self-hosting) for that flow. This page is the reference for every variable the code reads.

## Web app

The web app takes its instance values from `/config.json` at page load and falls back to the `VITE_*` values Vite inlined at build time (`src/services/runtimeConfig.ts`). A non-empty key in `/config.json` wins over the build value.

- **Web image** (`ghcr.io/y4my4my4m/harmony-web`): the entrypoint `self-host/web-entrypoint.d/40-harmony-config.sh` writes `/config.json` from the container environment at start. A change needs a container restart, not a rebuild. Each key reads the container variable below, then the same name with the `VITE_` prefix.
- **Static build** (`npm run build-only`, served by any web server): the `VITE_*` values in `.env` at build time apply. A `config.json` next to `index.html`, served as `application/json`, overrides them without a rebuild.
- **Native clients** (desktop, Android) ignore both: they read the chosen instance's settings from `GET /api/federation/instance-info`.

| `config.json` key | Container variable | Build variable | Meaning |
|---|---|---|---|
| `supabaseUrl` | `SUPABASE_URL` | `VITE_SUPABASE_URL` | Public Supabase API URL (Kong), e.g. `https://db.chat.example.com`. Required |
| `supabaseAnonKey` | `SUPABASE_ANON_KEY` | `VITE_SUPABASE_ANON_KEY` | Supabase anon key. Required |
| `domain` | `DOMAIN`, else `INSTANCE_DOMAIN` | `VITE_DOMAIN` | Host part of local handles and ActivityPub ids. Default: the page's host name |
| `instanceDomain` | `INSTANCE_DOMAIN`, else `domain` | `VITE_INSTANCE_DOMAIN` | Instance domain used until `instance_config` loads |
| `instanceName` | `INSTANCE_NAME` | `VITE_INSTANCE_NAME` | Display name used until `instance_config` loads. Default `Harmony` |
| `appUrl` | `APP_URL` | `VITE_APP_URL` | Public origin of the web app; base of invite links. Default: the page origin |
| `federationUrl` | `FEDERATION_URL` | `VITE_FEDERATION_URL` | Public origin of the federation backend; base of the Ko-fi webhook URL shown in the admin panel. Default: the page origin |
| `storageDomain` | `STORAGE_DOMAIN` | `VITE_STORAGE_DOMAIN` | Comma-separated hosts, besides the Supabase URL's, that serve this instance's storage; image transforms apply to their URLs |
| `altDomains` | `HARMONY_ALT_DOMAINS` | `VITE_HARMONY_ALT_DOMAINS` | Comma-separated alternate host names of this instance, treated as local by embed detection |
| `termsUrl` | `TERMS_URL` | `VITE_TERMS_URL` | Terms of service link on the registration page. The admin panel sets it too |
| `privacyUrl` | `PRIVACY_URL` | `VITE_PRIVACY_URL` | Privacy policy link on the registration page |
| `oauthProviders` | `ENABLED_OAUTH_PROVIDERS` | `VITE_ENABLED_OAUTH_PROVIDERS` | Comma-separated OAuth providers (`google`, `github`, `twitch`) offered on sign-in when `instance_config` names none. Each also needs its `GOTRUE_EXTERNAL_*` settings in Supabase Auth |

Build-only variables:

| Variable | Meaning |
|---|---|
| `VITE_DEBUG_LOGGING` | `true` runs `debug.log`/`warn`/`info` in development builds. Production builds never run them |
| `VITE_DEFAULT_INSTANCE_URL` | Native clients: instance pre-filled in the first-launch picker (e.g. `https://har.mony.lol`). Unset leaves the field blank. CI reads it from the `DEFAULT_INSTANCE_URL` repository variable |

No other `VITE_` variable is read. Voice availability and the LiveKit URL come from the federation backend (`GET /api/livekit/config`), the Web Push key from `GET /api/federation/push/vapid-key`, and the GIF provider keys stay on the backend.

## Federation backend

`federation-backend/.env` (copy `federation-backend/env.template`), or `self-host/federation.env` in the self-host stack. `federation-backend/src/config/index.ts` validates the environment at start; an invalid value stops the process with the variable named.

### Required

| Variable | Meaning |
|---|---|
| `SUPABASE_URL` | Supabase API URL as the backend reaches it: `http://supabase-kong:8000` on the self-host Docker network, the public URL otherwise |
| `SUPABASE_ANON_KEY` | Supabase anon key; `/instance-info` hands it to native clients |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `INSTANCE_DOMAIN` | Public domain without scheme, e.g. `chat.example.com`. ActivityPub ids derive from it |

### Server

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production` or `test` |
| `PORT` | `3001` | HTTP port |
| `FEDERATION_MODE` | `unified` | `server` (HTTP only), `worker` (queues only, no HTTP) or `unified` (both in one process) |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated browser origins. Tauri origins are always allowed |
| `TRUST_PROXY` | `loopback, uniquelocal` | Express `trust proxy`: peers trusted to name the client in `X-Real-IP`. Rate limits key on that address, so the reverse proxy must set `X-Real-IP` on every location proxied to the backend |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `INSTANCE_NAME` | `Harmony` | Name in `/health` and `/instance-info`, and in NodeInfo when `instance_config` has none |
| `INSTANCE_DESCRIPTION` | `A federated social platform` | NodeInfo description when `instance_config` has none |
| `PUBLIC_SUPABASE_URL` | `SUPABASE_URL` | Public Supabase URL: storage URLs handed to other instances and the `supabaseUrl` native clients read from `/instance-info`. Set it whenever `SUPABASE_URL` is an internal address |
| `SUPABASE_REALTIME_URL` | unset | Realtime endpoint override |

### Queue and database

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | BullMQ queues, cache, presence and rate limits |
| `USE_BULLMQ_QUEUE` | `true` | `false` processes database events through a Supabase Realtime subscription instead of the queue: no job persistence, and events raised while the worker is down are missed. `USE_PGBOSS_QUEUE` is read when this is unset |
| `FEDERATION_LISTENER_URL` | unset | Direct, session-mode Postgres URL (port 5432, not a transaction pooler) on which the worker runs `LISTEN federation_jobs` for instant job pickup. Use the least-privilege `harmony_listener` role. Unset, the 60 s sweep and the 30 s delivery retry pick jobs up |
| `DATABASE_URL` | unset | Read when `FEDERATION_LISTENER_URL` is unset |

### Federation and media

| Variable | Default | Meaning |
|---|---|---|
| `REQUIRE_VALID_SIGNATURES` | `true` | `false` accepts unsigned inbound activities. Refused with `NODE_ENV=production` |
| `MEDIA_URL_SECRET` | derived from the service role key | HMAC key, 32 characters or more, of the chat attachment URLs sent to other instances. Rotating it invalidates URLs already delivered |
| `MEDIA_PUBLIC_BASE_URL` | `https://<INSTANCE_DOMAIN>/api/federation` | Public prefix of this backend in those URLs |
| `INTERNAL_API_SECRET` | service role key | Bearer secret of `POST /link-preview/enrich-message`. Must equal the bot gateway's |

### Push notifications

| Variable | Meaning |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push key pair (browsers, the PWA, UnifiedPush). Unset disables those transports. Subscriptions are bound to the public key: changing the pair invalidates every subscription |
| `VAPID_SUBJECT` | Contact address, `admin@example.com` or `mailto:admin@example.com`; must be an email address |
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase service account JSON, raw or base64, for the Android app over FCM |
| `FCM_SERVICE_ACCOUNT_FILE` | Path to that JSON file. `FCM_SERVICE_ACCOUNT_JSON` wins when both are set |
| `PUSH_ALLOW_PRIVATE_ENDPOINTS` | `true` accepts push endpoints on private, loopback or link-local addresses (a UnifiedPush distributor on the LAN). Default `false` |

Details: [Push Notifications](/PUSH_NOTIFICATIONS).

### Voice and video (LiveKit)

| Variable | Default | Meaning |
|---|---|---|
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | unset | A key pair from `keys` in `livekit.yaml` |
| `LIVEKIT_URL` | unset | LiveKit as the backend reaches it, e.g. `ws://livekit:7880`. LiveKit counts as configured when key, secret and URL are all set |
| `LIVEKIT_PUBLIC_URL` | `LIVEKIT_URL` | URL clients connect to, e.g. `wss://live.chat.example.com`; served by `GET /api/livekit/config` |
| `WEBRTC_MODE` | `hybrid` | `sfu` (LiveKit), `p2p`, or `hybrid` (LiveKit when configured, else peer-to-peer) |
| `ALLOW_FEDERATED_VOICE` | `true` | Voice and video calls with users on other instances |
| `VOICE_RECONCILE_INTERVAL_SECONDS` | `60` | Worker: seconds between checks of `voice_channel_participants` against the LiveKit rooms; `0` disables. A row whose profile is not in the channel's room two minutes after joining is removed. Off without LiveKit or with `WEBRTC_MODE=p2p` |

LiveKit webhooks remove a dropped client within seconds. In `livekit.yaml`, `webhook.api_key` is `LIVEKIT_API_KEY` and `webhook.urls` reaches the federation server's `/api/livekit/webhook` (`http://federation-server:3001/api/livekit/webhook` on the self-host network, `https://<domain>/api/livekit/webhook` through the reverse proxy). The backend verifies each call with `LIVEKIT_API_SECRET`.

### GIFs and AI emoji

| Variable | Meaning |
|---|---|
| `KLIPY_API_KEY_ADS` | Klipy key with ads enabled, served to regular users |
| `KLIPY_API_KEY_NOADS` | Klipy key without ads, served to supporters whose tier removes ads. With one key set it serves everyone; with neither, GIF search is off |
| `KLIPY_BASE_URL` | Default `https://api.klipy.com` |
| `AI_EMOJI_WEBHOOK_SECRET` | Token in the AI emoji callback URL. Default: derived from the service role key |

## Bot gateway

`bot-gateway/.env`, or `self-host/bot-gateway.env` in the self-host stack.

| Variable | Default | Meaning |
|---|---|---|
| `SUPABASE_URL` | required | Supabase API URL as the gateway reaches it |
| `SUPABASE_SERVICE_ROLE_KEY` | required | Supabase service role key |
| `PUBLIC_URL` | `SUPABASE_URL` | Public Supabase URL, substituted for `SUPABASE_URL` in the storage URLs (avatars, attachments) handed to bots and bridges |
| `INSTANCE_DOMAIN` | `localhost:3000` | Base of the bridge pairing URLs: `https://<INSTANCE_DOMAIN>/bot-gateway` and `wss://<INSTANCE_DOMAIN>/bot-gateway/gateway` |
| `FEDERATION_BACKEND_URL` | `http://localhost:3001` | Federation backend that builds link previews of bot messages. The gateway sends its secret only to an `https` URL or to `localhost`/`127.0.0.1` |
| `INTERNAL_API_SECRET` | service role key | Must equal the federation backend's |
| `PORT` | `3002` | HTTP and WebSocket port |
| `NODE_ENV` | `development` | |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Requests per window |
| `WS_HEARTBEAT_INTERVAL` | `30000` | Gateway heartbeat, ms |
| `WS_MAX_CONNECTIONS_PER_BOT` | `5` | Concurrent gateway sessions per bot |
| `WS_REVALIDATE_INTERVAL_MS` | `30000` | Token and bot recheck of open sessions, clamped to 1000-60000 ms |

Discord bridge hosting, read by the bridge v2 gateway:

| Variable | Default | Meaning |
|---|---|---|
| `BRIDGE_HOST_SECRET` | unset | At least 32 characters; must equal the bridge host's. `GET /bridge/v2/hosted` answers 404 while it is unset or shorter, or while hosting is disabled in Admin, Instance |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express `trust proxy`. A number is a hop count; `true`/`false` are booleans |
| `BRIDGE_CONFIG_POLL_MS` | `5000` | Interval of the bridge configuration poll, clamped to 1000-60000 ms |

## LiveKit

The LiveKit server reads only its YAML file. `webrtc/livekit.yaml.example` is the template; `self-host/configure.sh` fills it in as `self-host/livekit.yaml`. The values that must agree with the federation backend are `keys` (`LIVEKIT_API_KEY: LIVEKIT_API_SECRET`), `webhook.api_key` and `webhook.urls`. See `webrtc/README.md`.

## Integration tests (`.env.test`)

Copy `.env.test.example`.

| Variable | Meaning |
|---|---|
| `TEST_SUPABASE_URL` | Supabase API URL of the test stack |
| `TEST_SUPABASE_ANON_KEY` | Its anon key |
| `TEST_SUPABASE_SERVICE_ROLE_KEY` | Its service role key |
| `TEST_DATABASE_URL` | Direct PostgreSQL connection for database tests |

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/environment.md` and run `npm run docs:generate-guide` to update.
