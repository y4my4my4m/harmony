import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'

export class EventDispatcher {
  private subscriptions: any[] = []
  private pollingInterval: NodeJS.Timeout | null = null
  private lastProcessedTimestamp: Date = new Date()
  private processedMessageIds: Set<string> = new Set()
  
  constructor(private gateway: WebSocketGateway) {}
  
  async start() {
    console.log('🎯 Starting Event Dispatcher...')
    
    // Use polling instead of realtime subscriptions for local development
    // This is more reliable with local Supabase and service role
    this.startPolling()
    this.startRealtimeSubscriptions()
    
    console.log('✅ Event Dispatcher started with polling mode + realtime for edits/deletes')
  }
  
  private startPolling() {
    console.log('🔄 Starting polling mode for message events (every 1 second)...')
    
    // Poll every second for new messages
    this.pollingInterval = setInterval(async () => {
      await this.pollMessages()
    }, 1000)
  }
  
  private startRealtimeSubscriptions() {
    console.log('🔄 Starting realtime subscriptions for message updates/deletes...')
    
    // Subscribe to message updates
    const updateChannel = supabase
      .channel('bot-message-updates')
      .on('postgres_changes', 
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => this.handleMessageUpdate(payload)
      )
      .subscribe()
    
    // Subscribe to message deletes
    const deleteChannel = supabase
      .channel('bot-message-deletes')
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages' },
        (payload) => this.handleMessageDelete(payload)
      )
      .subscribe()
    
    this.subscriptions.push(updateChannel, deleteChannel)
  }
  
  private async pollMessages() {
    try {
      // Get messages created since last check
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .gt('created_at', this.lastProcessedTimestamp.toISOString())
        .order('created_at', { ascending: true })
        .limit(50)
      
      if (error) {
        console.error('❌ Error polling messages:', error)
        return
      }
      
      if (messages && messages.length > 0) {
        // Only log if we have NEW unprocessed messages
        const newMessages = messages.filter(m => !this.processedMessageIds.has(m.id))
        
        if (newMessages.length > 0) {
          console.log(`📨 Polled ${newMessages.length} new messages`)
          
          for (const message of newMessages) {
            await this.handleMessageCreate({ new: message })
            this.processedMessageIds.add(message.id)
            this.lastProcessedTimestamp = new Date(message.created_at)
            
            // Keep set size reasonable (only keep last 1000 IDs)
            if (this.processedMessageIds.size > 1000) {
              const idsArray = Array.from(this.processedMessageIds);
              this.processedMessageIds = new Set(idsArray.slice(-1000));
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ Polling error:', error)
    }
  }
  
  async handleMessageCreate(payload: any) {
    const message = payload.new
    
    console.log(`🔔 EventDispatcher: Message received`, {
      id: message.id,
      channel_id: message.channel_id,
      user_id: message.user_id,
      bot_id: message.bot_id,
      encrypted: message.encrypted
    });
    
    // Skip encrypted messages (bots can't read them)
    if (message.encrypted) {
      console.log('⏭️  Skipping encrypted message');
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
      console.log(`📍 Channel lookup: channel_id=${message.channel_id}, server_id=${serverId}`);
    }
    
    if (!serverId) {
      console.log('⚠️  No server ID found, skipping dispatch');
      return
    }
    
    // Get bots with permissions in this server
    const { data: botPermissions } = await supabase
      .from('bot_server_permissions')
      .select('bot_id, read_messages')
      .eq('server_id', serverId)
      .eq('read_messages', true)
      .eq('is_active', true)
    
    console.log(`🔍 Found ${botPermissions?.length || 0} bots with read_messages permission in server ${serverId}`);
    
    if (!botPermissions || botPermissions.length === 0) {
      console.log('⚠️  No bots have permission to read messages in this server');
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
    
    console.log(`📨 Dispatched MESSAGE_CREATE to ${botIds.length} bots:`, botIds)
  }
  
  private async handleMessageUpdate(payload: any) {
    const message = payload.new
    
    console.log(`📝 EventDispatcher: Message updated`, {
      id: message.id,
      channel_id: message.channel_id
    });
    
    // Skip encrypted messages (bots can't read them)
    if (message.encrypted) {
      console.log('⏭️  Skipping encrypted message');
      return
    }
    
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
    
    if (!serverId) {
      console.log('⚠️  No server ID found, skipping dispatch');
      return
    }
    
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
      t: 'MESSAGE_UPDATE',
      d: await this.formatMessage(message)
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`📨 Dispatched MESSAGE_UPDATE to ${botIds.length} bots`)
  }
  
  private async handleMessageDelete(payload: any) {
    const message = payload.old
    
    console.log(`🗑️ EventDispatcher: Message deleted`, {
      id: message.id,
      channel_id: message.channel_id
    });
    
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
    
    if (!serverId) {
      console.log('⚠️  No server ID found, skipping dispatch');
      return
    }
    
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
      t: 'MESSAGE_DELETE',
      d: {
        id: message.id,
        channel_id: message.channel_id,
        metadata: message.metadata
      }
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`📨 Dispatched MESSAGE_DELETE to ${botIds.length} bots`)
  }
  
  // =====================================================
  // FORMATTERS
  // =====================================================
  
  /**
   * Convert a relative avatar path to a full URL
   * Handles both Supabase storage paths and external URLs
   */
  private formatAvatarUrl(avatarPath: string | null | undefined): string | undefined {
    if (!avatarPath) return undefined
    
    // If already a full URL, return as-is
    if (avatarPath.startsWith('http://') || avatarPath.startsWith('https://')) {
      return avatarPath
    }
    
    // If it's a relative path, construct the full Supabase storage URL
    const supabaseUrl = process.env.SUPABASE_URL
    if (!supabaseUrl) {
      console.warn('SUPABASE_URL not set, cannot construct avatar URL')
      return undefined
    }
    
    // Remove leading slash if present
    const cleanPath = avatarPath.startsWith('/') ? avatarPath.slice(1) : avatarPath
    
    // Construct full URL with image optimization params
    return `${supabaseUrl}/storage/v1/render/image/public/avatars/${cleanPath}?width=256&height=256&resize=contain&quality=80`
  }
  
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
        avatar: this.formatAvatarUrl(data.avatar_url),
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
          avatar: discordUser.avatar_url, // Discord URLs are already complete
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
          avatar: this.formatAvatarUrl(data.avatar_url),
          bot: true
        } : null
      }
    }
    
    return {
      id: message.id,
      channel_id: message.channel_id,
      author,
      content: this.contentToText(message.content),
      content_raw: message.content, // Also include raw content for debugging
      timestamp: message.created_at,
      edited_timestamp: message.updated_at,
      mentions: this.extractMentions(message.content),
      metadata: message.metadata // Include metadata in event
    }
  }
  
  private contentToText(content: any): string {
    console.log('🔍 contentToText input:', JSON.stringify(content).substring(0, 200));
    
    if (typeof content === 'string') {
      console.log('✅ Content is string:', content);
      return content
    }
    
    if (Array.isArray(content)) {
      const textParts = content
        .filter(part => part && part.type === 'text')
        .map(part => part.text || part.value || '')
        .join(' ')
        .trim()
      
      console.log(`✅ Extracted text from ${content.length} parts: "${textParts}"`);
      return textParts
    }
    
    console.log('⚠️ Content is neither string nor array, returning empty');
    return ''
  }
  
  private extractMentions(content: any): string[] {
    if (!Array.isArray(content)) return []
    
    return content
      .filter(part => part.type === 'mention')
      .map(part => part.user_id)
      .filter(Boolean)
  }
  
  // =====================================================
  // SHUTDOWN
  // =====================================================
  
  async shutdown() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
    }
    
    for (const channel of this.subscriptions) {
      await channel.unsubscribe()
    }
    this.subscriptions = []
    console.log('🛑 Event Dispatcher shut down')
  }
}
