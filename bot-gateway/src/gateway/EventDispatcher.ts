import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'

export class EventDispatcher {
  private subscriptions: any[] = []
  
  constructor(private gateway: WebSocketGateway) {}
  
  async start() {
    console.log('🎯 Starting Event Dispatcher...')
    
    // Subscribe to message events
    this.subscribeToMessages()
    
    // Subscribe to member events
    this.subscribeToMemberEvents()
    
    // Subscribe to channel events
    this.subscribeToChannelEvents()
    
    console.log('✅ Event Dispatcher started')
  }
  
  private subscribeToMessages() {
    const channel = supabase
      .channel('bot_message_events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        this.handleMessageCreate.bind(this)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        this.handleMessageUpdate.bind(this)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages' },
        this.handleMessageDelete.bind(this)
      )
      .subscribe()
    
    this.subscriptions.push(channel)
    console.log('📬 Subscribed to message events')
  }
  
  private subscribeToMemberEvents() {
    const channel = supabase
      .channel('bot_member_events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'server_members' },
        this.handleMemberJoin.bind(this)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'server_members' },
        this.handleMemberLeave.bind(this)
      )
      .subscribe()
    
    this.subscriptions.push(channel)
    console.log('👥 Subscribed to member events')
  }
  
  private subscribeToChannelEvents() {
    const channel = supabase
      .channel('bot_channel_events')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'channels' },
        this.handleChannelCreate.bind(this)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'channels' },
        this.handleChannelUpdate.bind(this)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'channels' },
        this.handleChannelDelete.bind(this)
      )
      .subscribe()
    
    this.subscriptions.push(channel)
    console.log('📺 Subscribed to channel events')
  }
  
  // =====================================================
  // MESSAGE EVENTS
  // =====================================================
  
  private async handleMessageCreate(payload: any) {
    const message = payload.new
    
    // Skip encrypted messages (bots can't read them)
    if (message.encrypted) {
      return
    }
    
    // Note: We DO dispatch bot messages so other bots can see them
    // Each bot should filter out its own messages using the author.id
    
    // Get server ID from channel
    let serverId: string | null = null
    
    if (message.channel_id) {
      const { data: channel } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', message.channel_id)
        .single()
      
      serverId = channel?.server_id
    }
    
    if (!serverId) return
    
    // Get bots with permissions in this server
    const { data: botPermissions } = await supabase
      .from('bot_server_permissions')
      .select('bot_id, read_messages')
      .eq('server_id', serverId)
      .eq('read_messages', true)
      .eq('is_active', true)
    
    if (!botPermissions || botPermissions.length === 0) {
      return
    }
    
    // Format and dispatch event
    const event = {
      op: 0,
      t: 'MESSAGE_CREATE',
      d: await this.formatMessage(message)
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`📨 Dispatched MESSAGE_CREATE to ${botIds.length} bots`)
  }
  
  private async handleMessageUpdate(payload: any) {
    const message = payload.new
    
    // Similar logic to CREATE
    // ... (implementation similar to above)
  }
  
  private async handleMessageDelete(payload: any) {
    const message = payload.old
    
    // Similar logic to CREATE
    // ... (implementation similar to above)
  }
  
  // =====================================================
  // MEMBER EVENTS
  // =====================================================
  
  private async handleMemberJoin(payload: any) {
    const membership = payload.new
    
    const { data: botPermissions } = await supabase
      .from('bot_server_permissions')
      .select('bot_id')
      .eq('server_id', membership.server_id)
      .eq('is_active', true)
    
    if (!botPermissions || botPermissions.length === 0) return
    
    const event = {
      op: 0,
      t: 'MEMBER_JOIN',
      d: {
        guild_id: membership.server_id,
        user_id: membership.user_id,
        joined_at: membership.created_at
      }
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`👋 Dispatched MEMBER_JOIN to ${botIds.length} bots`)
  }
  
  private async handleMemberLeave(payload: any) {
    const membership = payload.old
    
    const { data: botPermissions } = await supabase
      .from('bot_server_permissions')
      .select('bot_id')
      .eq('server_id', membership.server_id)
      .eq('is_active', true)
    
    if (!botPermissions || botPermissions.length === 0) return
    
    const event = {
      op: 0,
      t: 'MEMBER_LEAVE',
      d: {
        guild_id: membership.server_id,
        user_id: membership.user_id
      }
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
  }
  
  // =====================================================
  // CHANNEL EVENTS
  // =====================================================
  
  private async handleChannelCreate(payload: any) {
    const channel = payload.new
    
    const { data: botPermissions } = await supabase
      .from('bot_server_permissions')
      .select('bot_id, view_channels')
      .eq('server_id', channel.server_id)
      .eq('view_channels', true)
      .eq('is_active', true)
    
    if (!botPermissions || botPermissions.length === 0) return
    
    const event = {
      op: 0,
      t: 'CHANNEL_CREATE',
      d: this.formatChannel(channel)
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
  }
  
  private async handleChannelUpdate(payload: any) {
    // Similar to CREATE
  }
  
  private async handleChannelDelete(payload: any) {
    // Similar to CREATE
  }
  
  // =====================================================
  // FORMATTERS
  // =====================================================
  
  private async formatMessage(message: any) {
    // Get author info - could be user or bot
    let author = null
    
    if (message.user_id) {
      // User message
      const { data } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', message.user_id)
        .single()
      
      author = data ? {
        id: data.id,
        username: data.username,
        display_name: data.display_name,
        avatar: data.avatar_url,
        bot: false
      } : null
    } else if (message.bot_id) {
      // Bot message - check if it has Discord user metadata
      if (message.metadata?.discord_user) {
        // Use Discord user info for author
        const discordUser = message.metadata.discord_user
        author = {
          id: discordUser.id,
          username: discordUser.username,
          display_name: discordUser.display_name,
          avatar: discordUser.avatar_url,
          bot: false, // Treat as regular user for display
          discord_user: true
        }
      } else {
        // Regular bot message
        const { data } = await supabase
          .from('bots')
          .select('id, username, display_name, avatar_url')
          .eq('id', message.bot_id)
          .single()
        
        author = data ? {
          id: data.id,
          username: data.username,
          display_name: data.display_name,
          avatar: data.avatar_url,
          bot: true
        } : null
      }
    }
    
    return {
      id: message.id,
      channel_id: message.channel_id,
      author,
      content: this.contentToText(message.content),
      timestamp: message.created_at,
      edited_timestamp: message.updated_at,
      mentions: this.extractMentions(message.content),
      metadata: message.metadata // Include metadata in event
    }
  }
  
  private contentToText(content: any): string {
    if (typeof content === 'string') return content
    
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text')
        .map(part => part.value || '')
        .join(' ')
    }
    
    return ''
  }
  
  private extractMentions(content: any): string[] {
    if (!Array.isArray(content)) return []
    
    return content
      .filter(part => part.type === 'mention')
      .map(part => part.user_id)
      .filter(Boolean)
  }
  
  private formatChannel(channel: any) {
    return {
      id: channel.id,
      guild_id: channel.server_id,
      name: channel.name,
      type: channel.type,
      position: channel.position,
      parent_id: channel.parent_id
    }
  }
  
  // =====================================================
  // SHUTDOWN
  // =====================================================
  
  async shutdown() {
    for (const channel of this.subscriptions) {
      await channel.unsubscribe()
    }
    this.subscriptions = []
    console.log('🛑 Event Dispatcher shut down')
  }
}

