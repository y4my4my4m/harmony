# Discord-Harmony Bridge

Cross-platform bridge connecting Discord and Harmony servers.

## Features

- Bi-directional message sync
- User mention translation
- Custom emoji translation
- Attachment support
- Reaction syncing
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
  gatewayUrl: "ws://localhost:3001/gateway"
  apiUrl: "http://localhost:3001/api/v1"

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
1. Ignoring all bot messages
2. Checking for `[Discord]` and `[Harmony]` prefixes
3. Not bridging messages that are already bridged

## Production Deployment

### Build

```bash
npm run build
```

### Run

```bash
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

