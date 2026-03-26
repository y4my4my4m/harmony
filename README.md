# 🐻‍❄️ Harmony

Harmony is a federated social app: Discord-style servers and chat with ActivityPub, built on Vue 3 and Supabase.

**Docs:** `npm run docs:dev` (see [docs/README.md](docs/README.md)).

## What it does

- Servers, channels, DMs, threads, voice/video (LiveKit where configured)
- ActivityPub timelines, follows, and federation with other instances
- Multi-instance servers (members from different Harmony domains in one server)

## Stack

- Frontend: Vue 3, TypeScript, Pinia, Vite
- Data: Supabase (Postgres, auth, realtime, storage)
- Federation: Node service in `federation-backend/` ([README](federation-backend/README.md)) — HTTP **server** and queue **worker** split in production Docker; **Redis** for BullMQ and related features
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

App: http://localhost:5173 — With federation running, health is http://localhost:3001/health.

**Installer:** `bash scripts/install.sh` — Full production-style steps: [docs/HOW_TO_SELF_HOST.md](docs/HOW_TO_SELF_HOST.md).

## Documentation

| Topic | Link |
|--------|------|
| Self-hosting / Docker / Redis / federation-server & worker | [docs/HOW_TO_SELF_HOST.md](docs/HOW_TO_SELF_HOST.md) |
| Roadmap & tech debt | [TODO_latest.md](TODO_latest.md) (older notes: [TODO.md](TODO.md)) |
| DB init | [db_schema/init/README.md](db_schema/init/README.md) |
| Contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

## License

[GNU Affero General Public License v3.0](https://www.gnu.org/licenses/agpl-3.0.html) — see [LICENSE](LICENSE).
