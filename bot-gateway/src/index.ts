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

const app = express()

app.use(helmet())
app.use(cors())
app.use(compression())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  })
})

const server = createServer(app)

const wss = new WebSocketServer({ 
  server, 
  path: '/gateway'
})

const gateway = new WebSocketGateway(wss)
const eventDispatcher = new EventDispatcher(gateway)

eventDispatcher.start().catch(error => {
  console.error('Failed to start event dispatcher:', error)
  process.exit(1)
})

// Bot API routes require bot token authentication.
const botAPI = new BotRestAPI()
app.use('/api/v1', botAPI.router)

// USER-AUTHENTICATED ENDPOINTS
//
// These require a valid Supabase user JWT. `/bridged-users` additionally
// requires the caller to be a member of the channel's server; unauthenticated
// access allowed enumeration of connected bots and of bridged Discord users
// for arbitrary channel IDs. See BUGS.md C4.

/**
 * Validates the Supabase user JWT in `Authorization: Bearer <token>`.
 * Returns `profiles.id`, or `null` when unauthenticated.
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

// Public bridge onboarding lookup. Pairing codes resolve non-secret metadata only.
app.get('/bridge-setup/:pairingCode', async (req, res): Promise<void> => {
  const pairingCode = String(req.params.pairingCode ?? '').trim().toUpperCase()
  if (!/^HRM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairingCode)) {
    res.status(400).json({ error: 'Invalid pairing code format' })
    return
  }

  const { data, error } = await supabase.rpc('lookup_discord_bridge_pairing_public', {
    p_pairing_code: pairingCode,
  })

  if (error) {
    console.error('bridge-setup lookup failed:', error)
    res.status(500).json({ error: 'Lookup failed' })
    return
  }

  const row = Array.isArray(data) ? data[0] : data
  const serverId = row?.server_id as string | undefined
  if (!serverId) {
    res.status(404).json({ error: 'Pairing code not found' })
    return
  }

  const rawDomain = config.instanceDomain
  const baseUrl = rawDomain.startsWith('http') ? rawDomain.replace(/\/$/, '') : `https://${rawDomain}`
  const wsBase = baseUrl.startsWith('https://')
    ? `wss://${baseUrl.slice('https://'.length)}`
    : baseUrl.startsWith('http://')
      ? `ws://${baseUrl.slice('http://'.length)}`
      : baseUrl

  res.json({
    pairing_code: pairingCode,
    server_id: serverId,
    base_url: baseUrl,
    gateway_url_remote: `${wsBase}/bot-gateway/gateway`,
    api_url_remote: `${baseUrl}/bot-gateway`,
    gateway_url_colocated: 'ws://localhost:3002/gateway',
    api_url_colocated: 'http://localhost:3002',
  })
})

// Gateway status. Authenticated: the connected-bot inventory is not public.
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

// Discord bridge users, consumed by the frontend for mention autosuggest.
// Caller must be a member of the channel's server; otherwise Discord user
// lists are enumerable by channel ID.
app.get('/bridged-users/:channelId', async (req, res): Promise<void> => {
  const callerProfileId = await getCallerProfileId(req)
  if (!callerProfileId) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  const { channelId } = req.params

  // Channel resolves to server_id, then caller membership in user_servers.
  // The service role bypasses RLS, so this is the authoritative check.
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

// On-demand attachment refresh, active when bridge_attachment_mode = 'refresh'.
// The frontend calls this when a bridged message's external CDN URL has
// expired; a REFRESH_ATTACHMENTS request goes to the owning bridge bot, which
// re-signs the URLs and patches the message. Deduped so simultaneous viewers
// produce one Discord API call.
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

  // Enabled per instance by the admin.
  if ((await getBridgeAttachmentMode()) !== 'refresh') {
    res.json({ refreshing: false, reason: 'not_enabled' })
    return
  }

  // Refresh already in flight for this message.
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

  // Caller must be a member of the channel's server; same gate as bridged-users.
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

app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err)
  res.status(500).json({
    error: 'Internal server error',
    message: config.nodeEnv === 'development' ? err.message : undefined
  })
})

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  console.log('Received shutdown signal')
  
  gateway.shutdown()
  
  await eventDispatcher.shutdown()
  
  server.close(() => {
    console.log('Server shut down gracefully')
    process.exit(0)
  })
  
  // Hard exit 10s after the shutdown signal.
  setTimeout(() => {
    console.error('Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
}

const PORT = config.port
server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════╗')
  console.log('║   Harmony Bot Gateway Started      ║')
  console.log('╠════════════════════════════════════════╣')
  console.log(`║   HTTP Server:  http://localhost:${PORT}   ║`)
  console.log(`║   WebSocket:    ws://localhost:${PORT}/gateway`)
  console.log(`║   Environment:  ${config.nodeEnv.padEnd(23)}║`)
  console.log('╚════════════════════════════════════════╝')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
  process.exit(1)
})

export { app, server, gateway, eventDispatcher }

