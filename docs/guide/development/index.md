# Development Workflow

## Getting Started

After [installing](../installation) dependencies, start the dev server:

```bash
npm run dev
```

This starts Vite on `http://localhost:5173` with hot module replacement.

## Project Structure

```
harmony/
├── src/                    # Main Vue 3 application
│   ├── components/         # Vue components by feature
│   ├── composables/        # Vue composables (useXxx)
│   ├── config/             # App configuration
│   ├── directives/         # Custom Vue directives
│   ├── layouts/            # Page layouts (Auth, Chat, Social)
│   ├── locales/            # i18n translation files
│   ├── router/             # Vue Router configuration
│   ├── services/           # Business logic services
│   │   ├── core/           # Core local-only services
│   │   ├── encryption/     # E2EE (Megolm, recovery keys)
│   │   └── federation/     # Federation decision/activity services
│   ├── stores/             # Pinia state stores
│   ├── types/              # TypeScript type definitions
│   ├── utils/              # Utility functions
│   └── views/              # Route-level view components
├── federation-backend/     # Node.js ActivityPub backend
├── bot-gateway/            # Bot API gateway
├── bot-plugins/            # Bot plugin implementations
├── db_schema/              # Database schema and migrations
│   ├── init/               # Fresh install SQL (numbered files)
│   └── migrations/         # Incremental migrations
├── src-tauri/              # Tauri desktop app (Rust)
├── webrtc/                 # LiveKit configuration
├── tests/                  # Integration and E2E tests
├── docs/                   # VitePress documentation site
├── docs-source/            # Guide documentation source
├── scripts/                # Build and generation scripts
└── public/                 # Static assets
```

## Available Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start Vite dev server (port 5173) |
| `npm run build-only` | Production build |
| `npm run preview` | Preview production build |
| `npm run type-check` | TypeScript type checking (`vue-tsc`) |
| `npm run lint` | ESLint with auto-fix |
| `npm run format` | Prettier formatting on `src/` |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:integration` | Integration tests (requires Supabase) |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run tauri:dev` | Desktop app development |
| `npm run tauri:build` | Desktop app production build |

## Code Style

### Formatting

- **Prettier**: No semicolons, single quotes, 100-char width, tab width 2, no trailing commas
- **ESLint**: Vue 3 essential rules + TypeScript

Run both:

```bash
npm run format && npm run lint
```

### TypeScript

- Strict mode enabled
- Path alias: `@/` maps to `src/`
- Vue components use `<script setup lang="ts">` (Composition API preferred)

### Component Guidelines

- Use Composition API with `<script setup>` for new components
- Keep components focused -- extract logic into composables or services
- Use `services` facade for database operations, never call Supabase directly from components
- Props down, events up; use Pinia stores for shared state

## Hot Reload

Vite provides instant HMR for:

- Vue SFC changes (template, script, style)
- TypeScript/JavaScript modules
- CSS/SCSS changes

State is preserved during HMR via Pinia store persistence.

## Type Checking

Run type checking separately (not included in dev server for speed):

```bash
npm run type-check
```

This runs `vue-tsc --build --force` to check all TypeScript and Vue files.

## Documentation

Generate and preview documentation locally:

```bash
# Generate all docs (guide + API + components)
npm run docs:generate-all

# Dev server for docs (port 3001)
npm run docs:dev
```

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/development/index.md` and run `npm run docs:generate-guide` to update.
