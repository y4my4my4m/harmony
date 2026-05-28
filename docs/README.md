# Harmony documentation

The user-facing docs are a VitePress site rooted at `docs/`. To preview locally:

```bash
npm run docs:dev
```

The dev server listens on port 3001 - same port as `federation-backend`, so don't run both at once unless you change one.

## How documentation is built

| What | Where to edit | Regenerate |
|------|----------------|------------|
| Guide (hand-written) | `docs-source/guide/` at repo root | `npm run docs:generate-guide` → writes `docs/guide/` |
| API reference | Generated from TypeScript | `npm run docs:generate-api` |
| Components | Generated from Vue | `npm run docs:generate-components` |
| Typedoc bundle | `typedoc.json` | `npm run docs:generate` |
| VitePress nav/sidebar | After changing generated trees | `npm run docs:sync-config` |

Full pipeline (guides + API + components + sync + typedoc + static build): `npm run docs:generate-all`. Setup details: [VITEPRESS_SETUP.md](./VITEPRESS_SETUP.md).

**Do not edit `docs/guide/` by hand** - change `docs-source/guide/` and run `docs:generate-guide`. `docs/guide/`, `docs/api/`, `docs/components/`, and `docs/generated/` are all `.gitignore`d and regenerated on demand.

## Documentation index

- [Architecture Overview](./ARCHITECTURE.md)
- [Development Guide](./DEVELOPMENT.md)
- [API Reference](./API_REFERENCE.md)
- [Federation System](./FEDERATION.md)
- [Component Library](./COMPONENTS.md)
- [State Management](./STATE_MANAGEMENT.md)
- [Service Layer](./SERVICES.md)
- [E2EE Implementation](./E2EE_IMPLEMENTATION.md)
- [Bot API](./bot-api.md)
- [Plugin System](./PLUGIN_SYSTEM.md)
- [ActivityPub Extensions](./ACTIVITYPUB_EXTENSIONS.md)
- [Self-Hosting Guide](./self-hosting.md)
- [Push Notifications](./PUSH_NOTIFICATIONS.md)
- [OpenStatus Setup](./OPENSTATUS_SETUP.md)

## Quick start (app)

```bash
npm install
npm run dev
```

Production:

```bash
npm run build
```

Desktop (Tauri):

```bash
npm run tauri:dev
```

`bun` works too if you prefer it (`bun install`, `bun run dev`); the scripts are written for npm but Bun runs them fine.

## Project layout

```
harmony/
├── src/
│   ├── components/        # Vue components organized by feature
│   ├── layouts/           # Application layout components
│   ├── views/             # Route-level components
│   ├── stores/            # Pinia state stores
│   ├── services/          # Business-logic services
│   ├── composables/       # Vue composition functions
│   ├── utils/             # Utility functions
│   ├── types/             # TypeScript type definitions
│   └── assets/            # Static assets and styles
├── docs/                  # VitePress site + generated API/component docs
├── docs-source/           # Source for guide pages (see "How documentation is built" above)
├── db_schema/             # Database schema and migrations
├── federation-backend/    # Node.js ActivityPub backend
├── bot-gateway/           # Bot API gateway
├── src-tauri/             # Tauri desktop app configuration
└── public/                # Public assets
```

## External links

- [Live application](https://har.mony.lol)
- [GitHub repository](https://github.com/y4my4my4m/harmony)
- [Tauri documentation](https://tauri.app/)
