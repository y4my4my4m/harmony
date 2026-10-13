---
title: Testing
description: Harmony's test suites - unit tests, pgTAP database tests, Playwright journeys and the federation round trip - how to run each locally, and what CI runs.
---

# Testing

This page lists Harmony's test suites, how to run each one locally, and what CI runs on a pull request. It is for contributors adding or changing code. [Development setup](/contribute/) covers installing the tools.

## What a change needs

Every feature and every fix ships with an end-to-end test:

- a **Playwright journey** in `e2e/specs/` for behaviour a user sees in the app;
- a **federation round-trip case** in `e2e/federation/cases/` for ActivityPub behaviour.

Unit tests and pgTAP tests are expected as well, but alone they are not enough. A schema change also adds a pgTAP file in `db_schema/tests/`.

## Suites

| Suite | Location | Command | Needs | CI job |
| --- | --- | --- | --- | --- |
| App unit tests | `src/**/__tests__/`, `tests/unit/` | `npm test` | Nothing | Unit Tests |
| Release script tests | `scripts/github-release.test.mjs` | `node --test scripts/github-release.test.mjs` | Nothing | Unit Tests |
| Federation backend | `federation-backend/src/` | `npm run test:federation` | Nothing | Federation Tests |
| Bot gateway | `bot-gateway/src/` | `npm test` in `bot-gateway/` | Nothing | Bot Gateway Tests |
| Bot gateway database | `bot-gateway/tests/db/` | `npm run test:db` in `bot-gateway/` | Docker | Bot Gateway DB Tests |
| pgTAP | `db_schema/tests/` | `./scripts/run-db-tests.sh` | Docker | Database: `pgtap` |
| E2E stack smoke | `e2e/seed.mjs`, `e2e/smoke.mjs` | `npm run e2e:verify` | Docker | E2E Stack |
| Playwright journeys | `e2e/specs/` | `npx playwright test --project=journeys` | Docker, Chrome | E2E Journeys |
| Federation round trip | `e2e/federation/` | `bash e2e/federation/stack.sh verify` | Docker | Federation Round Trip |
| Integration | `tests/integration/` | `npm run test:integration` | A running Supabase stack | Not run |
| Database (Vitest) | `tests/db/` | `npm run test:db` | A running Supabase stack, the `pg` package | Not run |

`npm run test:all` runs the app unit tests, `tests/db`, `tests/integration` and the federation backend tests in sequence.

## Unit tests

[`vitest.config.ts`](https://github.com/y4my4my4m/harmony/blob/master/vitest.config.ts) runs every `*.test.ts` under `src/` and `tests/` except `tests/db/` and `tests/integration/`, in a `happy-dom` environment. [`tests/setup.ts`](https://github.com/y4my4my4m/harmony/blob/master/tests/setup.ts) mocks `@/supabase`, so no service is needed. Tests sit next to the code in `__tests__/` directories; [`tests/helpers/`](https://github.com/y4my4my4m/harmony/tree/master/tests/helpers) has factories and Supabase, Pinia and component helpers.

| Command | Effect |
| --- | --- |
| `npm test` | Run once |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Run with V8 coverage into `coverage/` |
| `npm run test:ui` | Vitest UI |

The federation backend's [`vitest.config.ts`](https://github.com/y4my4my4m/harmony/blob/master/federation-backend/vitest.config.ts) sets coverage thresholds for `src/utils/` and `src/activitypub/converters/`. The bot gateway's unit tests replace Supabase with a fake (`bot-gateway/src/__tests__/fakeSupabase.ts`).

## Database tests (pgTAP)

[`scripts/run-db-tests.sh`](https://github.com/y4my4my4m/harmony/blob/master/scripts/run-db-tests.sh) starts a `supabase/postgres:15.8.1.060` container, applies [`scripts/test-db/supabase-compat.sql`](https://github.com/y4my4my4m/harmony/blob/master/scripts/test-db/supabase-compat.sql) (the storage columns and `realtime` objects that Supabase's services create at start), replays every migration, then runs each file in [`db_schema/tests/`](https://github.com/y4my4my4m/harmony/tree/master/db_schema/tests). A file fails when an assertion fails, when it raises an error, or when it runs a different number of assertions than it planned.

| Variable | Effect |
| --- | --- |
| `SUPABASE_PG_IMAGE` | Postgres image (default `supabase/postgres:15.8.1.060`) |
| `CONTAINER_NAME` | Container name (default `harmony-dbtest`) |
| `KEEP_CONTAINER=1` | Leave the container running for inspection |

`00_bootstrap.sql` installs pgTAP into a `tests` schema and defines the impersonation helpers; `01_fixtures.sql` loads the shared fixture (users `alice`, `bob`, `mallory` and `banned`, a server and a DM, with fixed ids). Every other file runs in its own transaction and rolls back.

### Write a pgTAP test

Add a file named with the next free number, for example `141_my_feature.sql`:

```sql
-- What the file covers, in one line.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(2);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');  -- alice's auth user id
SELECT ok(public.my_function() IS NOT NULL, 'alice can call my_function');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.my_function()$q$, '42501', NULL, 'anon cannot call it');

SELECT * FROM finish();
ROLLBACK;
```

`tests.authenticate_as` takes an auth user id, not a profile id: policies resolve the profile through `profiles.auth_user_id`. `tests.clear_authentication()` returns to the `postgres` role.

## Integration tests against a running Supabase

`tests/integration/` drives a full Supabase stack through supabase-js with real users, and `tests/db/` connects to its Postgres directly. Neither runs in CI.

1. Run the full Supabase stack from [Development setup](/contribute/#use-the-full-supabase-stack).
2. Publish its database on port 54322: add `ports: ["54322:${POSTGRES_PORT}"]` to the `db` service of the Supabase stack's `docker-compose.yml`, as [`dev/supabase-docker-compose.patch.yml`](https://github.com/y4my4my4m/harmony/blob/master/dev/supabase-docker-compose.patch.yml) shows, and restart the stack.
3. Copy [`.env.test.example`](https://github.com/y4my4my4m/harmony/blob/master/.env.test.example) to `.env.test` and fill in the keys and the database password.
4. Run `npm run test:integration` or `npm run test:db`.

`tests/db/` imports the `pg` package, which is not a dependency in the root `package.json`; install it first. Without it, or without a reachable database, those suites are skipped rather than failed.

## Playwright journeys

Journeys are browser tests of one user task each, in [`e2e/specs/`](https://github.com/y4my4my4m/harmony/tree/master/e2e/specs). They run against the E2E stack (Postgres, GoTrue and PostgREST from [`e2e/stack.sh`](https://github.com/y4my4my4m/harmony/blob/master/e2e/stack.sh)) and a Vite dev server pointed at it.

```bash
(cd federation-backend && npm ci)
(cd bot-gateway && npm ci)
npm run e2e:up
npm run e2e:seed
npx playwright test --project=journeys
npm run e2e:down
```

[`playwright.config.ts`](https://github.com/y4my4my4m/harmony/blob/master/playwright.config.ts) loads `e2e/stack.env` and starts `npm run dev` on the port of `BASE_URL` (default `http://localhost:5173`). It reuses a server already listening on that port, whatever Supabase that server points at; set `BASE_URL=http://localhost:5174` (or any free port) when your own dev server is running.

| Variable | Effect |
| --- | --- |
| `BASE_URL` | URL and port of the dev server the tests use |
| `PW_BUNDLED=1` | Use Playwright's bundled Chromium instead of the installed Google Chrome (install it with `npx playwright install chromium`) |
| `CI=true` | One worker, no video, `test.only` fails the run |
| `E2E_PROJECT`, `E2E_PORT`, `E2E_SUBNET` | Compose project, gateway port and subnet of the stack, for running several side by side |

Each checkout has one `e2e/stack.env`: another stack's `up` in the same checkout overwrites it and its `down` deletes it.

A failed run writes the HTML report to `playwright-report/` and traces to `test-results/`; `npx playwright show-report` opens it.

### Write a journey

[`e2e/specs/harness.ts`](https://github.com/y4my4my4m/harmony/blob/master/e2e/specs/harness.ts) holds the shared steps: `createUser`, `deleteUser`, `seedServer`, `addMember`, `grantRole`, `addChannel`, `signIn`, `openChannel`, `sendMessage` and others.

- Each spec creates its own users in `beforeAll` and deletes them in `afterAll`. Users are never shared between specs, so parallel workers cannot change each other's counts.
- The stack has no Realtime. To see another user's message, reload the page instead of waiting for it.
- A journey that needs the federation backend's routes starts it with [`e2e/specs/backend.ts`](https://github.com/y4my4my4m/harmony/blob/master/e2e/specs/backend.ts), which forwards the page's `/api/federation/*` requests to it; such a context blocks service workers. Bot journeys start the bot gateway with [`e2e/specs/botGateway.ts`](https://github.com/y4my4my4m/harmony/blob/master/e2e/specs/botGateway.ts).
- Start the file with a comment that states the journey in one sentence.

`tests/e2e/` holds older Playwright specs (projects `auth-tests`, `chromium` and `navigation`) that share users created by `tests/e2e/global-setup.ts`. CI runs only the `journeys` project.

## Federation round trip

[`e2e/federation/roundtrip.ts`](https://github.com/y4my4my4m/harmony/blob/master/e2e/federation/roundtrip.ts) exercises federation against a real database. The local instance is the federation backend's own Express app on a Postgres and PostgREST stack; the remote instance is a peer server in the same script, with a real RSA key, that records what it receives. Activities are signed with HTTP Signatures and every assertion reads a row back through PostgREST. The stack's LiveKit stands in for both instances' SFUs.

```bash
(cd federation-backend && npm ci)
bash e2e/federation/stack.sh verify    # up, then run roundtrip.ts
bash e2e/federation/stack.sh down
```

| Command | Effect |
| --- | --- |
| `up` | Tear down, start the stack and build the schema |
| `test` | Run `roundtrip.ts` from a scratch directory, so a developer's `federation-backend/.env` is not read |
| `verify` | `up` then `test` |
| `down` | Remove containers, volumes, network and `e2e/federation/stack.env` |
| `status`, `logs` | What is running, and compose logs |

`HMFED_PROJECT`, `HMFED_PORT`, `HMFED_LIVEKIT_PORT` and `HMFED_SUBNET` separate concurrent runs. The subnet defaults to `203.0.113.0/24` and must not be a private range: the federation backend's SSRF guard refuses loopback, RFC 1918 and link-local addresses, and the peer listens on the subnet's `.1`.

The round trip does not cover the BullMQ worker, Redis, Realtime delivery or media.

### Add a round-trip case

Put the case in its own file in [`e2e/federation/cases/`](https://github.com/y4my4my4m/harmony/tree/master/e2e/federation/cases), export a function that takes the context it needs (the PostgREST client, the peer, the local URL), and call it from `roundtrip.ts`. Use fixed ids so a failure names the row.

## What CI runs

Two workflows check every pull request into `master`. Each ends in a verdict job that fails unless every other job in the workflow succeeded.

[`.github/workflows/ci.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/ci.yml) (CI), on pull requests and pushes to `master`:

| Job | Runs |
| --- | --- |
| Unit Tests | `npm run test`, then `node --test scripts/github-release.test.mjs` |
| Federation Tests | `npx vitest run` in `federation-backend/` |
| Bot Gateway Tests | `npx vitest run` in `bot-gateway/` |
| Bot Gateway DB Tests | `npm run test:db` in `bot-gateway/` |
| Type Check (app) | `npx vue-tsc --build --force` |
| Type Check (federation-backend) | `npm run type-check` in `federation-backend/` |
| Type Check (bot-gateway) | `npm run type-check` in `bot-gateway/` |
| Build | `npm run build` with placeholder Supabase values |
| E2E Stack | `npm run e2e:verify` |
| E2E Journeys | `npm run e2e:up`, `npm run e2e:seed`, `npx playwright test --project=journeys`; uploads the report on failure |
| Federation Round Trip | `bash e2e/federation/stack.sh verify` |
| Docs | `npm run docs:build`, which fails on dead links and template errors |
| CI verdict | Fails unless every job above succeeded |

[`.github/workflows/schema-drift.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/schema-drift.yml) (Database), on every pull request: the schema checks and the pgTAP suite, listed in [Database migrations](/contribute/migrations#checks).

[`.github/workflows/images.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/images.yml) also builds the three container images for both platforms on a pull request, without pushing them.

ESLint is not part of CI; run `npm run lint` before you push.
