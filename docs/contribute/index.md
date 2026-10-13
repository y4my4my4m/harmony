---
title: Development setup
description: Set up a Harmony development checkout, run the web app, federation backend, bot gateway and native apps locally, and find your way around the repository.
---

# Development setup

This page is for people changing Harmony's code. It covers the tools you need, the two local backends you can develop against, how to run each service, and how branches and pull requests work. To run an instance for real users, see [Self-host](/self-host/) instead.

## Prerequisites

| Tool | Needed for | Version |
| --- | --- | --- |
| Node.js and npm | Everything | The version in [`.nvmrc`](https://github.com/y4my4my4m/harmony/blob/master/.nvmrc) (24). npm is the package manager; every package has a `package-lock.json`. |
| Git | Everything | |
| Docker with Compose | Local stacks, pgTAP tests, schema checks, end-to-end tests | |
| `openssl`, `curl` | The end-to-end stack (`e2e/stack.sh` checks for both) | |
| Python 3 | `scripts/generate-surface.sh`, `scripts/generate-reachability.sh`, `scripts/check-upsert-conflicts.py` | |
| Google Chrome | Playwright tests (system Chrome; `PW_BUNDLED=1` selects Playwright's bundled Chromium instead) | |
| Rust toolchain | Desktop and Android apps | 1.95 or later (`rust-version` in `src-tauri/Cargo.toml`) |
| JDK, Android SDK and NDK | Android app | The versions CI uses: JDK 21, SDK platform 34, build-tools 34.0.0, NDK 28.2.13676358 |

## Get the code

```bash
git clone https://github.com/y4my4my4m/harmony.git
cd harmony
npm ci
```

`federation-backend/` and `bot-gateway/` are separate npm packages with their own lockfiles. Install them when you run or test them. The Playwright journeys start both from source and the federation round trip starts the federation backend, so those need them too:

```bash
(cd federation-backend && npm ci)
(cd bot-gateway && npm ci)
```

## Choose a local backend

The web app talks to Supabase. Two local setups exist:

| | E2E stack | Full Supabase stack |
| --- | --- | --- |
| Started by | `npm run e2e:up` | The upstream Supabase Docker stack, then `self-host/bootstrap.sh` |
| Services | Postgres, GoTrue (auth) and PostgREST behind an nginx gateway | Every Supabase service Harmony uses, including Realtime and Storage |
| Realtime updates, uploads | Absent: the gateway answers 501 on those paths | Present |
| Federation backend, Redis | Not included | Run them yourself (below) |
| Best for | UI work against real data, Playwright journeys | Realtime, media, voice and federation work |

### Use the E2E stack

[`e2e/stack.sh`](https://github.com/y4my4my4m/harmony/blob/master/e2e/stack.sh) raises a throwaway stack, builds the schema from `db_schema/migrations/` and writes generated credentials to `e2e/stack.env`.

```bash
npm run e2e:up      # stack on http://localhost:54480
set -a; . e2e/stack.env; set +a
npm run dev         # app on http://localhost:5173, pointed at the stack
```

`e2e/stack.env` sets `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `VITE_DOMAIN`; values in the environment take precedence over `.env`. Register a new account in the app: the stack confirms email addresses on sign-up. The fixture users that `npm run e2e:seed` creates are meant for API tests: their profile ids differ from their auth ids on purpose, and the chat UI shows them no servers.

| Command | Effect |
| --- | --- |
| `npm run e2e:up` | Tear down any previous stack, start a new one and build the schema |
| `npm run e2e:seed` | Create the fixture users, server and DM (`e2e/fixture.json`) |
| `npm run e2e:smoke` | Sign in and assert one RLS allow and one RLS deny |
| `npm run e2e:verify` | `up`, `seed` and `smoke` in one go |
| `npm run e2e:status` | Containers, port, and whether `stack.env` and `fixture.json` exist |
| `npm run e2e:logs` | Compose logs |
| `npm run e2e:down` | Remove containers, volumes, network, `stack.env` and `fixture.json` |

`E2E_PROJECT` and `E2E_PORT` name the compose project and the gateway port, so stacks from separate checkouts can run side by side. `E2E_SUBNET` pins the network's subnet when Docker's default address pools run out.

### Use the full Supabase stack

Harmony's CI installs the schema on `supabase/postgres:15.8.1.060`. [`self-host/configure.sh`](https://github.com/y4my4my4m/harmony/blob/master/self-host/configure.sh) pins the upstream Supabase Docker stack (the `docker/` directory of `github.com/supabase/supabase`) to the last commit that runs that image, in `SUPABASE_REF_DEFAULT`. Use the same commit for development.

1. Check out the upstream stack at that commit and start it:

   ```bash
   ref=$(sed -n 's/^SUPABASE_REF_DEFAULT=//p' self-host/configure.sh)
   git clone https://github.com/supabase/supabase ../supabase
   git -C ../supabase checkout "$ref"
   cd ../supabase/docker
   cp .env.example .env
   docker compose up -d
   ```

   Its Postgres container is `supabase-db` and its API gateway (Kong) listens on `http://localhost:8000`.

2. Load the Harmony schema from your Harmony checkout:

   ```bash
   bash self-host/bootstrap.sh --migrations-only
   ```

   `bootstrap.sh` applies every migration in `db_schema/migrations/` that the database has not recorded yet, then reloads PostgREST. Run it again after you pull new migrations. `SUPABASE_DB_CONTAINER` names a different container. See [Database migrations](/contribute/migrations).

3. Point the app at the stack:

   ```bash
   cp .env.example .env
   ```

   Set `VITE_SUPABASE_URL=http://localhost:8000` and `VITE_SUPABASE_ANON_KEY` to `ANON_KEY` from the Supabase stack's `.env`.

4. Start the app with `npm run dev`.

The integration tests under `tests/` also need the database port published on the host; see [Testing](/contribute/testing#integration-tests-against-a-running-supabase).

## Run the web app

```bash
npm run dev
```

Vite serves the app on port 5173 on all interfaces. It proxies `/api/federation/*` (with the prefix removed) and `/api/livekit/*` to the federation backend on `http://localhost:3001`.

The app reads its instance values from a stored instance (native apps), then `/config.json` (the web image writes it at container start), then the `VITE_*` variables built in from `.env`. [`.env.example`](https://github.com/y4my4my4m/harmony/blob/master/.env.example) documents each variable. `VITE_DEBUG_LOGGING=true` turns on `debug.log`, `debug.warn` and `debug.info` output in development builds.

| Command | Effect |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run type-check` | `vue-tsc --build --force` |
| `npm run lint` | ESLint over the repository, applying fixes |
| `npm run format` | Prettier over `src/` |
| `npm run dev:audio-pack` | The audio pack studio in `dev/audio-pack-studio/` |

## Run the federation backend

The federation backend serves ActivityPub, push, link previews, the GIF proxy, LiveKit tokens, presence and typing. Its [README](https://github.com/y4my4my4m/harmony/blob/master/federation-backend/README.md) lists every script.

```bash
cd federation-backend
cp .env.example .env    # set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
npm run dev             # HTTP server on 3001 and the queue worker, reloading on change
```

`.env.example` holds development values; `env.template` holds production values. `src/config/index.ts` validates the environment at start and stops on an invalid value, naming it. The health check is `http://localhost:3001/health`.

- **Redis.** The queue worker needs Redis at `REDIS_URL` (default `redis://localhost:6379`) and stops at start without it. A local one: `docker run -d --name harmony-redis -p 6379:6379 redis:7-alpine`. `npm run dev:server` runs the HTTP server alone, which starts without Redis and falls back to in-memory rate limits.
- **Job pickup.** Database triggers announce federation and push jobs with `pg_notify`. With `FEDERATION_LISTENER_URL` (a direct Postgres URL that can `LISTEN`) the worker picks them up at once; without it, a sweep every 60 seconds and the delivery retry every 30 seconds pick them up.
- **Process modes.** `npm run dev:server` and `npm run dev:worker` run one role each, as production does.

Federation with other instances needs a public HTTPS domain; for ActivityPub work locally, use the [federation round trip](/contribute/testing#federation-round-trip).

## Run the bot gateway

```bash
cd bot-gateway
cp .env.example .env    # set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm run dev             # REST API and WebSocket gateway (/gateway) on port 3002
```

The gateway's API is documented under [Build](/build/).

## Run the desktop app

```bash
npm run tauri:dev
```

`tauri dev` starts `npm run dev` and opens the app on `http://localhost:5173`. Native builds choose their instance at runtime through the instance picker; `VITE_DEFAULT_INSTANCE_URL` in `.env` pre-fills it.

| Command | Effect |
| --- | --- |
| `npm run tauri:dev` | Desktop app against the development server |
| `npm run tauri:dev:x11` | The same with `GDK_BACKEND=x11` |
| `npm run tauri:build` | Local release build of the desktop app |

Windows and macOS use the system webview. On Linux the app runs on the Chromium Embedded Framework through `tauri-runtime-cef`:

- Install the build dependencies listed in the `apt-get install` step of [`.github/workflows/release.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/release.yml) (Ubuntu 24.04 package names). `cmake` and `ninja-build` build CEF's C++ wrapper.
- The first build downloads the CEF distribution into the cargo target directory, where `cargo clean` removes it. Set `CEF_PATH` to a persistent directory to download it there once and reuse it.
- `src-tauri/linux/package.sh` turns the deb from `npx tauri build --bundles deb` into the AppImage, and `src-tauri/linux/smoke-test.sh` starts a build under Xvfb and fails when it exits early, Chromium logs `FATAL`, or its main thread stays busy while idle.

## Build the Android app

The Android project is committed under `src-tauri/gen/android/`; the push plugin lives in `src-tauri/crates/tauri-plugin-harmony-push/`. With JDK 21, the Android SDK and NDK installed and the Rust target added (`rustup target add aarch64-linux-android`):

```bash
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
npx tauri android build --debug --target aarch64
```

The APK lands under `src-tauri/gen/android/app/build/outputs/apk/universal/`. A build without `--debug` is signed only when `src-tauri/gen/android/app/keystore.properties` names a keystore. Firebase Cloud Messaging needs `google-services.json` in `src-tauri/gen/android/app/`; without it the app still receives push through UnifiedPush.

The push plugin's Robolectric tests run after a build, which generates the Gradle settings that include the plugin module:

```bash
cd src-tauri/gen/android
./gradlew :tauri-plugin-harmony-push:testDebugUnitTest
```

## Serve the app over HTTPS locally

[`dev/`](https://github.com/y4my4my4m/harmony/tree/master/dev) runs Caddy with [mkcert](https://github.com/FiloSottile/mkcert) certificates in front of the development server at `https://har.mony.local`, and LiveKit at `wss://live.mony.local`. It also runs the federation backend in a container on the Supabase stack's `supabase_default` network, where it can `LISTEN` on the database. [`dev/README.md`](https://github.com/y4my4my4m/harmony/blob/master/dev/README.md) has the steps: install the local CA, generate the certificates into `dev/certs/`, add both names to `/etc/hosts`, then `./dev/start.sh` and `npm run dev`.

`dev/start.sh` also starts LiveKit from `webrtc/`, where only `docker-compose.example.yml` and `livekit.yaml.example` are committed; copy them to `docker-compose.yml` and `livekit.yaml` first, as [`webrtc/README.md`](https://github.com/y4my4my4m/harmony/blob/master/webrtc/README.md) describes. See [Voice and video](/self-host/voice) for LiveKit configuration.

## Repository layout

| Path | Contents |
| --- | --- |
| [`src/`](https://github.com/y4my4my4m/harmony/tree/master/src) | The Vue 3 web app, also the UI of the desktop and Android apps |
| [`public/`](https://github.com/y4my4my4m/harmony/tree/master/public) | Static files served as-is: service worker, web manifest, backgrounds, offline page |
| [`federation-backend/`](https://github.com/y4my4my4m/harmony/tree/master/federation-backend) | Node service: ActivityPub server, BullMQ queue worker, push, link previews, LiveKit tokens |
| [`bot-gateway/`](https://github.com/y4my4my4m/harmony/tree/master/bot-gateway) | Bot REST API, WebSocket gateway and the Bridge v2 API |
| [`bot-plugins/`](https://github.com/y4my4my4m/harmony/tree/master/bot-plugins) | README only; the Discord bridge lives in [its own repository](https://github.com/y4my4my4m/harmony-discord-bridge) |
| [`bull-board/`](https://github.com/y4my4my4m/harmony/tree/master/bull-board) | Bull Board dashboard for the BullMQ queues |
| [`db_schema/`](https://github.com/y4my4my4m/harmony/tree/master/db_schema) | Migrations, pgTAP tests and the generated schema inventories |
| [`supabase/`](https://github.com/y4my4my4m/harmony/tree/master/supabase) | Supabase CLI project file; `migrations` links to `db_schema/migrations` |
| [`src-tauri/`](https://github.com/y4my4my4m/harmony/tree/master/src-tauri) | Tauri shell (Rust) for the desktop and Android apps, Linux packaging, the Android project |
| [`self-host/`](https://github.com/y4my4my4m/harmony/tree/master/self-host) | Installer, `harmony` command and Docker Compose stack for self-hosting |
| [`webrtc/`](https://github.com/y4my4my4m/harmony/tree/master/webrtc) | LiveKit configuration examples and a load test |
| [`dev/`](https://github.com/y4my4my4m/harmony/tree/master/dev) | Local HTTPS proxy, nginx templates for manual deployments, the audio pack studio |
| [`e2e/`](https://github.com/y4my4my4m/harmony/tree/master/e2e) | E2E stack, Playwright journeys (`e2e/specs/`) and the federation round trip (`e2e/federation/`) |
| [`tests/`](https://github.com/y4my4my4m/harmony/tree/master/tests) | Test setup and helpers, integration and database tests against a running Supabase, older Playwright specs |
| [`scripts/`](https://github.com/y4my4my4m/harmony/tree/master/scripts) | Schema checks, inventory generators, release helpers, benchmarks |
| [`docs/`](https://github.com/y4my4my4m/harmony/tree/master/docs) | This site (VitePress); see [Docs style](/contribute/docs-style) |
| [`.github/workflows/`](https://github.com/y4my4my4m/harmony/tree/master/.github/workflows) | CI, database checks, container images, desktop and Android builds, releases |

## Branches and pull requests

- `master` is the default branch; pull requests target it.
- Branch from `master` with a prefix naming the kind of change: `feat/` for features, `fix/` for bug fixes. Security fixes are coordinated through [SECURITY.md](https://github.com/y4my4my4m/harmony/blob/master/SECURITY.md) before anything is public.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): description`, with `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test` or `chore` as the type.
- Every feature and fix comes with tests, including an end-to-end case. See [Testing](/contribute/testing).
- Before you open the pull request, run the lint, type check and tests, add a `CHANGELOG.md` entry under `[Unreleased]` for user-facing changes, and rebase on `master`.
- In the description, say what changed and why, link related issues, add screenshots for UI changes and list breaking changes.
- The CI and Database workflows must pass. See [What CI runs](/contribute/testing#what-ci-runs).

Report security vulnerabilities privately, through GitHub's private vulnerability reporting on the repository, not in a public issue. Contributions are licensed under the GNU Affero General Public License v3.0, like the rest of Harmony.
