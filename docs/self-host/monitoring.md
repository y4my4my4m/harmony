---
title: Monitoring
description: The checks, health endpoints, logs and dashboards available for watching a self-hosted Harmony instance.
---

# Monitoring

This page is for operators. It lists what a Harmony instance offers for
watching its health: `harmony doctor`, health endpoints, container health
checks, logs, the admin panel, Supabase Studio and the queue dashboard. No
service exposes a metrics endpoint for Prometheus or similar collectors.

## Check the whole instance

```bash
harmony doctor
```

`harmony doctor` checks the host (memory, disk, the age of the last backup),
the containers, the database and migrations, DNS, TLS certificates,
federation through the public URL, push, email, the sign-in service, the bot
gateway and voice when they are on, database security and versions. Each
line is OK, WARN or FAIL with a fix. It exits with status 1 when any check
fails, so a scheduler can run it and act on the result. `--offline` skips
the checks that need the internet. [The harmony command](/self-host/cli#harmony-doctor)
lists every check.

`harmony status` prints the URL, code and image versions, enabled profiles,
registration policy, last backup and the state of every container.

## Health endpoints

| Endpoint | Service | Answers |
|---|---|---|
| `GET https://chat.example.com/health` (also `/api/federation/health`) | Federation server | 200 with the database, Redis and queue state; 503 when its database query fails |
| `GET https://chat.example.com/api/livekit/health` | Federation server | `not_configured`, `healthy` with the active room count, or 503 `unhealthy` when LiveKit does not answer |
| `GET https://chat.example.com/api/federation/push/status` | Federation server | Which push transports work: `available`, `configured`, `fcm`, `unifiedpush` |
| `GET https://chat.example.com/bot-gateway/health` | Bot gateway | `{"status": "ok", "uptime": ..., "timestamp": ...}` |
| `GET https://chat.example.com/bot-gateway/status` | Bot gateway | Connected bots and connection count. Needs a signed-in user's access token |
| `GET https://db.chat.example.com/auth/v1/health` | Supabase sign-in service | 200 when healthy. Needs the anon key in an `apikey` header |
| `GET https://chat.example.com/health/key-consistency` | Federation server | Local users missing or with inconsistent signing keys. Needs an instance admin's access token |

The federation health answer:

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
  "queues": { "status": "not_running" },
  "timestamp": "2026-10-13T00:00:00.000Z"
}
```

`redis` reads `unavailable` when Redis does not answer; the endpoint still
returns 200. `version` is the backend's `VERSION` variable. `queues` holds
per-queue job counts only in a process that runs the queues: the compose
files run the HTTP server and the queue worker as separate containers, so
the public endpoint reports `not_running`. Watch the queues with the
[queue dashboard](#queue-dashboard) instead.

Inside the stack, the services answer directly at
`http://federation-server:3001/health` and `http://bot-gateway:3002/health`.

## Container health checks

| Container | Check |
|---|---|
| `harmony-federation-server` | `GET /health` every 30 seconds |
| `harmony-federation-worker` | None: the worker serves no HTTP |
| `harmony-redis` | `redis-cli ping` every 10 seconds |
| `harmony-web` | `GET /` every 30 seconds |
| `harmony-bot-gateway` | `GET /health` every 30 seconds |

`docker compose ps` in `self-host/` shows each container's health, and
`harmony doctor` fails on an unhealthy one.

## Logs

```bash
harmony logs                              # every service, followed
harmony logs federation                   # federation-server and federation-worker
harmony logs supabase                     # db, auth, rest, realtime, storage, kong
harmony logs caddy -n 500 --no-follow     # the last 500 lines, then exit
```

Any compose service name works: `caddy`, `web`, `federation-server`,
`federation-worker`, `redis`, `bot-gateway`, `discord-bridge-host`,
`livekit`, and Supabase's services. [The harmony command](/self-host/cli#harmony-logs)
describes the options.

The federation backend logs at `LOG_LEVEL` (`error`, `warn`, `info` or
`debug`; default `info`) in `federation.env`. Besides the container output,
it writes `logs/error.log` and `logs/combined.log` under `/app` inside its
container. They are not on a volume, so recreating the container empties
them.

## Admin panel

**User settings** → **Instance admin** shows instance admins:

- **Overview** → **System health**: database response time and connection
  count, pending deliveries in the federation queue (shown as a warning above
  100), and database size.
- **Federation**: endpoint health (dead endpoints and endpoints with
  failures, which you can purge), the key consistency report, and the
  **Key generation sweep** and **Orphan cleanup** maintenance tasks.
- **Tools** → **Performance monitoring**: request, latency, slow query and
  federation charts. They read hourly aggregates written by the database
  function `public.aggregate_hourly_metrics()`; no migration or service
  schedules it, so on a new instance the charts stay empty.

## Supabase Studio

Studio, Supabase's database browser, is at `https://db.chat.example.com`:
user `supabase`, password `DASHBOARD_PASSWORD` from `self-host/supabase/.env`.
It shows tables, sign-in users, storage, and the Supabase services' logs.

## Queue dashboard

Bull Board, in `bull-board/`, shows the job queues the federation worker processes: waiting, active,
completed, failed and delayed jobs, with their data and errors.

The root compose files (`docker-compose.prod.yml`, `docker-compose.full.yml`)
run it under the `monitoring` profile, on `127.0.0.1:3003`:

```bash
docker compose -f docker-compose.full.yml --profile monitoring up -d
```

It requires HTTP basic auth: `BULL_BOARD_PASSWORD` (it exits at start
without one) and `BULL_BOARD_USER` (default `admin`), set in the root `.env`.
`dev/nginx-bullboard.template.conf` publishes it on its own subdomain behind
nginx.

The installer stack does not include it. To run it against that stack's
Redis, build the image and attach it to the `harmony` network:

```bash
cd /opt/harmony/bull-board
docker build -t harmony-bull-board .
docker run -d --name harmony-bull-board --restart unless-stopped \
  --network harmony -p 127.0.0.1:3003:3003 \
  -e REDIS_URL="redis://:$(grep '^REDIS_PASSWORD=' ../self-host/.env | cut -d= -f2)@redis:6379" \
  -e BULL_BOARD_PASSWORD='choose-a-password' \
  harmony-bull-board
```

It listens on the server's loopback address only. Reach it through an SSH
tunnel:

```bash
ssh -L 3003:127.0.0.1:3003 you@chat.example.com
```

then open `http://localhost:3003`.

The dashboard lists a fixed set of queues compiled into `bull-board/server.js`.

## External uptime checks

A check running on the same server goes down with it. Run uptime checks
from another host or service; [OpenStatus](https://www.openstatus.dev) is
one open-source option. Useful targets:

| Check | URL | Healthy answer |
|---|---|---|
| App | `https://chat.example.com` | 200 |
| Federation backend | `https://chat.example.com/health` | 200, `"status": "healthy"` |
| Federation discovery | `https://chat.example.com/.well-known/webfinger?resource=acct:admin@chat.example.com` | 200, with a real username in place of `admin` |
| Voice | `https://chat.example.com/api/livekit/health` | 200, `"status": "healthy"` |
| Bot gateway | `https://chat.example.com/bot-gateway/health` | 200, `"status": "ok"` |

Also worth alerting on: certificate expiry (`harmony doctor` warns 21 days
ahead), free disk space (the database and uploads live in
`self-host/supabase/volumes/`), and the age of the last backup
(`harmony doctor` warns after 7 days).
