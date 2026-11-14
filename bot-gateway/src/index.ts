import express from 'express'
import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import { config, supabase } from './config/supabase.js'
import { WebSocketGateway } from './gateway/WebSocketGateway.js'
import { EventDispatcher } from './gateway/EventDispatcher.js'
import { InteractionPoller } from './gateway/InteractionPoller.js'
import { BotRestAPI } from './api/BotRestAPI.js'
import { BridgeV2API, MIN_HOST_SECRET_LENGTH } from './api/BridgeV2API.js'
import { BridgeConfigWatcher } from './gateway/BridgeConfigWatcher.js'
import { TTLCache } from './utils/TTLCache.js'
import { getBridgeAttachmentMode, getUploadCeilingBytes, hasDiscordCdnFilePart, readBridgeAttachmentMode } from './utils/mirrorExternalMedia.js'
import { mirrorFileToStorage } from './utils/mirrorFile.js'
import { MirrorWorker } from './bridge/mirrorWorker.js'
import { removeUnreferencedMirrors } from './bridge/mirrorEnqueue.js'
import { meetsAssurance } from './utils/sessionAssurance.js'
import { DiscordLinkRefresher, expiredDiscordAttachmentUrls } from './bridge/discordLinkRefresh.js'

const app = express()

// req.ip and req.protocol come from the reverse proxy's X-Forwarded-* headers; see config.trustProxy.
app.set('trust proxy', config.trustProxy)

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

// INTERACTION_CREATE: slash command invocations of connected bots.
const interactionPoller = new InteractionPoller(gateway)
interactionPoller.start()

// Bot API routes require bot token authentication.
const botAPI = new BotRestAPI(eventDispatcher)
app.use('/api/v1', botAPI.router)

// Discord bridge v2: setup-code redeem, hosted list, and the bridge bot's config, status and pairs.
app.use('/bridge/v2', new BridgeV2API().router)

const bridgeConfigWatcher = new BridgeConfigWatcher(gateway)
bridgeConfigWatcher.start()

// Stores Discord attachments in Harmony storage in the background (mirror mode).
const mirrorWorker = new MirrorWorker({
  rpc: async (name, args) => {
    const { data, error } = await supabase.rpc(name, args)
    if (error) throw Object.assign(new Error(`${name} failed: ${error.message}`), { code: error.code })
    return data
  },
  readMessage: async (id) => {
    const { data, error } = await supabase
      .from('messages')
      .select('id, channel_id, bot_id, content, is_deleted')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(`message read failed: ${error.message}`)
    return data
  },
  mode: readBridgeAttachmentMode,
  ceiling: getUploadCeilingBytes,
  mirror: mirrorFileToStorage,
  discard: removeUnreferencedMirrors,
  gateway,
  now: () => Date.now(),
  log: console,
})
mirrorWorker.start()
if (config.bridge.hostSecret && config.bridge.hostSecret.length < MIN_HOST_SECRET_LENGTH) {
  console.warn(`BRIDGE_HOST_SECRET is shorter than ${MIN_HOST_SECRET_LENGTH} characters; GET /bridge/v2/hosted stays disabled`)
}

// USER-AUTHENTICATED ENDPOINTS
//
// These require a valid Supabase user JWT. `/bridged-users` additionally
// requires the caller to be a member of the channel's server; unauthenticated
// access allowed enumeration of connected bots and of bridged Discord users
// for arbitrary channel IDs. See BUGS.md C4.

/**
 * Validates the Supabase user JWT in `Authorization: Bearer <token>`.
 * Returns `profiles.id`, or `null` when unauthenticated or below the account's
 * assurance level.
 */
async function getCallerProfileId(req: express.Request): Promise<string | null> {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length).trim()
  if (!token) return null

  const { data: userData, error: userError } = await supabase.auth.getUser(token)
  if (userError || !userData?.user || !meetsAssurance(userData.user, token)) return null

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
  // Listed bots: public ones, the caller's own, every one for an instance admin.
  const connected = gateway.getConnectedBots()
  const [{ data: caller }, { data: botRows }] = await Promise.all([
    supabase.from('profiles').select('is_admin').eq('id', callerProfileId).maybeSingle(),
    connected.length > 0
      ? supabase.from('bots').select('id, owner_id, is_public').in('id', connected.map(b => b.botId))
      : Promise.resolve({ data: [] as Array<{ id: string; owner_id: string | null; is_public: boolean | null }> }),
  ])
  const listable = new Set(
    ((botRows ?? []) as Array<{ id: string; owner_id: string | null; is_public: boolean | null }>)
      .filter(b => caller?.is_admin === true || b.is_public === true || b.owner_id === callerProfileId)
      .map(b => b.id),
  )
  res.json({
    connected_bots: gateway.getConnectedBotCount(),
    total_connections: gateway.getTotalConnectionCount(),
    bots: connected.filter(b => listable.has(b.botId)).map(b => ({
      id: b.botId,
      username: b.username,
      last_heartbeat: b.lastHeartbeat
    }))
  })
})

/** VIEW_CHANNEL of a profile in a channel (has_permission); false on a failed lookup. */
async function canViewChannel(profileId: string, serverId: string, channelId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('has_permission', {
    p_user_id: profileId,
    p_server_id: serverId,
    p_permission: 'VIEW_CHANNEL',
    p_channel_id: channelId,
  })
  return !error && data === true
}

// Discord bridge users, consumed by the frontend for mention autosuggest.
// The caller must view the channel: the list is that channel's Discord members.
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

  // has_permission is false for a non-member, so this also checks membership.
  if (!(await canViewChannel(callerProfileId, channel.server_id, channelId))) {
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

  const allIds = (channels ?? []).map((c: { id: string }) => c.id)
  const viewable = await Promise.all(allIds.map((id) => canViewChannel(callerProfileId, serverId, id)))
  const channelIds = allIds.filter((_id, i) => viewable[i])
  const bridgedUsers = gateway.getBridgedUsersForServer(channelIds)
  const hasBridge = gateway.hasBridgedUsersForServer(channelIds)

  res.json({
    server_id: serverId,
    has_bridge: hasBridge,
    users: bridgedUsers,
  })
})

// On-demand attachment refresh, active when bridge_attachment_mode = 'refresh'.
// The frontend calls this when a message's Discord CDN URL has expired. A message
// whose bot is connected gets REFRESH_ATTACHMENTS: the bot re-signs and patches
// it. Any other message, a person's pasted link or a bridged message whose bridge
// is offline, is re-signed here with the instance Discord application's token.
// Deduped so simultaneous viewers produce one Discord API call.
const refreshDedupe = new TTLCache<string, true>(5_000, 15_000)

const linkRefresher = new DiscordLinkRefresher({
  token: async () => {
    const { data, error } = await supabase.rpc('discord_bridge_instance_hosted')
    if (error) throw new Error(`discord_bridge_instance_hosted: ${error.message}`)
    const token = (data as { discord_token?: unknown } | null)?.discord_token
    return typeof token === 'string' && token ? token : null
  },
  write: async (messageId, oldContent, content) => {
    const { data, error } = await supabase.rpc('update_message_content_silent', {
      p_message_id: messageId,
      p_old_content: oldContent,
      p_content: content,
    })
    if (error) throw new Error(error.message)
    return data === true
  },
})

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
    .select('id, channel_id, bot_id, content, is_deleted')
    .eq('id', messageId)
    .maybeSingle()

  // Channel messages with Discord CDN parts qualify, whoever wrote them.
  if (!message || message.is_deleted || !message.channel_id || !hasDiscordCdnFilePart(message.content)) {
    res.json({ refreshing: false, reason: 'not_applicable' })
    return
  }

  // Caller must view the channel; same gate as bridged-users.
  const { data: channel } = await supabase
    .from('channels')
    .select('server_id')
    .eq('id', message.channel_id)
    .maybeSingle()

  if (!channel?.server_id) {
    res.status(404).json({ error: 'Channel not found' })
    return
  }

  if (!(await canViewChannel(callerProfileId, channel.server_id, message.channel_id))) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  if (message.bot_id && gateway.isBotConnected(message.bot_id)) {
    refreshDedupe.set(messageId, true)
    gateway.sendToBot(message.bot_id, {
      op: 0,
      t: 'REFRESH_ATTACHMENTS',
      d: { messageId: message.id, channelId: message.channel_id, content: message.content },
    })
    res.json({ refreshing: true })
    return
  }

  const urls = expiredDiscordAttachmentUrls(message.content, Date.now())
  if (urls.length === 0) {
    res.json({ refreshing: false, reason: 'not_expired' })
    return
  }

  const admission = await linkRefresher.request(message.id, message.content, urls)
  if (admission !== 'queued') {
    // A bridged message with no instance Discord application to fall back on.
    const reason = admission === 'no_signer' && message.bot_id ? 'bridge_offline' : admission
    res.json({ refreshing: false, reason })
    return
  }
  refreshDedupe.set(messageId, true)
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
  
  // Hard exit 10s after the shutdown signal.
  setTimeout(() => {
    console.error('Forced shutdown after timeout')
    process.exit(1)
  }, 10000)
  
  bridgeConfigWatcher.stop()
  interactionPoller.stop()
  // Awaited: the exit in the server.close callback drops bot_presence writes still in flight.
  await gateway.shutdown()

  // A download in flight must not hold up the exit; the lease returns its row to the queue.
  await Promise.race([mirrorWorker.stop(), new Promise((resolve) => setTimeout(resolve, 3000))])

  await eventDispatcher.shutdown()
  
  server.close(() => {
    console.log('Server shut down gracefully')
    process.exit(0)
  })
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

export { app, server, gateway, eventDispatcher, interactionPoller, linkRefresher }

