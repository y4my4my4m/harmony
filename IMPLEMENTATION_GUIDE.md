# E2EE and Bot API Implementation - Complete Guide

## 📋 Implementation Status

### ✅ COMPLETED (Phase 1: E2EE Foundation)

1. **Database Schema** - `db_schema/e2ee_schema.sql`
   - user_key_pairs table with per-user keys
   - prekeys table for Signal Protocol
   - encryption_sessions for session management
   - server_encryption_settings for policy control
   - conversation_encryption_settings
   - Full RLS policies

2. **Database Functions** - `db_schema/e2ee_functions.sql`
   - `get_user_prekey_bundle()` - Fetch keys for session establishment
   - `rotate_prekeys()` - Key rotation management
   - `check_encryption_policy()` - Server policy checking
   - `initialize_user_encryption()` - User setup
   - Session management functions

3. **Signal Protocol Service** - `src/services/encryption/SignalProtocolService.ts`
   - Full Signal Protocol wrapper
   - Key generation (identity, signed prekeys, one-time prekeys)
   - Session establishment via PreKeyBundle
   - Message encryption/decryption
   - Group encryption with Sender Keys
   - Key rotation logic

4. **Encryption Key Store** - `src/services/encryption/EncryptionKeyStore.ts`
   - IndexedDB storage adapter
   - Implements all Signal Protocol storage interfaces
   - Web Crypto API encryption for sensitive keys
   - PBKDF2 key derivation from password

5. **Message Encryption Service** - `src/services/encryption/MessageEncryptionService.ts`
   - High-level encryption API
   - Transparent encrypt/decrypt for messages
   - Server policy enforcement
   - Session management
   - Prekey rotation automation

6. **Bot Database Schema** - `db_schema/bot_api_schema.sql`
   - bots table with full metadata
   - bot_tokens with bcrypt hashing
   - bot_server_permissions (Discord-like permission system)
   - bot_rate_limits for API throttling
   - bot_webhooks for event delivery
   - bot_commands for discovery
   - bot_audit_log for security
   - Helper functions and RLS policies

7. **Package Dependencies** - Added to `package.json`
   - @signalapp/libsignal-client ^0.46.0
   - discord.js ^14.14.1
   - ws ^8.16.0
   - yaml ^2.3.4

---

## 🚧 REMAINING WORK

### Phase 1 Remaining: E2EE UI & Integration

#### 1. CoreMessageService Integration
**File**: `src/services/core/CoreMessageService.ts`

Add before message insert:
```typescript
import { messageEncryptionService } from '@/services/encryption'

async sendChannelMessage(serverId: string, channelId: string, content: MessagePart[], replyTo?: string) {
  // Check server encryption policy
  const policy = await messageEncryptionService.checkServerEncryptionPolicy(serverId)
  
  let finalContent = content
  let encrypted = false
  let encryptionMetadata = null
  
  if (policy.mode === 'required' || (policy.mode === 'optional' && policy.enabled)) {
    if (!policy.hasKeys) {
      throw new Error('Encryption required but keys not set up')
    }
    
    // Get all server members
    const { data: members } = await supabase
      .from('server_members')
      .select('user_id')
      .eq('server_id', serverId)
    
    const recipientIds = members?.map(m => m.user_id) || []
    
    // Encrypt message
    const encryptedData = await messageEncryptionService.encryptMessage(content, recipientIds)
    finalContent = encryptedData.content
    encrypted = true
    encryptionMetadata = encryptedData.encryption_metadata
  }
  
  const messageData = {
    user_id: currentUser.id,
    channel_id: channelId,
    content: finalContent,
    reply_to: replyTo || null,
    encrypted,
    encryption_metadata: encryptionMetadata,
    metadata: { created_via: 'harmony_client' }
  }
  
  // ... rest of insert logic
}
```

Similar integration for `sendDMMessage()`.

Add decryption in message retrieval (stores):
```typescript
// In useChatStore or useDMStore, after fetching messages:
if (message.encrypted) {
  try {
    const decrypted = await messageEncryptionService.decryptMessage(
      message.content,
      message.user_id
    )
    message.content = decrypted
    message._decrypted = true
  } catch (error) {
    console.error('Decryption failed:', error)
    message.content = [{ type: 'text', value: '[Encrypted message - decryption failed]' }]
  }
}
```

#### 2. Key Setup Wizard
**File**: `src/components/encryption/KeySetupWizard.vue`

Full setup modal for first-time E2EE:
```vue
<template>
  <div class="key-setup-wizard">
    <div v-if="step === 1" class="step">
      <h2>🔐 Enable End-to-End Encryption</h2>
      <p>Protect your messages with industry-standard encryption</p>
      <ul>
        <li>✅ Only you and recipients can read messages</li>
        <li>✅ Not even Harmony servers can decrypt</li>
        <li>✅ Based on Signal Protocol</li>
      </ul>
      <button @click="step = 2">Get Started</button>
    </div>
    
    <div v-if="step === 2" class="step">
      <h2>Create Encryption Password</h2>
      <p>This password encrypts your keys locally</p>
      <input v-model="password" type="password" placeholder="Enter password" />
      <input v-model="confirmPassword" type="password" placeholder="Confirm password" />
      <p class="warning">⚠️ If you lose this password, you cannot recover your encrypted messages</p>
      <button @click="setupEncryption" :disabled="!isPasswordValid">Continue</button>
    </div>
    
    <div v-if="step === 3" class="step">
      <h2>✅ Encryption Enabled!</h2>
      <p>Your messages are now protected with end-to-end encryption</p>
      <div class="backup-code">
        <p>Backup Code (save this!):</p>
        <code>{{ backupCode }}</code>
      </div>
      <button @click="$emit('complete')">Done</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { messageEncryptionService } from '@/services/encryption'

const step = ref(1)
const password = ref('')
const confirmPassword = ref('')
const backupCode = ref('')

const isPasswordValid = computed(() => {
  return password.value.length >= 8 && password.value === confirmPassword.value
})

async function setupEncryption() {
  try {
    await messageEncryptionService.setupEncryption(password.value)
    backupCode.value = generateBackupCode()
    step.value = 3
  } catch (error) {
    console.error('Setup failed:', error)
  }
}

function generateBackupCode() {
  // Generate random backup code
  return Array.from({length: 4}, () => 
    Math.random().toString(36).substring(2, 6).toUpperCase()
  ).join('-')
}
</script>
```

#### 3. Encryption Indicator
**File**: `src/components/encryption/EncryptionIndicator.vue`

Shows lock icon in message input:
```vue
<template>
  <div class="encryption-indicator" :class="{ active: isEncrypted }">
    <svg class="lock-icon"><!-- Lock SVG --></svg>
    <span v-if="isEncrypted">E2EE Active</span>
    <span v-else>Not Encrypted</span>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { messageEncryptionService } from '@/services/encryption'

const props = defineProps<{
  serverId?: string
  conversationId?: string
}>()

const isEncrypted = ref(false)

watch(() => [props.serverId, props.conversationId], async () => {
  if (props.serverId) {
    const policy = await messageEncryptionService.checkServerEncryptionPolicy(props.serverId)
    isEncrypted.value = policy.enabled
  } else if (props.conversationId) {
    const status = await messageEncryptionService.checkConversationEncryption(props.conversationId)
    isEncrypted.value = status.enabled
  }
}, { immediate: true })
</script>
```

#### 4. Server Encryption Settings
**File**: Add to `src/components/settings/ServerSettings.vue`

Section for encryption policy:
```vue
<div class="encryption-settings">
  <h3>🔐 Encryption Policy</h3>
  <select v-model="encryptionMode">
    <option value="disabled">Disabled</option>
    <option value="optional">Optional (User Choice)</option>
    <option value="required">Required (Local Only)</option>
    <option value="required_local_only">Required + No Federation</option>
  </select>
  
  <p v-if="encryptionMode === 'required_local_only'" class="warning">
    ⚠️ This will prevent federation with other instances
  </p>
  
  <button @click="saveEncryptionPolicy">Save Policy</button>
</div>
```

#### 5. WebRTC E2EE
**File**: `src/services/unifiedWebRTC.ts`

Add insertable streams for additional E2EE:
```typescript
async setupE2EEForCall(remoteUserId: string) {
  if (!this.peerConnection) return
  
  // Enable insertable streams
  const sender = this.peerConnection.getSenders()[0]
  if (!sender) return
  
  const senderStreams = sender.createEncodedStreams()
  const transformStream = new TransformStream({
    transform: async (chunk, controller) => {
      // Encrypt frame with Signal Protocol session
      const encrypted = await signalProtocolService.encryptMessage(
        `${remoteUserId}:1`,
        chunk.data
      )
      chunk.data = Buffer.from(encrypted.body, 'base64')
      controller.enqueue(chunk)
    }
  })
  
  senderStreams.readable
    .pipeThrough(transformStream)
    .pipeTo(senderStreams.writable)
}
```

---

### Phase 2: Bot Gateway Service

#### Setup bot-gateway/ Project

**File**: `bot-gateway/package.json`
```json
{
  "name": "@harmony/bot-gateway",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.39.2",
    "express": "^4.18.2",
    "ws": "^8.16.0",
    "bcrypt": "^5.1.1",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/ws": "^8.5.10",
    "@types/bcrypt": "^5.0.2",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

**File**: `bot-gateway/src/index.ts`
```typescript
import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { WebSocketGateway } from './gateway/WebSocketGateway.js'
import { BotRestAPI } from './api/BotRestAPI.js'
import { EventDispatcher } from './gateway/EventDispatcher.js'

const app = express()
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/gateway' })

// Initialize services
const gateway = new WebSocketGateway(wss)
const eventDispatcher = new EventDispatcher(gateway)
const botAPI = new BotRestAPI(app)

// Start event dispatcher
eventDispatcher.start()

// Start server
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`🤖 Bot Gateway running on port ${PORT}`)
})
```

**File**: `bot-gateway/src/gateway/WebSocketGateway.ts`
```typescript
import { WebSocketServer, WebSocket } from 'ws'
import { supabase } from '../config/supabase.js'

interface BotConnection {
  botId: string
  username: string
  scopes: string[]
  lastHeartbeat: number
}

export class WebSocketGateway {
  private connections = new Map<WebSocket, BotConnection>()
  
  constructor(private wss: WebSocketServer) {
    this.wss.on('connection', this.handleConnection.bind(this))
  }
  
  private async handleConnection(ws: WebSocket) {
    let botConnection: BotConnection | null = null
    
    ws.on('message', async (data) => {
      const payload = JSON.parse(data.toString())
      
      if (payload.op === 2) { // IDENTIFY
        botConnection = await this.authenticate(payload.d.token)
        if (botConnection) {
          this.connections.set(ws, botConnection)
          ws.send(JSON.stringify({ op: 0, t: 'READY', d: { bot: botConnection } }))
        } else {
          ws.close(4004, 'Authentication failed')
        }
      } else if (payload.op === 1) { // HEARTBEAT
        if (botConnection) {
          botConnection.lastHeartbeat = Date.now()
          ws.send(JSON.stringify({ op: 11 })) // HEARTBEAT_ACK
        }
      }
    })
    
    ws.on('close', () => {
      this.connections.delete(ws)
    })
  }
  
  private async authenticate(token: string): Promise<BotConnection | null> {
    const { data } = await supabase.rpc('verify_bot_token', { 
      p_token_hash: hashToken(token) 
    })
    
    if (data?.valid) {
      return {
        botId: data.bot_id,
        username: data.username,
        scopes: data.scopes,
        lastHeartbeat: Date.now()
      }
    }
    return null
  }
  
  // Broadcast event to specific bot
  sendToBot(botId: string, event: any) {
    for (const [ws, conn] of this.connections) {
      if (conn.botId === botId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event))
      }
    }
  }
}
```

**File**: `bot-gateway/src/gateway/EventDispatcher.ts`
```typescript
import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'

export class EventDispatcher {
  constructor(private gateway: WebSocketGateway) {}
  
  async start() {
    // Listen to messages table
    supabase
      .channel('bot_events')
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'messages' },
        this.handleMessage.bind(this)
      )
      .subscribe()
  }
  
  private async handleMessage(payload: any) {
    const message = payload.new
    
    // Get bots in this server/channel
    const { data: bots } = await supabase
      .from('bot_server_permissions')
      .select('bot_id, read_messages')
      .eq('server_id', message.server_id)
      .eq('read_messages', true)
      .eq('is_active', true)
    
    // Dispatch to each bot
    for (const bot of bots || []) {
      this.gateway.sendToBot(bot.bot_id, {
        op: 0,
        t: 'MESSAGE_CREATE',
        d: this.formatMessage(message)
      })
    }
  }
  
  private formatMessage(msg: any) {
    // Convert to Discord-like format
    return {
      id: msg.id,
      channel_id: msg.channel_id,
      author: { id: msg.user_id },
      content: this.contentToText(msg.content),
      timestamp: msg.created_at
    }
  }
}
```

**File**: `bot-gateway/src/api/BotRestAPI.ts`
```typescript
import express from 'express'
import { botAuthMiddleware } from '../auth/BotAuthMiddleware.js'
import { supabase } from '../config/supabase.js'

export class BotRestAPI {
  constructor(private app: express.Application) {
    this.setupRoutes()
  }
  
  private setupRoutes() {
    this.app.use(express.json())
    this.app.use(botAuthMiddleware)
    
    // POST /channels/:id/messages
    this.app.post('/channels/:channelId/messages', async (req, res) => {
      const { channelId } = req.params
      const { content } = req.body
      const botId = req.bot.id
      
      // Check permissions
      const canSend = await this.checkPermission(botId, channelId, 'send_messages')
      if (!canSend) {
        return res.status(403).json({ error: 'Missing permissions' })
      }
      
      // Insert message
      const { data, error } = await supabase
        .from('messages')
        .insert({
          channel_id: channelId,
          user_id: botId,
          content: [{ type: 'text', value: content }],
          metadata: { bot: true }
        })
        .select()
        .single()
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json(data)
    })
    
    // GET /guilds/:id/members
    this.app.get('/guilds/:guildId/members', async (req, res) => {
      const { guildId } = req.params
      
      const { data } = await supabase
        .from('server_members')
        .select('user_id, profiles(*)')
        .eq('server_id', guildId)
      
      res.json(data)
    })
  }
  
  private async checkPermission(botId: string, channelId: string, permission: string) {
    const { data } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single()
    
    if (!data) return false
    
    return await supabase.rpc('check_bot_permission', {
      p_bot_id: botId,
      p_server_id: data.server_id,
      p_permission: permission
    })
  }
}
```

---

### Phase 3: Discord Bridge

**File**: `bot-plugins/discord-bridge/package.json`
```json
{
  "name": "@harmony/discord-bridge",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "discord.js": "^14.14.1",
    "ws": "^8.16.0",
    "yaml": "^2.3.4"
  }
}
```

**File**: `bot-plugins/discord-bridge/src/HarmonyClient.ts`
```typescript
import { WebSocket } from 'ws'

export class HarmonyClient {
  private ws: WebSocket | null = null
  private botToken: string
  
  constructor(botToken: string) {
    this.botToken = botToken
  }
  
  async connect() {
    this.ws = new WebSocket('ws://localhost:3001/gateway')
    
    this.ws.on('open', () => {
      // Send IDENTIFY
      this.ws!.send(JSON.stringify({
        op: 2,
        d: { token: this.botToken }
      }))
    })
    
    this.ws.on('message', (data) => {
      const payload = JSON.parse(data.toString())
      this.handleEvent(payload)
    })
  }
  
  private handleEvent(payload: any) {
    if (payload.t === 'MESSAGE_CREATE') {
      this.emit('messageCreate', payload.d)
    }
  }
  
  async sendMessage(channelId: string, content: string) {
    const res = await fetch(`http://localhost:3001/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    })
    return res.json()
  }
}
```

**File**: `bot-plugins/discord-bridge/src/MessageTranslator.ts`
```typescript
export class MessageTranslator {
  discordToHarmony(discordMsg: any): string {
    let content = discordMsg.content
    
    // Translate mentions: <@123> -> @username
    content = content.replace(/<@!?(\d+)>/g, (match, id) => {
      const user = discordMsg.mentions.users.get(id)
      return user ? `@${user.username}` : match
    })
    
    // Translate custom emojis: <:name:123> -> :name:
    content = content.replace(/<a?:(\w+):\d+>/g, ':$1:')
    
    return `[Discord] ${content}`
  }
  
  harmonyToDiscord(harmonyMsg: any): string {
    // Reverse translations
    return harmonyMsg.content
  }
}
```

**File**: `bot-plugins/discord-bridge/src/index.ts`
```typescript
import { Client as DiscordClient } from 'discord.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MessageTranslator } from './MessageTranslator.js'
import { readFileSync } from 'fs'
import { parse } from 'yaml'

// Load config
const config = parse(readFileSync('./config/bridge-config.yml', 'utf8'))

const discordClient = new DiscordClient({ intents: ['Guilds', 'GuildMessages', 'MessageContent'] })
const harmonyClient = new HarmonyClient(config.harmony.botToken)
const translator = new MessageTranslator()

// Discord -> Harmony
discordClient.on('messageCreate', async (msg) => {
  if (msg.author.bot) return
  
  const mapping = config.channelMappings.find(m => m.discord === msg.channelId)
  if (!mapping) return
  
  const translated = translator.discordToHarmony(msg)
  await harmonyClient.sendMessage(mapping.harmony, translated)
})

// Harmony -> Discord
harmonyClient.on('messageCreate', async (msg) => {
  const mapping = config.channelMappings.find(m => m.harmony === msg.channel_id)
  if (!mapping) return
  
  const discordChannel = await discordClient.channels.fetch(mapping.discord)
  const translated = translator.harmonyToDiscord(msg)
  await discordChannel.send(translated)
})

// Start
await discordClient.login(config.discord.botToken)
await harmonyClient.connect()

console.log('🌉 Discord-Harmony bridge active!')
```

**File**: `bot-plugins/discord-bridge/config/bridge-config.yml`
```yaml
discord:
  botToken: "YOUR_DISCORD_BOT_TOKEN"

harmony:
  botToken: "YOUR_HARMONY_BOT_TOKEN"
  gatewayUrl: "ws://localhost:3001/gateway"

channelMappings:
  - discord: "123456789" # Discord channel ID
    harmony: "uuid-here" # Harmony channel ID
  - discord: "987654321"
    harmony: "uuid-here-2"
```

---

## 📚 Documentation

### File: `docs/E2EE_IMPLEMENTATION.md`

Complete guide covering:
- Architecture overview
- Key management (per-user → per-device migration path)
- Message encryption flow
- Server policy configuration
- User setup wizard
- Troubleshooting

### File: `docs/BOT_API.md`

Full API reference:
- Authentication (bot tokens)
- WebSocket gateway protocol
- REST API endpoints
- Permission system
- Rate limiting
- Event types
- Code examples (Python, JavaScript, Go)

### File: `docs/PLUGIN_SYSTEM.md`

Guide for building bridges/integrations:
- Plugin architecture
- Bridge pattern (Discord example)
- Channel mapping
- Message translation
- Deployment

### File: `bot-plugins/README.md`

Template and quickstart for plugin developers.

---

## 🔧 Installation & Usage

### E2EE Setup (End Users)
1. Navigate to User Settings → Security
2. Click "Enable E2EE"
3. Follow Key Setup Wizard
4. Save backup code securely

### Bot Creation (Developers)
1. Go to Developer Portal (Admin → Bots)
2. Click "Create Bot"
3. Generate token
4. Configure permissions
5. Add to server

### Running Bot Gateway
```bash
cd bot-gateway
npm install
npm run dev
```

### Running Discord Bridge
```bash
cd bot-plugins/discord-bridge
npm install
# Edit config/bridge-config.yml
npm run dev
```

---

## 🎯 Next Steps

To complete the implementation:

1. ✅ E2EE foundation is complete - database, services, crypto
2. ⚠️ Add E2EE UI components (4-6 Vue files)
3. ⚠️ Integrate encryption into message flow (2 service edits)
4. ✅ Bot database schema is complete
5. ⚠️ Implement bot-gateway service (backend Node project)
6. ⚠️ Create bot management UI (2-3 Vue components in Admin)
7. ⚠️ Build Discord bridge (standalone service)
8. ⚠️ Write comprehensive documentation

**Estimated Time**: ~40-60 hours remaining for full completion

**Priority Order**:
1. E2EE UI (functional encryption for users)
2. Bot Gateway (core bot infrastructure)
3. Bot Management UI (bot creation interface)
4. Discord Bridge (demonstrates plugin system)
5. Documentation (for developers and users)

All core architecture and schemas are complete. Remaining work is primarily:
- UI components (Vue)
- Bot gateway backend (Node/TypeScript)
- Bridge example (Node/Discord.js)
- Documentation

