import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'
import { TTLCache } from '../utils/TTLCache.js'

// Cached bot-permission row. Only the fields downstream code reads.
interface BotPermissionRow {
  bot_id: string
  read_messages: boolean | null
}

// ---------------------------------------------------------------------------
// Per-message DB amplification was the dominant cost of message dispatch
// before these caches were added (see BUGS.md PC1). Each handled message
// previously issued TWO additional DB queries (channel → server, then
// server → bot permissions) - three handlers (create/update/delete) ×
// N messages = O(N) queries on top of the polling baseline.
//
// channel.server_id rarely changes (channels are moved between servers
// only via admin actions). 1 hour TTL is generous; in practice the cache
// stays warm for the life of the gateway.
//
// bot_server_permissions changes when an admin edits bot permissions or
// activates/deactivates a bot. 5 minutes is a safe ceiling for staleness
// for what's effectively a read-mostly access control list.
// ---------------------------------------------------------------------------
const CHANNEL_TO_SERVER_TTL_MS = 60 * 60 * 1000
const CHANNEL_TO_SERVER_MAX = 10_000
const BOT_PERMISSIONS_TTL_MS = 5 * 60 * 1000
const BOT_PERMISSIONS_MAX = 1_000

export class EventDispatcher {
  private subscriptions: any[] = []
  private pollingInterval: NodeJS.Timeout | null = null
  private editPollingInterval: NodeJS.Timeout | null = null
  private reactionPollingInterval: NodeJS.Timeout | null = null
  private lastProcessedTimestamp: Date = new Date()
  private lastReactionTimestamp: Date = new Date()
  private processedMessageIds: Set<string> = new Set()

  // Reaction add/remove tracking. Reactions are hard-deleted, so (like message
  // deletes) we detect removals by diffing a window of known reaction IDs
  // against what currently exists.
  private knownReactionIds: Set<string> = new Set()
  private reactionContext: Map<string, { channel_id: string | null, message_id: string }> = new Map()
  // emoji_id -> shortcode name (for custom emoji reactions). Read-mostly.
  private emojiNameCache = new TTLCache<string, string | null>(5_000, 30 * 60 * 1000)
  
  // Track message versions for edit detection (includes channel_id for delete dispatch)
  private messageVersions: Map<string, { updated_at: string, content: string, channel_id: string, metadata: any }> = new Map()
  // Track known message IDs for delete detection
  private knownMessageIds: Set<string> = new Set()

  // Read-mostly lookup caches - see CHANNEL_TO_SERVER_TTL_MS comment above.
  // A null value is cached too so we don't repeatedly look up channels that
  // have been deleted or are inaccessible.
  private channelToServerCache = new TTLCache<string, string | null>(
    CHANNEL_TO_SERVER_MAX,
    CHANNEL_TO_SERVER_TTL_MS,
  )
  private botPermissionsCache = new TTLCache<string, BotPermissionRow[]>(
    BOT_PERMISSIONS_MAX,
    BOT_PERMISSIONS_TTL_MS,
  )
  // Author (user OR bot) lookup cache. Username/display_name/avatar are
  // read-mostly; a 10-minute staleness ceiling is acceptable for bot
  // event dispatch and saves one DB roundtrip per message.
  private authorCache = new TTLCache<string, {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    isBot: boolean
  } | null>(5_000, 10 * 60 * 1000)
  
  constructor(private gateway: WebSocketGateway) {}
  
  async start() {
    console.log('🎯 Starting Event Dispatcher...')
    
    // Initialize known messages for a recent window (for delete detection)
    await this.initializeKnownMessages()
    await this.initializeKnownReactions()
    
    // Use polling for everything - more reliable than Realtime
    this.startPolling()
    
    console.log('✅ Event Dispatcher started with polling mode (creates, edits, deletes, reactions)')
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
    // Tracked so shutdown can clear it (previously this handle leaked).
    this.editPollingInterval = setInterval(async () => {
      await this.pollEditsAndDeletes()
    }, 2000)

    // Poll every 2 seconds for reaction add/remove so bots (and the Discord
    // bridge) get MESSAGE_REACTION_ADD / MESSAGE_REACTION_REMOVE events.
    this.reactionPollingInterval = setInterval(async () => {
      await this.pollReactions()
    }, 2000)
  }

  // ---------------------------------------------------------------------
  // Reactions
  // ---------------------------------------------------------------------

  private async initializeKnownReactions() {
    // Seed the known-reaction window so we don't replay historical reactions
    // as "adds" on startup, and so removals can be detected from now on.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: reactions } = await supabase
      .from('reactions')
      .select('id, message_id, channel_id, created_at')
      .gt('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(5000)

    if (reactions) {
      for (const r of reactions) {
        this.knownReactionIds.add(r.id)
        this.reactionContext.set(r.id, { channel_id: r.channel_id, message_id: r.message_id })
      }
      console.log(`📋 Initialized ${reactions.length} known reactions for add/remove tracking (last 24h)`)
    }
  }

  private async pollReactions() {
    try {
      // --- new reactions (adds) ---
      const { data: newReactions, error } = await supabase
        .from('reactions')
        .select('id, message_id, channel_id, user_id, bot_id, emoji_id, custom_emoji_content, metadata, created_at')
        .gt('created_at', this.lastReactionTimestamp.toISOString())
        .order('created_at', { ascending: true })
        .limit(100)

      if (error) {
        console.error('❌ Error polling reactions:', error)
      } else if (newReactions?.length) {
        for (const r of newReactions) {
          if (!this.knownReactionIds.has(r.id)) {
            await this.handleReactionEvent('MESSAGE_REACTION_ADD', r)
            this.knownReactionIds.add(r.id)
            this.reactionContext.set(r.id, { channel_id: r.channel_id, message_id: r.message_id })
          }
          this.lastReactionTimestamp = new Date(r.created_at)
        }

        // Keep the tracking set bounded.
        if (this.knownReactionIds.size > 10000) {
          const ids = Array.from(this.knownReactionIds).slice(-10000)
          this.knownReactionIds = new Set(ids)
          const ctx = new Map<string, { channel_id: string | null, message_id: string }>()
          for (const id of ids) {
            const c = this.reactionContext.get(id)
            if (c) ctx.set(id, c)
          }
          this.reactionContext = ctx
        }
      }

      // --- removed reactions (hard deletes) ---
      // Check the most recent window of known reaction IDs; any that no longer
      // exist were removed.
      const idsToCheck = Array.from(this.knownReactionIds).slice(-200)
      if (idsToCheck.length > 0) {
        const { data: stillThere } = await supabase
          .from('reactions')
          .select('id')
          .in('id', idsToCheck)

        const present = new Set((stillThere || []).map(r => r.id))
        for (const id of idsToCheck) {
          if (!present.has(id)) {
            const ctx = this.reactionContext.get(id)
            this.knownReactionIds.delete(id)
            this.reactionContext.delete(id)
            if (ctx) {
              await this.handleReactionEvent('MESSAGE_REACTION_REMOVE', {
                id,
                message_id: ctx.message_id,
                channel_id: ctx.channel_id,
              })
            }
          }
        }
      }
    } catch (err) {
      console.error('❌ pollReactions exception:', err)
    }
  }

  /**
   * Resolve a custom emoji's shortcode name (cached). Native/unicode reactions
   * store the character in custom_emoji_content and have no emoji_id.
   */
  private async resolveEmojiName(emojiId: string): Promise<string | null> {
    const cached = this.emojiNameCache.get(emojiId)
    if (cached !== undefined) return cached
    const { data, error } = await supabase
      .from('emojis')
      .select('name')
      .eq('id', emojiId)
      .single()
    if (error && error.code !== 'PGRST116') return null
    const name = data?.name ?? null
    this.emojiNameCache.set(emojiId, name)
    return name
  }

  private async handleReactionEvent(type: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', reaction: any) {
    const serverId = await this.resolveServerId(reaction.channel_id)
    if (!serverId) return

    const botPermissions = await this.resolveBotPermissions(serverId)
    if (botPermissions.length === 0) return

    // Build the emoji descriptor the way consumers (e.g. the Discord bridge)
    // expect: { id, name }. Unicode emoji -> name is the character itself.
    let emoji: { id: string | null, name: string | null }
    if (reaction.emoji_id) {
      emoji = { id: reaction.emoji_id, name: await this.resolveEmojiName(reaction.emoji_id) }
    } else {
      emoji = { id: null, name: reaction.custom_emoji_content ?? null }
    }

    const event = {
      op: 0,
      t: type,
      d: {
        reaction_id: reaction.id,
        message_id: reaction.message_id,
        channel_id: reaction.channel_id,
        user_id: reaction.user_id ?? null,
        bot_id: reaction.bot_id ?? null,
        emoji,
        metadata: reaction.metadata ?? {},
      },
    }

    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
    console.log(`🎭 Dispatched ${type} to ${botIds.length} bots`)
  }

  // ---------------------------------------------------------------------
  // Cached lookups (BUGS.md PC1)
  // ---------------------------------------------------------------------

  /**
   * Resolve a channel's server_id. Cached for 1 hour because channels
   * rarely move between servers.
   *
   * Caching semantics (BUGS.md H3 from code review):
   * - Channel found with server_id: cache it (positive hit).
   * - Channel definitively not found (PGRST116 "no rows"): cache `null`
   *   so deleted/orphan channels don't re-query forever.
   * - Any other error (network, RLS denial, schema reload, transient
   *   Postgres issue): do NOT cache; return null for this call and try
   *   again next time. Caching transient nulls would lock out a working
   *   channel for the full TTL.
   */
  private async resolveServerId(channelId: string | null | undefined): Promise<string | null> {
    if (!channelId) return null
    const cached = this.channelToServerCache.get(channelId)
    if (cached !== undefined) return cached

    const { data: channel, error } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single()

    // PGRST116 = no row returned by .single() (the channel genuinely
    // does not exist). Any other error is transient and must not be
    // cached as a negative result.
    if (error && error.code !== 'PGRST116') {
      console.warn(`channels lookup for ${channelId} returned a transient error; skipping cache:`, error)
      return null
    }

    const serverId = channel?.server_id ?? null
    this.channelToServerCache.set(channelId, serverId)
    return serverId
  }

  /**
   * Resolve the list of bots that have read_messages permission in a
   * server. Cached for 5 minutes because permissions are read-mostly.
   *
   * As with `resolveServerId`, only cache on a clean response. A
   * transient error returning `[]` would silence all bots for that
   * server for the full TTL.
   */
  private async resolveBotPermissions(serverId: string): Promise<BotPermissionRow[]> {
    const cached = this.botPermissionsCache.get(serverId)
    if (cached !== undefined) return cached

    const { data: botPermissions, error } = await supabase
      .from('bot_server_permissions')
      .select('bot_id, read_messages')
      .eq('server_id', serverId)
      .eq('read_messages', true)
      .eq('is_active', true)

    if (error) {
      console.warn(`bot_server_permissions lookup for ${serverId} returned a transient error; skipping cache:`, error)
      return []
    }

    const list = botPermissions ?? []
    this.botPermissionsCache.set(serverId, list)
    return list
  }
  
  private async pollEditsAndDeletes() {
    try {
      // Only check if we have known messages to track
      if (this.knownMessageIds.size === 0) return
      
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
      
      for (const msg of currentMessages || []) {
        const cached = this.messageVersions.get(msg.id)
        
        // Check for soft-deletes (is_deleted = true)
        if (msg.is_deleted && cached) {
          console.log(`🗑️ Message deleted: ${msg.id}`)
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
          console.log(`📝 Message edited: ${msg.id}`)
        }
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
          try {
            await this.handleMessageUpdate({ new: current, old: { id } })
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
    
    // Get server ID from channel (cached, see resolveServerId).
    const serverId = await this.resolveServerId(message.channel_id)
    if (!serverId) {
      console.log('⚠️  No server ID found, skipping dispatch');
      return
    }
    
    // Get bots with permissions in this server (cached).
    const botPermissions = await this.resolveBotPermissions(serverId)
    
    console.log(`🔍 Found ${botPermissions.length} bots with read_messages permission in server ${serverId}`);
    
    if (botPermissions.length === 0) {
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
    
    if (!message || !message.id) return
    if (message.encrypted) return
    
    const serverId = await this.resolveServerId(message.channel_id)
    if (!serverId) return
    
    const botPermissions = await this.resolveBotPermissions(serverId)
    if (botPermissions.length === 0) return
    
    // Format and dispatch event
    const formattedMessage = await this.formatMessage(message)
    const event = {
      op: 0,
      t: 'MESSAGE_UPDATE',
      d: formattedMessage
    }
    
    const botIds = botPermissions.map(bp => bp.bot_id)
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`📝 Dispatched MESSAGE_UPDATE to ${botIds.length} bots`)
  }
  
  private async handleMessageDelete(payload: any) {
    const message = payload.old
    
    console.log(`🗑️ EventDispatcher: Message deleted`, {
      id: message.id,
      channel_id: message.channel_id
    });
    
    const serverId = await this.resolveServerId(message.channel_id)
    if (!serverId) {
      console.log('⚠️  No server ID found, skipping dispatch');
      return
    }
    
    const botPermissions = await this.resolveBotPermissions(serverId)
    if (botPermissions.length === 0) {
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
  
  private async resolveAuthor(userId: string | null, botId: string | null) {
    const cacheKey = userId ? `u:${userId}` : botId ? `b:${botId}` : null
    if (!cacheKey) return null
    const cached = this.authorCache.get(cacheKey)
    if (cached !== undefined) return cached

    // BUGS.md H3: cache only on clean responses or definitive
    // "row not found" (PGRST116). Transient errors must not poison
    // the cache for the full 10 min TTL.
    if (userId) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', userId)
        .single()
      if (error && error.code !== 'PGRST116') {
        console.warn(`profiles lookup for ${userId} returned a transient error; skipping cache:`, error)
        return null
      }
      const entry = data ? { ...data, isBot: false } : null
      this.authorCache.set(cacheKey, entry)
      return entry
    } else {
      const { data, error } = await supabase
        .from('bots')
        .select('id, username, display_name, avatar_url')
        .eq('id', botId!)
        .single()
      if (error && error.code !== 'PGRST116') {
        console.warn(`bots lookup for ${botId} returned a transient error; skipping cache:`, error)
        return null
      }
      const entry = data ? { ...data, isBot: true } : null
      this.authorCache.set(cacheKey, entry)
      return entry
    }
  }

  private async formatMessage(message: any) {
    // Get author info - could be user or bot
    let author = null

    // Discord-bridged messages carry the original user's profile inline; no DB hit.
    if (message.bot_id && message.metadata?.discord_user) {
      const discordUser = message.metadata.discord_user
      author = {
        id: discordUser.id,
        username: discordUser.username,
        display_name: discordUser.display_name,
        avatar: discordUser.avatar_url, // Discord URLs are already complete
        bot: false, // Treat as regular user for display
        discord_user: true
      }
    } else if (message.user_id || message.bot_id) {
      const entry = await this.resolveAuthor(message.user_id ?? null, message.bot_id ?? null)
      if (entry) {
        author = {
          id: entry.id,
          username: entry.username,
          display_name: entry.display_name,
          avatar: this.formatAvatarUrl(entry.avatar_url),
          bot: entry.isBot
        }
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
    if (this.editPollingInterval) {
      clearInterval(this.editPollingInterval)
      this.editPollingInterval = null
    }
    if (this.reactionPollingInterval) {
      clearInterval(this.reactionPollingInterval)
      this.reactionPollingInterval = null
    }
    
    for (const channel of this.subscriptions) {
      await channel.unsubscribe()
    }
    this.subscriptions = []
    this.channelToServerCache.clear()
    this.botPermissionsCache.clear()
    this.authorCache.clear()
    this.emojiNameCache.clear()
    console.log('🛑 Event Dispatcher shut down')
  }
}
