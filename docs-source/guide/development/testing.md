# Testing

Harmony uses Vitest for unit and integration tests, and Playwright for end-to-end tests.

## Test Structure

```
src/services/encryption/__tests__/   # Unit tests (co-located)
tests/
├── integration/                     # Integration tests (requires Supabase)
├── db/                              # Database schema/function tests
├── e2e/                             # Playwright E2E tests
└── helpers/                         # Shared test utilities
```

## Unit Tests

Unit tests run in a `happy-dom` environment with mocked Supabase:

```bash
# Run all unit tests
npm run test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Vitest UI
npm run test:ui
```

### Configuration

`vitest.config.ts` (main config):

- Environment: `happy-dom`
- Includes: `src/**/*.test.ts`, `tests/**/*.test.ts`
- Excludes: `tests/db/`, `tests/integration/`
- Timeout: 10 seconds
- Setup file: `tests/setup.ts`

### Test Setup (`tests/setup.ts`)

The setup file:

- Polyfills Web Crypto API for Node 18
- Stubs `import.meta.env` with test Supabase credentials
- Mocks `@/supabase` (auth, storage, channel)
- Mocks `@/utils/debug`

### Encryption Tests

Encryption tests in `src/services/encryption/__tests__/` use `fake-indexeddb` to simulate the browser's IndexedDB:

- `MegolmService.test.ts` - Session creation, rotation, encrypt/decrypt cycles
- `MegolmMessageEncryptionService.test.ts` - High-level message encryption
- `RecoveryKeyService.test.ts` - Mnemonic derivation and key recovery

## Integration Tests

Integration tests hit a local Supabase instance:

```bash
# Prerequisites: start local Supabase
supabase start

# Run integration tests
npm run test:integration
```

### Configuration

`vitest.integration.config.ts`:

- Environment: `node`
- Includes: `tests/integration/**/*.test.ts`
- Timeout: 30 seconds

### Environment

Create `.env.test` from `.env.test.example`:

```env
TEST_SUPABASE_URL=http://localhost:54321
TEST_SUPABASE_ANON_KEY=your-local-anon-key
TEST_SUPABASE_SERVICE_ROLE_KEY=your-local-service-role-key
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
```

### Test Helper (`tests/helpers/supabaseTestHelper.ts`)

Provides admin-level test operations using the `service_role` key:

| Method | Purpose |
|--------|---------|
| `createTestUser()` | Create a user with profile |
| `cleanupTestUsers()` | Delete test users and data |
| `createTestServer()` | Create a server for testing |
| `createTestChannel()` | Create a channel in a server |
| `addUserToServer()` | Add a member to a server |
| `createDirectConversation()` | Set up a DM conversation |
| `sendMessage()` | Insert a test message |

Test cleanup uses the `_test_delete_owned_servers` RPC which disables protected role triggers during teardown.

### Other Helpers

| Helper | Purpose |
|--------|---------|
| `componentTestHelper.ts` | `mountComponent()` with Pinia and Router |
| `piniaTestHelper.ts` | `setupTestPinia()` for isolated store tests |
| `supabaseMock.ts` | Supabase client mock |
| `factories.ts` | Test data factories (`createProfile`, `createServer`, etc.) |

## Database Tests

Test database schema and functions:

```bash
npm run test:db
```

Uses `vitest.db.config.ts` with `tests/db/**/*.test.ts`.

## E2E Tests

Playwright tests for full browser-based testing:

```bash
npm run test:e2e
```

Configuration in `playwright.config.ts`. Tests cover:

- Authentication flows (login, register)
- Navigation between views
- Basic feature interactions

## Federation Tests

Test the federation backend separately:

```bash
npm run test:federation
```

Runs tests in the `federation-backend/` directory.

## Running All Tests

```bash
npm run test:all
```

This runs unit + integration + federation tests sequentially.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/development/testing.md` and run `npm run docs:generate-guide` to update.
