# Development Guide

## Overview

Welcome to the Harmony development guide! This document provides everything you need to know to contribute to Harmony, from setting up your development environment to understanding our coding standards and deployment processes.

## Quick Start

### Prerequisites

- **Node.js**: Version 24, as pinned in `.nvmrc`
- **npm**: Bundled with Node; the only supported package manager (scripts and `package-lock.json` assume it)
- **Git**: For version control
- **VS Code**: Recommended editor with suggested extensions

### Installation

```bash
# Clone the repository
git clone https://github.com/y4my4my4m/harmony.git
cd harmony

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start development server
npm run dev
```

### Environment Variables

Create a `.env` file with the following variables:

```bash
# Supabase Configuration
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key

# Optional: Development overrides
VITE_DEV_MODE=true
VITE_DEBUG_FEDERATION=true
VITE_DEBUG_VOICE=true
```

## Project Structure

```bash
harmony/
├── src/                    # Vue 3 application source
│   ├── components/         # Vue components organized by feature
│   │   ├── common/        # Shared components
│   │   ├── chat/          # Chat-specific components
│   │   ├── voice/         # Voice/video components
│   │   └── activitypub/   # Social / federation UI
│   ├── layouts/           # Application layouts
│   ├── views/             # Route-level components
│   ├── stores/            # Pinia state stores
│   ├── services/          # Business logic services
│   ├── composables/       # Vue composition functions
│   ├── utils/             # Utility functions
│   ├── types/             # TypeScript type definitions
│   └── assets/            # Static assets and styles
├── docs/                  # VitePress site + generated API/component docs
├── docs-source/           # Source for guide pages (edit these)
├── db_schema/             # Database schema and migrations (init/ + migrations/)
├── federation-backend/    # Node.js ActivityPub backend (server + worker)
├── bot-gateway/           # Bot API gateway
├── bot-plugins/           # Bot plugin implementations (e.g. discord-bridge)
├── src-tauri/             # Tauri desktop app configuration (Rust)
├── public/                # Public assets (backgrounds, emoji packs, icons)
└── tests/                 # Integration and E2E tests
```

## Development Workflow

### Branch Strategy

We use a simple, master-as-trunk flow:

- **`master`**: Production / default branch. PRs target this directly.
- **`feature/*`**: Individual feature branches
- **`bugfix/*`**: Bug fixes
- **`security/*`**: Security-related fixes (please coordinate via [SECURITY.md](https://github.com/y4my4my4m/harmony/blob/master/SECURITY.md))

See [ROADMAP.md](https://github.com/y4my4my4m/harmony/blob/master/ROADMAP.md) for what we want to ship next and [BUGS.md](https://github.com/y4my4my4m/harmony/blob/master/BUGS.md) for currently tracked defects.

### Development Process

1. **Create Feature Branch**
   ```bash
   git checkout master
   git pull origin master
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes**
   - Write code following our style guide
   - Add tests for new functionality
   - Update documentation if needed

3. **Test Changes**
   ```bash
   # Run linting
   npm run lint

   # Run type checking
   npm run type-check

   # Run tests
   npm run test

   # Build project
   npm run build
   ```

4. **Commit Changes**
   ```bash
   git add .
   git commit -m "feat: add new feature description"
   ```

5. **Push and Create PR**
   ```bash
   git push origin feature/your-feature-name
   # Open a pull request against master on GitHub
   ```

### Commit Message Convention

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```bash
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```bash
feat(chat): add message reactions functionality
fix(voice): resolve audio connection issues
docs(api): update authentication documentation
refactor(stores): simplify user data management
```

## Component Development

### Component Structure

Follow this structure for new components:

```vue
<template>
  <div class="component-name">
    <!-- Template content -->
  </div>
</template>

<script setup lang="ts">
/**
 * @fileoverview Component description
 * @author Your Name
 */

import { ref, computed, onMounted } from 'vue'
import type { ComponentProps } from '@/types'

// Props definition
interface Props {
  required: string
  optional?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  optional: false
})

// Emits definition
interface Emits {
  (e: 'update', value: string): void
  (e: 'close'): void
}

const emit = defineEmits<Emits>()

// Reactive state
const loading = ref(false)

// Computed properties
const computedValue = computed(() => {
  return `Processed: ${props.required}`
})

// Lifecycle hooks
onMounted(() => {
  console.log('Component mounted')
})

// Methods
const handleAction = () => {
  emit('update', 'new value')
}
</script>

<style scoped>
.component-name {
  /* Component styles */
}
</style>
```

### Component Guidelines

1. **Use TypeScript**: Always define proper interfaces for props and emits
2. **Composition API**: Use the Composition API for all new components
3. **Scoped Styles**: Use scoped styles to prevent CSS leakage
4. **Accessibility**: Follow WCAG guidelines for accessibility
5. **Performance**: Use `v-memo` and `v-once` for performance optimization

### Creating Reusable Components

```typescript
// src/components/common/Button.vue
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  loading?: boolean
}

const props = withDefaults(defineProps<ButtonProps>(), {
  variant: 'primary',
  size: 'md',
  disabled: false,
  loading: false
})
```

## State Management

### Creating Stores

Use Pinia for state management:

```typescript
// src/stores/useExample.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useExampleStore = defineStore('example', () => {
  // State
  const items = ref<Item[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Getters (computed)
  const itemCount = computed(() => items.value.length)
  const hasItems = computed(() => itemCount.value > 0)

  // Actions
  const fetchItems = async () => {
    loading.value = true
    error.value = null
    
    try {
      const response = await api.getItems()
      items.value = response.data
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  const addItem = (item: Item) => {
    items.value.push(item)
  }

  const removeItem = (id: string) => {
    const index = items.value.findIndex(item => item.id === id)
    if (index > -1) {
      items.value.splice(index, 1)
    }
  }

  return {
    // State
    items,
    loading,
    error,
    
    // Getters
    itemCount,
    hasItems,
    
    // Actions
    fetchItems,
    addItem,
    removeItem
  }
})
```

### Store Best Practices

1. **Single Responsibility**: Each store should handle one domain
2. **Reactive State**: Use `ref()` for reactive state
3. **Computed Properties**: Use `computed()` for derived state
4. **Error Handling**: Always handle errors in actions
5. **TypeScript**: Define proper types for all state

## Testing

### Testing Strategy

We use a comprehensive testing approach:

- **Unit Tests**: Individual functions and components
- **Integration Tests**: Component interactions and API calls
- **E2E Tests**: Full user workflows

### Setting Up Tests

```bash
# Testing dependencies are installed by `npm install`
# (vitest, @vue/test-utils, happy-dom, fake-indexeddb, msw, etc.)

# Run unit tests
npm run test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Vitest UI
npm run test:ui

# Integration tests (requires `supabase start`)
npm run test:integration

# E2E tests (Playwright)
npm run test:e2e
```

### Writing Component Tests

```typescript
// tests/components/Button.test.ts
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import Button from '@/components/common/Button.vue'

describe('Button Component', () => {
  it('renders correctly', () => {
    const wrapper = mount(Button, {
      props: {
        variant: 'primary'
      },
      slots: {
        default: 'Click me'
      }
    })

    expect(wrapper.text()).toBe('Click me')
    expect(wrapper.classes()).toContain('btn-primary')
  })

  it('emits click event', async () => {
    const wrapper = mount(Button)
    
    await wrapper.trigger('click')
    
    expect(wrapper.emitted('click')).toBeTruthy()
  })

  it('disables when loading', () => {
    const wrapper = mount(Button, {
      props: {
        loading: true
      }
    })

    expect(wrapper.find('button').attributes('disabled')).toBeDefined()
  })
})
```

### Writing Store Tests

```typescript
// tests/stores/useExample.test.ts
import { createPinia, setActivePinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useExampleStore } from '@/stores/useExample'

describe('Example Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('initializes with empty state', () => {
    const store = useExampleStore()
    
    expect(store.items).toEqual([])
    expect(store.loading).toBe(false)
    expect(store.error).toBe(null)
  })

  it('adds items correctly', () => {
    const store = useExampleStore()
    const item = { id: '1', name: 'Test Item' }
    
    store.addItem(item)
    
    expect(store.items).toContain(item)
    expect(store.itemCount).toBe(1)
  })
})
```

## Styling Guidelines

### CSS Architecture

We use a component-based CSS architecture:

1. **Design System**: Global design tokens
2. **Component Styles**: Scoped component styles
3. **Utility Classes**: Helper classes for common patterns

### Design System Usage

```vue
<style scoped>
.component {
  /* Use design system variables */
  background-color: var(--background-primary);
  color: var(--text-primary);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  
  /* Use design system breakpoints */
  @media (max-width: 768px) {
    padding: var(--spacing-sm);
  }
}
</style>
```

### CSS Best Practices

1. **Use CSS Variables**: Leverage the design system
2. **BEM Methodology**: Use BEM for class naming
3. **Mobile First**: Write mobile-first responsive styles
4. **Performance**: Minimize CSS bundle size
5. **Accessibility**: Ensure sufficient color contrast

## Service Development

### Creating Services

Services encapsulate business logic:

```typescript
// src/services/ExampleService.ts
import { supabase } from '@/supabase'

export class ExampleService {
  /**
   * Get items from the database
   */
  async getItems(): Promise<Item[]> {
    const { data, error } = await supabase
      .from('items')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      throw new Error(`Failed to fetch items: ${error.message}`)
    }

    return data
  }

  /**
   * Create a new item
   */
  async createItem(item: CreateItemData): Promise<Item> {
    const { data, error } = await supabase
      .from('items')
      .insert(item)
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to create item: ${error.message}`)
    }

    return data
  }

  /**
   * Update an existing item
   */
  async updateItem(id: string, updates: Partial<Item>): Promise<Item> {
    const { data, error } = await supabase
      .from('items')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to update item: ${error.message}`)
    }

    return data
  }
}

// Export singleton instance
export const exampleService = new ExampleService()
```

### Service Guidelines

1. **Single Responsibility**: Each service handles one domain
2. **Error Handling**: Throw descriptive errors
3. **TypeScript**: Define proper types for all methods
4. **Testing**: Write comprehensive tests for services
5. **Documentation**: Document all public methods

## Documentation

### Code Documentation

Use JSDoc for code documentation:

```typescript
/**
 * Sends a message to a channel
 * 
 * @param channelId - The ID of the channel
 * @param content - The message content
 * @param options - Additional message options
 * @returns Promise that resolves to the created message
 * 
 * @example
 * ```typescript
 * const message = await services.messages.sendMessage('channel-1', 'Hello!', {
 *   attachments: ['file-1.jpg']
 * })
 * ```
 */
async sendMessage(
  channelId: string, 
  content: string, 
  options: SendMessageOptions = {}
): Promise<Message> {
  // Implementation
}
```

### API Documentation

Generate API documentation using TypeDoc:

```bash
# Generate everything (guides + components + API + sync + typedoc + static build)
npm run docs:generate-all

# Or just the typedoc bundle
npm run docs:generate

# Live-reload VitePress site (port 3001)
npm run docs:dev

# Serve the typedoc bundle on port 8080
npm run docs:serve
```

### Writing Markdown Documentation

Follow these guidelines for Markdown documentation:

1. **Clear Structure**: Use proper heading hierarchy
2. **Code Examples**: Include practical examples
3. **Screenshots**: Add screenshots for UI features
4. **Links**: Link to related documentation
5. **Keep Updated**: Update docs with code changes

## Building and Deployment

### Development Build

```bash
# Start development server (Vite, port 5173)
npm run dev

# Preview production build
npm run preview
```

### Production Build

```bash
# Build for production (writes to ./dist)
npm run build

# Type check
npm run type-check

# Lint code
npm run lint
```

### Desktop App Build

```bash
# Start desktop development
npm run tauri:dev

# Build desktop app
npm run tauri:build

# Build for Windows (cross-compile)
npm run tauri:build:windows
```

### Deployment Process

There is no separate `develop` branch. Releases are cut from `master`:

```bash
# Land your PR on master via the normal review flow,
# then tag a release from a clean master:

git checkout master
git pull origin master
git tag v1.0.0
git push origin master --tags
```

A `v*` tag triggers `.github/workflows/release.yml`, which builds the Windows
and macOS installers and the Android APK into a draft GitHub release:

| Job | Runs after | Does |
| --- | --- | --- |
| `release` | | Stamps the tag's version, names the assets, finds or drafts the release and deletes any `latest.json` on it |
| `desktop` (Windows, macOS) | `release` | Builds and uploads the installer, plus the updater payload and `.sig` when signing is configured |
| `latest-json` | `release`, `desktop` | Writes `latest.json` from the release's uploaded payloads and `.sig` files, once |
| `android` | `desktop` | Builds and attaches the APK |

`latest-json` runs only when every desktop build succeeded and signing is
configured, and fails without uploading when a payload or signature is
missing, so a release carries either a manifest for both platforms or none.
Re-running the workflow for a tag reuses its release and replaces each asset.
A manual run (Actions > Release > Run workflow, with an existing tag) builds
the tag's tree but runs `scripts/name-artifact.sh` and
`scripts/github-release.mjs` from the workflow's own commit, so tags that
predate them build too.

### Desktop auto-updates

The Windows and macOS apps update in place through `tauri-plugin-updater`.
They poll `releases/latest/download/latest.json`, which GitHub resolves to
the newest published, non-prerelease release, so publishing the draft is the
rollout. Payloads are verified against the minisign public key in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

Signing needs two repository secrets, `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and the matching public key committed in
place of the `HARMONY_UPDATER_PUBKEY` placeholder. Generate the pair once with
`npx tauri signer generate -w ~/.tauri/harmony-updater.key`, store the key file
contents and password as the secrets, and paste the `.pub` contents into the
config. When either half is missing, the release still ships installers but
skips updater artifacts with a workflow warning, and builds carrying the
placeholder disable the updater at runtime.

Losing the private key or its password strands installed apps: they accept
only payloads signed by that key. Rotating it means shipping one release with
the new public key, signed by the old key.

Linux has no release build, so there is no AppImage to update; the updater
reports itself unsupported outside an AppImage. Android is outside the
plugin's scope and shows a notice linking the latest release's APK instead.

### Native builds in CI

`.github/workflows/tauri.yml` builds the Windows installer, the macOS dmg and
the Android APK on every push to `master` that changes anything outside
Markdown files, `docs/` and `federation-backend/`. Pull requests and other
branches build only on request: Actions > Tauri > Run workflow, then pick the
branch under "Use workflow from", the platforms and the profile. From the
command line:

```bash
gh workflow run tauri.yml --ref my-branch \
  -f windows=false -f macos=false -f android=true -f profile=debug
```

A dispatch runs the branch's own copy of `tauri.yml`, so the branch needs a
version with these inputs. A new run on the same branch cancels the one in
progress.

Each build is uploaded as one unzipped artifact named after its file:

| Build | Example |
| --- | --- |
| Release (`v*` tag) | `Harmony_Windows_V1.6.5.exe`, `Harmony_macOS_V1.6.5.dmg`, `Harmony_Android_V1.6.5.apk` |
| `tauri.yml`, release profile | `Harmony_Windows_V1.6.5_dev-master-1a2b3c4.exe` |
| `tauri.yml`, debug profile | `Harmony_Android_V1.6.5_debug-feat-push-1a2b3c4.apk` |

Both workflows take every name from `scripts/name-artifact.sh`: tagged
releases with `--release`, `tauri.yml` without. The version is the one in
`src-tauri/tauri.conf.json`, which `release.yml` stamps from the tag. The
branch keeps `[A-Za-z0-9.-]` and every other run of characters becomes `-`.
An APK built without the signing secrets is a debug build and is named as one,
in releases too (`Harmony_Android_V1.6.5_debug.apk`).

```bash
bash scripts/name-artifact.sh --release macOS release   # Harmony_macOS_V1.6.5
```

Releases also carry the updater files under the same names:
`Harmony_Windows_V<version>.exe.sig`, `Harmony_macOS_V<version>.app.tar.gz`
and its `.sig`. `latest.json` keeps its name and points at those files under
`releases/download/<tag>/`, with the platform keys tauri-action v0.6.2 writes:
`windows-x86_64` and `windows-x86_64-nsis` for the NSIS installer, and
`darwin-aarch64`, `darwin-x86_64`, `darwin-aarch64-app` and
`darwin-x86_64-app` for the universal app. Installed apps read
`<os>-<arch>`. The updater verifies the signature over the downloaded bytes
and detects the installer type from its content, so file names do not affect
installed apps. The `file:` field in a `.sig`'s trusted comment still holds
tauri's original file name; it is signed but not compared with anything.

`node --test scripts/github-release.test.mjs` runs the release scripts against
a stand-in for the GitHub releases API; CI runs it with the unit tests.

### Android push

The Android app receives push while closed through one of two transports, chosen
per device in Settings > Notifications:

- **UnifiedPush**: the user's distributor app (ntfy, NextPush, ...) delivers Web
  Push. The server needs only the VAPID keys it already uses for browsers; the
  endpoint is stored in `push_subscriptions` with `transport = 'unifiedpush'` and
  sent by the same web-push sender.
- **FCM**: needs Google Play Services on the device, `google-services.json` in the
  APK and a Firebase service account on the federation backend.

With neither, the app shows notifications only while running. Taps open the
notification's target, and notifications read on another device are cancelled on
the phone by a `dismiss-push-notifications` job (migration
`20261004100001_push_transports.sql`). The Android side lives in
`src-tauri/crates/tauri-plugin-harmony-push`.

FCM setup, once per Firebase project:

1. In the Firebase console, create a project and add an Android app with package
   name `online.knowmad.harmony`. Download `google-services.json`.
2. Under Project settings > Service accounts, generate a private key (JSON). Check
   that "Firebase Cloud Messaging API (V1)" is enabled under Cloud Messaging.
3. Store `google-services.json` base64-encoded as the `ANDROID_GOOGLE_SERVICES_JSON_BASE64`
   repository secret (`base64 -w 0 google-services.json | gh secret set
   ANDROID_GOOGLE_SERVICES_JSON_BASE64`). `release.yml` writes it into the build;
   `tauri.yml` builds without it.
4. Give the federation server and worker the service account, either as
   `FCM_SERVICE_ACCOUNT_FILE` (path to the JSON, mounted read-only) or as
   `FCM_SERVICE_ACCOUNT_JSON` (the JSON, raw or base64). The log then reads
   `FCM enabled for project <id>` and `GET /api/federation/push/status` reports
   `"fcm": true`.

For a local build with FCM, place `google-services.json` in
`src-tauri/gen/android/app/` (gitignored); the Google Services Gradle plugin is
applied only when that file exists.

For self-hosters, the production deployment path lives in
[self-hosting guide](./self-hosting.md) and the supplied
`docker-compose.prod.yml` / `docker-compose.full.yml`. There is no Vercel
build target - Harmony ships as a static SPA + federation-backend stack,
with optional Tauri desktop builds.

## Security Guidelines

### Code Security

1. **Input Validation**: Always validate user input
2. **XSS Prevention**: Sanitize HTML content
3. **CSRF Protection**: Use Supabase's built-in protection
4. **Authentication**: Implement proper authentication
5. **Authorization**: Check permissions before actions

### Environment Security

1. **Environment Variables**: Never commit secrets
2. **Dependencies**: Keep dependencies updated
3. **HTTPS**: Always use HTTPS in production
4. **CSP**: Implement Content Security Policy
5. **Rate Limiting**: Implement rate limiting

## Debugging

### Development Tools

1. **Vue DevTools**: Browser extension for Vue debugging
2. **VS Code Debugger**: Built-in debugger
3. **Network Tab**: Monitor API requests
4. **Console Logs**: Strategic logging
5. **Error Tracking**: Use error reporting services

### Common Issues

1. **Build Errors**: Check TypeScript types
2. **Styling Issues**: Verify CSS variables
3. **API Errors**: Check network requests
4. **Performance**: Use Vue DevTools profiler
5. **Memory Leaks**: Monitor memory usage

### Debug Configuration

```typescript
// vite.config.ts
export default defineConfig({
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false
  },
  build: {
    sourcemap: process.env.NODE_ENV === 'development'
  }
})
```

## Performance Guidelines

### Frontend Performance

1. **Code Splitting**: Use dynamic imports
2. **Lazy Loading**: Load components on demand
3. **Image Optimization**: Optimize images
4. **Bundle Analysis**: Monitor bundle size
5. **Caching**: Implement proper caching

### Vue.js Optimization

```vue
<template>
  <!-- Use v-memo for expensive renders -->
  <div v-memo="[user.id, user.name]">
    {{ expensiveCalculation(user) }}
  </div>
  
  <!-- Use v-once for static content -->
  <h1 v-once>{{ title }}</h1>
  
  <!-- Use v-show vs v-if appropriately -->
  <div v-show="isVisible">Content</div>
</template>

<script setup>
// Use computed for derived state
const computedValue = computed(() => {
  return expensiveOperation(props.data)
})

// Use shallowRef for large objects
const largeData = shallowRef({})
</script>
```

## Contributing Guidelines

### Pull Request Process

1. **Fork Repository**: Fork the repository to your account
2. **Create Branch**: Create a feature branch
3. **Make Changes**: Implement your changes
4. **Write Tests**: Add tests for new functionality
5. **Update Docs**: Update documentation if needed
6. **Submit PR**: Create a pull request

### Code Review Process

1. **Automated Checks**: All CI checks must pass
2. **Code Review**: At least one approval required
3. **Testing**: Manual testing for UI changes
4. **Documentation**: Documentation must be updated
5. **Merge**: Squash and merge to `master`

### Getting Help

- **GitHub Issues**: Report bugs and feature requests
- **GitHub Discussions**: General questions and ideas
- **Harmony chat**: Real-time chat at <https://har.mony.lol>
- **Documentation**: Check existing documentation first

## License

Harmony is under **GNU AGPL-3.0** with additional terms under AGPL §7
(attribution + trademark). Forks must rename and keep the "Powered by
Harmony" link to the original repository visible. See:

- [`LICENSE`](https://github.com/y4my4my4m/harmony/blob/master/LICENSE) - AGPL v3 text
- [`LICENSE-ADDITIONAL-TERMS.md`](https://github.com/y4my4my4m/harmony/blob/master/LICENSE-ADDITIONAL-TERMS.md) - required attribution
- [`COPYRIGHT`](https://github.com/y4my4my4m/harmony/blob/master/COPYRIGHT) - copyright statement and bundled-asset notices
- [`TRADEMARK.md`](https://github.com/y4my4my4m/harmony/blob/master/TRADEMARK.md) - name and logo policy
