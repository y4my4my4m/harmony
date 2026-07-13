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
              // Fire-and-forget: unhandled rejection would crash the worker (BUGS.md M47).
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
        
        this.cleanupBotBridgeData(botConnection.botId)
        
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
    
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
    
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
    
    await supabase
      .from('bot_presence')
      .upsert({
        bot_id: botConnection.botId,
        status: 'online',
        connected_at: new Date().toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        gateway_session_id: botConnection.sessionId
      })
    
    await supabase
      .from('bots')
      .update({ last_online_at: new Date().toISOString() })
      .eq('id', botConnection.botId)
    
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
    
    ws.send(JSON.stringify({ op: 11 }))
    
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
    
    console.log(`📣 Broadcast event to ${sent} bots`)
  }
  
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
  
  // BUGS.md H40: a malicious bot token could inject fake member lists into
  // bridgedUsersByChannel for channels in servers it isn't installed on. For
  // each harmonyChannelId, resolve channels.server_id and require an active
  // bot_server_permissions row for that server; failing channels are dropped.
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
    
    if (!this.channelsByBot.has(botConnection.botId)) {
      this.channelsByBot.set(botConnection.botId, new Set())
    }
    const botChannels = this.channelsByBot.get(botConnection.botId)!

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
  
  getBridgedUsers(channelId: string): BridgedUser[] {
    return this.bridgedUsersByChannel.get(channelId) || []
  }

  /**
   * Merged bridged users for all mapped channels on a server (deduped by Discord id).
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
    
    for (const [ws] of this.connections) {
      ws.close(1000, 'Server shutting down')
    }
    
    this.connections.clear()
    this.bridgedUsersByChannel.clear()
    this.channelsByBot.clear()
    console.log('🛑 WebSocket Gateway shut down')
  }
}

