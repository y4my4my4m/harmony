import { WebSocketServer, WebSocket } from 'ws'
import { supabase, config } from '../config/supabase.js'
import * as crypto from 'crypto'

export interface BotConnection {
  botId: string
  username: string
  scopes: string[]
  lastHeartbeat: number
  sessionId: string
}

// Bridged user info (from Discord bridge)
export interface BridgedUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string
  source: 'discord'
}

// Channel bridge data
export interface ChannelBridgeData {
  botId: string
  harmonyChannelId: string
  discordChannelId: string
  members: BridgedUser[]
}

export class WebSocketGateway {
  private connections = new Map<WebSocket, BotConnection>()
  private heartbeatInterval: NodeJS.Timeout | null = null
  
  // Bridged users cache: Harmony channel ID -> bridged users
  private bridgedUsersByChannel = new Map<string, BridgedUser[]>()
  // Track which bot registered which channels (for cleanup on disconnect)
  private channelsByBot = new Map<string, Set<string>>()
  
  constructor(private wss: WebSocketServer) {
    this.wss.on('connection', this.handleConnection.bind(this))
    this.startHeartbeatCheck()
    console.log('✅ WebSocket Gateway initialized')
  }
  
  private handleConnection(ws: WebSocket) {
    let botConnection: BotConnection | null = null
    
    console.log('🔌 New WebSocket connection')
    
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
              // Fire-and-forget; the registration is best-effort caching and
              // an unhandled rejection here would otherwise crash the gateway
              // worker (see BUGS.md M47 - unhandled rejection policy).
              this.handleBridgeDataRegistration(botConnection, payload.d).catch(err => {
                console.error('Error handling bridge data registration:', err)
              })
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
        console.log(`🔌 Bot disconnected: ${botConnection.username}`)
        this.connections.delete(ws)
        
        // Clean up bridged users registered by this bot
        this.cleanupBotBridgeData(botConnection.botId)
        
        // Update presence
        supabase
          .from('bot_presence')
          .update({
            status: 'offline',
            last_heartbeat_at: new Date().toISOString()
          })
          .eq('bot_id', botConnection.botId)
          .then()
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
    
    // Hash token for lookup
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    
    // Verify token
    const { data: verification } = await supabase.rpc('verify_bot_token', {
      p_token_hash: tokenHash
    }) as any
    
    if (!verification || !verification.valid) {
      console.warn('❌ Invalid bot token attempt')
      ws.close(4004, 'Authentication failed')
      return null
    }
    
    const botConnection: BotConnection = {
      botId: verification.bot_id,
      username: verification.username,
      scopes: verification.scopes || [],
      lastHeartbeat: Date.now(),
      sessionId: crypto.randomUUID()
    }
    
    this.connections.set(ws, botConnection)
    
    // Update presence
    await supabase
      .from('bot_presence')
      .upsert({
        bot_id: botConnection.botId,
        status: 'online',
        connected_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        gateway_session_id: botConnection.sessionId
      })
    
    // Update bot last_online_at
    await supabase
      .from('bots')
      .update({ last_online_at: new Date().toISOString() })
      .eq('id', botConnection.botId)
    
    // Send READY event
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
    
    console.log(`✅ Bot authenticated: ${botConnection.username} (${botConnection.botId})`)
    return botConnection
  }
  
  private handleHeartbeat(ws: WebSocket, botConnection: BotConnection) {
    botConnection.lastHeartbeat = Date.now()
    
    // Send HEARTBEAT_ACK
    ws.send(JSON.stringify({ op: 11 }))
    
    // Update presence timestamp
    supabase
      .from('bot_presence')
      .update({
        last_heartbeat_at: new Date().toISOString(),
        latency_ms: Date.now() - botConnection.lastHeartbeat
      })
      .eq('bot_id', botConnection.botId)
      .then()
  }
  
  private startHeartbeatCheck() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now()
      const timeout = config.websocket.heartbeatInterval * 2 // 2x heartbeat interval
      
      for (const [ws, conn] of this.connections) {
        if (now - conn.lastHeartbeat > timeout) {
          console.warn(`⚠️ Bot heartbeat timeout: ${conn.username}`)
          ws.close(1000, 'Heartbeat timeout')
          this.connections.delete(ws)
        }
      }
    }, config.websocket.heartbeatInterval)
  }
  
  // =====================================================
  // EVENT BROADCASTING
  // =====================================================
  
  /**
   * Send event to a specific bot
   */
  sendToBot(botId: string, event: any) {
    let sent = 0
    
    for (const [ws, conn] of this.connections) {
      if (conn.botId === botId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event))
        sent++
      }
    }
    
    if (sent > 0) {
      console.log(`📤 Sent event to bot ${botId} (${sent} connections)`)
    }
  }
  
  /**
   * Send event to multiple bots
   */
  sendToMultipleBots(botIds: string[], event: any) {
    for (const botId of botIds) {
      this.sendToBot(botId, event)
    }
  }
  
  /**
   * Broadcast event to all connected bots
   */
  broadcast(event: any) {
    let sent = 0
    
    for (const ws of this.connections.keys()) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event))
        sent++
      }
    }
    
    console.log(`📣 Broadcast event to ${sent} bots`)
  }
  
  // =====================================================
  // STATUS & MANAGEMENT
  // =====================================================
  
  /**
   * Get connected bot count
   */
  getConnectedBotCount(): number {
    return new Set([...this.connections.values()].map(c => c.botId)).size
  }
  
  /**
   * Get total connection count
   */
  getTotalConnectionCount(): number {
    return this.connections.size
  }
  
  /**
   * Get bots by connection
   */
  getConnectedBots(): BotConnection[] {
    return Array.from(this.connections.values())
  }
  
  /**
   * Check if bot is connected
   */
  isBotConnected(botId: string): boolean {
    for (const conn of this.connections.values()) {
      if (conn.botId === botId) {
        return true
      }
    }
    return false
  }
  
  // =====================================================
  // BRIDGE DATA MANAGEMENT
  // =====================================================
  
  /**
   * Handle bridge data registration from Discord bridge.
   *
   * BUGS.md H40: previously this trusted whatever `harmonyChannelId`s the bot
   * sent us and cached the member list under those IDs. A compromised or
   * malicious bot token could therefore inject fake Discord member lists into
   * `bridgedUsersByChannel` for ANY channel, including channels in servers
   * the bot is not installed on. The cached lists are then served back to the
   * Harmony frontend via `/bridged-users/:channelId` (used for mention
   * autosuggest) - so the attack surface includes both fabricated mention
   * pings and impersonation by way of crafted Discord user metadata.
   *
   * Fix: for each `harmonyChannelId`, resolve `channels.server_id` and verify
   * that the bot has an active `bot_server_permissions` row for that server.
   * Channels failing the check are silently dropped from the registration.
   */
  private async handleBridgeDataRegistration(botConnection: BotConnection, data: any) {
    if (!data.channels || !Array.isArray(data.channels)) {
      console.warn('⚠️ Invalid bridge data registration - missing channels array')
      return
    }
    
    console.log('╔════════════════════════════════════════╗')
    console.log('║   🌉 Gateway: Bridge Data Received    ║')
    console.log('╠════════════════════════════════════════╣')
    console.log(`║   From bot: ${botConnection.username}`)
    console.log(`║   Channels: ${data.channels.length}`)
    if (Array.isArray(data.members) && data.members.length > 0) {
      console.log(`║   Shared Discord members: ${data.members.length}`)
    }
    
    // Track channels registered by this bot
    if (!this.channelsByBot.has(botConnection.botId)) {
      this.channelsByBot.set(botConnection.botId, new Set())
    }
    const botChannels = this.channelsByBot.get(botConnection.botId)!

    // Collect candidate harmony channel IDs up-front so we can batch the
    // server lookup and permission check (one DB round-trip instead of N).
    // Members may be sent once at the root (guild-wide) or per-channel (legacy).
    const sharedMembers: BridgedUser[] = Array.isArray(data.members) ? data.members as BridgedUser[] : []
    const candidates: Array<{ harmonyChannelId: string; members: BridgedUser[] }> = []
    for (const channelData of data.channels) {
      const { harmonyChannelId, members } = channelData
      if (typeof harmonyChannelId !== 'string' || harmonyChannelId.length === 0) continue
      const channelMembers = Array.isArray(members) && members.length > 0 ? members as BridgedUser[] : sharedMembers
      candidates.push({ harmonyChannelId, members: channelMembers })
    }

    if (candidates.length === 0) {
      console.log('╚════════════════════════════════════════╝')
      return
    }

    // Resolve channel → server_id in one batch.
    const { data: channelRows } = await supabase
      .from('channels')
      .select('id, server_id')
      .in('id', candidates.map(c => c.harmonyChannelId))

    const channelServerMap = new Map<string, string>()
    for (const row of (channelRows || []) as Array<{ id: string; server_id: string | null }>) {
      if (row.server_id) channelServerMap.set(row.id, row.server_id)
    }

    // Resolve which servers this bot is actually allowed to act on.
    const candidateServerIds = Array.from(new Set(channelServerMap.values()))
    let authorizedServerIds = new Set<string>()
    if (candidateServerIds.length > 0) {
      const { data: permRows } = await supabase
        .from('bot_server_permissions')
        .select('server_id')
        .eq('bot_id', botConnection.botId)
        .eq('is_active', true)
        .in('server_id', candidateServerIds)
      authorizedServerIds = new Set(
        ((permRows || []) as Array<{ server_id: string }>).map(r => r.server_id),
      )
    }

    let acceptedCount = 0
    let rejectedCount = 0
    for (const { harmonyChannelId, members } of candidates) {
      const serverId = channelServerMap.get(harmonyChannelId)
      if (!serverId || !authorizedServerIds.has(serverId)) {
        console.warn(
          `║   🚫 ${harmonyChannelId}: bot ${botConnection.botId} not authorized for server ${serverId ?? 'unknown'} - dropping`,
        )
        rejectedCount++
        continue
      }
      this.bridgedUsersByChannel.set(harmonyChannelId, members)
      botChannels.add(harmonyChannelId)
      console.log(`║   📍 ${harmonyChannelId}: ${members.length} Discord users`)
      acceptedCount++
    }
    console.log(`║   accepted=${acceptedCount} rejected=${rejectedCount}`)
    console.log('╚════════════════════════════════════════╝')
  }
  
  /**
   * Clean up bridge data when a bot disconnects
   */
  private cleanupBotBridgeData(botId: string) {
    const botChannels = this.channelsByBot.get(botId)
    if (botChannels) {
      for (const channelId of botChannels) {
        this.bridgedUsersByChannel.delete(channelId)
        console.log(`🗑️ Cleaned up bridged users for channel ${channelId}`)
      }
      this.channelsByBot.delete(botId)
    }
  }
  
  /**
   * Get bridged users for a channel (used by REST API)
   */
  getBridgedUsers(channelId: string): BridgedUser[] {
    return this.bridgedUsersByChannel.get(channelId) || []
  }
  
  /**
   * Check if a channel has bridged users
   */
  hasChannelBridge(channelId: string): boolean {
    return this.bridgedUsersByChannel.has(channelId)
  }
  
  /**
   * Clean up
   */
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    
    // Close all connections
    for (const [ws] of this.connections) {
      ws.close(1000, 'Server shutting down')
    }
    
    this.connections.clear()
    this.bridgedUsersByChannel.clear()
    this.channelsByBot.clear()
    console.log('🛑 WebSocket Gateway shut down')
  }
}

