# Configuration

Harmony's configuration lives in four places: the environment of each service, the Vite build, the database (`instance_config`, set from the admin panel) and per-server settings. [Environment Variables](./environment) lists every variable; this page covers how the pieces fit.

## Instance settings

`public.instance_config` holds the instance's name, description, domain, rules, registration, limits, federation settings and legal links, and the admin panel (`/admin`, Instance) edits it. The environment supplies only the values needed before the database answers.

`instance_config.domain` must be the public domain. The local link-preview trigger and the web app's ActivityPub ids read it. The self-host `bootstrap.sh` writes it on a new database from `DOMAIN` in `self-host/.env`; any other install sets it once:

```sql
UPDATE public.instance_config
   SET config_value = to_jsonb('chat.example.com'::text)
 WHERE config_key = 'domain';
```

## Frontend

### Runtime configuration (`src/services/runtimeConfig.ts`)

The web app reads `/config.json` before it mounts and falls back to the `VITE_*` values inlined at build time. One bundle therefore serves any instance: the web image writes `/config.json` from its container environment at start. Native clients skip it and read the chosen instance's `GET /api/federation/instance-info` instead.

### Vite (`vite.config.ts`)

- **Dev server**: port 5173 (strict), bound to `0.0.0.0` (`TAURI_DEV_HOST` overrides), any host allowed.
- **Dev proxy**: `/api/federation/*` goes to `http://localhost:3001` with the `/api/federation` prefix stripped; `/api/livekit/*` goes to `http://localhost:3001` unchanged.
- **Path alias**: `@` maps to `./src`.
- **Build target**: `chrome105` when `TAURI_PLATFORM=windows`, `safari16` otherwise.
- **Chunks**: vendor chunks (`vue-vendor`, `supabase-vendor`, `crypto-vendor`, `vendor`); routes split at their dynamic imports and are not preloaded.

### TypeScript

- `tsconfig.app.json`: app code (`src/`), extends `@vue/tsconfig/tsconfig.dom.json`
- `tsconfig.node.json`: Vite, Vitest and Playwright configs, extends `@tsconfig/node18`
- `tsconfig.json`: project references combining both

### ActivityPub (`src/config/activitypub.ts`)

- `domain`: the runtime `domain` (`VITE_DOMAIN`), else the page's host name
- `federationApiUrl`: `/api/federation`
- `endpoints`: WebFinger, NodeInfo, actor and inbox paths
- `contentTypes`: ActivityPub media types

### Supabase client (`src/supabase.ts`)

The client is created from the runtime `supabaseUrl` and `supabaseAnonKey` (native clients: the stored instance's). A web build without either throws at start. Row Level Security applies to every table the client touches.

## OAuth providers

The sign-in page offers the providers `instance_config` enables, else those in `ENABLED_OAUTH_PROVIDERS` / `VITE_ENABLED_OAUTH_PROVIDERS` (`google`, `github`, `twitch`). Each provider also needs its client credentials in Supabase Auth (`GOTRUE_EXTERNAL_<PROVIDER>_*`).

## Link previews

Link previews are stored on the message, in `metadata.embeds`, and need no configuration beyond a running federation worker.

- **This instance's own post URLs**: the `BEFORE INSERT` trigger `process_local_link_previews` on `messages` fills them in from the database, using `instance_config.domain`.
- **Every other URL**: a channel message from a local author in an unencrypted channel, or a DM, queues a federation job (`federate-channel-message`, `federate-dm`). The worker's job handlers fetch the previews through the backend's SSRF-guarded fetcher and write them with the `update_message_embeds` RPC; Realtime carries the update to clients. Posts take the same path through the post job handler. With `USE_BULLMQ_QUEUE=false`, the worker's Realtime listener does the same work.
- **Bot and bridge messages**: right after inserting one, the bot gateway calls `POST <FEDERATION_BACKEND_URL>/link-preview/enrich-message` with `Authorization: Bearer <INTERNAL_API_SECRET>`, so the preview does not wait for the queue.
- A URL part with `preview: false` is skipped.

The self-host stack writes the same `INTERNAL_API_SECRET` into `federation.env` and `bot-gateway.env` and points `FEDERATION_BACKEND_URL` at `https://<domain>`. A manual install proxies `/link-preview` to the backend (`dev/nginx-harmony.template.conf` does), sets one `INTERNAL_API_SECRET` on both services, and gives the gateway an `https` or `localhost` `FEDERATION_BACKEND_URL`.

## Server encryption modes

Each server sets an encryption floor for its channels (`server_encryption_settings`):

| `encryption_mode` | Behavior |
|---|---|
| `disabled` | No channel encrypts messages |
| `optional` | Each channel opts in to message encryption |
| `required` | Every channel encrypts messages. `required_local_only` is a stored variant the settings page shows as `required` |

`voice_encryption_mode` is `disabled` or `required`. `required` encrypts voice end to end in every channel; otherwise, under any `encryption_mode` but `disabled`, each channel opts in.

## Code style

### ESLint (`.eslintrc.cjs`)

- Extends `plugin:vue/vue3-essential`, `eslint:recommended`, `@vue/eslint-config-typescript` and `@vue/eslint-config-prettier/skip-formatting`
- `unused-imports` reports unused imports and variables; names starting with `_` are exempt

### Prettier (`.prettierrc.json`)

```json
{
  "semi": false,
  "tabWidth": 2,
  "singleQuote": true,
  "printWidth": 100,
  "trailingComma": "none"
}
```

## Internationalization

`vue-i18n` with locale files in `src/locales/`, loaded on demand (`src/i18n.ts`). Users pick the language in their settings.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/configuration.md` and run `npm run docs:generate-guide` to update.
