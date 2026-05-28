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
  /**
   * BUGS.md H39: gate the auto-reconnect on `close` so a manual `disconnect()`
   * (called from the bridge's `shutdown()` path) does not immediately schedule
   * another `connect()` and resurrect the WebSocket. Without this flag the
   * shutdown path would loop reconnect timers forever.
   */
  private reconnectEnabled: boolean = true
  private reconnectTimer: NodeJS.Timeout | null = null
  
  constructor(botToken: string, gatewayUrl: string = 'ws://localhost:3002/gateway', apiUrl: string = 'http://localhost:3002') {
    super()
    this.botToken = botToken
    this.gatewayUrl = gatewayUrl
    this.apiUrl = apiUrl
  }
  
  async connect() {
    console.log('🔌 Connecting to Harmony gateway...')

    // A new explicit connect() implies we want auto-reconnect again; clear
    // any pending timer from a previous disconnect cycle.
    this.reconnectEnabled = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

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
      if (!this.reconnectEnabled) {
        console.log('   ↳ reconnect disabled (intentional shutdown)')
        return
      }
      // Reconnect after 5 seconds
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (this.reconnectEnabled) {
          this.connect().catch(err => console.error('❌ Reconnect failed:', err))
        }
      }, 5000)
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
    // Check if this is a READY event (could be in different formats)
    if (payload.t === 'READY' || payload.type === 'READY') {
      this.sessionId = payload.d.session_id
      console.log('✅ Harmony bot ready:', payload.d.bot.username)
      this.emit('ready', payload.d)
      
      // Start heartbeat
      const interval = payload.d.heartbeat_interval || 30000
      this.startHeartbeat(interval)
      return
    }
    
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
    }
  }
  
  private handleEvent(eventType: string, data: any) {
    switch (eventType) {
      case 'MESSAGE_CREATE':
        this.emit('messageCreate', data as HarmonyMessage)
        break
        
      case 'MESSAGE_UPDATE':
        console.log('📡 HarmonyClient received MESSAGE_UPDATE:', data?.id)
        this.emit('messageUpdate', data)
        break
        
      case 'MESSAGE_DELETE':
        console.log('📡 HarmonyClient received MESSAGE_DELETE:', data?.id)
        this.emit('messageDelete', data)
        break
        
      case 'MESSAGE_REACTION_ADD':
        this.emit('reactionAdd', data)
        break
        
      case 'MESSAGE_REACTION_REMOVE':
        this.emit('reactionRemove', data)
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
  
  async sendMessage(
    channelId: string,
    content: string | any[],
    metadata?: any,
    replyTo?: string | null,
  ): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content,
        metadata,
        reply_to: replyTo || undefined,
      })
    })

    if (!response.ok) {
      const errorData = await response.json() as any
      throw new Error(errorData.error || 'Failed to send message')
    }

    return response.json()
  }

  // ---------------------------------------------------------------------------
  // Server structure: categories + channels.
  // Used by the bridge's `/bridge clone-server` and `/bridge link` commands.
  // The bot must have `manage_channels` on the target server (granted at
  // install time by the owner) for these to succeed; the gateway enforces it.
  // ---------------------------------------------------------------------------

  async getServerInfo(serverId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/servers/${serverId}`, {
      headers: { 'Authorization': `Bot ${this.botToken}` }
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch server info: ${response.status}`)
    }
    return response.json()
  }

  async getServerChannels(serverId: string): Promise<any[]> {
    const response = await fetch(`${this.apiUrl}/api/v1/servers/${serverId}/channels`, {
      headers: { 'Authorization': `Bot ${this.botToken}` }
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch server channels: ${response.status}`)
    }
    return response.json() as Promise<any[]>
  }

  async getServerCategories(serverId: string): Promise<any[]> {
    const response = await fetch(`${this.apiUrl}/api/v1/servers/${serverId}/categories`, {
      headers: { 'Authorization': `Bot ${this.botToken}` }
    })
    if (!response.ok) {
      throw new Error(`Failed to fetch server categories: ${response.status}`)
    }
    return response.json() as Promise<any[]>
  }

  async createCategory(serverId: string, name: string, order: number = 0): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/servers/${serverId}/categories`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, order })
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as any
      throw new Error(errorData.error || `Failed to create category (${response.status})`)
    }
    return response.json()
  }

  async createChannel(
    serverId: string,
    opts: {
      name: string
      type?: 0 | 1
      categoryId?: string | null
      description?: string | null
      order?: number
    },
  ): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/servers/${serverId}/channels`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: opts.name,
        type: opts.type ?? 0,
        category_id: opts.categoryId ?? null,
        description: opts.description ?? null,
        order: opts.order ?? 0,
      })
    })
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as any
      throw new Error(errorData.error || `Failed to create channel (${response.status})`)
    }
    return response.json()
  }
  
  async editMessage(messageId: string, content: string | any[]): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content })
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as any
      throw new Error(errorData.error || 'Failed to edit message')
    }
    
    return response.json()
  }
  
  async deleteMessage(messageId: string): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/messages/${messageId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bot ${this.botToken}`
      }
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as any
      throw new Error(errorData.error || 'Failed to delete message')
    }
    
    // DELETE returns 204 No Content on success
    if (response.status === 204) {
      return { success: true }
    }
    
    return response.json()
  }
  
  async addReaction(channelId: string, messageId: string, emoji: string, metadata?: any): Promise<any> {
    const response = await fetch(`${this.apiUrl}/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ metadata: metadata || null })
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as any
      throw new Error(errorData.error || 'Failed to add reaction')
    }
    
    // API returns 204 No Content on success
    if (response.status === 204) {
      return { success: true }
    }
    
    return response.json()
  }
  
  /**
   * Find or create a Discord custom emoji in Harmony
   * Returns the Harmony emoji ID
   * Uses the same approach as ActivityPub remote emoji handling
   */
  async findOrCreateDiscordEmoji(
    emojiName: string,
    discordEmojiId: string,
    isAnimated: boolean = false,
    botId: string
  ): Promise<string | null> {
    try {
      // Build the Discord CDN URL
      const discordEmojiUrl = `https://cdn.discordapp.com/emojis/${discordEmojiId}.${isAnimated ? 'gif' : 'png'}`
      const cleanName = emojiName.replace(/:/g, '') // Remove colons (same as ActivityPub)
      
      console.log(`🔍 Looking for existing emoji with URL: ${discordEmojiUrl}`)
      
      // Check if emoji already exists by URL (same as ActivityPub does)
      // We'll make a direct supabase check via the API
      const checkResponse = await fetch(`${this.apiUrl}/api/v1/emojis?url=${encodeURIComponent(discordEmojiUrl)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bot ${this.botToken}`
        }
      })
      
      if (checkResponse.ok) {
        const emojis = await checkResponse.json() as any[]
        if (emojis && emojis.length > 0) {
          console.log(`♻️  Using existing Discord emoji: ${cleanName} (${emojis[0].id})`)
          return emojis[0].id
        }
      }
      
      // Emoji doesn't exist - create it just like ActivityPub does
      console.log(`➕ Creating new Discord emoji entry: ${cleanName}`)
      
      // Create emoji via bot API
      const createResponse = await fetch(`${this.apiUrl}/api/v1/emojis`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: cleanName,
          url: discordEmojiUrl,
          server_id: null, // Global/federated emoji (same as ActivityPub)
          uploader: botId,
          domain: 'discord.com' // Mark as Discord emoji
        })
      })
      
      if (!createResponse.ok) {
        const errorData = await createResponse.json().catch(() => ({})) as any
        console.error(`❌ Failed to create Discord emoji: ${errorData.error || 'Unknown error'}`)
        return null
      }
      
      const newEmoji = await createResponse.json() as any
      console.log(`✨ Created Discord emoji: ${cleanName} (ID: ${newEmoji.id})`)
      return newEmoji.id
    } catch (error: any) {
      console.error(`❌ Error finding/creating Discord emoji:`, error)
      return null
    }
  }

  
  async removeReaction(channelId: string, messageId: string, emoji: string, _userId?: string): Promise<any> {
    // Note: Bot API doesn't need channelId or userId - bot removes its own reaction
    const url = `${this.apiUrl}/api/v1/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`
    
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bot ${this.botToken}`,
        'Content-Type': 'application/json'
      }
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as any
      throw new Error(errorData.error || 'Failed to remove reaction')
    }
    
    // API returns 204 No Content on success
    if (response.status === 204) {
      return { success: true }
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
    
    return response.json() as Promise<any[]>
  }
  
  /**
   * Load recent messages for a channel to restore message ID mappings
   * This is called on startup to restore mappings for recent messages
   */
  async loadRecentMessages(channelId: string, limit: number = 100): Promise<any[]> {
    const response = await fetch(`${this.apiUrl}/api/v1/channels/${channelId}/messages?limit=${limit}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bot ${this.botToken}`
      }
    })
    
    if (!response.ok) {
      console.error('Failed to fetch recent messages')
      return []
    }
    
    return response.json() as Promise<any[]>
  }
  
  /**
   * Register bridge data with the gateway
   * This sends channel mappings and Discord member data to the gateway
   * so the frontend can query bridged users for autosuggest
   */
  registerBridgeData(channels: Array<{
    harmonyChannelId: string
    discordChannelId: string
    members: Array<{
      id: string
      username: string
      displayName: string
      avatarUrl: string
      source: 'discord'
    }>
  }>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Cannot register bridge data - WebSocket not connected')
      console.error(`   WebSocket state: ${this.ws?.readyState}`)
      return
    }
    
    const totalMembers = channels.reduce((sum, ch) => sum + ch.members.length, 0)
    console.log(`📡 Sending REGISTER_BRIDGE_DATA to gateway:`)
    console.log(`   Channels: ${channels.length}`)
    console.log(`   Total members: ${totalMembers}`)
    
    const payload = {
      op: 6, // REGISTER_BRIDGE_DATA
      d: { channels }
    }
    
    this.ws.send(JSON.stringify(payload))
    console.log(`✅ Bridge data sent to gateway`)
  }
  
  disconnect() {
    // Disable auto-reconnect BEFORE closing - the `close` event handler reads
    // `reconnectEnabled` to decide whether to schedule another connect attempt.
    this.reconnectEnabled = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.cleanup()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }
}

