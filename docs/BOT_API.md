# Harmony Bot API Reference

## 🤖 Overview

The Harmony Bot API provides a Discord-compatible interface for creating bots that can:
- Send and receive messages
- Interact with servers and channels
- Manage members and permissions
- Respond to events in real-time

**Compatible with existing Discord bot libraries with minimal changes!**

## 🚀 Quick Start

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
// See bot-plugins/discord-bridge/ for a reference implementation
// Connect to the bot gateway WebSocket at wss://your-domain/bot-gateway/gateway
const WebSocket = require('ws')

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

## 🔌 WebSocket Gateway

### Connection

**URL:** `ws://your-instance.com:3001/gateway`

### Protocol

#### 1. IDENTIFY (Op 2)

Send immediately after connection:

```json
{
  "op": 2,
  "d": {
    "token": "YOUR_BOT_TOKEN"
  }
}
```

#### 2. READY (Op 0, Event)

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

#### 3. HEARTBEAT (Op 1)

Send every `heartbeat_interval` milliseconds:

```json
{
  "op": 1
}
```

#### 4. HEARTBEAT_ACK (Op 11)

Received after each heartbeat:

```json
{
  "op": 11
}
```

### Gateway Opcodes

| Code | Name | Description |
|------|------|-------------|
| 0 | Dispatch | Event dispatch |
| 1 | Heartbeat | Keep connection alive |
| 2 | Identify | Authenticate |
| 11 | Heartbeat ACK | Heartbeat acknowledged |

## 📨 Events

### MESSAGE_CREATE

New message in a channel:

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

Message edited:

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

Message deleted:

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

### MEMBER_JOIN

User joined server:

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

### MEMBER_LEAVE

User left server:

```json
{
  "op": 0,
  "t": "MEMBER_LEAVE",
  "d": {
    "guild_id": "server-id",
    "user_id": "user-id"
  }
}
```

### CHANNEL_CREATE

Channel created:

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

## 🌐 REST API

Base URL: `http://your-instance.com:3001/api/v1`

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
  "reply_to": "message-id" // optional
}
```

**Response:**
```json
{
  "id": "message-id",
  "channel_id": "channel-id",
  "author": { ... },
  "content": "Hello, world!",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

#### Get Channel Messages

```http
GET /channels/:channelId/messages?limit=50&before=2024-01-01T00:00:00Z
```

**Response:**
```json
[
  {
    "id": "message-id",
    "content": "message text",
    ...
  }
]
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

**Response:** 204 No Content

#### Add Reaction

```http
PUT /messages/:messageId/reactions/:emoji
```

**Response:** 204 No Content

#### Trigger Typing Indicator

```http
POST /channels/:channelId/typing
```

**Response:** 204 No Content

#### Get Guild Info

```http
GET /guilds/:guildId
```

**Response:**
```json
{
  "id": "guild-id",
  "name": "Server Name",
  "icon": "icon-url",
  "owner_id": "owner-id",
  "member_count": 42
}
```

#### Get Guild Members

```http
GET /guilds/:guildId/members?limit=100
```

**Response:**
```json
[
  {
    "user": {
      "id": "user-id",
      "username": "username",
      "avatar": "avatar-url"
    },
    "nick": "nickname",
    "roles": [],
    "joined_at": "2024-01-01T00:00:00Z"
  }
]
```

#### Get Guild Channels

```http
GET /guilds/:guildId/channels
```

**Response:**
```json
[
  {
    "id": "channel-id",
    "type": 0,
    "guild_id": "guild-id",
    "name": "channel-name",
    "position": 1
  }
]
```

#### Get User Info

```http
GET /users/:userId
```

**Response:**
```json
{
  "id": "user-id",
  "username": "username",
  "display_name": "Display Name",
  "avatar": "avatar-url",
  "bio": "User bio"
}
```

#### Get Current Bot

```http
GET /users/@me
```

**Response:**
```json
{
  "id": "bot-id",
  "username": "bot-username",
  "avatar": "avatar-url",
  "bot": true,
  "verified": false
}
```

## 🔒 Permissions

Discord-compatible permission system:

### Message Permissions
- `read_messages` - View channels and read messages
- `send_messages` - Send messages
- `send_tts_messages` - Send TTS messages
- `manage_messages` - Delete any message
- `embed_links` - Send embeds
- `attach_files` - Upload files
- `read_message_history` - Read old messages
- `mention_everyone` - @everyone mentions
- `use_external_emojis` - Use custom emojis
- `add_reactions` - React to messages

### Channel Permissions
- `view_channels` - See channels
- `manage_channels` - Create/edit/delete channels
- `manage_webhooks` - Manage webhooks
- `create_instant_invite` - Create invites

### Voice Permissions
- `connect_voice` - Join voice channels
- `speak` - Speak in voice
- `mute_members` - Mute others
- `deafen_members` - Deafen others
- `move_members` - Move users between channels

### Server Permissions
- `change_nickname` - Change own nickname
- `manage_nicknames` - Change others' nicknames
- `manage_roles` - Assign/remove roles
- `kick_members` - Kick members
- `ban_members` - Ban members

## ⏱️ Rate Limits

### Global Limits

- 50 requests per minute per bot
- 5 gateway connections per bot

### Per-Route Limits

| Route | Limit |
|-------|-------|
| POST /channels/:id/messages | 5/sec |
| GET /channels/:id/messages | 10/sec |
| Any other route | 10/sec |

**Rate Limit Headers:**
```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1640000000
```

**429 Response:**
```json
{
  "error": "Rate limit exceeded",
  "retry_after": 60
}
```

## 🔍 Error Codes

| Code | Meaning |
|------|---------|
| 401 | Invalid token |
| 403 | Missing permissions |
| 404 | Resource not found |
| 429 | Rate limited |
| 500 | Internal server error |

## 💡 Examples

### Python Bot

```python
import asyncio
import websockets
import json
import requests

class HarmonyBot:
    def __init__(self, token):
        self.token = token
        self.gateway_url = "ws://localhost:3001/gateway"
        self.api_url = "http://localhost:3001/api/v1"
    
    async def connect(self):
        async with websockets.connect(self.gateway_url) as ws:
            # Identify
            await ws.send(json.dumps({
                "op": 2,
                "d": {"token": self.token}
            }))
            
            # Receive READY
            ready = json.loads(await ws.recv())
            print(f"Ready: {ready['d']['bot']['username']}")
            
            # Start heartbeat
            asyncio.create_task(self.heartbeat(ws, 30000))
            
            # Handle events
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

# Run bot
bot = HarmonyBot("YOUR_BOT_TOKEN")
asyncio.run(bot.connect())
```

### JavaScript/Node.js Bot

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

## 🛠️ Bot Development Tips

### 1. Command Handling

```javascript
const commands = {
  '!help': async (msg) => {
    await bot.sendMessage(msg.channel_id, 'Available commands: !help, !ping, !info')
  },
  '!ping': async (msg) => {
    await bot.sendMessage(msg.channel_id, 'Pong!')
  },
  '!info': async (msg) => {
    const members = await bot.getGuildMembers(msg.guild_id)
    await bot.sendMessage(msg.channel_id, `Server has ${members.length} members`)
  }
}

bot.on('messageCreate', async (msg) => {
  const handler = commands[msg.content]
  if (handler) await handler(msg)
})
```

### 2. Permission Checking

Always verify bot has necessary permissions before actions:

```javascript
async function canManageMessages(channelId) {
  try {
    // Try to perform action
    await bot.deleteMessage(messageId)
    return true
  } catch (error) {
    if (error.status === 403) {
      console.log('Missing permissions')
      return false
    }
    throw error
  }
}
```

### 3. Error Handling

```javascript
bot.on('messageCreate', async (msg) => {
  try {
    await handleMessage(msg)
  } catch (error) {
    console.error('Error handling message:', error)
    
    // Notify user of error
    if (error.status !== 403) { // Don't spam if missing permissions
      await bot.sendMessage(
        msg.channel_id,
        'Sorry, an error occurred processing your command.'
      )
    }
  }
})
```

### 4. Rate Limit Handling

```javascript
async function sendWithRetry(channelId, content, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await bot.sendMessage(channelId, content)
    } catch (error) {
      if (error.status === 429) {
        const retryAfter = error.retry_after || 60
        console.log(`Rate limited, waiting ${retryAfter}s...`)
        await sleep(retryAfter * 1000)
      } else {
        throw error
      }
    }
  }
  throw new Error('Max retries exceeded')
}
```

## 📊 Bot Analytics

Track bot usage via audit logs:

```sql
-- Messages sent by bot
SELECT COUNT(*) 
FROM bot_audit_log
WHERE bot_id = 'your-bot-id'
AND action_type = 'message_sent';

-- Actions by date
SELECT 
  DATE(created_at) as date,
  action_type,
  COUNT(*) as count
FROM bot_audit_log
WHERE bot_id = 'your-bot-id'
GROUP BY DATE(created_at), action_type
ORDER BY date DESC;
```

## 🔐 Security Best Practices

### Token Security

1. **Never commit tokens to git**
   - Use environment variables
   - Add `.env` to `.gitignore`

2. **Regenerate compromised tokens immediately**
   - Old token invalidated instantly
   - Update bot code with new token

3. **Use separate tokens for dev/prod**

### Permission Principle of Least Privilege

Only request permissions your bot actually needs:

```javascript
// ❌ BAD - requesting everything
const permissions = [
  'read_messages', 'send_messages', 'manage_messages',
  'manage_channels', 'kick_members', 'ban_members'
]

// ✅ GOOD - only what's needed
const permissions = [
  'read_messages',
  'send_messages'
]
```

### Input Validation

Always validate user input:

```javascript
bot.on('messageCreate', async (msg) => {
  if (msg.content.startsWith('!ban ')) {
    const username = msg.content.substring(5).trim()
    
    // Validate input
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return await bot.sendMessage(
        msg.channel_id,
        'Invalid username format'
      )
    }
    
    // ... proceed with ban
  }
})
```

## 🧪 Testing

### Local Testing

```bash
# Start bot gateway
cd bot-gateway
npm run dev

# Start your bot
cd your-bot
npm run dev
```

### Test Commands

```javascript
// Simple echo bot for testing
bot.on('messageCreate', async (msg) => {
  if (msg.content.startsWith('!echo ')) {
    const text = msg.content.substring(6)
    await bot.sendMessage(msg.channel_id, text)
  }
})
```

## 🔄 Migration from Discord

### Discord.js → Harmony

Most Discord.js patterns work with minimal changes:

```javascript
// Discord.js
client.on('messageCreate', async (message) => {
  if (message.content === '!ping') {
    await message.channel.send('Pong!')
  }
})

// Harmony (with adapter)
bot.on('messageCreate', async (message) => {
  if (message.content === '!ping') {
    await bot.sendMessage(message.channel_id, 'Pong!')
  }
})
```

### Key Differences

| Discord.js | Harmony |
|------------|---------|
| `message.channel.send()` | `bot.sendMessage(channelId)` |
| `message.guild.id` | `message.guild_id` |
| `message.author.id` | `message.author.id` |
| `client.user` | `bot.user` |

## Bot Gateway Connection

### JavaScript/TypeScript

Connect to the bot gateway via WebSocket:

```javascript
// See bot-plugins/discord-bridge/ for a full reference implementation
const ws = new WebSocket('wss://your-domain/bot-gateway/gateway')

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'identify', token: process.env.BOT_TOKEN }))
})
```

### Python

```bash
pip install harmony-bot-py
```

```python
from harmony_bot import HarmonyBot

bot = HarmonyBot(token=os.getenv('BOT_TOKEN'))

@bot.on('message_create')
async def on_message(message):
    if message.content == '!ping':
        await bot.send_message(message.channel_id, 'Pong!')

bot.run()
```

## 🎯 Use Cases

### Moderation Bot

Auto-moderate content, kick/ban users, manage roles.

### Welcome Bot

Greet new members, assign default roles, send DM with rules.

### Utility Bot

Server stats, polls, reminders, currency systems.

### Integration Bot

Connect to external services (GitHub, Twitter, RSS feeds).

### Bridge Bot

Connect to other platforms (Discord, Matrix, IRC).

## 📞 Support

- Documentation: https://docs.har.mony.lol
- GitHub: https://github.com/y4my4my4m/harmony-bot-api


## 📄 License

GNU **AGPL-3.0** with additional terms under AGPL §7 — same as the main
Harmony repository. See the repo root for:

- [`LICENSE`](../LICENSE) — AGPL v3 text
- [`LICENSE-ADDITIONAL-TERMS.md`](../LICENSE-ADDITIONAL-TERMS.md) — required attribution
- [`COPYRIGHT`](../COPYRIGHT) — copyright statement and bundled-asset notices
- [`TRADEMARK.md`](../TRADEMARK.md) — name and logo policy

