import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import { config, supabase } from './config/supabase.js'
import { WebSocketGateway } from './gateway/WebSocketGateway.js'
import { EventDispatcher } from './gateway/EventDispatcher.js'
import { BotRestAPI } from './api/BotRestAPI.js'
import { TTLCache } from './utils/TTLCache.js'
import { getBridgeAttachmentMode, hasDiscordCdnFilePart } from './utils/mirrorExternalMedia.js'

// Create Express app
const app = express()

// Middleware
app.use(helmet())
app.use(cors())
app.use(compression())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  })
})

// Create HTTP server
const server = createServer(app)

// Create WebSocket server
const wss = new WebSocketServer({ 
  server, 
  path: '/gateway'
})

// Initialize services
const gateway = new WebSocketGateway(wss)
const eventDispatcher = new EventDispatcher(gateway)

// Start event dispatcher
eventDispatcher.start().catch(error => {
  console.error('❌ Failed to start event dispatcher:', error)
  process.exit(1)
})

// Bot API routes (authenticated)
const botAPI = new BotRestAPI()
app.use('/api/v1', botAPI.router)

// =====================================================
// USER-AUTHENTICATED ENDPOINTS
// =====================================================
//
// These endpoints used to be public, which let any unauthenticated caller
// enumerate connected bots (`/status`) and bridged Discord users for any
// channel ID (`/bridged-users/:channelId` - see BUGS.md C4). They now require
// a valid Supabase user JWT, and `/bridged-users` additionally checks that
// the caller is a member of the channel's server.

/**
 * Validate a Supabase user JWT from the `Authorization: Bearer <token>` header.
 * Returns the caller's profile id (`profiles.id`), or `null` if unauthenticated.
 */
async function getCallerProfileId(req: express.Request): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length).trim()
  if (!token) return null

  const { data: userData, error: userError } = await supabase.auth.getUser(token)
  if (userError || !userData?.user) return null

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle()

  if (profileError || !profile) return null
  return profile.id as string
}

// Gateway status - admin-style endpoint; require authentication so we don't leak
// connected bot inventory to arbitrary callers.
app.get('/status', async (req, res): Promise<void> => {
  const callerProfileId = await getCallerProfileId(req)
  if (!callerProfileId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  res.json({
    connected_bots: gateway.getConnectedBotCount(),
    total_connections: gateway.getTotalConnectionCount(),
    bots: gateway.getConnectedBots().map(b => ({
      id: b.botId,
      username: b.username,
      last_heartbeat: b.lastHeartbeat
    }))
  })
})

// Bridged users for Discord bridge - used by the Harmony frontend for mention
// autosuggest. Requires the caller to be a member of the channel's server so
// you can't enumerate Discord user lists for arbitrary channel IDs.
app.get('/bridged-users/:channelId', async (req, res): Promise<void> => {
  const callerProfileId = await getCallerProfileId(req)
  if (!callerProfileId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  const { channelId } = req.params

  // Resolve channel → server_id, then check the caller is in user_servers for
  // that server. Service role bypasses RLS, so this is the authoritative check.
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', channelId)
    .maybeSingle()

  if (!channel?.server_id) {
    res.status(404).json({ error: 'Channel not found' })
    return
  }

  const { data: membership } = await supabase
    .from('user_servers')
    .select('user_id')
    .eq('server_id', channel.server_id)
    .eq('user_id', callerProfileId)
    .eq('status', 'accepted')
    .maybeSingle()

  if (!membership) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const bridgedUsers = gateway.getBridgedUsers(channelId)
  const hasBridge = gateway.hasChannelBridge(channelId)

  res.json({
    channel_id: channelId,
    has_bridge: hasBridge,
    users: bridgedUsers
  })
})

app.get('/bridged-users/server/:serverId', async (req, res): Promise<void> => {
  const callerProfileId = await getCallerProfileId(req)
  if (!callerProfileId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  const { serverId } = req.params

  const { data: membership } = await supabase
    .from('user_servers')
    .select('user_id')
    .eq('server_id', serverId)
    .eq('user_id', callerProfileId)
    .eq('status', 'accepted')
    .maybeSingle()

  if (!membership) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const { data: channels } = await supabase
    .from('channels')
    .select('id')
    .eq('server_id', serverId)

  const channelIds = (channels ?? []).map((c: { id: string }) => c.id)
  const bridgedUsers = gateway.getBridgedUsersForServer(channelIds)
  const hasBridge = gateway.hasBridgedUsersForServer(channelIds)

  res.json({
    server_id: serverId,
    has_bridge: hasBridge,
    users: bridgedUsers,
  })
})

// On-demand attachment refresh (bridge_attachment_mode = 'refresh'). When a
// user views a bridged message whose external CDN URL has expired, the frontend
// calls this; we forward a REFRESH_ATTACHMENTS request to the owning bot (the
// bridge), which re-signs the URLs and silently patches the message. Deduped so
// many simultaneous viewers don't fan out into many Discord API calls.
const refreshDedupe = new TTLCache<string, true>(5_000, 15_000)

app.post('/attachments/refresh', async (req, res): Promise<void> => {
  const callerProfileId = await getCallerProfileId(req)
  if (!callerProfileId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  const messageId = (req.body?.messageId ?? '').toString()
  if (!messageId) {
    res.status(400).json({ error: 'messageId is required' })
    return
  }

  // Feature must be enabled by the instance admin.
  if ((await getBridgeAttachmentMode()) !== 'refresh') {
    res.json({ refreshing: false, reason: 'not_enabled' })
    return
  }

  // Already kicked off a refresh for this message very recently — no-op.
  if (refreshDedupe.get(messageId)) {
    res.json({ refreshing: true, deduped: true })
    return
  }

  const { data: message } = await supabase
    .from('messages')
    .select('id, channel_id, bot_id, content')
    .eq('id', messageId)
    .maybeSingle()

  // Only bridged (bot-authored) messages with expirable Discord CDN parts qualify.
  if (!message?.bot_id || !message.channel_id || !hasDiscordCdnFilePart(message.content)) {
    res.json({ refreshing: false, reason: 'not_applicable' })
    return
  }

  // Caller must be a member of the channel's server (same gate as bridged-users).
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', message.channel_id)
    .maybeSingle()

  if (!channel?.server_id) {
    res.status(404).json({ error: 'Channel not found' })
    return
  }

  const { data: membership } = await supabase
    .from('user_servers')
    .select('user_id')
    .eq('server_id', channel.server_id)
    .eq('user_id', callerProfileId)
    .eq('status', 'accepted')
    .maybeSingle()

  if (!membership) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  if (!gateway.isBotConnected(message.bot_id)) {
    res.json({ refreshing: false, reason: 'bridge_offline' })
    return
  }

  refreshDedupe.set(messageId, true)
  gateway.sendToBot(message.bot_id, {
    op: 0,
    t: 'REFRESH_ATTACHMENTS',
    d: { messageId: message.id, channelId: message.channel_id, content: message.content },
  })

  res.json({ refreshing: true })
})

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(500).json({
    error: 'Internal server error',
    message: config.nodeEnv === 'development' ? err.message : undefined
  })
})

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Graceful shutdown
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  console.log('📥 Received shutdown signal')
  
  // Close WebSocket connections
  gateway.shutdown()
  
  // Close event dispatcher
  await eventDispatcher.shutdown()
  
  // Close HTTP server
  server.close(() => {
    console.log('👋 Server shut down gracefully')
    process.exit(0)
  })
  
  // Force close after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
}

// Start server
const PORT = config.port
server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗')
  console.log('║   🤖 Harmony Bot Gateway Started      ║')
  console.log('╠════════════════════════════════════════╣')
  console.log(`║   HTTP Server:  http://localhost:${PORT}   ║`)
  console.log(`║   WebSocket:    ws://localhost:${PORT}/gateway`)
  console.log(`║   Environment:  ${config.nodeEnv.padEnd(23)}║`)
  console.log('╚════════════════════════════════════════╝')
})

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error)
  process.exit(1)
})

export { app, server, gateway, eventDispatcher }

