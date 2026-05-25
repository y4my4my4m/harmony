# Configuration

Harmony's configuration is split across several layers: frontend environment variables, Vite build config, federation backend config, and database settings.

## Frontend Configuration

### Vite Config (`vite.config.ts`)

The Vite configuration handles:

- **Dev server**: Port 5173 (strict), allowed hosts include `localhost` and custom local domains
- **Path aliases**: `@` maps to `./src` for clean imports
- **Build target**: Chrome 105 (Windows) / Safari 16 (other platforms)
- **Code splitting**: Automatic chunking for Vue, Supabase, and crypto vendor libraries, plus route-based chunks for each view

### TypeScript

The project uses a multi-config TypeScript setup:

- `tsconfig.app.json` - App code (`src/`), extends `@vue/tsconfig/tsconfig.dom.json`
- `tsconfig.node.json` - Build tooling and configs, extends `@tsconfig/node18`
- `tsconfig.json` - Project references combining both

### ActivityPub Config (`src/config/activitypub.ts`)

Federation-specific settings derived from environment variables:

- `domain` - Instance domain from `VITE_DOMAIN`
- `federationApiBase` - API prefix (`/api/federation`)
- `endpoints` - WebFinger, NodeInfo, actor, inbox, outbox paths
- `contentTypes` - ActivityPub MIME types

## Feature Flags

Several features can be toggled via environment variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `VITE_ENABLE_FEDERATION` | `false` | Enables ActivityPub federation UI and features |
| `VITE_ENABLE_VOICE` | `false` | Enables voice/video channel support |
| `VITE_ENABLE_E2E_ENCRYPTION` | `false` | Enables end-to-end encryption for messages |
| `VITE_ENABLED_OAUTH_PROVIDERS` | `""` | Comma-separated OAuth providers (e.g., `google,github,twitch`) |

## Server Encryption Modes

Each server can configure its encryption mode independently:

| Mode | Behavior |
|------|----------|
| `disabled` | No encryption, all messages are plaintext |
| `optional` | Encryption available; falls back to plaintext if keys unavailable |
| `required` | All messages must be encrypted; blocks send without encryption setup |

## Code Style

### ESLint (`.eslintrc.cjs`)

- Extends: `plugin:vue/vue3-essential`, `eslint:recommended`, `@vue/eslint-config-typescript`
- Prettier integration via `@vue/eslint-config-prettier/skip-formatting`

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

The app uses `vue-i18n` with locale files in `src/locales/`. Language can be changed in user settings.

## Supabase Configuration

The Supabase client is initialized in `src/supabase.ts` using the `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` environment variables. All database access goes through this client with Row Level Security (RLS) enforced on every table.

See [Environment Setup](./environment) for the full list of variables and [Supabase Deployment](./deployment/supabase) for database configuration details.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/configuration.md` and run `npm run docs:generate-guide` to update.
