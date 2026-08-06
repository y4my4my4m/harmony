# Installation

## Prerequisites

- **Node.js** 24 (the version in `.nvmrc`)
- **npm** - the supported package manager; all scripts and the lockfile assume it
- **Git**
- A **Supabase** project (cloud or self-hosted)

### Optional

- **Rust** 1.70+ and Tauri CLI for desktop builds
- **Docker** and Docker Compose for containerized deployment
- **LiveKit** server for voice/video channels

## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/y4my4my4m/harmony.git
cd harmony
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

Copy the example environment file and fill in your Supabase credentials:

```bash
cp .env.example .env
```

At minimum, set these values:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_INSTANCE_DOMAIN=your-domain.com
VITE_INSTANCE_NAME=My Harmony
VITE_APP_URL=http://localhost:5173
```

See [Environment Setup](./environment) for a full variable reference.

### 4. Set up the database

For a fresh Supabase project, run the init scripts in order via the Supabase SQL editor or CLI:

```bash
# If using Supabase CLI locally:
supabase start
supabase db reset
```

The schema files live in `db_schema/init/` and are loaded by `init.sql` in numbered order. See [Supabase Deployment](./deployment/supabase) for details.

### 5. Start the dev server

```bash
npm run dev
```

The app will be available at `http://localhost:5173`.

## Federation Backend (Optional)

If you want ActivityPub federation, link previews, or voice/video:

```bash
cd federation-backend
cp env.template .env
# Edit .env with your Supabase credentials and domain
npm install
npm run dev
```

The federation backend runs on port 3001 by default. Minimum `.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://...
INSTANCE_DOMAIN=your-domain.com
CORS_ORIGIN=https://your-domain.com
```

## Desktop App (Tauri)

### Additional prerequisites

- **Rust** 1.70+ via [rustup](https://rustup.rs)
- Platform dependencies (Linux: WebKit2GTK, Windows: WebView2)

### Linux environment variables

Some Linux setups require:

```bash
export GDK_BACKEND=x11
export WEBKIT_DISABLE_DMABUF_RENDERER=1
```

### Build and run

```bash
# Development
npm run tauri:dev

# Production build
npm run tauri:build
```

## Docker Deployment

For production deployment with Docker, see the [Docker guide](./deployment/docker). Quick overview:

```bash
# Build the frontend
npm run build-only

# Start with Supabase Cloud
docker compose -f docker-compose.prod.yml up -d

# Or with self-hosted Supabase
docker compose -f docker-compose.full.yml up -d
```

## Verifying the Installation

1. Open `http://localhost:5173` in your browser
2. Register a new account
3. Create a server and channel
4. Send a message

With the federation backend running:

```bash
curl http://localhost:3001/health
curl 'http://localhost:5173/.well-known/webfinger?resource=acct:username@your-domain'
curl http://localhost:5173/.well-known/nodeinfo
```

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/installation.md` and run `npm run docs:generate-guide` to update.
