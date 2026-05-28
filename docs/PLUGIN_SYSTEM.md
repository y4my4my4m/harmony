# Harmony Plugin System

## Overview

The Harmony Plugin System allows developers to create bridges, integrations, and extensions that connect Harmony to other platforms and services.

**Built on the Bot API**, plugins are standalone services that:
- Use Harmony Bot API for communication
- Run as independent processes
- Follow a standard architecture pattern
- Can be deployed separately from Harmony

## Bridge Pattern

The **Discord Bridge** serves as the reference implementation for all plugins.

### Architecture

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│   Discord API   │◄───────►│  Bridge Service  │◄───────►│  Harmony API    │
│  (discord.js)   │         │   (Translator)   │         │  (Bot Client)   │
└─────────────────┘         └──────────────────┘         └─────────────────┘
        │                            │                            │
        │                            │                            │
    Discord                   Channel Mapper                  Harmony
    Messages                  Configuration                   Messages
```

### Core Components

1. **Platform Client** (e.g., Discord.js)
   - Connects to external platform
   - Receives platform events
   - Sends platform messages

2. **Harmony Client** (`HarmonyClient.ts`)
   - Connects to Harmony Bot Gateway
   - Receives Harmony events
   - Sends Harmony messages

3. **Message Translator**
   - Converts message formats
   - Translates mentions/emojis
   - Handles platform-specific features

4. **Channel Mapper**
   - Maps channels between platforms
   - Configuration management
   - Bidirectional control

## Creating a Plugin

### Step 1: Project Structure

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

### Step 2: Implement HarmonyClient

Use the reference implementation from `discord-bridge/src/HarmonyClient.ts`:

```typescript
// Copy the HarmonyClient implementation from bot-plugins/discord-bridge/src/
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

### Step 3: Implement Platform Client

Connect to your target platform:

```typescript
// Example: Slack bridge
import { WebClient } from '@slack/web-api'

const slackClient = new WebClient(process.env.SLACK_TOKEN)

// Listen to Slack messages
slackApp.message(async ({ message, say }) => {
  // Translate and send to Harmony
  const translated = translator.slackToHarmony(message)
  await harmonyClient.sendMessage(channelMapping[message.channel], translated)
})
```

### Step 4: Message Translation

Implement bidirectional translation:

```typescript
export class MessageTranslator {
  platformToHarmony(platformMsg: any): string {
    // Convert platform format → Harmony format
    // Translate mentions, emojis, attachments
    return `**[Platform]** ${platformMsg.user}: ${platformMsg.text}`
  }
  
  harmonyToPlatform(harmonyMsg: any): string {
    // Convert Harmony format → platform format
    return `**[Harmony]** ${harmonyMsg.author.username}: ${harmonyMsg.content}`
  }
}
```

### Step 5: Channel Mapping

Load and manage channel mappings:

```typescript
import { ChannelMapper } from './ChannelMapper.js'

const mapper = new ChannelMapper('./config/bridge-config.yml')

// Get mapped channel
const harmonyChannel = mapper.getHarmonyChannel(platformChannelId)

// Check if should bridge
if (mapper.shouldBridge(platformChannelId)) {
  // Bridge the message
}
```

### Step 6: Configuration

Create config file:

```yaml
platform:
  token: "PLATFORM_BOT_TOKEN"
  # Platform-specific config

harmony:
  token: "HARMONY_BOT_TOKEN"
  gatewayUrl: "ws://localhost:3001/gateway"

channelMappings:
  - platform: "platform-channel-id"
    harmony: "harmony-channel-uuid"
    bidirectional: true
```

## Bridge Types

### 1. Real-time Chat Bridges

**Examples:** Discord, Slack, Matrix, IRC, Telegram

**Requirements:**
- Bi-directional message sync
- User mention translation
- Attachment handling
- Loop prevention

**Implementation:**
- Subscribe to both platform's events
- Translate and forward messages
- Cache message IDs for edits/deletes

### 2. Social Media Integrations

**Examples:** Twitter/X, Mastodon, RSS feeds

**Requirements:**
- One-way or selective two-way sync
- Media embedding
- Link preservation
- Rate limit handling

**Implementation:**
- Poll or webhook for new posts
- Format for Harmony display
- Optional: Allow replies from Harmony

### 3. Service Integrations

**Examples:** GitHub, GitLab, CI/CD, Monitoring

**Requirements:**
- Webhook receiver
- Event formatting
- Action triggers from Harmony

**Implementation:**
- HTTP server for webhooks
- Parse webhook payloads
- Send to Harmony channels

### 4. Automation Bots

**Examples:** Moderation, Analytics, Utilities

**Requirements:**
- Event subscription
- Command processing
- Database (optional)

**Implementation:**
- Standard bot implementation
- Command parser
- Action handlers

## Plugin Template

### package.json

```json
{
  "name": "@harmony/your-bridge",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "ws": "^8.16.0",
    "yaml": "^2.3.4",
    "dotenv": "^16.3.1"
  }
}
```

### src/index.ts

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

// Start
await Promise.all([
  harmonyClient.connect(),
  platformClient.connect()
])

console.log('🌉 Bridge is running!')
```

## Best Practices

### 1. Loop Prevention

**Always check if message originated from your bridge:**

```typescript
// Don't bridge messages from the bridge itself
if (message.content.includes('[YourBridge]')) return

// Don't bridge bot messages
if (message.author.bot) return
```

### 2. Rate Limiting

**Implement proper rate limiting:**

```typescript
class RateLimiter {
  private queue: Array<() => Promise<void>> = []
  private processing = false
  
  async add(fn: () => Promise<void>) {
    this.queue.push(fn)
    if (!this.processing) {
      this.process()
    }
  }
  
  private async process() {
    this.processing = true
    while (this.queue.length > 0) {
      const fn = this.queue.shift()!
      await fn()
      await this.sleep(200) // 5 messages/second
    }
    this.processing = false
  }
}
```

### 3. Error Recovery

**Implement reconnection logic:**

```typescript
async function connectWithRetry(maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await harmonyClient.connect()
      return
    } catch (error) {
      console.error(`Connection attempt ${i + 1} failed`)
      await sleep(5000 * (i + 1)) // Exponential backoff
    }
  }
  throw new Error('Failed to connect after retries')
}
```

### 4. Graceful Shutdown

**Handle signals properly:**

```typescript
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  console.log('Shutting down...')
  
  // Close connections
  await harmonyClient.disconnect()
  await platformClient.disconnect()
  
  // Flush logs, save state, etc.
  
  process.exit(0)
}
```

## Distribution

### NPM Package

```json
{
  "name": "@harmony/slack-bridge",
  "bin": {
    "harmony-slack-bridge": "./dist/index.js"
  }
}
```

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
version: '3.8'
services:
  harmony-bridge:
    build: .
    environment:
      - HARMONY_TOKEN=${HARMONY_TOKEN}
      - PLATFORM_TOKEN=${PLATFORM_TOKEN}
    restart: unless-stopped
```

## UI Plugins (Future)

While current plugins are backend services, future support for UI plugins:

```typescript
// Register UI plugin
HarmonyPluginManager.register({
  id: 'custom-widget',
  name: 'Custom Widget',
  component: () => import('./CustomWidget.vue'),
  location: 'sidebar'
})
```

## Existing Bridges

### Discord Bridge

**Status:** ✅ Reference implementation included

**Features:**
- Bi-directional message sync
- Mention translation
- Attachment support

**Repo:** `bot-plugins/discord-bridge/`

### Matrix Bridge (Community)

**Status:** 🚧 In development

**Features:**
- Full federation
- E2EE support
- Room mapping

### Slack Bridge (Community)

**Status:** 📋 Planned

**Features:**
- Workspace integration
- Slash commands
- Interactive messages

## Resources

- [Bot API Reference](./BOT_API.md)
- Discord Bridge source: `bot-plugins/discord-bridge/` (reference implementation)

## Community Plugins

Want to contribute a plugin?
1. Create a plugin following this guide
2. Add a README with setup instructions
3. Submit a PR to the repository

## Plugin Ideas

- **IRC Bridge** - Connect to IRC networks
- **Matrix Bridge** - Full Matrix federation
- **RSS Bot** - Post RSS feed updates
- **GitHub Bot** - Commit/PR notifications
- **Twitch Bot** - Stream notifications
- **Music Bot** - Play music in voice channels
- **Moderation Bot** - Auto-mod system
- **Stats Bot** - Server analytics
- **Translation Bot** - Auto-translate messages
- **Games Bot** - Mini-games and fun

## Contributing

We welcome plugin contributions!

1. Follow the plugin template
2. Write clear documentation
3. Include setup instructions
4. Test thoroughly
5. Submit to community directory

**Happy bridging! 🌉**

