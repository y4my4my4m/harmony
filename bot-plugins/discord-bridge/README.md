# Discord-Harmony Bridge

Cross-platform bridge connecting Discord and Harmony servers.

This is a **standalone** service: it talks only to a Harmony `bot-gateway` over
WebSocket + REST, so you can host it on its own without the Harmony backend or
database. See [`EXTRACTION.md`](./EXTRACTION.md) to split it into its own repo.

## Features

- Bi-directional message sync
- Bi-directional reaction sync (unicode emojis both ways; custom Discord emojis
  are synced into Harmony as federated emojis)
- User mention translation
- Custom emoji translation
- Attachment support
- Message editing sync
- Message deletion sync
- Loop prevention
- Configurable channel mappings

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create Discord Bot

1. Go to https://discord.com/developers/applications
2. Create a new application
3. Go to "Bot" tab and create a bot
4. Copy the bot token
5. Enable "Message Content Intent"
6. Invite bot to your server with these permissions:
   - Read Messages/View Channels
   - Send Messages
   - Read Message History

### 3. Create Harmony Bot

1. Log into your Harmony admin panel
2. Go to Bot Management
3. Create a new bot
4. Copy the bot token
5. Add bot to your Harmony server with permissions:
   - Read Messages
   - Send Messages

### 4. Configure Bridge

```bash
cp config/bridge-config.example.yml config/bridge-config.yml
nano config/bridge-config.yml
```

Fill in:
- Discord bot token
- Discord server (guild) ID
- Harmony bot token
- Channel mappings (Discord ID <-> Harmony ID)

To get channel IDs:
- **Discord**: Enable Developer Mode in Discord settings, right-click channel, Copy ID
- **Harmony**: Check channel URL or use developer tools

### 5. Start Bridge

```bash
npm run dev
```

## Configuration

### Example Config

```yaml
discord:
  token: "YOUR_DISCORD_BOT_TOKEN"
  guildId: "123456789012345678"

harmony:
  token: "YOUR_HARMONY_BOT_TOKEN"
  # Both point at the Harmony bot-gateway (default port 3002). When hosting the
  # bridge remotely, use your public proxy, e.g.
  #   gatewayUrl: "wss://chat.example.com/bot-gateway/gateway"
  #   apiUrl:     "https://chat.example.com/bot-gateway/api/v1"
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002/api/v1"
  serverId: "YOUR_HARMONY_SERVER_UUID"
  baseUrl: "https://chat.example.com"

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

## Loop Prevention

The bridge prevents infinite loops by:
1. Ignoring its own bot's messages on both platforms
2. Tagging bridged content with `metadata.bridge_source = "discord"` and
   skipping anything already carrying that marker
3. Posting Harmony → Discord via a webhook so bridged messages are never
   re-ingested as normal user messages

## Production Deployment

### Docker Compose (recommended)

```bash
cp config/bridge-config.example.yml config/bridge-config.yml
# edit config/bridge-config.yml with your tokens + channel mappings
docker compose up -d
```

The bundled `docker-compose.yml` builds the image and mounts `./config`
read-only (the bridge hot-reloads channel mappings on change).

### Manual

```bash
npm ci
npm run build
npm start
```

## Troubleshooting

### Messages not bridging

1. Check both bots are online
2. Verify channel IDs in config are correct
3. Check bot permissions in both platforms
4. Check bot-gateway is running (for Harmony)
5. Look at bridge logs for errors

### Mentions not translating

- Ensure `mentionTranslation: true` in config
- Discord mentions require user to be in server
- Harmony mentions use profile ID

### Attachments not working

- Set `syncAttachments: true`
- Attachments are linked, not re-uploaded
- Ensure bots have embed/attachment permissions

## Limitations

- No voice/video bridging
- Embeds are simplified
- 2000 character Discord limit
- Custom Discord emojis are automatically synced to Harmony as federated emojis

## License

GNU **AGPL-3.0** (same as the main Harmony repository; see root `LICENSE`).

