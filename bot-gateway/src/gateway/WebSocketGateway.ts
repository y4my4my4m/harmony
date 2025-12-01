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
              this.handleBridgeDataRegistration(botConnection, payload.d)
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
    
    for (const [ws, conn] of this.connections) {
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
   * Handle bridge data registration from Discord bridge
   */
  private handleBridgeDataRegistration(botConnection: BotConnection, data: any) {
    if (!data.channels || !Array.isArray(data.channels)) {
      console.warn('⚠️ Invalid bridge data registration - missing channels array')
      return
    }
    
    console.log(`🌉 Registering bridge data from ${botConnection.username}`)
    
    // Track channels registered by this bot
    if (!this.channelsByBot.has(botConnection.botId)) {
      this.channelsByBot.set(botConnection.botId, new Set())
    }
    const botChannels = this.channelsByBot.get(botConnection.botId)!
    
    for (const channelData of data.channels) {
      const { harmonyChannelId, members } = channelData
      
      if (harmonyChannelId && Array.isArray(members)) {
        this.bridgedUsersByChannel.set(harmonyChannelId, members)
        botChannels.add(harmonyChannelId)
        console.log(`📝 Registered ${members.length} bridged users for channel ${harmonyChannelId}`)
      }
    }
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

