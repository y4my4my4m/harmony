# Harmony

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![CI](https://github.com/y4my4my4m/harmony/actions/workflows/ci.yml/badge.svg)](https://github.com/y4my4my4m/harmony/actions/workflows/ci.yml)

Harmony is a federated social app: Discord-style servers and chat with ActivityPub, built on Vue 3 and Supabase.

- **Project home:** <https://mony.lol>
- **Live instance:** <https://har.mony.lol>
- **Docs:** <https://docs.mony.lol> (see [docs/README.md](docs/README.md))

<img width="1597" height="911" alt="image" src="https://github.com/user-attachments/assets/43a874fc-7af0-4056-ba3a-0472d70daaf5" />

## What it does

- Servers, channels, DMs, threads, voice/video (LiveKit where configured)
- ActivityPub timelines, follows, and federation with other instances
- Multi-instance servers (members from different Harmony domains in one server)
- End-to-end encryption (Megolm-style) for chat, with cross-device key sharing (per-message derived keys + periodic session rotation; see [Encryption notes](SECURITY.md#encryption-specific-notes) for the exact secrecy properties)
- Tauri desktop app and web app from the same codebase

## Stack

- Frontend: Vue 3, TypeScript, Pinia, Vite
- Data: Supabase (Postgres, auth, realtime, storage)
- Federation: Node service in `federation-backend/` ([README](federation-backend/README.md)) - HTTP **server** and queue **worker** split in production Docker; **Redis** for BullMQ and related features
- Desktop: Tauri (`src-tauri/`)

## Self-hosting

On a blank Linux server with a domain pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/y4my4my4m/harmony/master/self-host/install.sh | bash
```

The installer puts Harmony in `/opt/harmony`, asks for the domain, the admin
account and the optional services (voice, bots, Discord bridge hosting, email),
and runs the whole instance in Docker from prebuilt images: the app, Supabase,
the federation server and worker, Redis, and Caddy with automatic HTTPS. The
host (x86_64 or arm64) needs Docker Engine with Compose 2.24.4 or later and
nothing else; the installer offers to install Docker. From a checkout,
`bash self-host/install.sh` does the same. Afterwards the `harmony` command
updates, backs up and checks the instance.

Guide: [docs/self-hosting.md](docs/self-hosting.md).

## Quick start (development)

```bash
git clone https://github.com/y4my4my4m/harmony.git
cd harmony

npm install
cd federation-backend && npm install && cd ..

cp .env.example .env                                         # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
cp federation-backend/env.template federation-backend/.env   # Supabase keys, INSTANCE_DOMAIN

# With the upstream Supabase Docker stack running (container supabase-db):
bash self-host/bootstrap.sh --migrations-only               # applies db_schema/migrations

npm run dev
# Second terminal: cd federation-backend && npm run dev
```

App: http://localhost:5173. Federation backend health: http://localhost:3001/health.
Details: [docs-source/guide/installation.md](docs-source/guide/installation.md).

## Documentation

| Topic | Link |
|--------|------|
| Self-hosting: install, update, backup, manual setups | [docs/self-hosting.md](docs/self-hosting.md) |
| Self-host stack: compose, Caddy, scripts | [self-host/README.md](self-host/README.md) |
| Federation / ActivityPub interop | [docs/FEDERATION.md](docs/FEDERATION.md) |
| Roadmap | [ROADMAP.md](ROADMAP.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security policy | [SECURITY.md](SECURITY.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## Community

- Real-time chat: join the canonical instance at <https://har.mony.lol>
- Bugs / features: [GitHub Issues](https://github.com/y4my4my4m/harmony/issues)
- Security vulns: see [SECURITY.md](SECURITY.md) - please do not file public issues

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) **with additional terms** under AGPL §7 (attribution + trademark) - see:

- [`LICENSE`](LICENSE) - AGPL v3 text
- [`LICENSE-ADDITIONAL-TERMS.md`](LICENSE-ADDITIONAL-TERMS.md) - required attribution
- [`COPYRIGHT`](COPYRIGHT) - copyright statement and bundled-asset notices
- [`TRADEMARK.md`](TRADEMARK.md) - name and logo policy

You are free to fork, modify, and self-host. Forks must rename and keep the
"Powered by Harmony" link to the original repository visible. See
[`LICENSE-ADDITIONAL-TERMS.md`](LICENSE-ADDITIONAL-TERMS.md) for the short
plain-language version.
