# Bot Gateway Setup Guide

## Local Development (No Nginx!)

For local development, everything runs on separate ports with **direct connections**:

### Services Running Locally

```bash
# Terminal 1: Main Harmony app
npm run dev
# → http://localhost:5173

# Terminal 2: Federation backend
cd federation-backend
npm run dev
# → http://localhost:3001

# Terminal 3: Bot Gateway
cd bot-gateway
npm install  # First time only
npm run dev
# → http://localhost:3002
```

### Bot configuration (local)

When the bridge runs on the **same machine** as bot-gateway, connect directly —
no nginx, no `/bot-gateway` prefix:

```yaml
# harmony-discord-bridge/config/bridge-config.yml
discord:
  token: "DISCORD_BOT_TOKEN"
  guildId: "DISCORD_SERVER_ID"

harmony:
  token: "HARMONY_BOT_TOKEN"
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002"       # base only; bridge appends /api/v1
  serverId: "YOUR_HARMONY_SERVER_UUID"
  baseUrl: "http://localhost:5173"      # Harmony UI (npm run dev)

channelMappings:
  - discord: "discord-channel-id"
    harmony: "harmony-channel-uuid"
    bidirectional: true
```

Install the bridge from [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge) (not `bot-plugins/` in this repo).

**No reverse proxy needed for local dev.**

---

## Production Setup

### 1. Nginx Configuration

The whole `/bot-gateway/` prefix is proxied with the prefix stripped, as `handle_path` does in
`self-host/Caddyfile`. The web client also calls `/bot-gateway/bridged-users/*`,
`/bot-gateway/attachments/refresh` and `/bot-gateway/bridge-setup/*`, so per-path locations are
not enough.

```nginx
# http {} context
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# server {} context
location /bot-gateway/ {
    proxy_pass http://localhost:3002/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```

`proxy_read_timeout` exceeds twice the 30 s heartbeat interval, so idle gateway sessions are not cut
by the proxy.

**Reload nginx after updating:**
```bash
sudo nginx -t  # Test config
sudo systemctl reload nginx
```

### 2. Production URLs

Update bot documentation with production URLs:

```markdown
# Production Bot Gateway URLs

- WebSocket: wss://har.mony.lol/bot-gateway/gateway
- REST API: https://har.mony.lol/bot-gateway/api/v1
- Health: https://har.mony.lol/bot-gateway/health
```

### 3. Bot configuration (production)

**Hostname note:** On har.mony.lol, `har.mony.lol` is the Harmony app and
bot-gateway (when proxied). `db.mony.lol` is Supabase/storage only — bots do
**not** connect there.

#### A) Bridge on the same server as bot-gateway (common)

Even in production, use localhost if the bridge process runs on the Harmony host:

```yaml
harmony:
  token: "HARMONY_BOT_TOKEN"
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002"
  serverId: "YOUR_HARMONY_SERVER_UUID"
  baseUrl: "https://har.mony.lol"
```

#### B) Bridge on another machine (or only HTTPS exposed)

Use the nginx `/bot-gateway` paths on the **app** domain:

```yaml
harmony:
  token: "HARMONY_BOT_TOKEN"
  gatewayUrl: "wss://har.mony.lol/bot-gateway/gateway"
  apiUrl: "https://har.mony.lol/bot-gateway"   # base only, no /api/v1
  serverId: "YOUR_HARMONY_SERVER_UUID"
  baseUrl: "https://har.mony.lol"
```

### 4. Deploy Bot Gateway

**Option A: PM2 (Simple)**
```bash
cd bot-gateway
npm install
npm run build
pm2 start dist/index.js --name "harmony-bot-gateway"
pm2 save
```

**Option B: systemd (Recommended)**
```ini
# /etc/systemd/system/harmony-bot-gateway.service
[Unit]
Description=Harmony Bot Gateway
After=network.target

[Service]
Type=simple
User=username
WorkingDirectory=/path/to/harmony/bot-gateway
ExecStart=/usr/bin/node dist/index.js
Restart=always
Environment=NODE_ENV=production
Environment=PORT=3002

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable harmony-bot-gateway
sudo systemctl start harmony-bot-gateway
sudo systemctl status harmony-bot-gateway
```

**Option C: Docker Compose**
```yaml
# docker-compose.yml
services:
  bot-gateway:
    build: ./bot-gateway
    ports:
      - "3002:3002"
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
      - INSTANCE_DOMAIN=har.mony.lol
      - NODE_ENV=production
    restart: unless-stopped
```

---

## Environment Variables

### Bot Gateway (.env)

```bash
# Required
SUPABASE_URL=your-supabase-url
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Port (default: 3002)
PORT=3002

# Your domain (for production)
INSTANCE_DOMAIN=har.mony.lol

# Optional: Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Optional: WebSocket settings
WS_HEARTBEAT_INTERVAL=30000
WS_MAX_CONNECTIONS_PER_BOT=5

# Environment
NODE_ENV=production
```

---

## Testing Local Setup

### 1. Start Bot Gateway
```bash
cd bot-gateway
npm run dev
```

You should see:
```
╔════════════════════════════════════════╗
║   🤖 Harmony Bot Gateway Started      ║
╠════════════════════════════════════════╣
║   HTTP Server:  http://localhost:3002  ║
║   WebSocket:    ws://localhost:3002/gateway
║   Environment:  development            ║
╚════════════════════════════════════════╝
```

### 2. Check Health
```bash
curl http://localhost:3002/health
```

Response:
```json
{
  "status": "ok",
  "uptime": 10.5,
  "timestamp": "2025-11-24T..."
}
```

### 3. Create a Bot
1. Open User Settings → My Bots at `http://localhost:5173`
2. Click **New bot** and submit the form
3. Copy the token from the dialog; it is shown once

### 4. Test with Discord Bridge
```bash
git clone https://github.com/y4my4my4m/harmony-discord-bridge.git
cd harmony-discord-bridge
cp config/bridge-config.example.yml config/bridge-config.yml
nano config/bridge-config.yml  # Add tokens
npm run dev
```

Bot should connect and show:
```
✅ Connected to Harmony gateway
✅ Harmony bot connected: YourBotName
✅ Discord bot connected: BotTag#1234
```

---

## Architecture Summary

### Local (Development)
```
Your App (5173) ──> Supabase
                     ↓ (realtime)
Bot Gateway (3002) ──┘
   ↓ (ws/rest)
User Bots (any port)
```

### Production
```
Nginx (443/80) ──> Harmony App (static files)
      │
      ├──> /bot-gateway/* ──> Bot Gateway (3002)
      │                           ↓ (realtime)
      └──> Federation (3001)      Supabase
                                   
User Bots ──> wss://har.mony.lol/bot-gateway/gateway
```

---

## Troubleshooting

### Bot Can't Connect Locally

**Check:**
1. Is bot-gateway running? (`curl http://localhost:3002/health`)
2. Correct URLs in bot config? (ws://localhost:3002/gateway)
3. Valid bot token? (User Settings → My Bots → the bot → Token shows its last four characters and last use)
4. Supabase credentials in bot-gateway/.env?

### Bot Can't Connect in Production

**Check:**
1. Nginx config updated and reloaded?
2. Bot gateway service running? (`systemctl status harmony-bot-gateway`)
3. Firewall allows port 3002? (if not using nginx)
4. WSS (not WS) in production config?
5. HTTPS certificate valid?

### "Invalid or expired token"

**Fix:**
1. Open User Settings → My Bots and select the bot
2. Click **Reset token** and copy the new token
3. Update bot configuration with the new token
4. Restart bot

---

## Checklist

### Local Development
- [ ] Bot gateway runs on port 3002
- [ ] Bots connect to ws://localhost:3002/gateway
- [ ] No nginx needed
- [ ] All services run directly

### Production Deployment
- [ ] Nginx config updated with bot-gateway routes
- [ ] Bot gateway deployed (PM2/systemd/Docker)
- [ ] Bot gateway .env configured
- [ ] Nginx reloaded
- [ ] Bot documentation updated with wss:// URLs
- [ ] SSL certificate valid
- [ ] Firewall configured (if needed)

---

**Local = Simple & Direct**  
**Production = Nginx Reverse Proxy**

That's it! No nginx needed for local dev! 🎉

