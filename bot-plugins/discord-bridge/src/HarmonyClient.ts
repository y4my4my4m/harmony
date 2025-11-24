import { WebSocket } from 'ws'
import { EventEmitter } from 'events'

interface HarmonyMessage {
  id: string
  channel_id: string
  author: {
    id: string
    username: string
    avatar?: string
  }
  content: string
  timestamp: string
}

export class HarmonyClient extends EventEmitter {
  private ws: WebSocket | null = null
  private botToken: string
  private gatewayUrl: string
  private apiUrl: string
  private heartbeatInterval: NodeJS.Timeout | null = null
  private sessionId: string | null = null
  
  constructor(botToken: string, gatewayUrl: string = 'ws://localhost:3002/gateway', apiUrl: string = 'http://localhost:3002') {
    super()
    this.botToken = botToken
    this.gatewayUrl = gatewayUrl
    this.apiUrl = apiUrl
  }
  
  async connect() {
    console.log('🔌 Connecting to Harmony gateway...')
    
    this.ws = new WebSocket(this.gatewayUrl)
    
    this.ws.on('open', () => {
      console.log('✅ Connected to Harmony gateway')
      this.identify()
    })
    
    this.ws.on('message', (data) => {
      const payload = JSON.parse(data.toString())
      this.handlePayload(payload)
    })
    
    this.ws.on('close', () => {
      console.log('🔌 Disconnected from Harmony gateway')
      this.cleanup()
      // Reconnect after 5 seconds
      setTimeout(() => this.connect(), 5000)
    })
    
    this.ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error)
    })
  }
  
  private identify() {
    if (!this.ws) return
    
    this.ws.send(JSON.stringify({
      op: 2, // IDENTIFY
      d: {
        token: this.botToken
      }
    }))
  }
  
  private handlePayload(payload: any) {
    switch (payload.op) {
      case 0: // DISPATCH
        this.handleEvent(payload.t, payload.d)
        break
        
      case 10: // HELLO (if implemented)
        if (payload.d?.heartbeat_interval) {
          this.startHeartbeat(payload.d.heartbeat_interval)
        }
        break
        
      case 11: // HEARTBEAT_ACK
        // Heartbeat acknowledged
        break
        
      default:
        if (payload.t === 'READY') {
          this.sessionId = payload.d.session_id
          console.log('✅ Harmony bot ready:', payload.d.bot.username)
          this.emit('ready', payload.d)
          
          // Start heartbeat
          const interval = payload.d.heartbeat_interval || 30000
          this.startHeartbeat(interval)
        }
    }
  }
  
  private handleEvent(eventType: string, data: any) {
    switch (eventType) {
      case 'MESSAGE_CREATE':
        this.emit('messageCreate', data as HarmonyMessage)
        break
        
      case 'MESSAGE_UPDATE':
        this.emit('messageUpdate', data)
        break
        
      case 'MESSAGE_DELETE':
        this.emit('messageDelete', data)
        break
        
      case 'MEMBER_JOIN':
        this.emit('memberJoin', data)
        break
        
      case 'MEMBER_LEAVE':
        this.emit('memberLeave', data)
        break
        
      default:
        console.log(`📨 Unhandled event: ${eventType}`)
    }
  }
  
  private startHeartbeat(interval: number) {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1 })) // HEARTBEAT
      }
    }, interval)
  }
  
  private cleanup() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.sessionId = null
  }
  
  // REST API Methods
  
  async sendMessage(channelId: string, content: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    })
    
    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || 'Failed to send message')
    }
    
    return response.json()
  }
  
  async getGuildMembers(guildId: string): Promise<any[]> {
    const response = await fetch(`${this.apiUrl}/api/v1/guilds/${guildId}/members`, {
      method: 'GET',
      headers: {
        'Authorization': `Bot ${this.botToken}`
      }
    })
    
    if (!response.ok) {
      throw new Error('Failed to fetch guild members')
    }
    
    return response.json()
  }
  
  disconnect() {
    this.cleanup()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

