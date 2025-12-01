import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'

export class EventDispatcher {
  private subscriptions: any[] = []
  private pollingInterval: NodeJS.Timeout | null = null
  private lastProcessedTimestamp: Date = new Date()
  private processedMessageIds: Set<string> = new Set()
  
  // Track message versions for edit detection (includes channel_id for delete dispatch)
  private messageVersions: Map<string, { updated_at: string, content: string, channel_id: string, metadata: any }> = new Map()
  // Track known message IDs for delete detection
  private knownMessageIds: Set<string> = new Set()
  
  constructor(private gateway: WebSocketGateway) {}
  
  async start() {
    console.log('🎯 Starting Event Dispatcher...')
    
    // Initialize known messages for a recent window (for delete detection)
    await this.initializeKnownMessages()
    
    // Use polling for everything - more reliable than Realtime
    this.startPolling()
    
    console.log('✅ Event Dispatcher started with polling mode (creates, edits, deletes)')
  }
  
  private async initializeKnownMessages() {
    // Load recent NON-DELETED messages to track for edits and deletes (last 72 hours)
    const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
    
    const { data: messages } = await supabase
      .from('messages')
      .select('id, updated_at, content, channel_id, metadata')
      .gt('created_at', seventyTwoHoursAgo)
      .eq('is_deleted', false) // Only track non-deleted messages
      .order('created_at', { ascending: false })
      .limit(10000)
    
    if (messages) {
      for (const msg of messages) {
        this.knownMessageIds.add(msg.id)
        this.messageVersions.set(msg.id, { 
          updated_at: msg.updated_at, 
          content: msg.content,
          channel_id: msg.channel_id,
          metadata: msg.metadata
        })
      }
      console.log(`📋 Initialized ${messages.length} known messages for edit/delete tracking (last 72h)`)
    }
  }
  
  private startPolling() {
    console.log('🔄 Starting polling mode for all message events...')
    
    // Poll every second for new messages
    this.pollingInterval = setInterval(async () => {
      await this.pollMessages()
    }, 1000)
    
    // Poll every 2 seconds for edits/deletes (compares cached content vs DB)
    setInterval(async () => {
      await this.pollEditsAndDeletes()
    }, 2000)
  }
  
  private pollCount = 0
  
  private async pollEditsAndDeletes() {
    this.pollCount++
    
    // Log every 10th poll to show it's running
    if (this.pollCount % 10 === 0) {
      console.log(`🔄 pollEditsAndDeletes running (poll #${this.pollCount}, tracking ${this.knownMessageIds.size} messages)`)
    }
    
    try {
      // Only check if we have known messages to track
      if (this.knownMessageIds.size === 0) {
        if (this.pollCount % 10 === 0) console.log('   (no messages to track)')
        return
      }
      
      // Check the NEWEST messages first (most likely to be edited)
      const allIds = Array.from(this.knownMessageIds)
      const idsToCheck = allIds.slice(-100) // Last 100 = newest
      
      const { data: currentMessages, error } = await supabase
        .from('messages')
        .select('id, content, channel_id, user_id, bot_id, metadata, encrypted, updated_at, is_deleted')
        .in('id', idsToCheck)
      
      if (error) {
        console.error('❌ pollEditsAndDeletes error:', error)
        return
      }
      
      // Log comparison details every 5th poll - check ALL messages for changes
      if (this.pollCount % 5 === 0) {
        // Show first few IDs being checked
        console.log(`   Checking IDs: ${idsToCheck.slice(0, 3).map(id => id.substring(0, 8)).join(', ')}... (${idsToCheck.length} total)`)
        console.log(`   DB returned ${currentMessages?.length || 0} messages`)
      }
      
      let changesFound = 0
      let deletesFound = 0
      
      for (const msg of currentMessages || []) {
        const cached = this.messageVersions.get(msg.id)
        
        // Check for soft-deletes (is_deleted = true)
        if (msg.is_deleted && cached) {
          deletesFound++
          console.log(`🗑️ SOFT DELETE detected: ${msg.id} (is_deleted = true)`)
          await this.handleMessageDelete({ 
            old: { 
              id: msg.id, 
              channel_id: msg.channel_id,
              metadata: msg.metadata
            } 
          })
          // Remove from cache
          this.knownMessageIds.delete(msg.id)
          this.messageVersions.delete(msg.id)
          continue
        }
        
        // Check for content changes (edits)
        if (cached && this.contentChanged(cached.content, msg.content)) {
          changesFound++
          console.log(`🔍 EDIT DETECTED in ${msg.id}:`)
          console.log(`   DB type: ${typeof msg.content}, Cache type: ${typeof cached.content}`)
          console.log(`   DB: "${this.contentPreview(msg.content)}"`)
          console.log(`   Cache: "${this.contentPreview(cached.content)}"`)
        }
      }
      
      if (this.pollCount % 5 === 0 && changesFound === 0 && deletesFound === 0) {
        console.log(`   No changes detected`)
      }
      
      const currentById = new Map((currentMessages || []).map(m => [m.id, m]))
      
      for (const id of idsToCheck) {
        const cached = this.messageVersions.get(id)
        const current = currentById.get(id)
        
        if (!current) {
          // Message was DELETED
          if (cached?.channel_id) {
            console.log(`🗑️ Detected message delete: ${id}`)
            await this.handleMessageDelete({ 
              old: { 
                id, 
                channel_id: cached.channel_id,
                metadata: cached.metadata
              } 
            })
          }
          this.knownMessageIds.delete(id)
          this.messageVersions.delete(id)
        } else if (cached && this.contentChanged(cached.content, current.content)) {
          // Message was EDITED (content changed)
          console.log(`📝 Detected message edit: ${id}`)
          console.log(`   old: "${this.contentPreview(cached.content)}"`)
          console.log(`   new: "${this.contentPreview(current.content)}"`)
          console.log(`   channel_id: ${current.channel_id}`)
          
          try {
            await this.handleMessageUpdate({ new: current, old: { id } })
            console.log(`✅ handleMessageUpdate completed for ${id}`)
          } catch (err) {
            console.error(`❌ handleMessageUpdate failed for ${id}:`, err)
          }
          
          // Update cache with new content
          this.messageVersions.set(id, {
            updated_at: current.updated_at,
            content: current.content,
            channel_id: current.channel_id,
            metadata: current.metadata
          })
        }
      }
    } catch (error) {
      console.error('❌ pollEditsAndDeletes exception:', error)
    }
  }
  
  // Helper to safely compare content (handles string, object, null)
  private contentChanged(a: any, b: any): boolean {
    const strA = typeof a === 'string' ? a : JSON.stringify(a)
    const strB = typeof b === 'string' ? b : JSON.stringify(b)
    return strA !== strB
  }
  
  // Helper to get a preview of content for logging
  private contentPreview(content: any): string {
    if (content === null || content === undefined) return '(empty)'
    if (typeof content === 'string') return content.substring(0, 40) + (content.length > 40 ? '...' : '')
    // It's an object/array - stringify and truncate
    const str = JSON.stringify(content)
    return str.substring(0, 40) + (str.length > 40 ? '...' : '')
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
            
            // Add to version cache for edit/delete tracking
            this.knownMessageIds.add(message.id)
            this.messageVersions.set(message.id, {
              updated_at: message.updated_at,
              content: message.content,
              channel_id: message.channel_id,
              metadata: message.metadata
            })
            console.log(`📋 Cached message ${message.id.substring(0, 8)} with content type: ${typeof message.content}`)
            
            // Keep set size reasonable (only keep last 10000 IDs)
            if (this.processedMessageIds.size > 10000) {
              const idsArray = Array.from(this.processedMessageIds);
              this.processedMessageIds = new Set(idsArray.slice(-10000));
            }
            
            // Also prune version cache
            if (this.messageVersions.size > 10000) {
              const entries = Array.from(this.messageVersions.entries());
              const toKeep = entries.slice(-10000);
              this.messageVersions = new Map(toKeep);
              this.knownMessageIds = new Set(toKeep.map(([id]) => id));
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
    
    console.log(`📝 EventDispatcher.handleMessageUpdate called:`, {
      id: message?.id,
      channel_id: message?.channel_id,
      hasContent: !!message?.content
    });
    
    if (!message || !message.id) {
      console.log('⚠️  No message data in payload');
      return
    }
    
    // Skip encrypted messages (bots can't read them)
    if (message.encrypted) {
      console.log('⏭️  Skipping encrypted message');
      return
    }
    
    // Get server ID from channel
    let serverId: string | null = null
    
    if (message.channel_id) {
      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', message.channel_id)
        .single()
      
      if (channelError) {
        console.log('⚠️  Channel lookup error:', channelError.message);
      }
      serverId = channel?.server_id
      console.log(`📍 Channel ${message.channel_id} -> Server ${serverId}`);
    }
    
    if (!serverId) {
      console.log('⚠️  No server ID found, skipping dispatch');
      return
    }
    
    // Get bots with permissions in this server
    const { data: botPermissions, error: permError } = await supabase
      .from('bot_server_permissions')
      .select('bot_id, read_messages')
      .eq('server_id', serverId)
      .eq('read_messages', true)
      .eq('is_active', true)
    
    if (permError) {
      console.log('⚠️  Permission lookup error:', permError.message);
    }
    
    console.log(`🔍 Found ${botPermissions?.length || 0} bots with read_messages permission`);
    
    if (!botPermissions || botPermissions.length === 0) {
      console.log('⚠️  No bots have permission, skipping dispatch');
      return
    }
    
    // Format and dispatch event
    const formattedMessage = await this.formatMessage(message)
    const event = {
      op: 0,
      t: 'MESSAGE_UPDATE',
      d: formattedMessage
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    console.log(`📤 Sending MESSAGE_UPDATE to bots:`, botIds);
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`✅ Dispatched MESSAGE_UPDATE to ${botIds.length} bots`)
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
   * Uses PUBLIC_URL for external-facing URLs (for Discord, ActivityPub, etc.)
   */
  private formatAvatarUrl(avatarPath: string | null | undefined): string | undefined {
    if (!avatarPath) return undefined
    
    // If already a full URL, return as-is
    if (avatarPath.startsWith('http://') || avatarPath.startsWith('https://')) {
      return avatarPath
    }
    
    // Use PUBLIC_URL for external-facing resources, fallback to SUPABASE_URL
    const publicUrl = process.env.PUBLIC_URL || process.env.SUPABASE_URL
    if (!publicUrl) {
      console.warn('PUBLIC_URL or SUPABASE_URL not set, cannot construct avatar URL')
      return undefined
    }
    
    // Remove leading slash if present
    const cleanPath = avatarPath.startsWith('/') ? avatarPath.slice(1) : avatarPath
    
    // Construct full URL with image optimization params
    return `${publicUrl}/storage/v1/render/image/public/avatars/${cleanPath}?width=256&height=256&resize=contain&quality=80`
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
