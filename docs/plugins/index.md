---
title: Plugin System
description: Build bridges, integrations, and extensions for Harmony
---

# Harmony Plugin System

The Harmony Plugin System allows developers to create bridges, integrations, and extensions that connect Harmony to other platforms and services.

**Built on the [Bot API](/bot-api)**, plugins are standalone services that:
- Use Harmony Bot API for communication
- Run as independent processes
- Follow a standard architecture pattern
- Can be deployed separately from Harmony

## Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│ External API    │◄───────►│  Bridge Service  │◄───────►│  Harmony API    │
│ (discord.js)    │         │   (Translator)   │         │  (Bot Client)   │
└─────────────────┘         └──────────────────┘         └─────────────────┘
        │                            │                            │
    Platform                  Channel Mapper                  Harmony
    Messages                  Configuration                   Messages
```

### Core Components

1. **Platform Client** - connects to the external platform
2. **Harmony Client** (`HarmonyClient.ts`) - connects to Harmony Bot Gateway
3. **Message Translator** - converts formats, translates mentions/emojis
4. **Channel Mapper** - maps channels between platforms

## Creating a Plugin

### Project Structure

```
my-bridge/
├── src/
│   ├── index.ts              # Main entry point
│   ├── HarmonyClient.ts      # Harmony Bot API client
│   ├── PlatformClient.ts     # External platform client
│   ├── MessageTranslator.ts  # Format conversion
│   └── ChannelMapper.ts      # Channel mapping
├── config/
│   └── bridge-config.yml     # Configuration
├── package.json
├── tsconfig.json
└── README.md
```

### 1. Implement HarmonyClient

Use the reference implementation from the Discord Bridge:

```typescript
import { HarmonyClient } from './HarmonyClient'

const harmonyClient = new HarmonyClient(
  config.harmony.token,
  config.harmony.gatewayUrl
)

harmonyClient.on('ready', (data) => {
  console.log(`Connected: ${data.bot.username}`)
})

harmonyClient.on('messageCreate', async (message) => {
  // Handle Harmony messages
})

await harmonyClient.connect()
```

### 2. Implement Platform Client

```typescript
// Example: Slack bridge
import { WebClient } from '@slack/web-api'

const slackClient = new WebClient(process.env.SLACK_TOKEN)

slackApp.message(async ({ message, say }) => {
  const translated = translator.slackToHarmony(message)
  await harmonyClient.sendMessage(channelMapping[message.channel], translated)
})
```

### 3. Message Translation

```typescript
export class MessageTranslator {
  platformToHarmony(platformMsg: any): string {
    return `**[Platform]** ${platformMsg.user}: ${platformMsg.text}`
  }

  harmonyToPlatform(harmonyMsg: any): string {
    return `**[Harmony]** ${harmonyMsg.author.username}: ${harmonyMsg.content}`
  }
}
```

### 4. Channel Mapping

```yaml
# config/bridge-config.yml
platform:
  token: "PLATFORM_BOT_TOKEN"

harmony:
  token: "HARMONY_BOT_TOKEN"
  gatewayUrl: "ws://localhost:3002/gateway"

channelMappings:
  - platform: "platform-channel-id"
    harmony: "harmony-channel-uuid"
    bidirectional: true
```

### 5. Entry Point

```typescript
import { HarmonyClient } from './HarmonyClient.js'
import { PlatformClient } from './PlatformClient.js'
import { MessageTranslator } from './MessageTranslator.js'
import { ChannelMapper } from './ChannelMapper.js'

const mapper = new ChannelMapper()
const translator = new MessageTranslator()
const harmonyClient = new HarmonyClient(process.env.HARMONY_TOKEN!)
const platformClient = new PlatformClient(process.env.PLATFORM_TOKEN!)

// Platform → Harmony
platformClient.on('message', async (msg) => {
  const harmonyChannel = mapper.getHarmonyChannel(msg.channelId)
  if (!harmonyChannel) return
  const translated = translator.platformToHarmony(msg)
  await harmonyClient.sendMessage(harmonyChannel, translated)
})

// Harmony → Platform
harmonyClient.on('messageCreate', async (msg) => {
  const platformChannel = mapper.getPlatformChannel(msg.channel_id)
  if (!platformChannel) return
  const translated = translator.harmonyToPlatform(msg)
  await platformClient.sendMessage(platformChannel, translated)
})

await Promise.all([
  harmonyClient.connect(),
  platformClient.connect()
])

console.log('🌉 Bridge is running!')
```

## Bridge Types

| Type | Examples | Key Features |
|---|---|---|
| **Real-time Chat** | Discord, Slack, Matrix, IRC | Bi-directional sync, mention translation, loop prevention |
| **Social Media** | Twitter/X, Mastodon, RSS | One-way or selective sync, media embedding |
| **Service Integration** | GitHub, GitLab, CI/CD | Webhook receiver, event formatting |
| **Automation Bots** | Moderation, Analytics | Command processing, event subscriptions |

## Best Practices

- **Loop prevention** - always check if a message originated from your bridge
- **Rate limiting** - implement proper request queuing (5 messages/sec max)
- **Error recovery** - reconnection with exponential backoff
- **Graceful shutdown** - handle `SIGTERM`/`SIGINT` signals

## Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["npm", "start"]
```

### Docker Compose

```yaml
services:
  harmony-bridge:
    build: .
    environment:
      - HARMONY_TOKEN=${HARMONY_TOKEN}
      - PLATFORM_TOKEN=${PLATFORM_TOKEN}
    restart: unless-stopped
```

## Available Plugins

| Plugin | Status | Description |
|---|---|---|
| [Discord Bridge](/plugins/discord-bridge) | Reference implementation | Bi-directional Discord ↔ Harmony sync |
| Matrix Bridge | In development | Full federation + E2EE support |
| Slack Bridge | Planned | Workspace integration |

## Plugin Ideas

- **IRC Bridge** - Connect to IRC networks
- **Matrix Bridge** - Full Matrix federation
- **RSS Bot** - Post RSS feed updates
- **GitHub Bot** - Commit/PR notifications
- **Twitch Bot** - Stream notifications
- **Music Bot** - Play music in voice channels
- **Moderation Bot** - Auto-mod system
- **Translation Bot** - Auto-translate messages

## Contributing

Follow the project structure above, write clear docs, test thoroughly, and submit a PR.
