# 🐻‍❄️ Harmony

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![CI](https://github.com/y4my4my4m/harmony/actions/workflows/ci.yml/badge.svg)](https://github.com/y4my4my4m/harmony/actions/workflows/ci.yml)

Harmony is a federated social app: Discord-style servers and chat with ActivityPub, built on Vue 3 and Supabase.

- **Project home:** <https://mony.lol>
- **Live instance:** <https://har.mony.lol>
- **Docs:** `npm run docs:dev` (see [docs/README.md](docs/README.md))

## What it does

- Servers, channels, DMs, threads, voice/video (LiveKit where configured)
- ActivityPub timelines, follows, and federation with other instances
- Multi-instance servers (members from different Harmony domains in one server)
- End-to-end encryption (Megolm-style) for chat, with cross-device key sharing
- Tauri desktop app and web app from the same codebase

## Stack

- Frontend: Vue 3, TypeScript, Pinia, Vite
- Data: Supabase (Postgres, auth, realtime, storage)
- Federation: Node service in `federation-backend/` ([README](federation-backend/README.md)) - HTTP **server** and queue **worker** split in production Docker; **Redis** for BullMQ and related features
- Desktop: Tauri (`src-tauri/`)

## Quick start (development)

```bash
git clone <repository-url>
cd harmony

npm install
cd federation-backend && npm install && cd ..

cp .env.example .env
cp federation-backend/env.template federation-backend/.env
# Fill in Supabase URL, anon key, instance domain.

# Database: fresh install → db_schema/init/init.sql (see db_schema/init/README.md)
# Updates → db_schema/migrations/*.sql in the SQL editor as needed

npm run dev
# Optional second terminal: cd federation-backend && npm run dev
```

App: http://localhost:5173 - With federation running, health is http://localhost:3001/health.

**Installer:** `bash scripts/install.sh` - Full production-style steps: [docs/self-hosting.md](docs/self-hosting.md).

## Documentation

| Topic | Link |
|--------|------|
| Self-hosting / Docker / Redis / federation-server & worker | [docs/self-hosting.md](docs/self-hosting.md) |
| Roadmap | [ROADMAP.md](ROADMAP.md) |
| DB init | [db_schema/init/README.md](db_schema/init/README.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security policy | [SECURITY.md](SECURITY.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

## Community

- Real-time chat: join the canonical instance at <https://har.mony.lol>
- Bugs / features: [GitHub Issues](https://github.com/y4my4my4m/harmony/issues)
- Security vulns: see [SECURITY.md](SECURITY.md) — please do not file public issues

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) **with additional terms** under AGPL §7 (attribution + trademark) — see:

- [`LICENSE`](LICENSE) — AGPL v3 text
- [`LICENSE-ADDITIONAL-TERMS.md`](LICENSE-ADDITIONAL-TERMS.md) — required attribution
- [`COPYRIGHT`](COPYRIGHT) — copyright statement and bundled-asset notices
- [`TRADEMARK.md`](TRADEMARK.md) — name and logo policy

You are free to fork, modify, and self-host. Forks must rename and keep the
"Powered by Harmony" link to the original repository visible. See
[`LICENSE-ADDITIONAL-TERMS.md`](LICENSE-ADDITIONAL-TERMS.md) for the short
plain-language version.
