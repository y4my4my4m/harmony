---
title: Bot API
description: Discord-compatible Bot API reference for Harmony
---

# Harmony Bot API Reference

The Harmony Bot API provides a Discord-compatible interface for creating bots that can:
- Send and receive messages
- Interact with servers and channels
- Manage members and permissions
- Respond to events in real-time

**Compatible with existing Discord bot libraries with minimal changes!**

## Quick Start

### 1. Create a Bot

1. Log into Harmony admin panel
2. Navigate to "Bot Management"
3. Click "Create New Bot"
4. Fill in bot details
5. Copy the generated token (shown once!)

### 2. Add Bot to Server

1. Go to Server Settings
2. Click "Bots" tab
3. Search for your bot
4. Click "Add to Server"
5. Configure permissions

### 3. Connect Your Bot

```javascript
const client = new HarmonyClient('YOUR_BOT_TOKEN')

client.on('ready', () => {
  console.log('Bot is ready!')
})

client.on('messageCreate', async (message) => {
  if (message.content === '!ping') {
    await client.sendMessage(message.channel_id, 'Pong!')
  }
})

client.connect()
```

## WebSocket Gateway

### Connection

| Environment | URL |
|---|---|
| Local dev | `ws://localhost:3002/gateway` |
| Production | `wss://your-domain/bot-gateway/gateway` |

### Protocol

#### IDENTIFY (Op 2)

Send immediately after connection:

```json
{
  "op": 2,
  "d": {
    "token": "YOUR_BOT_TOKEN"
  }
}
```

#### READY (Op 0, Event)

Received after successful authentication:

```json
{
  "op": 0,
  "t": "READY",
  "d": {
    "bot": {
      "id": "bot-id",
      "username": "bot-username"
    },
    "session_id": "session-id",
    "heartbeat_interval": 30000
  }
}
```

#### HEARTBEAT (Op 1)

Send every `heartbeat_interval` milliseconds:

```json
{
  "op": 1
}
```

### Gateway Opcodes

| Code | Name | Description |
|------|------|-------------|
| 0 | Dispatch | Event dispatch |
| 1 | Heartbeat | Keep connection alive |
| 2 | Identify | Authenticate |
| 11 | Heartbeat ACK | Heartbeat acknowledged |

## Events

### MESSAGE_CREATE

```json
{
  "op": 0,
  "t": "MESSAGE_CREATE",
  "d": {
    "id": "message-id",
    "channel_id": "channel-id",
    "author": {
      "id": "user-id",
      "username": "username",
      "avatar": "avatar-url"
    },
    "content": "message text",
    "timestamp": "2024-01-01T00:00:00Z",
    "mentions": ["user-id-1", "user-id-2"]
  }
}
```

### MESSAGE_UPDATE

```json
{
  "op": 0,
  "t": "MESSAGE_UPDATE",
  "d": {
    "id": "message-id",
    "channel_id": "channel-id",
    "content": "new content",
    "edited_timestamp": "2024-01-01T00:00:00Z"
  }
}
```

### MESSAGE_DELETE

```json
{
  "op": 0,
  "t": "MESSAGE_DELETE",
  "d": {
    "id": "message-id",
    "channel_id": "channel-id"
  }
}
```

### MEMBER_JOIN / MEMBER_LEAVE

```json
{
  "op": 0,
  "t": "MEMBER_JOIN",
  "d": {
    "guild_id": "server-id",
    "user_id": "user-id",
    "joined_at": "2024-01-01T00:00:00Z"
  }
}
```

### CHANNEL_CREATE

```json
{
  "op": 0,
  "t": "CHANNEL_CREATE",
  "d": {
    "id": "channel-id",
    "guild_id": "server-id",
    "name": "channel-name",
    "type": 0,
    "position": 1
  }
}
```

## REST API

Base URL: `http://your-instance.com:3002/api/v1`

### Authentication

All REST requests require the `Authorization` header:

```
Authorization: Bot YOUR_BOT_TOKEN
```

### Endpoints

#### Send Message

```http
POST /channels/:channelId/messages
Content-Type: application/json

{
  "content": "Hello, world!",
  "reply_to": "message-id"
}
```

#### Get Channel Messages

```http
GET /channels/:channelId/messages?limit=50&before=2024-01-01T00:00:00Z
```

#### Edit Message

```http
PATCH /messages/:messageId
Content-Type: application/json

{
  "content": "Updated message"
}
```

#### Delete Message

```http
DELETE /messages/:messageId
```

#### Add Reaction

```http
PUT /messages/:messageId/reactions/:emoji
```

#### Trigger Typing Indicator

```http
POST /channels/:channelId/typing
```

#### Get Guild Info

```http
GET /guilds/:guildId
```

#### Get Guild Members

```http
GET /guilds/:guildId/members?limit=100
```

#### Get Guild Channels

```http
GET /guilds/:guildId/channels
```

#### Get Current Bot

```http
GET /users/@me
```

## Permissions

Discord-compatible permission system:

| Category | Permissions |
|---|---|
| **Messages** | `read_messages`, `send_messages`, `manage_messages`, `embed_links`, `attach_files`, `read_message_history`, `mention_everyone`, `use_external_emojis`, `add_reactions` |
| **Channels** | `view_channels`, `manage_channels`, `manage_webhooks`, `create_instant_invite` |
| **Voice** | `connect_voice`, `speak`, `mute_members`, `deafen_members`, `move_members` |
| **Server** | `change_nickname`, `manage_nicknames`, `manage_roles`, `kick_members`, `ban_members` |

## Rate Limits

| Route | Limit |
|-------|-------|
| POST /channels/:id/messages | 5/sec |
| GET /channels/:id/messages | 10/sec |
| Global | 50 requests/min per bot |
| Any other route | 10/sec |

Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

## Error Codes

| Code | Meaning |
|------|---------|
| 401 | Invalid token |
| 403 | Missing permissions |
| 404 | Resource not found |
| 429 | Rate limited |
| 500 | Internal server error |

## Examples

### JavaScript/Node.js

```javascript
import { HarmonyClient } from './HarmonyClient.js'

const bot = new HarmonyClient('YOUR_BOT_TOKEN')

bot.on('ready', (data) => {
  console.log(`Logged in as ${data.bot.username}`)
})

bot.on('messageCreate', async (message) => {
  if (message.content === '!ping') {
    await bot.sendMessage(message.channel_id, 'Pong!')
  }

  if (message.content.startsWith('!say ')) {
    const text = message.content.substring(5)
    await bot.sendMessage(message.channel_id, text)
  }
})

bot.connect()
```

### Python

```python
import asyncio
import websockets
import json
import requests

class HarmonyBot:
    def __init__(self, token):
        self.token = token
        self.gateway_url = "ws://localhost:3002/gateway"
        self.api_url = "http://localhost:3002/api/v1"

    async def connect(self):
        async with websockets.connect(self.gateway_url) as ws:
            await ws.send(json.dumps({
                "op": 2,
                "d": {"token": self.token}
            }))

            ready = json.loads(await ws.recv())
            print(f"Ready: {ready['d']['bot']['username']}")

            asyncio.create_task(self.heartbeat(ws, 30000))

            async for message in ws:
                await self.handle_event(json.loads(message))

    async def heartbeat(self, ws, interval):
        while True:
            await asyncio.sleep(interval / 1000)
            await ws.send(json.dumps({"op": 1}))

    async def handle_event(self, payload):
        if payload['t'] == 'MESSAGE_CREATE':
            msg = payload['d']
            if msg['content'] == '!ping':
                self.send_message(msg['channel_id'], 'Pong!')

    def send_message(self, channel_id, content):
        requests.post(
            f"{self.api_url}/channels/{channel_id}/messages",
            headers={"Authorization": f"Bot {self.token}"},
            json={"content": content}
        )

bot = HarmonyBot("YOUR_BOT_TOKEN")
asyncio.run(bot.connect())
```

## Migration from Discord.js

Most Discord.js patterns work with minimal changes:

| Discord.js | Harmony |
|------------|---------|
| `message.channel.send()` | `bot.sendMessage(channelId)` |
| `message.guild.id` | `message.guild_id` |
| `message.author.id` | `message.author.id` |
| `client.user` | `bot.user` |

## Security Best Practices

1. **Never commit tokens to git** - use environment variables
2. **Regenerate compromised tokens immediately** via admin panel
3. **Use separate tokens for dev/prod**
4. **Request only the permissions your bot needs**
5. **Always validate user input**

## Gateway Setup

For local development and production deployment details, see the [Bot Gateway Setup Guide](/BOT_GATEWAY_SETUP).
