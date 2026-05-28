---
title: Discord Bridge Setup Guide
description: Connect your Discord server to Harmony with bi-directional message sync
---

# Discord Bridge Plugin

Cross-platform bridge connecting Discord and Harmony servers with bi-directional message sync.

## Features

- ✅ Bi-directional message sync
- ✅ User mention translation
- ✅ Custom emoji translation (Discord emojis auto-sync to Harmony as federated emojis)
- ✅ Attachment support
- ✅ Reaction syncing
- ✅ Message editing sync
- ✅ Message deletion sync
- ✅ Loop prevention
- ✅ Configurable channel mappings

## Prerequisites

- A running Harmony instance with the [Bot Gateway](/bot-api)
- Node.js 18+
- A Discord bot token
- A Harmony bot token (created via admin panel)

## Setup

### 1. Install Dependencies

```bash
cd bot-plugins/discord-bridge
npm install
```

### 2. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" tab and create a bot
4. Copy the bot token
5. Enable **Message Content Intent** under Privileged Gateway Intents
6. Invite the bot to your server with permissions:
   - Read Messages / View Channels
   - Send Messages
   - Read Message History

### 3. Create a Harmony Bot

1. Log into your Harmony admin panel
2. Go to Bot Management
3. Create a new bot
4. Copy the bot token
5. Add the bot to your Harmony server with permissions:
   - Read Messages
   - Send Messages

### 4. Configure the Bridge

```bash
cp config/bridge-config.example.yml config/bridge-config.yml
```

Edit `config/bridge-config.yml`:

```yaml
discord:
  token: "YOUR_DISCORD_BOT_TOKEN"
  guildId: "123456789012345678"

harmony:
  token: "YOUR_HARMONY_BOT_TOKEN"
  gatewayUrl: "ws://localhost:3002/gateway"    # Local dev
  apiUrl: "http://localhost:3002/api/v1"        # Local dev

channelMappings:
  - discord: "987654321098765432"
    harmony: "550e8400-e29b-41d4-a716-446655440000"
    bidirectional: true
    name: "general"

  - discord: "111222333444555666"
    harmony: "650e8400-e29b-41d4-a716-446655440000"
    bidirectional: true
    name: "announcements"

settings:
  syncAttachments: true
  syncReactions: true
  syncEdits: true
  syncDeletes: true
  mentionTranslation: true
```

**To get channel IDs:**
- **Discord**: Enable Developer Mode in Discord Settings → right-click channel → Copy ID
- **Harmony**: Check channel URL or use developer tools

### 5. Start the Bridge

```bash
npm run dev
```

You should see:

```
✅ Connected to Harmony gateway
✅ Harmony bot connected: YourBotName
✅ Discord bot connected: BotTag#1234
```

## How It Works

### Discord → Harmony

```
User sends message in Discord
  ↓
Bridge receives via discord.js
  ↓
Translate mentions and emojis
  ↓
Format: **[Discord]** username: message
  ↓
Send to Harmony via Bot API
  ↓
Appears in Harmony channel
```

### Harmony → Discord

```
User sends message in Harmony
  ↓
Bridge receives via WebSocket gateway
  ↓
Check if from Discord (avoid loop)
  ↓
Format: **[Harmony]** username: message
  ↓
Send to Discord channel
  ↓
Appears in Discord channel
```

### Loop Prevention

The bridge prevents infinite loops by:
1. Ignoring all bot messages
2. Checking for `[Discord]` and `[Harmony]` prefixes
3. Not bridging messages that are already bridged

## Production Deployment

### Production URLs

Update your config for production:

```yaml
harmony:
  token: "YOUR_HARMONY_BOT_TOKEN"
  gatewayUrl: "wss://your-domain.com/bot-gateway/gateway"
  apiUrl: "https://your-domain.com/bot-gateway/api/v1"
```

### Build & Run

```bash
npm run build
npm start
```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
COPY config ./config
CMD ["npm", "start"]
```

### Docker Compose

```yaml
services:
  discord-bridge:
    build: ./bot-plugins/discord-bridge
    environment:
      - NODE_ENV=production
    volumes:
      - ./bot-plugins/discord-bridge/config:/app/config
    restart: unless-stopped
```

### PM2

```bash
cd bot-plugins/discord-bridge
npm run build
pm2 start dist/index.js --name "harmony-discord-bridge"
pm2 save
```

## Troubleshooting

### Messages not bridging

1. Check both bots are online
2. Verify channel IDs in config are correct
3. Check bot permissions in both platforms
4. Ensure bot-gateway is running (for Harmony side)
5. Check bridge logs for errors

### Mentions not translating

- Ensure `mentionTranslation: true` in config
- Discord mentions require the mentioned user to be in the server
- Harmony mentions use profile ID

### Attachments not working

- Set `syncAttachments: true` in config
- Attachments are linked, not re-uploaded
- Ensure bots have embed/attachment permissions

### Bot can't connect to Harmony

1. Is the bot-gateway running? (`curl http://localhost:3002/health`)
2. Correct URLs in bridge config? (`ws://localhost:3002/gateway`)
3. Valid bot token? (check admin panel)
4. Supabase credentials set in bot-gateway `.env`?

### Bot can't connect in production

1. Nginx config updated and reloaded?
2. Bot gateway service running?
3. Using `wss://` (not `ws://`) in production config?
4. HTTPS certificate valid?

## Limitations

- No voice/video bridging
- Embeds are simplified
- 2000 character Discord limit applies
- Custom Discord emojis are synced to Harmony as federated emojis

## Bot Gateway Setup

For complete bot gateway deployment instructions (Nginx, systemd, Docker, environment variables), see the [Bot Gateway Setup Guide](/BOT_GATEWAY_SETUP).
