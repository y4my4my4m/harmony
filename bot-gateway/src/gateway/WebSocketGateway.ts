import { WebSocketServer, WebSocket } from 'ws'
import { supabase, config } from '../config/supabase.js'
import * as crypto from 'crypto'
import { type InstallRow, botCanSeeChannel, loadEveryoneLayers } from '../auth/botPermissions.js'

function logPresenceError(op: string, error: unknown) {
  if (!error) return
  const message = error instanceof Error ? error.message : (error as { message?: string }).message ?? String(error)
  console.error(`bot_presence ${op} failed:`, message)
}

export interface BotConnection {
  botId: string
  username: string
  scopes: string[]
  lastHeartbeat: number
  sessionId: string
  // SHA-256 hex of the IDENTIFY token; bot_tokens.token_hash.
  tokenHash: string
}

interface TokenRow {
  bot_id?: string
  token_hash?: string
  is_active?: boolean | null
  revoked_at?: string | null
  expires_at?: string | null
}

interface BotRow {
  id: string
  is_active?: boolean | null
}

/**
 * Why a session's credential no longer authenticates, or null. Mirrors verify_bot_token(): the
 * token row is active and unexpired, and the bot active. Staging's bot_tokens has no is_active;
 * there revoked_at marks revocation.
 */
export function sessionRevocationReason(
  conn: Pick<BotConnection, 'botId' | 'tokenHash'>,
  tokens: TokenRow[],
  bots: BotRow[],
  now: number,
): string | null {
  const token = tokens.find(t => t.token_hash === conn.tokenHash && t.bot_id === conn.botId)
  if (!token) return 'Token revoked'
  const revoked = 'is_active' in token ? token.is_active !== true : token.revoked_at != null
  if (revoked) return 'Token revoked'
  if (token.expires_at != null && Date.parse(token.expires_at) <= now) return 'Token expired'

  const bot = bots.find(b => b.id === conn.botId)
  if (!bot || bot.is_active !== true) return 'Bot inactive'
  return null
}

// Token hashes per bot_tokens lookup; 64 hex characters each in the query string.
const REVALIDATE_CHUNK = 50

// verify_bot_token's refusals ({valid: false, error}); any other text reads as the first.
const IDENTIFY_REFUSALS = new Set(['Invalid or expired token', 'Bot not found or inactive'])

/** 4004 close reason for a token verify_bot_token refused. */
export function identifyRefusalReason(verification: unknown): string {
  const error = (verification as { error?: unknown } | null)?.error
  return typeof error === 'string' && IDENTIFY_REFUSALS.has(error) ? error : 'Invalid or expired token'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Bridged user info, sent by the Discord bridge.
export interface BridgedDiscordRole {
  id: string
  name: string
  color: string | null
  position: number
}

export interface BridgedUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string
  bannerUrl?: string | null
  accentColor?: string | null
  harmonyRoleIds?: string[]
  roles?: BridgedDiscordRole[]
  joinedAt?: string | null
  createdAt?: string | null
  presenceStatus?: 'online' | 'away' | 'busy' | 'offline'
  customStatus?: { text: string; emoji: string | null } | null
  source: 'discord'
}

export type BridgedPresenceStatus = NonNullable<BridgedUser['presenceStatus']>
const PRESENCE_STATUSES: ReadonlySet<string> = new Set<BridgedPresenceStatus>(['online', 'away', 'busy', 'offline'])
const DISCORD_ID = /^[0-9]{1,20}$/
// Discord: custom status text up to 128 characters; its emoji a custom emoji name of up to 32
// characters or a unicode emoji sequence.
const CUSTOM_STATUS_TEXT_MAX = 128
const CUSTOM_STATUS_EMOJI_MAX = 64

/**
 * One BRIDGE_PRESENCE_UPDATE (op 7) entry, validated. An absent or malformed presenceStatus
 * leaves the stored status; customStatus null clears it, absent leaves it.
 */
export interface PresenceDelta {
  id: string
  presenceStatus?: BridgedPresenceStatus
  customStatus?: BridgedUser['customStatus']
}

/** op 7 `d.updates`, reduced to valid entries. */
export function parsePresenceDeltas(data: unknown): PresenceDelta[] {
  const updates = (data as { updates?: unknown } | null)?.updates
  if (!Array.isArray(updates)) return []
  const out: PresenceDelta[] = []
  for (const raw of updates) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    if (typeof entry.id !== 'string' || !DISCORD_ID.test(entry.id)) continue
    const delta: PresenceDelta = { id: entry.id }
    if (typeof entry.presenceStatus === 'string' && PRESENCE_STATUSES.has(entry.presenceStatus)) {
      delta.presenceStatus = entry.presenceStatus as BridgedPresenceStatus
    }
    if (entry.customStatus === null) {
      delta.customStatus = null
    } else if (entry.customStatus && typeof entry.customStatus === 'object') {
      const custom = entry.customStatus as Record<string, unknown>
      const text = typeof custom.text === 'string' ? custom.text.slice(0, CUSTOM_STATUS_TEXT_MAX) : null
      const emoji = typeof custom.emoji === 'string' ? custom.emoji.slice(0, CUSTOM_STATUS_EMOJI_MAX) : null
      if (text !== null && (custom.emoji === null || custom.emoji === undefined || emoji !== null)) {
        delta.customStatus = { text, emoji }
      }
    }
    if (delta.presenceStatus !== undefined || delta.customStatus !== undefined) out.push(delta)
  }
  return out
}

export interface ChannelBridgeData {
  botId: string
  harmonyChannelId: string
  discordChannelId: string
  members: BridgedUser[]
}

export class WebSocketGateway {
  private connections = new Map<WebSocket, BotConnection>()
  private heartbeatInterval: NodeJS.Timeout | null = null
  private revalidateInterval: NodeJS.Timeout | null = null
  private revalidating = false
  
  // Harmony channel ID -> bridged users.
  private bridgedUsersByChannel = new Map<string, BridgedUser[]>()
  private channelsByBot = new Map<string, Set<string>>()
  // Bot ID -> Discord user ID -> the user objects of that bot's registration, one per channel
  // list holding the user. op 7 updates these objects in place.
  private usersByBot = new Map<string, Map<string, BridgedUser[]>>()
  
  constructor(private wss: WebSocketServer) {
    this.wss.on('connection', this.handleConnection.bind(this))
    this.startHeartbeatCheck()
    this.startSessionRevalidation()
    console.log('WebSocket Gateway initialized')
  }
  
  private handleConnection(ws: WebSocket) {
    let botConnection: BotConnection | null = null
    
    console.log('New WebSocket connection')
    
    ws.on('message', async (data) => {
      try {
        const payload = JSON.parse(data.toString())
        
        switch (payload.op) {
          case 2: // IDENTIFY
            botConnection = await this.handleIdentify(ws, payload.d)
            break
            
          case 1: // HEARTBEAT
            if (botConnection) {
              this.handleHeartbeat(ws, botConnection)
            }
            break
            
          case 6: // REGISTER_BRIDGE_DATA
            if (botConnection) {
              // Fire-and-forget: registration is best-effort caching, and an
              // unhandled rejection crashes the gateway worker (BUGS.md M47,
              // unhandled rejection policy).
              this.handleBridgeDataRegistration(botConnection, payload.d).catch(err => {
                console.error('Error handling bridge data registration:', err)
              })
            }
            break

          case 7: // BRIDGE_PRESENCE_UPDATE
            if (botConnection) {
              this.applyBridgePresence(botConnection.botId, payload.d)
            }
            break
            
          default:
            console.warn(`Unknown opcode: ${payload.op}`)
        }
      } catch (error) {
        console.error('Error handling message:', error)
        ws.close(1008, 'Invalid payload')
      }
    })
    
    ws.on('close', () => {
      if (botConnection) {
        console.log(`Bot disconnected: ${botConnection.username}`)
        this.connections.delete(ws)
        
        this.cleanupBotBridgeData(botConnection.botId)
        
        supabase
          .from('bot_presence')
          .update({
            status: 'offline',
            last_heartbeat_at: new Date().toISOString()
          })
          .eq('bot_id', botConnection.botId)
          .then(
            ({ error }) => logPresenceError('offline update', error),
            (err) => logPresenceError('offline update', err)
          )
      }
    })
    
    ws.on('error', (error) => {
      console.error('WebSocket error:', error)
    })
  }
  
  private async handleIdentify(ws: WebSocket, data: any): Promise<BotConnection | null> {
    const token = data?.token
    
    if (!token) {
      ws.close(4001, 'Missing token')
      return null
    }
    
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    
    const { data: verification, error } = await supabase.rpc('verify_bot_token', {
      p_token_hash: tokenHash
    })

    // Close code stays 4004 either way; the reason tells a failed lookup from a refused token.
    // The SQLSTATE only reaches the log from here.
    if (error) {
      console.error('verify_bot_token failed:', error.code, error.message, error.details)
      ws.close(4004, 'Token verification unavailable')
      return null
    }

    if (!verification || !verification.valid) {
      console.warn('Invalid bot token attempt')
      ws.close(4004, identifyRefusalReason(verification))
      return null
    }
    
    const botConnection: BotConnection = {
      botId: verification.bot_id,
      username: verification.username,
      scopes: verification.scopes || [],
      lastHeartbeat: Date.now(),
      sessionId: crypto.randomUUID(),
      tokenHash
    }
    
    this.connections.set(ws, botConnection)
    
    // Arbiter is explicit; PostgREST otherwise derives ON CONFLICT from the
    // primary key, which is the surrogate id rather than bot_id.
    const { error: presenceError } = await supabase
      .from('bot_presence')
      .upsert({
        bot_id: botConnection.botId,
        status: 'online',
        connected_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        gateway_session_id: botConnection.sessionId
      }, { onConflict: 'bot_id' })

    logPresenceError('identify upsert', presenceError)

    const { error: botUpdateError } = await supabase
      .from('bots')
      .update({ last_online_at: new Date().toISOString() })
      .eq('id', botConnection.botId)

    if (botUpdateError) {
      console.error('bots.last_online_at update failed:', botUpdateError.message)
    }

    ws.send(JSON.stringify({
      op: 0,
      t: 'READY',
      d: {
        bot: {
          id: botConnection.botId,
          username: botConnection.username
        },
        session_id: botConnection.sessionId,
        heartbeat_interval: config.websocket.heartbeatInterval
      }
    }))
    
    console.log(`Bot authenticated: ${botConnection.username} (${botConnection.botId})`)
    return botConnection
  }
  
  private handleHeartbeat(ws: WebSocket, botConnection: BotConnection) {
    const previousHeartbeat = botConnection.lastHeartbeat
    const now = Date.now()
    botConnection.lastHeartbeat = now

    ws.send(JSON.stringify({ op: 11 }))

    // Only heartbeat arrivals are observable server-side. Latency is the arrival
    // delay past the interval advertised in READY; a client on schedule reports 0.
    const latencyMs = Math.max(0, now - previousHeartbeat - config.websocket.heartbeatInterval)

    supabase
      .from('bot_presence')
      .update({
        last_heartbeat_at: new Date(now).toISOString(),
        latency_ms: latencyMs
      })
      .eq('bot_id', botConnection.botId)
      .then(
        ({ error }) => logPresenceError('heartbeat update', error),
        (err) => logPresenceError('heartbeat update', err)
      )
  }
  
  private startHeartbeatCheck() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now()
      const timeout = config.websocket.heartbeatInterval * 2 // 2x heartbeat interval
      
      for (const [ws, conn] of this.connections) {
        if (now - conn.lastHeartbeat > timeout) {
          console.warn(`Bot heartbeat timeout: ${conn.username}`)
          ws.close(1000, 'Heartbeat timeout')
          this.connections.delete(ws)
        }
      }
    }, config.websocket.heartbeatInterval)
  }
  
  // Polled rather than subscribed: works with any number of gateway processes and needs no
  // Realtime publication on bot_tokens or bots.
  private startSessionRevalidation() {
    this.revalidateInterval = setInterval(() => {
      this.revalidateSessions().catch(err => {
        console.error('Session revalidation failed:', err)
      })
    }, config.websocket.revalidateIntervalMs)
  }

  /**
   * Closes, with 4004, every session whose token was revoked, rotated, deleted or expired, or
   * whose bot was deactivated or deleted. Reads the tables directly: verify_bot_token() counts a
   * use per call. A failed lookup closes nothing; the next run retries.
   */
  async revalidateSessions(): Promise<void> {
    if (this.revalidating || this.connections.size === 0) return
    this.revalidating = true
    try {
      const sessions = Array.from(this.connections.entries())
      const hashes = Array.from(new Set(sessions.map(([, conn]) => conn.tokenHash)))
      const botIds = Array.from(new Set(sessions.map(([, conn]) => conn.botId)))

      const tokens: TokenRow[] = []
      for (let i = 0; i < hashes.length; i += REVALIDATE_CHUNK) {
        // '*': staging's bot_tokens has no is_active column.
        const { data, error } = await supabase
          .from('bot_tokens')
          .select('*')
          .in('token_hash', hashes.slice(i, i + REVALIDATE_CHUNK))
        if (error || !Array.isArray(data)) {
          console.error('Session revalidation: bot_tokens lookup failed:', error?.message)
          return
        }
        tokens.push(...(data as TokenRow[]))
      }

      const { data: bots, error: botsError } = await supabase
        .from('bots')
        .select('id, is_active')
        .in('id', botIds)
      if (botsError || !Array.isArray(bots)) {
        console.error('Session revalidation: bots lookup failed:', botsError?.message)
        return
      }

      const now = Date.now()
      for (const [ws, conn] of sessions) {
        if (this.connections.get(ws) !== conn) continue
        const reason = sessionRevocationReason(conn, tokens, bots as BotRow[], now)
        if (!reason) continue
        console.warn(`Closing session ${conn.sessionId} of bot ${conn.botId}: ${reason}`)
        this.connections.delete(ws)
        ws.close(4004, reason)
      }
    } finally {
      this.revalidating = false
    }
  }

  // EVENT BROADCASTING
  
  sendToBot(botId: string, event: any) {
    let sent = 0
    
    for (const [ws, conn] of this.connections) {
      if (conn.botId === botId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event))
        sent++
      }
    }
    
    if (sent > 0) {
      console.log(`Sent event to bot ${botId} (${sent} connections)`)
    }
  }
  
  sendToMultipleBots(botIds: string[], event: any) {
    for (const botId of botIds) {
      this.sendToBot(botId, event)
    }
  }
  
  broadcast(event: any) {
    let sent = 0
    
    for (const ws of this.connections.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event))
        sent++
      }
    }
    
    console.log(`Broadcast event to ${sent} bots`)
  }
  
  // STATUS & MANAGEMENT
  
  getConnectedBotCount(): number {
    return new Set([...this.connections.values()].map(c => c.botId)).size
  }
  
  getTotalConnectionCount(): number {
    return this.connections.size
  }
  
  getConnectedBots(): BotConnection[] {
    return Array.from(this.connections.values())
  }
  
  isBotConnected(botId: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.botId === botId) {
        return true
      }
    }
    return false
  }
  
  // BRIDGE DATA MANAGEMENT
  
  /**
   * Handles bridge data registration from the Discord bridge.
   *
   * BUGS.md H40: `harmonyChannelId`s from the bot are untrusted. For each one,
   * `channels.server_id` is resolved, the bot must have an active
   * `bot_server_permissions` row for that server, and must see the channel
   * (botCanSeeChannel); channels failing the check are dropped from the
   * registration.
   *
   * Without that check a stolen bot token can cache fabricated Discord member
   * lists under any channel ID, including servers the bot is not installed on.
   * Those lists are served to the frontend via `/bridged-users/:channelId` for
   * mention autosuggest, yielding fake mention pings and impersonation through
   * crafted Discord user metadata.
   *
   * Members: a channel's own `members` array, empty included, is its list. The root `members`
   * list applies only to channels that carry no `members` field, and only when those channels
   * are all in one server; a v1 bridge sends the first guild's members at the root, and the
   * root list must not reach another guild's channels.
   *
   * A registration replaces the bot's previous one. An id that is not a uuid is dropped alone:
   * in the batched lookup PostgREST would refuse the whole list (22P02). A failed lookup keeps
   * the previous registration.
   */
  private async handleBridgeDataRegistration(botConnection: BotConnection, data: any) {
    if (!data || !Array.isArray(data.channels)) {
      console.warn('Invalid bridge data registration - missing channels array')
      return
    }
    const botId = botConnection.botId

    const sharedMembers: BridgedUser[] = Array.isArray(data.members) ? data.members as BridgedUser[] : []
    const candidates: Array<{ harmonyChannelId: string; members: BridgedUser[] | null }> = []
    let rejectedCount = 0
    for (const channelData of data.channels) {
      const harmonyChannelId = channelData?.harmonyChannelId
      if (typeof harmonyChannelId !== 'string' || !UUID.test(harmonyChannelId)) {
        console.warn(`Bridge data from bot ${botId}: harmonyChannelId ${JSON.stringify(harmonyChannelId)} is not a uuid - dropping`)
        rejectedCount++
        continue
      }
      const members = Array.isArray(channelData.members) ? channelData.members as BridgedUser[] : null
      candidates.push({ harmonyChannelId: harmonyChannelId.toLowerCase(), members })
    }

    const channelServerMap = new Map<string, string>()
    if (candidates.length > 0) {
      const { data: channelRows, error } = await supabase
        .from('channels')
        .select('id, server_id')
        .in('id', candidates.map(c => c.harmonyChannelId))
      if (error || !Array.isArray(channelRows)) {
        console.error(`Bridge data from bot ${botId}: channels lookup failed:`, error?.message)
        return
      }
      for (const row of channelRows as Array<{ id: string; server_id: string | null }>) {
        if (row.server_id) channelServerMap.set(row.id, row.server_id)
      }
    }

    // Installations of this bot, every column: see loadInstall().
    const candidateServerIds = Array.from(new Set(channelServerMap.values()))
    const installByServer = new Map<string, InstallRow>()
    if (candidateServerIds.length > 0) {
      const { data: permRows, error } = await supabase
        .from('bot_server_permissions')
        .select('*')
        .eq('bot_id', botId)
        .eq('is_active', true)
        .in('server_id', candidateServerIds)
      if (error || !Array.isArray(permRows)) {
        console.error(`Bridge data from bot ${botId}: bot_server_permissions lookup failed:`, error?.message)
        return
      }
      for (const row of permRows as InstallRow[]) {
        installByServer.set(row.server_id as string, row)
      }
    }

    const layers = await loadEveryoneLayers(
      Array.from(channelServerMap.entries())
        .filter(([, serverId]) => installByServer.has(serverId))
        .map(([id, server_id]) => ({ id, server_id })),
    )

    const accepted: Array<{ harmonyChannelId: string; serverId: string; members: BridgedUser[] | null }> = []
    for (const { harmonyChannelId, members } of candidates) {
      const serverId = channelServerMap.get(harmonyChannelId)
      const install = serverId ? installByServer.get(serverId) : undefined
      if (!serverId || !install) {
        console.warn(`Bridge data from bot ${botId}: ${harmonyChannelId} is in no server the bot is installed in - dropping`)
        rejectedCount++
        continue
      }
      const layer = layers.get(harmonyChannelId)
      if (!layer || !botCanSeeChannel(install, layer, harmonyChannelId)) {
        console.warn(`Bridge data from bot ${botId}: ${harmonyChannelId} is not visible to the bot - dropping`)
        rejectedCount++
        continue
      }
      accepted.push({ harmonyChannelId, serverId, members })
    }

    const inheritingServers = new Set(accepted.filter(a => a.members === null).map(a => a.serverId))
    const shared = inheritingServers.size <= 1 ? sharedMembers : []
    if (inheritingServers.size > 1 && sharedMembers.length > 0) {
      console.warn(`Bridge data from bot ${botId}: root members span ${inheritingServers.size} servers - ignoring them`)
    }

    const previous = this.channelsByBot.get(botId) ?? new Set<string>()
    const current = new Set<string>()
    const index = new Map<string, BridgedUser[]>()
    const indexed = new Set<BridgedUser[]>()
    for (const { harmonyChannelId, members } of accepted) {
      const list = members ?? shared
      this.bridgedUsersByChannel.set(harmonyChannelId, list)
      current.add(harmonyChannelId)
      // The shared root list can back several channels; its users are indexed once.
      if (indexed.has(list)) continue
      indexed.add(list)
      for (const user of list) {
        if (!user || typeof user.id !== 'string') continue
        const copies = index.get(user.id)
        if (copies) copies.push(user)
        else index.set(user.id, [user])
      }
    }
    this.channelsByBot.set(botId, current)
    this.usersByBot.set(botId, index)
    for (const channelId of previous) {
      if (!current.has(channelId)) this.releaseChannel(botId, channelId)
    }
    console.log(`Bridge data from bot ${botConnection.username}: accepted=${accepted.length} rejected=${rejectedCount}`)
  }

  /**
   * BRIDGE_PRESENCE_UPDATE (op 7) {updates:[{id, presenceStatus, customStatus}]}: presence
   * deltas for members of the bot's last registration (op 6). Updates the cached user objects
   * that /bridged-users serves; ids outside the registration are ignored. Returns the number of
   * user objects changed.
   */
  applyBridgePresence(botId: string, data: unknown): number {
    const index = this.usersByBot.get(botId)
    if (!index) return 0
    let changed = 0
    for (const delta of parsePresenceDeltas(data)) {
      for (const user of index.get(delta.id) ?? []) {
        if (delta.presenceStatus !== undefined) user.presenceStatus = delta.presenceStatus
        if (delta.customStatus !== undefined) user.customStatus = delta.customStatus
        changed++
      }
    }
    return changed
  }

  // A channel's members stay while another bot still registers the channel.
  private releaseChannel(botId: string, channelId: string) {
    for (const [otherBot, channels] of this.channelsByBot) {
      if (otherBot !== botId && channels.has(channelId)) return
    }
    this.bridgedUsersByChannel.delete(channelId)
  }

  // Called on bot disconnect.
  private cleanupBotBridgeData(botId: string) {
    this.usersByBot.delete(botId)
    const botChannels = this.channelsByBot.get(botId)
    if (botChannels) {
      this.channelsByBot.delete(botId)
      for (const channelId of botChannels) {
        this.releaseChannel(botId, channelId)
      }
    }
  }
  
  // Consumed by the REST API.
  getBridgedUsers(channelId: string): BridgedUser[] {
    return this.bridgedUsersByChannel.get(channelId) || []
  }

  /**
   * Merges bridged users across all mapped channels on a server, deduped by
   * Discord id.
   */
  getBridgedUsersForServer(channelIds: string[]): BridgedUser[] {
    const byDiscordId = new Map<string, BridgedUser>()
    for (const channelId of channelIds) {
      for (const user of this.bridgedUsersByChannel.get(channelId) ?? []) {
        byDiscordId.set(user.id, user)
      }
    }
    return Array.from(byDiscordId.values())
  }

  hasBridgedUsersForServer(channelIds: string[]): boolean {
    return channelIds.some(id => (this.bridgedUsersByChannel.get(id)?.length ?? 0) > 0)
  }
  
  hasChannelBridge(channelId: string): boolean {
    return (this.bridgedUsersByChannel.get(channelId)?.length ?? 0) > 0
  }
  
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    if (this.revalidateInterval) {
      clearInterval(this.revalidateInterval)
      this.revalidateInterval = null
    }
    
    for (const [ws] of this.connections) {
      ws.close(1000, 'Server shutting down')
    }
    
    this.connections.clear()
    this.bridgedUsersByChannel.clear()
    this.channelsByBot.clear()
    this.usersByBot.clear()
    console.log('WebSocket Gateway shut down')
  }
}

