# OpenStatus - Status Page Setup

A public status page lets your users know when your Harmony instance is experiencing issues or undergoing maintenance. This guide covers deploying [OpenStatus](https://www.openstatus.dev) (open-source) on a **separate VPS** to monitor your Harmony instance.

## Why a Separate VPS?

A status page running on the same machine as the service it monitors goes down at the exact moment users need it most. Deploying on a separate host ensures:

- Users can still check status when your main server is unreachable
- Monitoring probes can actually detect that your instance is down
- Planned maintenance announcements remain visible while you work on the main server

A small VPS ($4-5/month) or free-tier instance is sufficient for the lightweight stack.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────────┐
│  Main VPS           │         │  Status VPS              │
│                     │         │                          │
│  Harmony App        │◄────────│  OpenStatus Dashboard    │
│  Federation Backend │  checks │  OpenStatus Status Page  │
│  LiveKit / Redis    │         │  libSQL Database         │
│  Nginx              │         │  Nginx (reverse proxy)   │
└─────────────────────┘         └──────────────────────────┘
     harmony.example.com          status.example.com
```

## Prerequisites

- A separate VPS with Docker and Docker Compose installed
- A subdomain pointing to the status VPS (e.g., `status.example.com`)
- Git installed on the status VPS

## Step-by-Step Setup

### 1. Clone OpenStatus

On your **status VPS**:

```bash
git clone https://github.com/openstatushq/openstatus
cd openstatus
```

### 2. Configure Environment

Copy the lightweight environment template:

```bash
cp .env.docker-lightweight.example .env.docker
```

Edit `.env.docker` and set the required variables:

```bash
# Required: authentication secret
AUTH_SECRET=$(openssl rand -base64 32)

# Required: for magic-link login emails
# Get a key from https://resend.com/
RESEND_API_KEY=re_your_api_key_here
```

Optionally configure GitHub or Google OAuth providers in the same file.

### 3. Start Services

Use the lightweight Docker Compose file (4 containers only):

```bash
docker compose -f docker-compose-lightweight.yaml up -d
```

Wait for all services to become healthy:

```bash
docker compose -f docker-compose-lightweight.yaml ps
```

The `db-migrate` service will show as "exited" - this is expected (it runs once).

| Service    | Purpose                     | Default Port |
|------------|-----------------------------|--------------|
| libsql     | Database                    | 8080         |
| db-migrate | One-shot migration (exits)  | -            |
| dashboard  | Admin interface             | 3000         |
| status-page| Public status page          | 3001         |

### 4. Set Up Nginx Reverse Proxy

Install Nginx on the status VPS and create a config:

```nginx
# /etc/nginx/sites-available/status.example.com

server {
    listen 80;
    server_name status.example.com;

    # Dashboard (admin only - consider restricting by IP)
    location /dashboard/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Public status page
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/status.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. Set Up SSL

```bash
sudo apt install certbot python3-certbot-nginx   # Debian/Ubuntu
sudo certbot --nginx -d status.example.com
```

### 6. Configure OpenStatus Dashboard

1. Visit `https://status.example.com/dashboard/`
2. Log in via magic link (creates your account and workspace)
3. Set workspace feature limits by running this command on the status VPS:

```bash
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -d '{"statements":["UPDATE workspace SET limits = '\''{ \"monitors\":100, \"periodicity\":[\"30s\",\"1m\",\"5m\",\"10m\",\"30m\",\"1h\"], \"multi-region\":true, \"data-retention\":\"24 months\", \"status-pages\":20, \"maintenance\":true, \"status-subscribers\":true, \"custom-domain\":true, \"password-protection\":true, \"white-label\":true, \"notifications\":true, \"sms\":true, \"pagerduty\":true, \"notification-channels\":50, \"members\":\"Unlimited\", \"audit-log\":true, \"private-locations\":true }'\'' WHERE id = 1"]}'
```

### 7. Add Harmony Monitors

In the OpenStatus dashboard, create monitors for your Harmony instance endpoints:

| Monitor Name          | URL / Endpoint                                       | Interval |
|-----------------------|------------------------------------------------------|----------|
| Main Site             | `https://harmony.example.com`                        | 1m       |
| Federation API        | `https://harmony.example.com/.well-known/webfinger?resource=acct:admin@harmony.example.com` | 5m |
| Federation Backend    | `https://harmony.example.com/api/federation/health`  | 5m       |
| Voice (LiveKit)       | `https://livekit.harmony.example.com` (if enabled)   | 5m       |
| Bot Gateway           | `https://harmony.example.com/bot-gateway/health` (if enabled) | 5m |

### 8. Create Your Status Page

In the dashboard:

1. Create a new status page
2. Add components for each service (Website, Federation, Voice, etc.)
3. Publish the page
4. Your public status page is live at `https://status.example.com`

## Data & Backups

All data is stored in the `openstatus-libsql-data` Docker volume.

- `docker compose down` preserves data
- `docker compose down -v` **destroys** data - be careful
- Back up the volume regularly for production use

## Updating

```bash
cd openstatus
git pull
docker compose -f docker-compose-lightweight.yaml up -d --build
```

## Further Reading

- [OpenStatus Self-Hosting Guide (Full)](https://docs.openstatus.dev/guides/self-hosting-openstatus/) - includes automated monitoring and analytics
- [OpenStatus Self-Hosting Guide (Lightweight)](https://docs.openstatus.dev/guides/self-host-status-page-only/) - status page only
- [OpenStatus GitHub](https://github.com/openstatushq/openstatus)
