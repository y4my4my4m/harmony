# Monitoring

## harmony doctor

On a self-host install, `harmony doctor` checks the instance (configuration, containers, DNS, TLS and the proxy from outside, the database and migrations, email, push, voice, disk and backups) and prints each check as OK, WARN or FAIL with a one-line fix. It exits 1 when any check fails. `--offline` skips the checks that need the internet.

## Health endpoints

| Endpoint | Service | Answer |
|---|---|---|
| `GET /api/federation/health` | Federation server | 200 with database, Redis and queue state; 503 when the database query fails |
| `GET /api/federation/health/key-consistency` | Federation server | Key consistency report. Admin bearer token |
| `POST /api/federation/health/maintenance` | Federation server | Queues `{"task": "keygen-sweep" \| "cleanup-orphans" \| "verify-federation"}`. Admin bearer token |
| `GET /api/livekit/health` | Federation server | `not_configured`, `healthy` with the active room count, or 503 `unhealthy` when LiveKit does not answer |
| `GET /api/federation/push/status` | Federation server | `available`, `configured` (VAPID), `fcm`, `unifiedpush` |
| `GET /bot-gateway/health` | Bot gateway | `{"status": "ok", "uptime": ..., "timestamp": ...}` |

`/api/federation/health` answers:

```json
{
  "success": true,
  "status": "healthy",
  "version": "1.6.7",
  "environment": "production",
  "instance": { "name": "Harmony", "domain": "chat.example.com" },
  "database": "connected",
  "redis": "connected",
  "redis_latency_ms": 1,
  "queues": { "...": "per-queue job counts" },
  "timestamp": "2026-10-07T00:00:00.000Z"
}
```

Inside the stack, the same endpoints answer on the services directly: `http://federation-server:3001/health`, `http://bot-gateway:3002/health`.

## Container health

Docker health checks run on `harmony-federation-server` (`GET /health` every 30 s), `harmony-redis` (`redis-cli ping` every 10 s), `harmony-web` and `harmony-bot-gateway`. The worker serves no HTTP and has none.

```bash
harmony status                 # URL, version, profiles, container states
docker compose ps              # in self-host/
```

## Logs

```bash
harmony logs                   # every service, followed
harmony logs federation        # federation-server and federation-worker
harmony logs supabase          # db, auth, rest, realtime, storage, kong
harmony logs caddy -n 500 --no-follow
```

The federation backend logs through Winston at `LOG_LEVEL` (`error`, `warn`, `info`, `debug`; default `info`) to the console, and to `logs/error.log` and `logs/combined.log` under its working directory (`/app/logs` in the image).

Host nginx from the templates writes `/var/log/nginx/harmony.access.log`, `harmony.error.log`, `livekit.access.log` and `livekit.error.log`.

## Admin panel

`/admin` shows, to instance admins:

- **Performance Monitoring**: request latency over time, slow queries and federation health
- **Federation**: instance statistics, dead delivery endpoints, the key consistency report, a key generation sweep and orphaned key cleanup

## Queue dashboard

Bull Board (`bull-board/`) shows the BullMQ queues. It runs only in the root compose files, under the `monitoring` profile, on `127.0.0.1:3003` with HTTP basic auth (`BULL_BOARD_USER`, `BULL_BOARD_PASSWORD`); `dev/nginx-bullboard.template.conf` publishes it on a subdomain. The self-host stack does not include it.

## Supabase Studio

In the self-host stack, Studio is at `https://db.DOMAIN`, user `supabase`, password `DASHBOARD_PASSWORD` in `self-host/supabase/.env`. It shows the database, auth users, storage and logs.

## External monitoring

Any uptime service works; [OpenStatus Setup](/OPENSTATUS_SETUP) describes one. Useful monitors:

| Monitor | URL |
|---|---|
| App | `https://chat.example.com` |
| Federation | `https://chat.example.com/api/federation/health` |
| WebFinger | `https://chat.example.com/.well-known/webfinger?resource=acct:<user>@chat.example.com` |
| LiveKit | `https://chat.example.com/api/livekit/health` |
| Bot gateway | `https://chat.example.com/bot-gateway/health` |

Worth alerting on: 5xx from the health endpoints, certificate expiry, disk space (database and uploads live in `self-host/supabase/volumes/`), and a growing queue backlog in `/health`.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/deployment/monitoring.md` and run `npm run docs:generate-guide` to update.
