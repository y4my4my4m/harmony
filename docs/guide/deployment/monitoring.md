# Monitoring

## Health Endpoints

Harmony exposes health endpoints for monitoring:

| Endpoint | Service | Via Nginx |
|----------|---------|-----------|
| `GET /health` | Federation backend | `/api/federation/health` |
| `POST /health/maintenance` | Trigger maintenance tasks | `/api/federation/health/maintenance` |
| `GET /health/key-consistency` | Key consistency report | `/api/federation/health/key-consistency` |
| `GET /api/livekit/health` | LiveKit integration | `/api/livekit/health` |
| `GET /health` | Bot gateway | `/bot-gateway/health` |

### Federation Health Response

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "production",
  "instance": "har.mony.lol",
  "database": "connected",
  "timestamp": "2026-03-06T00:00:00.000Z"
}
```

## Logging

### Federation Backend

Uses Winston with configurable levels via `LOG_LEVEL` env var:

| Level | Description |
|-------|-------------|
| `error` | Errors only |
| `warn` | Warnings and errors |
| `info` | Standard operational logging (default) |
| `debug` | Verbose debugging output |

Log outputs:
- Console (all levels)
- `logs/error.log` (errors only)
- `logs/combined.log` (all levels)

### Nginx

Access and error logs are written to:

- `/var/log/nginx/harmony.access.log`
- `/var/log/nginx/harmony.error.log`
- `/var/log/nginx/harmony-docs.access.log`
- `/var/log/nginx/harmony-docs.error.log`

## External Monitoring

### OpenStatus

Harmony supports monitoring via [OpenStatus](https://www.openstatus.dev/) (or similar uptime services). See `docs/OPENSTATUS_SETUP.md` for detailed setup.

Recommended monitors:

| Monitor | URL | Interval |
|---------|-----|----------|
| Main site | `https://your-domain.com` | 1 minute |
| WebFinger | `https://your-domain.com/.well-known/webfinger?resource=acct:test@your-domain.com` | 5 minutes |
| Federation health | `https://your-domain.com/api/federation/health` | 5 minutes |
| LiveKit | `https://live.your-domain.com` | 5 minutes |
| Bot gateway | `https://your-domain.com/bot-gateway/health` | 5 minutes |

### Alerting

Set up alerts for:

- Health endpoint failures (5xx responses)
- SSL certificate expiration
- Disk space on the server
- Database connection failures
- Federation queue backlog growth

## Docker Container Monitoring

### Container Health

Docker Compose health checks are configured for:

- **federation-backend**: HTTP check on `/health` every 30 seconds
- **redis**: `redis-cli ping` every 10 seconds

Check container status:

```bash
docker compose -f docker-compose.prod.yml ps
```

### Container Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Specific service
docker logs -f harmony-federation
docker logs -f harmony-nginx
docker logs -f harmony-redis
```

## Admin Panel Monitoring

The Harmony admin panel (`/admin`) provides real-time monitoring:

- **System Overview**: User count, server count, post count, instance count
- **System Health**: Database, federation queue, storage, memory status
- **Federation Stats**: Active instances, endpoint health, success rates, dead endpoints
- **Maintenance**: Key consistency checks, orphan cleanup, key generation sweep

## Supabase Monitoring

### Dashboard

The Supabase dashboard provides:

- **Database**: Query performance, active connections, table sizes
- **Auth**: Active sessions, sign-up rates
- **Storage**: Bucket usage
- **Realtime**: Active connections, message throughput
- **Logs**: API request logs with filtering

### Local Development

With `supabase start`, the dashboard is at `http://localhost:54323`.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/deployment/monitoring.md` and run `npm run docs:generate-guide` to update.
