# Installation

This page sets up a development checkout. To run an instance, see [Self-Hosting](/self-hosting): one command installs the complete stack on a Linux server.

## Running an instance

On a blank Linux server with a domain pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
```

The installer puts Harmony in `/opt/harmony`, asks for the domain, the admin account, the instance name and the optional services, and starts everything in Docker from prebuilt images. The host (x86_64 or arm64) needs Docker Engine with Compose 2.24.4 or later and nothing else; the installer offers to install Docker when it is missing. From a checkout, `bash self-host/install.sh` does the same.

## Development prerequisites

- **Node.js** 24 (the version in `.nvmrc`)
- **npm**: the lockfile and every script assume it
- **Git**
- **Docker** with Compose, for Supabase and Redis

Optional:

- **Rust** 1.77 or later (`rust-version` in `src-tauri/Cargo.toml`) for the desktop and Android apps. The Tauri CLI comes with `npm install`
- **LiveKit** for voice and video channels (`webrtc/README.md`)

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/y4my4my4m/harmony.git
cd harmony
npm install
```

### 2. Start Supabase

Harmony needs a Supabase stack. CI installs the schema on `supabase/postgres:15.8.1.060`; `self-host/configure.sh` pins the upstream Supabase Docker stack (`docker/` of github.com/supabase/supabase) to the last commit that runs that image (`SUPABASE_REF_DEFAULT`). Start that stack with its `docker compose up -d`. Its Postgres container is `supabase-db` and its API gateway listens on `http://localhost:8000`.

### 3. Load the schema

```bash
bash self-host/bootstrap.sh --migrations-only
```

`bootstrap.sh` copies `db_schema/migrations/` into the `supabase-db` container, applies every pending file in version order and records each in `supabase_migrations.schema_migrations`. Re-running it applies only what is new. `SUPABASE_DB_CONTAINER` names a different container. [Supabase Setup](./deployment/supabase) covers databases outside Docker.

### 4. Configure the frontend

```bash
cp .env.example .env
```

Set at least:

```env
VITE_SUPABASE_URL=http://localhost:8000
VITE_SUPABASE_ANON_KEY=<ANON_KEY from the Supabase stack's .env>
```

Every other variable has a default; [Environment Variables](./environment) lists them.

### 5. Start the dev server

```bash
npm run dev
```

The app is at `http://localhost:5173`.

## Federation backend

Push notifications, link previews, GIF search, voice tokens and ActivityPub federation run in the federation backend. The Vite dev server proxies `/api/federation/*` and `/api/livekit/*` to it on port 3001.

```bash
cd federation-backend
cp env.template .env
npm install
npm run dev
```

Required in `federation-backend/.env`:

```env
SUPABASE_URL=http://localhost:8000
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service role key>
INSTANCE_DOMAIN=localhost
```

The job queue needs Redis at `REDIS_URL` (default `redis://localhost:6379`):

```bash
docker run -d --name harmony-dev-redis -p 127.0.0.1:6379:6379 redis:7-alpine
```

`npm run dev` runs the HTTP server and the queue worker in one process (`FEDERATION_MODE=unified`); `npm run dev:server` and `npm run dev:worker` run them apart.

## Desktop app (Tauri)

Additional prerequisites: Rust 1.95+ via [rustup](https://rustup.rs), plus per platform:

- Linux: GTK 4, CMake and Ninja. The app runs on the Chromium Embedded Framework, which the first
  build downloads. The full package list, AppImage packaging and sandbox notes are in
  `docs/DEVELOPMENT.md`, "Linux Build (CEF)".
- Windows: WebView2.

```bash
npm run tauri:dev       # development
npm run tauri:dev:x11   # Linux sessions that need GDK_BACKEND=x11
npm run tauri:build     # release build
```

Native clients choose their instance at first launch; `VITE_DEFAULT_INSTANCE_URL` pre-fills the picker.

## Verifying the installation

1. Open `http://localhost:5173` and register an account. Without a mail server, `ENABLE_EMAIL_AUTOCONFIRM=true` in the Supabase stack's `.env` makes accounts usable without a confirmation email.
2. Create a server and a channel, and send a message.

With the federation backend running:

```bash
curl http://localhost:3001/health
curl http://localhost:5173/api/federation/health
```

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/installation.md` and run `npm run docs:generate-guide` to update.
